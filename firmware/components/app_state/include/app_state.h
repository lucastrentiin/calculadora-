/*
 * Application state machine and UI (C counterpart of simulator/js/core/app.js).
 *
 * States: NORMAL, AUTH_PENDING, AUTHENTICATED, TEXT_ENTRY, AI_REQUEST,
 *         AI_RESPONSE, CAMERA, MATH_TOOLS, SETTINGS, PRIVACY_LOCK (transient)
 *
 * All hardware/network access goes through app_platform_t so the whole
 * module is compiled and tested on the host (tests/firmware).
 * app_key()/app_tick()/app_render() must be called from ONE task (UI task);
 * slow work (PBKDF2, HTTPS, camera) runs elsewhere and never blocks it.
 */
#pragma once
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

#include "ai_client.h"
#include "authentication.h"
#include "calculator.h"
#include "camera_hal.h"
#include "framebuffer.h"
#include "keypad.h"
#include "ota_update.h"
#include "power_manager.h"
#include "privacy_lock.h"
#include "settings.h"
#include "vault.h"
#include "wifi_manager.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ST_NORMAL = 0, ST_AUTH_PENDING, ST_AUTHENTICATED, ST_TEXT_ENTRY, ST_AI_REQUEST,
    ST_AI_RESPONSE, ST_CAMERA, ST_MATH_TOOLS, ST_SETTINGS, ST_PRIVACY_LOCK, ST_COUNT
} app_state_id_t;

typedef struct app app_t;
typedef struct view view_t;

struct view {
    app_state_id_t state;
    bool prot;  /* shows protected content */
    bool (*on_key)(view_t *v, app_t *a, keycode_t k, bool shift);
    void (*render)(view_t *v, app_t *a, fb_t *fb);
    void (*tick)(view_t *v, app_t *a);
    void (*dispose)(view_t *v); /* wipe + free */
};

typedef struct {
    kv_store_t *kv;
    ai_client_t *ai;            /* may be NULL (no network build) */
    camera_hal_t *cam;          /* may be NULL */
    wifi_hal_t *wifi;           /* may be NULL */
    ota_hal_t *ota;             /* may be NULL */
    bool (*battery)(battery_reading_t *out);
    uint32_t (*now_ms)(void);
    void (*log)(const char *event);                         /* never receives sensitive data */
    void (*run_async)(void (*fn)(void *), void *arg);       /* NULL = run inline (tests) */
    void (*request_flush)(void);                            /* present the frame now */
    void (*wake_worker)(void);                              /* AI worker notification */
    auth_policy_t auth_policy;
    uint16_t width, height;
} app_platform_t;

#define APP_MAX_VIEWS 8

typedef struct {
    _Atomic uint32_t token;     /* job generation */
    _Atomic int done;           /* 0 none, 1 finished */
    auth_result_t result;
    bool setup;                 /* creating a PIN instead of verifying */
    char pin[12];
    size_t pinlen;
    uint8_t key[AUTH_KEY_LEN];
} auth_job_t;

struct app {
    app_platform_t p;
    settings_t set;
    calculator_t calc;
    auth_t auth;
    vault_t vault;
    bool session;
    view_t *stack[APP_MAX_VIEWS];
    int depth;
    bool shift, alpha;
    struct { keycode_t k; uint32_t t; } combo[4];
    int ncombo;
    /* AUTH_PENDING */
    bool pin_active, pin_busy;
    char pin[9];
    uint8_t pinlen;
    uint32_t auth_started;
    auth_job_t job;
    /* activity / power */
    uint32_t last_activity;
    bool asleep;
    pm_state_t pm;
    /* AI */
    uint32_t ai_gen;
    char ai_question[160];
    resp_mode_t ai_mode;
    char session_id[33];        /* new random id per authenticated session; AI results must match it */
    struct { char id[24], label[16]; } providers[6];
    int nproviders;
    uint8_t aux_job;            /* 0 none, 1 config fetch, 2 diagnostics upload */
    /* feedback */
    char flash[24];
    uint32_t flash_until;
    pl_reason_t last_lock_reason;
    app_state_id_t last_lock_from;
    uint32_t last_lock_us;
};

void app_init(app_t *a, const app_platform_t *p);
void app_key(app_t *a, keycode_t k);
void app_tick(app_t *a);
void app_render(app_t *a, fb_t *fb);
app_state_id_t app_state(const app_t *a);
const char *app_state_name(app_state_id_t s);
bool app_is_protected(const app_t *a);
void app_privacy_lock(app_t *a, pl_reason_t reason, uint64_t t0_us);
/* exposed for tests */
void app_open_tools(app_t *a, bool prot);
void app_push(app_t *a, view_t *v);
void app_pop(app_t *a);
view_t *app_top(const app_t *a);

#ifdef __cplusplus
}
#endif
