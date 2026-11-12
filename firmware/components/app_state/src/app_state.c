#include "app_internal.h"
#include "security.h"

static const char *const STATE_NAMES[ST_COUNT] = {
    "NORMAL", "AUTH_PENDING", "AUTHENTICATED", "TEXT_ENTRY", "AI_REQUEST",
    "AI_RESPONSE", "CAMERA", "MATH_TOOLS", "SETTINGS", "PRIVACY_LOCK",
};

static const keycode_t COMBOS[COMBO_COUNT][4] = {
    {KEY_SHIFT, KEY_SHIFT, KEY_ALPHA, KEY_ALPHA},
    {KEY_ALPHA, KEY_SHIFT, KEY_ALPHA, KEY_SHIFT},
    {KEY_MODE, KEY_MODE, KEY_SHIFT, KEY_SHIFT},
};
#define COMBO_WINDOW_MS 3000
#define AUTH_TIMEOUT_MS 30000

const char *app_state_name(app_state_id_t s) { return s < ST_COUNT ? STATE_NAMES[s] : "?"; }
uint32_t app_now(const app_t *a) { return a->p.now_ms(); }

layout_t app_layout(const app_t *a)
{
    layout_t L;
    L.scale = a->set.large_font ? 2 : 1;
    L.cw = 6 * L.scale;
    L.ch = 8 * L.scale;
    L.x0 = 3;
    L.cols = (a->p.width - L.x0 - 5) / L.cw;
    L.rows = a->p.height / L.ch;
    L.title_row = L.scale == 1 && !a->set.simple_menus && a->p.height >= 32;
    L.simple = a->set.simple_menus;
    return L;
}

layout_t app_layout1(const app_t *a)
{
    layout_t L = {1, 6, 8, 3, (a->p.width - 8) / 6, a->p.height / 8, false, false};
    return L;
}

void app_flash(app_t *a, const char *msg)
{
    snprintf(a->flash, sizeof(a->flash), "%s", msg);
    a->flash_until = app_now(a) + 800;
}

void app_save_settings(app_t *a)
{
    if (settings_save(a->p.kv, &a->set) != KV_OK) APP_LOG(a, "storage_error");
}

/* ------------------------------ stack ------------------------------ */

view_t *app_top(const app_t *a) { return a->depth ? a->stack[a->depth - 1] : NULL; }

void app_push(app_t *a, view_t *v)
{
    if (!v) return;
    if (a->depth >= APP_MAX_VIEWS) { if (v->dispose) v->dispose(v); app_flash(a, "Limite de telas"); return; }
    a->stack[a->depth++] = v;
}

void app_pop(app_t *a)
{
    if (!a->depth) return;
    view_t *v = a->stack[--a->depth];
    a->stack[a->depth] = NULL;
    if (v->dispose) v->dispose(v);
}

app_state_id_t app_state(const app_t *a)
{
    if (a->pin_active) return ST_AUTH_PENDING;
    view_t *v = app_top(a);
    return v ? v->state : ST_NORMAL;
}

bool app_is_protected(const app_t *a)
{
    if (a->session) return true;
    for (int i = 0; i < a->depth; i++) if (a->stack[i]->prot) return true;
    return false;
}

/* ------------------------------ privacy lock ------------------------ */

static void hook_ui(void *ctx, pl_reason_t r)
{
    app_t *a = ctx;
    (void)r;
    /* 1) visible UI first: drop every view (dispose wipes their buffers) */
    while (a->depth) app_pop(a);
    a->pin_active = false;
    a->pin_busy = false;
    sec_wipe(a->pin, sizeof(a->pin));
    a->pinlen = 0;
    atomic_fetch_add(&a->job.token, 1); /* late PBKDF2 results are ignored */
    a->session = false;
    a->shift = a->alpha = false;
    if (a->p.request_flush) a->p.request_flush();
}

static void hook_cancel(void *ctx, pl_reason_t r)
{
    app_t *a = ctx;
    (void)r;
    if (a->p.ai) { ai_client_cancel(a->p.ai); if (a->p.wake_worker) a->p.wake_worker(); }
    if (a->p.cam && a->p.cam->state(a->p.cam) != CAM_OFF) a->p.cam->stop(a->p.cam);
#ifdef ESP_PLATFORM
    camera_preview_stop();
#endif
}

static void hook_wipe(void *ctx, pl_reason_t r)
{
    app_t *a = ctx;
    (void)r;
    vault_close(&a->vault);
    sec_wipe(a->ai_question, sizeof(a->ai_question));
}

void app_privacy_lock(app_t *a, pl_reason_t reason, uint64_t t0)
{
    a->last_lock_from = app_state(a);
    a->last_lock_reason = reason;
    a->last_lock_us = pl_engage(reason, t0);
    APP_LOG(a, "privacy_lock");
}

/* ------------------------------ init ------------------------------- */

void app_init(app_t *a, const app_platform_t *p)
{
    memset(a, 0, sizeof(*a));
    a->p = *p;
    if (!a->p.width) a->p.width = 128;
    if (!a->p.height) a->p.height = 32;
    settings_load(a->p.kv, &a->set);
    calc_init(&a->calc);
    auth_init(&a->auth, a->p.kv, a->p.auth_policy.iterations ? &a->p.auth_policy : NULL, app_now(a) / 1000);
    a->last_activity = app_now(a);
    pm_policy_t pol = {a->set.sleep_s, 60, 15, 3, 3300};
    pm_init(&a->pm, &pol, app_now(a));
    pl_reset();
    pl_register("ui", PL_PRIO_UI, hook_ui, a);
    pl_register("cancel", PL_PRIO_CANCEL, hook_cancel, a);
    pl_register("wipe", PL_PRIO_WIPE, hook_wipe, a);
}

/* ------------------------------ authentication --------------------- */

static void auth_job_run(void *arg)
{
    app_t *a = arg;
    auth_job_t *j = &a->job;
    uint32_t token = atomic_load(&j->token);
    auth_result_t r;
    uint8_t key[AUTH_KEY_LEN];
    if (j->setup) r = auth_set_pin(&a->auth, j->pin, j->pinlen, key);
    else r = auth_verify(&a->auth, j->pin, j->pinlen, key, app_now(a) / 1000);
    sec_wipe(j->pin, sizeof(j->pin));
    j->pinlen = 0;
    if (token != atomic_load(&j->token)) { sec_wipe(key, sizeof(key)); return; } /* cancelled meanwhile */
    memcpy(j->key, key, sizeof(key));
    sec_wipe(key, sizeof(key));
    j->result = r;
    atomic_store(&j->done, 1);
}

static void start_auth_job(app_t *a, const char *pin, size_t len, bool setup)
{
    auth_job_t *j = &a->job;
    atomic_fetch_add(&j->token, 1);
    atomic_store(&j->done, 0);
    j->setup = setup;
    j->pinlen = len < sizeof(j->pin) ? len : sizeof(j->pin) - 1;
    memcpy(j->pin, pin, j->pinlen);
    if (a->p.run_async) a->p.run_async(auth_job_run, a);
    else auth_job_run(a);
}

static void open_session(app_t *a)
{
    a->session = true;
    a->last_activity = app_now(a);
    vault_open(&a->vault, a->p.kv, a->job.key);
    sec_wipe(a->job.key, sizeof(a->job.key));
    app_push(a, screens_protected_menu(a));
    APP_LOG(a, "session_open");
}

/** Called by the PIN setup form (app_screens.c). */
void app_begin_pin_setup(app_t *a, const char *pin, size_t len);
void app_begin_pin_setup(app_t *a, const char *pin, size_t len) { start_auth_job(a, pin, len, true); }

static void poll_auth_job(app_t *a)
{
    if (!atomic_load(&a->job.done)) return;
    atomic_store(&a->job.done, 0);
    if (a->job.setup) {
        if (a->job.result == AUTH_OK) { while (a->depth) app_pop(a); open_session(a); vault_save(&a->vault); }
        else { sec_wipe(a->job.key, sizeof(a->job.key)); app_flash(a, "Falha ao criar PIN"); }
        return;
    }
    a->pin_active = false;
    a->pin_busy = false;
    if (a->job.result == AUTH_OK) open_session(a);
    else { sec_wipe(a->job.key, sizeof(a->job.key)); APP_LOG(a, "auth_failed"); }
}

static void begin_auth(app_t *a)
{
    auth_tick(&a->auth, app_now(a) / 1000);
    if (auth_is_locked(&a->auth)) { APP_LOG(a, "auth_ignored_locked"); return; } /* stays fully silent */
    if (!auth_has_pin(&a->auth)) { screens_open_pin_setup(a); return; }
    a->pin_active = true;
    a->pin_busy = false;
    a->pinlen = 0;
    a->auth_started = app_now(a);
    APP_LOG(a, "auth_pending");
}

static void cancel_auth(app_t *a)
{
    sec_wipe(a->pin, sizeof(a->pin));
    a->pinlen = 0;
    a->pin_active = false;
    a->pin_busy = false;
    atomic_fetch_add(&a->job.token, 1);
}

static bool detect_combo(app_t *a, keycode_t k)
{
    const keycode_t *seq = COMBOS[a->set.auth_combo < COMBO_COUNT ? a->set.auth_combo : 0];
    uint32_t now = app_now(a);
    if (a->ncombo == 4) { memmove(&a->combo[0], &a->combo[1], sizeof(a->combo[0]) * 3); a->ncombo = 3; }
    a->combo[a->ncombo].k = k;
    a->combo[a->ncombo].t = now;
    a->ncombo++;
    if (a->ncombo < 4 || now - a->combo[0].t > COMBO_WINDOW_MS) return false;
    for (int i = 0; i < 4; i++) if (a->combo[i].k != seq[i]) return false;
    a->ncombo = 0;
    return true;
}

static void auth_key(app_t *a, keycode_t k)
{
    if (a->pin_busy) { if (k == KEY_AC) cancel_auth(a); return; }
    if (key_is_digit(k)) { if (a->pinlen < a->auth.pol.max_len && a->pinlen < sizeof(a->pin) - 1) a->pin[a->pinlen++] = key_digit(k); return; }
    if (k == KEY_DEL) { if (a->pinlen) a->pin[--a->pinlen] = 0; return; }
    if (k == KEY_AC) { cancel_auth(a); return; }
    if (k == KEY_EQ) {
        a->pin_busy = true;
        start_auth_job(a, a->pin, a->pinlen, false);
        sec_wipe(a->pin, sizeof(a->pin));
        a->pinlen = 0;
        return;
    }
    /* any other key: abandon silently and behave like a normal calculator key */
    cancel_auth(a);
    app_key(a, k);
}

/* ------------------------------ keys ------------------------------- */

void app_key(app_t *a, keycode_t k)
{
    uint64_t t0 = pl_now_us();
    a->last_activity = app_now(a);
    pm_activity(&a->pm, a->last_activity);
    if (a->asleep) { a->asleep = false; return; } /* first key only wakes */

    if (k == KEY_ON) {
        if (app_is_protected(a)) { app_privacy_lock(a, PL_REASON_KEY, t0); return; }
        if (a->pin_active) { cancel_auth(a); return; }
        if (a->depth) { while (a->depth) app_pop(a); return; } /* unprotected tools */
        calc_clear(&a->calc);
        a->shift = a->alpha = false;
        return;
    }
    if (app_state(a) == ST_NORMAL && !a->depth && detect_combo(a, k)) {
        a->shift = a->alpha = false;
        begin_auth(a);
        return;
    }
    if (a->pin_active) { auth_key(a, k); return; }
    view_t *top = app_top(a);
    if (k == KEY_SHIFT) { a->shift = !a->shift; return; }
    if (k == KEY_ALPHA && !(top && top->state == ST_TEXT_ENTRY)) { a->alpha = !a->alpha; return; }
    bool shift = a->shift;
    a->shift = a->alpha = false;
    if (top) { top->on_key(top, a, k, shift); return; }
    switch (k) {
    case KEY_MODE: a->set.angle_deg = !a->set.angle_deg; app_save_settings(a); return;
    case KEY_MENU: app_open_tools(a, false); return;
    case KEY_EQ:
        if (shift) {
            char e[ME_MAX_LEN + 1];
            calc_expr(&a->calc, e, sizeof(e));
            if (!e[0] && a->calc.nhist) snprintf(e, sizeof(e), "%s", a->calc.history[0].expr);
            screens_open_steps(a, e, false);
            return;
        }
        break;
    default: break;
    }
    calc_key(&a->calc, k, shift, a->set.angle_deg ? ME_ANGLE_DEG : ME_ANGLE_RAD);
}

/* ------------------------------ tick ------------------------------- */

void app_tick(app_t *a)
{
    uint32_t now = app_now(a);
    auth_tick(&a->auth, now / 1000);
    poll_auth_job(a);
    if (a->pin_active && !a->pin_busy && now - a->auth_started > AUTH_TIMEOUT_MS) cancel_auth(a);
    if (a->session && now - a->last_activity > (uint32_t)a->set.auto_lock_s * 1000u) app_privacy_lock(a, PL_REASON_INACTIVITY, 0);
    view_t *top = app_top(a);
    if (top && top->tick) top->tick(top, a);
    battery_reading_t bat = {0};
    bool have_bat = a->p.battery && a->p.battery(&bat);
    a->pm.pol.sleep_s = a->set.sleep_s;
    bool busy = a->p.ai && atomic_load(&a->p.ai->job_gen) != 0;
    pm_action_t act = pm_evaluate(&a->pm, now, have_bat ? &bat : NULL, busy);
    switch (act) {
    case PM_ACT_CRITICAL: if (app_is_protected(a)) app_privacy_lock(a, PL_REASON_BATTERY, 0); break;
    case PM_ACT_LOW_BATTERY: app_flash(a, "Bateria baixa"); if (a->p.cam && a->p.cam->state(a->p.cam) != CAM_OFF) a->p.cam->stop(a->p.cam); break;
    case PM_ACT_DISPLAY_OFF:
        if (app_is_protected(a)) app_privacy_lock(a, PL_REASON_SLEEP, 0);
        a->asleep = true;
        break;
    default: break;
    }
}

/* ------------------------------ render ----------------------------- */

static void render_normal(app_t *a, fb_t *fb)
{
    layout_t L = app_layout(a);
    uint32_t now = app_now(a);
    fb_tiny(fb, 1, 0, a->set.angle_deg ? "D" : "R");
    if (a->shift) fb_tiny(fb, 7, 0, "S");
    if (a->alpha) fb_tiny(fb, 13, 0, "A");
    if (a->calc.mem != 0) fb_tiny(fb, 19, 0, "M");
    if (a->calc.show_fraction) fb_tiny(fb, 25, 0, "F");
    battery_reading_t b = {0};
    if (a->p.battery && a->p.battery(&b) && b.supported) {
        int x = fb->width - 16;
        fb_rect(fb, x, 0, 9, 5);
        fb_vline(fb, x + 9, 1, 3);
        int lvl = 7 * (b.percent > 100 ? 100 : b.percent) / 100;
        if (b.percent > 15 || (now / 500) % 2) fb_fill_rect(fb, x + 1, 1, lvl, 3, true);
    }
    if (a->pin_active && (!a->pin_busy || (now / 250) % 2)) fb_fill_rect(fb, fb->width - 3, 0, 3, 3, true); /* discreet indicator */
    calc_render(&a->calc, fb, 8, 24, L.scale, (now / 500) % 2 == 0);
}

void app_render(app_t *a, fb_t *fb)
{
    fb_clear(fb);
    if (a->asleep) return;
    view_t *top = app_top(a);
    if (top && !a->pin_active) top->render(top, a, fb);
    else render_normal(a, fb);
    if (a->flash[0] && app_now(a) < a->flash_until) {
        int w = (int)mt_text_cells(a->flash) * 6 + 4, x = (fb->width - w) / 2;
        if (x < 0) x = 0;
        fb_fill_rect(fb, x, 11, w, 10, false);
        fb_rect(fb, x, 11, w, 10);
        fb_text(fb, x + 2, 12, a->flash, NULL);
    }
    if (a->set.invert) fb_invert_rect(fb, 0, 0, fb->width, fb->height);
}
