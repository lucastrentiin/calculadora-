#include "mt_test.h"
#include "authentication.h"
#include "favorites.h"
#include "security.h"
#include "settings.h"
#include "vault.h"
#include "wifi_manager.h"
#include "ota_update.h"
#include "power_manager.h"

TEST(crypto_vectors) {
    uint8_t h[32]; char hex[65];
    sec_sha256((const uint8_t *)"abc", 3, h); sec_hex(h, 32, hex);
    CHECK_STR(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    /* RFC 7914 PBKDF2-HMAC-SHA256 test vector (passwd/salt, c=1, dkLen=64) prefix */
    uint8_t dk[64];
    sec_pbkdf2_sha256((const uint8_t *)"passwd", 6, (const uint8_t *)"salt", 4, 1, dk, 64); sec_hex(dk, 8, hex);
    CHECK_STR(hex, "55ac046e56e3089f");
    uint8_t key[32] = {1}, iv[12] = {2}, pt[5] = "hello", ct[5], tag[16], out[5];
    CHECK_INT(sec_aes256_gcm_encrypt(key, iv, (const uint8_t *)"a", 1, pt, 5, ct, tag), 0);
    CHECK_INT(sec_aes256_gcm_decrypt(key, iv, (const uint8_t *)"a", 1, ct, 5, tag, out), 0);
    CHECK(memcmp(out, pt, 5) == 0);
    tag[0] ^= 1; CHECK(sec_aes256_gcm_decrypt(key, iv, (const uint8_t *)"a", 1, ct, 5, tag, out) != 0);
    CHECK(sec_ct_equal("abc", "abc", 3) && !sec_ct_equal("abc", "abd", 3));
    uint8_t b[8]; CHECK_INT(sec_base64_decode("aGVsbG8=", b, sizeof b), 5); CHECK(memcmp(b, "hello", 5) == 0);
}

static bool contains(kv_store_t *kv, const char *key, const char *needle) {
    uint8_t buf[70000]; size_t len = sizeof buf;
    if (kv->get(kv, key, buf, &len) != KV_OK) return false;
    for (size_t i = 0; i + strlen(needle) <= len; i++) if (memcmp(buf + i, needle, strlen(needle)) == 0) return true;
    return false;
}

TEST(pin_auth_and_lockout) {
    kv_store_t *kv = kv_memory_create();
    auth_policy_t pol; auth_default_policy(&pol); pol.iterations = 1000;
    auth_t a; auth_init(&a, kv, &pol, 0);
    CHECK(!auth_has_pin(&a));
    uint8_t key[32], key2[32];
    CHECK_INT(auth_set_pin(&a, "123", 3, key), AUTH_INVALID_FORMAT);
    CHECK_INT(auth_set_pin(&a, "12345a", 6, key), AUTH_INVALID_FORMAT);
    CHECK_INT(auth_set_pin(&a, "123456", 6, key), AUTH_OK);
    CHECK(auth_has_pin(&a));
    CHECK(!contains(kv, "auth_ver", "123456"));
    CHECK_INT(auth_verify(&a, "123456", 6, key2, 1), AUTH_OK);
    CHECK(memcmp(key, key2, 32) == 0); /* same data key */
    for (int i = 0; i < 5; i++) CHECK_INT(auth_verify(&a, "999999", 6, key2, 2), AUTH_WRONG);
    CHECK(auth_is_locked(&a));
    CHECK_INT(auth_verify(&a, "123456", 6, key2, 3), AUTH_LOCKED);
    auth_t reboot; auth_init(&reboot, kv, &pol, 0); CHECK(auth_is_locked(&reboot)); /* persisted */
    auth_tick(&a, 40); CHECK(!auth_is_locked(&a));
    CHECK_INT(auth_verify(&a, "000000", 6, key2, 41), AUTH_WRONG);
    CHECK(a.lock_remaining_s >= 60); /* exponential backoff */
    kv_memory_destroy(kv);
}

TEST(vault_history_favorites) {
    kv_store_t *kv = kv_memory_create();
    uint8_t key[32]; memset(key, 7, 32);
    vault_t v; CHECK_INT(vault_open(&v, kv, key), 0);
    CHECK_INT(history_add(&v, "titulo", "pergunta-secreta", "{\"version\":1}", 1), 0);
    CHECK_INT(fav_add(&v, FAV_RESULT, "fav", "conteudo-secreto"), 0);
    CHECK(!contains(kv, "vault", "pergunta-secreta"));
    CHECK(!contains(kv, "vault", "conteudo-secreto"));
    vault_close(&v); CHECK(!v.open);
    vault_t v2; vault_open(&v2, kv, key);
    CHECK_INT(history_count(&v2), 1); CHECK_INT(fav_count(&v2), 1);
    CHECK_INT(history_delete(&v2, 0), 0); CHECK_INT(history_count(&v2), 0);
    for (int i = 0; i < 120; i++) history_add(&v2, "t", "q", "{}", 0);
    CHECK_INT(history_count(&v2), HISTORY_MAX);
    CHECK_INT(history_clear(&v2), 0); CHECK_INT(history_count(&v2), 0);
    uint8_t nk[32]; memset(nk, 9, 32); vault_rekey(&v2, nk); vault_close(&v2);
    vault_t bad; CHECK_INT(vault_open(&bad, kv, key), 1); CHECK(bad.corrupt); vault_close(&bad); /* old key no longer works */
    vault_t good; CHECK_INT(vault_open(&good, kv, nk), 0); CHECK_INT(fav_count(&good), 1); vault_close(&good);
    CHECK_INT(fav_formula_toggle(kv, "pyth"), KV_OK); CHECK(fav_formula_is(kv, "pyth"));
    fav_formula_toggle(kv, "pyth"); CHECK(!fav_formula_is(kv, "pyth"));
    kv_memory_destroy(kv);
}

TEST(settings_persistence) {
    kv_store_t *kv = kv_memory_create();
    settings_t s; CHECK_INT(settings_load(kv, &s), KV_NOT_FOUND); CHECK_INT(s.auto_lock_s, 120);
    s.large_font = true; s.response_mode = RESP_FULL; CHECK_INT(settings_save(kv, &s), KV_OK);
    settings_t t; CHECK_INT(settings_load(kv, &t), KV_OK); CHECK(t.large_font); CHECK_INT(t.response_mode, RESP_FULL);
    uint8_t junk[3] = {1, 2, 3}; kv->set(kv, "settings", junk, 3);
    CHECK_INT(settings_load(kv, &t), KV_NOT_FOUND); /* corrupted -> defaults */
    kv_memory_fail_writes(kv, true); CHECK(settings_save(kv, &s) != KV_OK);
    kv_memory_destroy(kv);
}

TEST(wifi_ota_power) {
    wifi_saved_t w; memset(&w, 0, sizeof w);
    CHECK_INT(wifi_saved_add(&w, "rede", "curta"), -1); /* WPA2 needs >= 8 */
    CHECK_INT(wifi_saved_add(&w, "rede", "senha123"), 0);
    for (int i = 0; i < 6; i++) { char s[8]; snprintf(s, sizeof s, "n%d", i); wifi_saved_add(&w, s, ""); }
    CHECK_INT(w.n, WIFI_MAX_SAVED);
    CHECK_INT(wifi_saved_remove(&w, "n5"), 0); CHECK_INT(w.n, WIFI_MAX_SAVED - 1);
    CHECK_INT(wifi_backoff_ms(0), 1000); CHECK_INT(wifi_backoff_ms(20), 300000);
    CHECK(ota_version_cmp("0.2.0", "0.10.0") < 0); CHECK(ota_version_cmp("1.0.0", "1.0.0") == 0); CHECK(ota_version_cmp("2.0", "1.9.9") > 0);
    pm_policy_t p = {60, 30, 15, 3, 3300}; pm_state_t s; pm_init(&s, &p, 0);
    battery_reading_t b = {true, 80, 3900, false};
    CHECK_INT(pm_evaluate(&s, 1000, &b, false), PM_ACT_NONE);
    CHECK_INT(pm_evaluate(&s, 61000, &b, false), PM_ACT_DISPLAY_OFF);
    CHECK_INT(pm_evaluate(&s, 92000, &b, false), PM_ACT_LIGHT_SLEEP);
    pm_activity(&s, 100000);
    CHECK_INT(pm_evaluate(&s, 200000, &b, true), PM_ACT_NONE); /* busy never sleeps */
    b.percent = 10; CHECK_INT(pm_evaluate(&s, 200001, &b, true), PM_ACT_LOW_BATTERY);
    CHECK_INT(pm_evaluate(&s, 200002, &b, true), PM_ACT_NONE); /* warned once */
    b.percent = 2; CHECK_INT(pm_evaluate(&s, 200003, &b, true), PM_ACT_CRITICAL);
    b.supported = false; CHECK_INT(pm_evaluate(&s, 200004, &b, true), PM_ACT_NONE); /* no circuit: no guess */
    CHECK_INT(battery_percent_from_mv(4200), 100); CHECK_INT(battery_percent_from_mv(3000), 0);
}

TEST_MAIN(RUN(crypto_vectors); RUN(pin_auth_and_lockout); RUN(vault_history_favorites); RUN(settings_persistence); RUN(wifi_ota_power))
