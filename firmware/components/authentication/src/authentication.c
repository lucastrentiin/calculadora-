#include "authentication.h"

#include <string.h>

#include "security.h"

#define KEY_VERIFIER "auth_ver"
#define KEY_ATTEMPTS "auth_att"

typedef struct {
    uint8_t version;
    uint8_t reserved[3];
    uint32_t iterations;
    uint8_t salt[AUTH_SALT_LEN];
    uint8_t check[SEC_SHA256_LEN];
} verifier_t;

typedef struct { uint32_t failures, lock_remaining_s; } attempts_t;

void auth_default_policy(auth_policy_t *p)
{
    p->min_len = 6;
    p->max_len = 8;
    /* Must be measured on the final hardware (docs/SECURITY.md): target ~0.5-1 s per check. */
    p->iterations = 60000;
    p->max_attempts = 5;
    p->base_lock_s = 30;
    p->max_lock_s = 3600;
}

static void save_attempts(auth_t *a)
{
    attempts_t at = {a->failures, a->lock_remaining_s};
    a->kv->set(a->kv, KEY_ATTEMPTS, &at, sizeof(at));
}

void auth_init(auth_t *a, kv_store_t *kv, const auth_policy_t *pol, uint32_t now_s)
{
    memset(a, 0, sizeof(*a));
    a->kv = kv;
    if (pol) a->pol = *pol; else auth_default_policy(&a->pol);
    attempts_t at;
    size_t len = sizeof(at);
    if (kv->get(kv, KEY_ATTEMPTS, &at, &len) == KV_OK && len == sizeof(at)) {
        a->failures = at.failures;
        a->lock_remaining_s = at.lock_remaining_s;
    }
    a->last_tick_s = now_s;
}

bool auth_has_pin(auth_t *a)
{
    size_t len = 0;
    return a->kv->get(a->kv, KEY_VERIFIER, NULL, &len) == KV_OK && len == sizeof(verifier_t);
}

bool auth_valid_format(const auth_t *a, const char *pin, size_t len)
{
    if (len < a->pol.min_len || len > a->pol.max_len) return false;
    for (size_t i = 0; i < len; i++) if (pin[i] < '0' || pin[i] > '9') return false;
    return true;
}

static int derive(const char *pin, size_t len, const uint8_t *salt, uint32_t iter, uint8_t check[32], uint8_t key[32])
{
    uint8_t bits[64];
    int r = sec_pbkdf2_sha256((const uint8_t *)pin, len, salt, AUTH_SALT_LEN, iter, bits, sizeof(bits));
    if (r == 0) r = sec_sha256(bits, 32, check);
    if (r == 0) memcpy(key, bits + 32, 32);
    sec_wipe(bits, sizeof(bits));
    return r;
}

auth_result_t auth_set_pin(auth_t *a, const char *pin, size_t len, uint8_t key[AUTH_KEY_LEN])
{
    if (!auth_valid_format(a, pin, len)) return AUTH_INVALID_FORMAT;
    verifier_t v;
    memset(&v, 0, sizeof(v));
    v.version = 1;
    v.iterations = a->pol.iterations;
    if (sec_random(v.salt, sizeof(v.salt)) != 0) return AUTH_CRYPTO;
    if (derive(pin, len, v.salt, v.iterations, v.check, key) != 0) return AUTH_CRYPTO;
    if (a->kv->set(a->kv, KEY_VERIFIER, &v, sizeof(v)) != KV_OK) { sec_wipe(key, AUTH_KEY_LEN); return AUTH_STORAGE; }
    a->failures = 0;
    a->lock_remaining_s = 0;
    save_attempts(a);
    return AUTH_OK;
}

void auth_tick(auth_t *a, uint32_t now_s)
{
    uint32_t dt = now_s - a->last_tick_s;
    a->last_tick_s = now_s;
    if (!a->lock_remaining_s || !dt) return;
    uint32_t before = a->lock_remaining_s;
    a->lock_remaining_s = dt >= a->lock_remaining_s ? 0 : a->lock_remaining_s - dt;
    /* persist at most every ~10 s of progress to limit flash wear */
    if (a->lock_remaining_s == 0 || before / 10 != a->lock_remaining_s / 10) save_attempts(a);
}

bool auth_is_locked(const auth_t *a) { return a->lock_remaining_s > 0; }
uint32_t auth_failures(const auth_t *a) { return a->failures; }

auth_result_t auth_verify(auth_t *a, const char *pin, size_t len, uint8_t key[AUTH_KEY_LEN], uint32_t now_s)
{
    auth_tick(a, now_s);
    if (auth_is_locked(a)) return AUTH_LOCKED;
    verifier_t v;
    size_t vl = sizeof(v);
    if (a->kv->get(a->kv, KEY_VERIFIER, &v, &vl) != KV_OK || vl != sizeof(v)) return AUTH_NO_PIN;
    bool ok = false;
    if (auth_valid_format(a, pin, len)) {
        uint8_t check[32];
        if (derive(pin, len, v.salt, v.iterations, check, key) != 0) return AUTH_CRYPTO;
        ok = sec_ct_equal(check, v.check, sizeof(check));
        sec_wipe(check, sizeof(check));
        if (!ok) sec_wipe(key, AUTH_KEY_LEN);
    }
    if (ok) {
        a->failures = 0;
        a->lock_remaining_s = 0;
        save_attempts(a);
        return AUTH_OK;
    }
    a->failures++;
    if (a->failures >= a->pol.max_attempts) {
        uint32_t k = a->failures - a->pol.max_attempts;
        uint64_t lock = (uint64_t)a->pol.base_lock_s << (k > 16 ? 16 : k);
        a->lock_remaining_s = lock > a->pol.max_lock_s ? a->pol.max_lock_s : (uint32_t)lock;
    }
    save_attempts(a);
    return AUTH_WRONG;
}

void auth_clear(auth_t *a)
{
    a->kv->erase(a->kv, KEY_VERIFIER);
    a->failures = 0;
    a->lock_remaining_s = 0;
    save_attempts(a);
}
