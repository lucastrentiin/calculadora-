#include "mt_test.h"
#include "fakes.h"
#include "app_state.h"
#include "security.h"
#include "settings.h"
#include "favorites.h"

static app_t A;
static kv_store_t *KV;
static ai_client_t AI;
static uint8_t FBM[128 * 4];
static fb_t FB;
static battery_reading_t g_bat = {false, 0, 0, false};
static bool fake_battery(battery_reading_t *b) { *b = g_bat; return g_bat.supported; }
static int g_logs; static char g_logbuf[4096];
static void fake_log(const char *e) { g_logs++; strncat(g_logbuf, e, sizeof g_logbuf - strlen(g_logbuf) - 2); strcat(g_logbuf, "\n"); }

static void K(keycode_t k) { app_key(&A, k); }
static void keys(const keycode_t *ks, int n) { for (int i = 0; i < n; i++) K(ks[i]); }
static const keycode_t COMBO[] = {KEY_SHIFT, KEY_SHIFT, KEY_ALPHA, KEY_ALPHA};
static const keycode_t PIN[] = {KEY_K1, KEY_K2, KEY_K3, KEY_K4, KEY_K5, KEY_K6};
static void pump(void) { while (ai_client_run_pending(&AI)) {} app_tick(&A); }

static void teardown(void) { while (A.depth) app_pop(&A); vault_close(&A.vault); ai_result_t r; if (ai_client_poll(&AI, atomic_load(&AI.result_gen), &r)) ai_client_free_result(&r); }
static void boot(bool with_pin)
{
    teardown();
    if (KV) kv_memory_destroy(KV);
    KV = kv_memory_create();
    ai_client_cfg_t cfg; memset(&cfg, 0, sizeof cfg);
    strcpy(cfg.base_url, "https://b"); strcpy(cfg.device_id, "d"); cfg.transport = &g_transport; cfg.now_s = fake_now_s;
    ai_client_init(&AI, &cfg);
    memset(&g_net, 0, sizeof g_net);
    g_wifi_state = WIFI_ST_CONNECTED; g_cam.st = CAM_OFF; g_cam.fail_start = g_cam.fail_capture = 0;
    app_platform_t p; memset(&p, 0, sizeof p);
    p.kv = KV; p.ai = &AI; p.cam = &g_camhal; p.wifi = &g_wifihal; p.battery = fake_battery; p.now_ms = fake_now_ms; p.log = fake_log;
    auth_default_policy(&p.auth_policy); p.auth_policy.iterations = 1000; p.width = 128; p.height = 32;
    app_init(&A, &p);
    fb_init(&FB, 128, 32, FBM, sizeof FBM);
    if (with_pin) {
        keys(COMBO, 4); keys(PIN, 6); K(KEY_DOWN); keys(PIN, 6); K(KEY_EQ);
        app_tick(&A);
        K(KEY_ON);
    }
}
static void login(void) { keys(COMBO, 4); keys(PIN, 6); K(KEY_EQ); app_tick(&A); }

TEST(normal_calculator_offline) {
    boot(false);
    g_wifi_state = WIFI_ST_OFF;
    CHECK_INT(app_state(&A), ST_NORMAL);
    const keycode_t e[] = {KEY_K1, KEY_K2, KEY_DIV, KEY_K4, KEY_EQ};
    keys(e, 5);
    char r[32]; calc_result_text(&A.calc, r, sizeof r); CHECK_STR(r, "3");
    K(KEY_ADD); K(KEY_K1); K(KEY_EQ); calc_result_text(&A.calc, r, sizeof r); CHECK_STR(r, "4");
    K(KEY_ON); CHECK_INT(A.calc.ntok, 0); /* conventional ON */
    K(KEY_MODE); K(KEY_MODE); K(KEY_K2); CHECK_INT(A.set.angle_deg, ME_ANGLE_RAD); /* MODE MODE 2 = Rad */
    app_render(&A, &FB);
}

TEST(first_use_creates_pin_no_default) {
    boot(false);
    K(KEY_SHIFT); K(KEY_SHIFT); K(KEY_ALPHA); K(KEY_ALPHA);
    CHECK_INT(app_state(&A), ST_SETTINGS); /* PIN creation form */
    keys(PIN, 6); K(KEY_DOWN); keys(PIN, 6); K(KEY_EQ); app_tick(&A);
    CHECK_INT(app_state(&A), ST_AUTHENTICATED);
    uint8_t buf[256]; size_t l = sizeof buf;
    CHECK_INT(KV->get(KV, "auth_ver", buf, &l), KV_OK);
    bool found = false; for (size_t i = 0; i + 6 <= l; i++) if (!memcmp(buf + i, "123456", 6)) found = true;
    CHECK(!found);
    CHECK(strstr(g_logbuf, "123456") == NULL);
}

TEST(discreet_auth_indicator_only) {
    boot(true);
    const keycode_t e[] = {KEY_K7, KEY_MUL, KEY_K6, KEY_EQ}; keys(e, 4);
    app_render(&A, &FB); uint8_t before[sizeof FBM]; memcpy(before, FBM, sizeof FBM);
    keys(COMBO, 4);
    CHECK_INT(app_state(&A), ST_AUTH_PENDING);
    g_now_ms += 1; /* keep blink phase stable */
    app_render(&A, &FB);
    for (int x = 0; x < 128; x++) for (int y = 0; y < 32; y++) {
        bool b = (before[(y >> 3) * 128 + x] >> (y & 7)) & 1, n = fb_get(&FB, x, y);
        if (b != n) CHECK(x >= 125 && y <= 2);
    }
    uint8_t pending[sizeof FBM]; memcpy(pending, FBM, sizeof FBM);
    K(KEY_K1); K(KEY_K2); app_render(&A, &FB);
    CHECK(memcmp(pending, FBM, sizeof FBM) == 0); /* digits not shown */
    K(KEY_K3); K(KEY_K4); K(KEY_K5); K(KEY_K6); K(KEY_EQ); app_tick(&A);
    CHECK_INT(app_state(&A), ST_AUTHENTICATED);
}

TEST(auth_timeout_and_passthrough) {
    boot(true);
    keys(COMBO, 4); K(KEY_K1); g_now_ms += 31000; app_tick(&A);
    CHECK_INT(app_state(&A), ST_NORMAL);
    keys(COMBO, 4); K(KEY_K1); K(KEY_ADD);
    CHECK_INT(app_state(&A), ST_NORMAL);
    char e[32]; calc_expr(&A.calc, e, sizeof e); CHECK_STR(e, "+");
}

TEST(lockout_after_wrong_pins) {
    boot(true);
    const keycode_t bad[] = {KEY_K9, KEY_K9, KEY_K9, KEY_K9, KEY_K9, KEY_K9};
    for (int i = 0; i < 5; i++) { keys(COMBO, 4); keys(bad, 6); K(KEY_EQ); app_tick(&A); CHECK_INT(app_state(&A), ST_NORMAL); g_now_ms += 4000; }
    CHECK(auth_is_locked(&A.auth));
    login(); CHECK_INT(app_state(&A), ST_NORMAL); /* ignored while locked */
    g_now_ms += 31000; app_tick(&A);
    login(); CHECK_INT(app_state(&A), ST_AUTHENTICATED);
}

static void reach(app_state_id_t st)
{
    login();
    switch (st) {
    case ST_AUTHENTICATED: break;
    case ST_TEXT_ENTRY: K(KEY_K1); K(KEY_K4); break; /* menu item 1 -> editor, then type '4' */
    case ST_AI_REQUEST: K(KEY_K1); K(KEY_K2); app_key(&A, KEY_SHIFT); K(KEY_EQ); break;
    case ST_AI_RESPONSE: K(KEY_K1); K(KEY_K2); app_key(&A, KEY_SHIFT); K(KEY_EQ); pump(); break;
    case ST_CAMERA: K(KEY_K2); break;
    case ST_MATH_TOOLS: K(KEY_K3); break;
    case ST_SETTINGS: K(KEY_K7); break;
    default: break;
    }
}

TEST(privacy_lock_from_every_protected_state) {
    boot(true);
    g_net.reply = "{\"version\":1,\"status\":\"ok\",\"answer\":\"segredo\"}";
    const keycode_t e[] = {KEY_K2, KEY_ADD, KEY_K2, KEY_EQ}; keys(e, 4);
    app_state_id_t states[] = {ST_AUTHENTICATED, ST_TEXT_ENTRY, ST_AI_REQUEST, ST_AI_RESPONSE, ST_CAMERA, ST_MATH_TOOLS, ST_SETTINGS};
    for (size_t i = 0; i < sizeof states / sizeof states[0]; i++) {
        reach(states[i]);
        CHECK_INT(app_state(&A), states[i]);
        K(KEY_ON);
        CHECK_INT(app_state(&A), ST_NORMAL);
        CHECK(!app_is_protected(&A));
        CHECK(!A.vault.open);
        CHECK_INT(A.depth, 0);
        CHECK(A.last_lock_us < 100000); /* < 100 ms (host measurement) */
        CHECK_INT(A.last_lock_from, states[i]);
        char r[32]; calc_result_text(&A.calc, r, sizeof r); CHECK_STR(r, "4"); /* normal content back */
        if (states[i] == ST_CAMERA) CHECK_INT(g_cam.st, CAM_OFF);
        pump();
        CHECK_INT(app_state(&A), ST_NORMAL); /* nothing protected comes back later */
        K(KEY_MENU); CHECK(!app_is_protected(&A)); K(KEY_ON);
    }
}

TEST(ai_cancel_after_send_via_privacy_lock) {
    boot(true);
    g_net.reply = "{\"version\":1,\"status\":\"ok\",\"answer\":\"segredo\"}";
    reach(ST_AI_REQUEST);
    atomic_store(&AI.sent, true); /* request already reached the server */
    K(KEY_ON);
    pump();
    CHECK_INT(app_state(&A), ST_NORMAL);
    CHECK_INT(g_net.cancel_calls, 1);
    const ai_cancel_entry_t *e; CHECK_INT(ai_client_cancel_log(&AI, &e), 1);
}

TEST(full_ai_flow_history_and_favorite) {
    boot(true);
    g_net.reply = "{\"version\":1,\"status\":\"ok\",\"mode\":\"full\",\"answer\":\"x = 2\",\"steps\":[{\"title\":\"a\",\"math\":\"1+1\",\"text\":\"t\"}],\"check\":{\"expression\":\"1+1\",\"expected\":2}}";
    reach(ST_AI_RESPONSE);
    CHECK_INT(app_state(&A), ST_AI_RESPONSE);
    app_render(&A, &FB);
    K(KEY_DOWN); K(KEY_DOWN); K(KEY_RIGHT); K(KEY_STO);
    CHECK_INT(history_count(&A.vault), 1);
    CHECK_INT(fav_count(&A.vault), 1);
    K(KEY_ON); login();
    CHECK_INT(history_count(&A.vault), 1); /* re-opened with the PIN-derived key */
    K(KEY_K5); CHECK_INT(app_state(&A), ST_AUTHENTICATED); K(KEY_EQ); CHECK_INT(app_state(&A), ST_AI_RESPONSE);
}

TEST(wifi_off_and_offline_tools) {
    boot(true);
    login();
    g_wifi_state = WIFI_ST_OFF;
    K(KEY_K1); K(KEY_K2); app_key(&A, KEY_SHIFT); K(KEY_EQ);
    CHECK_INT(app_state(&A), ST_AI_RESPONSE); /* error message, no request */
    CHECK_INT(g_net.calls, 0);
    K(KEY_AC); K(KEY_K3); K(KEY_K3); /* tools -> 2nd degree */
    const keycode_t q[] = {KEY_K1, KEY_DOWN, KEY_SUB, KEY_K3, KEY_DOWN, KEY_K2, KEY_EQ}; keys(q, 7);
    CHECK_INT(app_state(&A), ST_MATH_TOOLS);
    app_render(&A, &FB);
}

TEST(camera_errors_and_capture) {
    boot(true);
    login();
    g_cam.fail_start = 1; K(KEY_K2); CHECK_INT(g_cam.st, CAM_ERROR);
    g_cam.fail_start = 0; K(KEY_EQ); CHECK_INT(g_cam.st, CAM_READY);
    g_cam.fail_capture = 1; K(KEY_EQ); CHECK_INT(g_cam.st, CAM_ERROR);
    g_cam.fail_capture = 0; K(KEY_EQ); K(KEY_EQ); CHECK_INT(g_cam.st, CAM_CAPTURED);
    app_render(&A, &FB);
    g_net.reply = "{\"version\":1,\"status\":\"ok\",\"answer\":\"img\"}";
    K(KEY_EQ);
    CHECK_INT(app_state(&A), ST_AI_REQUEST);
    pump();
    CHECK_INT(app_state(&A), ST_AI_RESPONSE);
    CHECK(strstr(g_net.last_url, "/v1/image") != NULL);
}

TEST(inactivity_battery_and_sleep) {
    boot(true);
    login(); g_now_ms += 121000; app_tick(&A);
    CHECK_INT(app_state(&A), ST_NORMAL); CHECK_INT(A.last_lock_reason, PL_REASON_INACTIVITY);
    login(); g_bat = (battery_reading_t){true, 2, 3200, false}; app_tick(&A);
    CHECK_INT(A.last_lock_reason, PL_REASON_BATTERY);
    g_bat.supported = false;
    g_now_ms += 301000; app_tick(&A); CHECK(A.asleep);
    K(KEY_K5); CHECK(!A.asleep); CHECK_INT(A.calc.ntok, 0); /* wake only */
}

TEST(text_entry_methods_preserve_text) {
    boot(true);
    login(); K(KEY_K1);
    CHECK_INT(app_state(&A), ST_TEXT_ENTRY);
    K(KEY_RIGHT); K(KEY_RIGHT); K(KEY_EQ);           /* 'e' (method A) */
    K(KEY_MODE); K(KEY_K4); K(KEY_K4); K(KEY_K4);     /* 'i' (method B) */
    K(KEY_MODE);
    app_render(&A, &FB);
    view_t *v = app_top(&A);
    CHECK(v && v->state == ST_TEXT_ENTRY);
    K(KEY_AC); CHECK_INT(app_state(&A), ST_AUTHENTICATED);
}

TEST(storage_failure_is_survivable) {
    boot(false);
    kv_memory_fail_writes(KV, true);
    K(KEY_MODE); K(KEY_MODE); K(KEY_K1); /* Deg: settings write fails */
    const keycode_t e[] = {KEY_K2, KEY_ADD, KEY_K2, KEY_EQ}; keys(e, 4);
    char r[16]; calc_result_text(&A.calc, r, sizeof r); CHECK_STR(r, "4");
    CHECK(strstr(g_logbuf, "storage_error") != NULL);
}

TEST(settings_large_font_and_menus) {
    boot(true);
    login(); K(KEY_K7);
    K(KEY_DOWN); K(KEY_DOWN); K(KEY_EQ); CHECK(A.set.large_font);
    app_render(&A, &FB);
    K(KEY_AC); K(KEY_AC); CHECK_INT(app_state(&A), ST_NORMAL); /* leaving the root menu locks */
}

TEST_MAIN(RUN(normal_calculator_offline); RUN(first_use_creates_pin_no_default); RUN(discreet_auth_indicator_only); RUN(auth_timeout_and_passthrough);
          RUN(lockout_after_wrong_pins); RUN(privacy_lock_from_every_protected_state); RUN(ai_cancel_after_send_via_privacy_lock);
          RUN(full_ai_flow_history_and_favorite); RUN(wifi_off_and_offline_tools); RUN(camera_errors_and_capture); RUN(inactivity_battery_and_sleep);
          RUN(text_entry_methods_preserve_text); RUN(storage_failure_is_survivable); RUN(settings_large_font_and_menus);
          teardown(); if (KV) kv_memory_destroy(KV))
