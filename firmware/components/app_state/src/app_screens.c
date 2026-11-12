/* Concrete screens built on the generic views. */
#include <stdlib.h>

#include "ai_response.h"
#include "app_internal.h"
#include "conversions.h"
#include "favorites.h"
#include "formulas.h"
#include "security.h"
#include "solvers.h"

void app_begin_pin_setup(app_t *a, const char *pin, size_t len);

void screens_message(app_t *a, app_state_id_t st, const char *title, const char *text)
{
    reader_view_t *r = reader_new(st, app_is_protected(a));
    if (!r) return;
    doc_add(&r->doc, DOC_TITLE, title, NULL);
    doc_add(&r->doc, DOC_TEXT, text, NULL);
    app_push(a, &r->base);
}

/* ------------------------------ protected menu --------------------- */

static const char *const PM_ITEMS[] = {"Perguntar (texto)", "Camera", "Ferramentas", "Favoritos", "Historico", "Modo resposta", "Assistente", "Ajustes", "Bloquear"};
static int pm_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return 9; }
static void pm_label(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)a; (void)m; snprintf(b, l, "%s", PM_ITEMS[i]); }
static void pm_value(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)m; b[0] = 0; if (i == 5) snprintf(b, l, "%s", settings_mode_name(a->set.response_mode)); }
static bool pm_cycle(app_t *a, menu_view_t *m, int i, int dir)
{
    (void)m;
    if (i != 5) return false;
    a->set.response_mode = (uint8_t)((a->set.response_mode + (dir < 0 ? 2 : 1)) % 3);
    app_save_settings(a);
    return true;
}
static void pm_select(app_t *a, menu_view_t *m, int i)
{
    (void)m;
    switch (i) {
    case 0: case 1:
        if (!a->set.ai_notice_ack) { screens_privacy_notice(a, i); break; }
        if (i == 0) screens_open_question(a); else screens_open_camera(a);
        break;
    case 2: app_open_tools(a, true); break;
    case 3: screens_open_favorites(a); break;
    case 4: screens_open_history(a); break;
    case 6: screens_open_assistant(a); break;
    case 7: screens_open_settings(a); break;
    case 8: app_privacy_lock(a, PL_REASON_MENU, 0); break;
    default: break;
    }
}

/* ------------------------------ privacy notice / assistant --------- */

#define PRIVACY_TEXT "Perguntas e imagens enviadas a um provedor externo sao processadas por esse servico segundo as politicas dele. " \
                     "O terminal nao guarda senhas nem chaves de IA. Pressione = para concordar ou AC para voltar."

static void notice_enter(app_t *a, reader_view_t *r)
{
    int next = (int)r->arg;
    a->set.ai_notice_ack = true;
    app_save_settings(a);
    app_pop(a);
    if (next == 0) screens_open_question(a); else if (next == 1) screens_open_camera(a);
}

void screens_privacy_notice(app_t *a, int next)
{
    reader_view_t *r = reader_new(ST_AUTHENTICATED, true);
    if (!r) return;
    r->arg = next;
    r->on_enter = notice_enter;
    doc_add(&r->doc, DOC_TITLE, "Aviso de privacidade", NULL);
    doc_add(&r->doc, DOC_TEXT, PRIVACY_TEXT, NULL);
    app_push(a, &r->base);
}

static int as_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return 4; }
static void as_label(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)a; (void)m;
    static const char *const L[] = {"Provedor", "Atualizar lista", "Aviso de privacidade", "Status do servidor"};
    snprintf(b, l, "%s", L[i]);
}
static const char *provider_label(const app_t *a, const char *id)
{
    for (int i = 0; i < a->nproviders; i++) if (!strcmp(a->providers[i].id, id)) return a->providers[i].label;
    return strcmp(id, "auto") ? id : "AUTOMATICO";
}
static void as_value(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)m;
    b[0] = 0;
    if (i == 0) snprintf(b, l, "%s", provider_label(a, a->set.ai_provider));
}
static bool as_cycle(app_t *a, menu_view_t *m, int i, int dir)
{
    (void)m;
    if (i != 0) return false;
    if (a->nproviders == 0) { app_flash(a, "Atualize a lista"); return true; }
    int cur = 0;
    for (int k = 0; k < a->nproviders; k++) if (!strcmp(a->providers[k].id, a->set.ai_provider)) cur = k;
    cur = (cur + (dir < 0 ? a->nproviders - 1 : 1)) % a->nproviders;
    snprintf(a->set.ai_provider, sizeof(a->set.ai_provider), "%s", a->providers[cur].id);
    app_save_settings(a);
    return true;
}
static void as_select(app_t *a, menu_view_t *m, int i)
{
    switch (i) {
    case 0: as_cycle(a, m, 0, 1); break;
    case 1: case 3:
        if (!a->p.ai) { screens_message(a, ST_SETTINGS, "Assistente", "Cliente de IA nao configurado neste firmware."); return; }
        if (!ai_client_aux_start(a->p.ai, "GET", i == 1 ? "/api/v1/device/config" : "/api/v1/device/status", NULL)) { app_flash(a, "Aguarde"); return; }
        a->aux_job = i == 1 ? 1 : 3;
        if (a->p.wake_worker) a->p.wake_worker();
        app_flash(a, "Consultando...");
        break;
    case 2: screens_privacy_notice(a, -1); break;
    default: break;
    }
}

void screens_open_assistant(app_t *a)
{
    menu_view_t *m = menu_new(ST_SETTINGS, true, "Assistente");
    if (!m) return;
    m->count = as_count; m->label = as_label; m->value = as_value; m->cycle = as_cycle; m->select = as_select;
    app_push(a, &m->base);
}

/* Called from app_tick while an auxiliary request is pending. */
void screens_aux_tick(app_t *a)
{
    char *resp = NULL;
    size_t len = 0;
    int st = 0;
    if (!a->p.ai) { a->aux_job = 0; return; }
    ai_aux_state_t s = ai_client_aux_poll(a->p.ai, &resp, &len, &st);
    if (s == AI_AUX_PENDING || s == AI_AUX_IDLE) { free(resp); return; }
    uint8_t job = a->aux_job;
    a->aux_job = 0;
    if (s == AI_AUX_FAILED) {
        app_flash(a, job == 2 ? "Envio falhou" : st == 401 ? "Nao autorizado" : "Servidor indisponivel");
    } else if (job == 1) {
        cJSON *o = cJSON_ParseWithLength(resp, len);
        cJSON *arr = cJSON_GetObjectItem(o, "providers"), *it;
        a->nproviders = 0;
        cJSON_ArrayForEach(it, arr) {
            cJSON *id = cJSON_GetObjectItem(it, "id"), *lb = cJSON_GetObjectItem(it, "label");
            if (!cJSON_IsString(id) || a->nproviders >= 6) continue;
            snprintf(a->providers[a->nproviders].id, sizeof(a->providers[0].id), "%s", id->valuestring);
            snprintf(a->providers[a->nproviders].label, sizeof(a->providers[0].label), "%s", cJSON_IsString(lb) ? lb->valuestring : id->valuestring);
            a->nproviders++;
        }
        cJSON_Delete(o);
        app_flash(a, a->nproviders ? "Lista atualizada" : "Sem provedores");
    } else if (job == 2) app_flash(a, "Diagnostico enviado");
    else app_flash(a, "Servidor OK");
    free(resp);
}
static void pm_back(app_t *a, menu_view_t *m) { (void)m; app_privacy_lock(a, PL_REASON_MENU, 0); } /* leaving the root ends the session */

view_t *screens_protected_menu(app_t *a)
{
    (void)a;
    menu_view_t *m = menu_new(ST_AUTHENTICATED, true, "Menu");
    if (!m) return NULL;
    m->count = pm_count; m->label = pm_label; m->value = pm_value; m->cycle = pm_cycle; m->select = pm_select; m->back = pm_back;
    return &m->base;
}

/* ------------------------------ AI flow ---------------------------- */

static void question_submit(app_t *a, editor_view_t *e, const char *text)
{
    (void)e;
    while (*text == ' ') text++;
    if (!*text) return;
    char q[AI_MAX_QUESTION + 1];
    snprintf(q, sizeof(q), "%s", text);
    app_pop(a); /* editor (wipes its buffer) */
    if (!a->p.ai) { screens_message(a, ST_AI_RESPONSE, "Sem rede", "Cliente de IA nao configurado neste firmware."); sec_wipe(q, sizeof(q)); return; }
    if (a->p.wifi && a->p.wifi->state(a->p.wifi) != WIFI_ST_CONNECTED) {
        screens_message(a, ST_AI_RESPONSE, "Sem conexao", "Wi-Fi desconectado. Calculos offline continuam disponiveis. Configure em Ajustes > Wi-Fi.");
        sec_wipe(q, sizeof(q));
        return;
    }
    a->ai_mode = (resp_mode_t)a->set.response_mode;
    uint32_t g = ai_client_start_text(a->p.ai, q, a->ai_mode, a->session_id, a->set.ai_provider);
    snprintf(a->ai_question, sizeof(a->ai_question), "%.159s", q);
    sec_wipe(q, sizeof(q));
    if (!g) { screens_message(a, ST_AI_RESPONSE, "Ocupado", "Aguarde a requisicao anterior terminar."); return; }
    a->ai_gen = g;
    if (a->p.wake_worker) a->p.wake_worker();
    app_push(a, &busy_new(0, g)->base);
}

void screens_open_question(app_t *a)
{
    editor_view_t *e = editor_new(ST_TEXT_ENTRY, true, "Pergunta", question_submit);
    if (!e) return;
    e->method = a->set.text_method;
    e->mt.timeout_ms = a->set.multitap_ms;
    app_push(a, &e->base);
}

static void resp_fav(app_t *a, reader_view_t *r)
{
    char *t = reader_plain_text(r);
    if (t && fav_add(&a->vault, FAV_RESOLUTION, r->extra[0] ? r->extra : "Resposta", t) == 0) app_flash(a, "Favorito salvo");
    if (t) { sec_wipe(t, strlen(t)); free(t); }
}

void screens_ai_result(app_t *a, busy_view_t *b)
{
    ai_result_t res;
    if (!a->p.ai || !ai_client_poll(a->p.ai, b->gen, &res)) return;
    if (!a->session || strcmp(res.session_id, a->session_id) != 0) { ai_client_free_result(&res); return; } /* other session: never shown */
    app_pop(a); /* busy view */
    reader_view_t *r = reader_new(ST_AI_RESPONSE, true);
    if (!r) { ai_client_free_result(&res); return; }
    snprintf(r->extra, sizeof(r->extra), "%.40s", a->ai_question);
    if (res.kind != AI_RESULT_OK) {
        char msg[160];
        if (res.kind == AI_RESULT_TRANSPORT_ERROR) snprintf(msg, sizeof(msg), "Falha de rede ou TLS (servidor local e remoto).");
        else {
            /* mt1 errors: {"error":{"code","message"}} */
            cJSON *o = res.body ? cJSON_ParseWithLength(res.body, res.body_len) : NULL;
            cJSON *er = cJSON_GetObjectItem(o, "error");
            cJSON *em = cJSON_GetObjectItem(er, "message"), *ec = cJSON_GetObjectItem(er, "code");
            if (cJSON_IsString(em)) snprintf(msg, sizeof(msg), "%.100s (%.24s, HTTP %d)", em->valuestring, cJSON_IsString(ec) ? ec->valuestring : "-", res.http_status);
            else if (res.http_status == 504) snprintf(msg, sizeof(msg), "Tempo de espera esgotado; a requisicao pode ser cancelada.");
            else snprintf(msg, sizeof(msg), "Servidor respondeu HTTP %d.", res.http_status);
            cJSON_Delete(o);
        }
        doc_add(&r->doc, DOC_TITLE, "Falha na consulta", NULL);
        doc_add(&r->doc, DOC_TEXT, msg, NULL);
        doc_add(&r->doc, DOC_TEXT, res.was_sent ? "O servidor pode ter recebido a solicitacao." : "A solicitacao nao foi enviada.", NULL);
    } else {
        air_t air;
        if (!air_parse(&air, res.body, res.body_len)) {
            doc_add(&r->doc, DOC_TITLE, "Resposta invalida", NULL);
            doc_add(&r->doc, DOC_TEXT, air.error, NULL);
        } else {
            air_to_doc(&air, a->ai_mode, a->ai_question, &r->doc);
            if (a->set.ai_history && air.status == AIR_STATUS_OK && a->vault.open)
                history_add(&a->vault, r->extra, a->ai_question, res.body, a->ai_mode);
            air_free(&air);
            r->on_fav = resp_fav;
        }
    }
    ai_client_free_result(&res);
    app_push(a, &r->base);
}

/* ------------------------------ camera ----------------------------- */

typedef struct {
    view_t base;
    cam_res_t res;
    bool started;
    cam_image_t img;
    char code[9];
} camera_view_t;

/* Set by the phone preview (HTTP server task); global so a late callback never touches freed view memory. */
static volatile bool s_remote_capture;

static void cam_send(app_t *a, camera_view_t *c)
{
    cam_image_t img = c->img;
    memset(&c->img, 0, sizeof(c->img));
    app_pop(a); /* camera off before the network transfer */
    if (!a->p.ai || (a->p.wifi && a->p.wifi->state(a->p.wifi) != WIFI_ST_CONNECTED)) {
        cam_image_free(&img);
        screens_message(a, ST_AI_RESPONSE, "Sem conexao", "Wi-Fi desconectado.");
        return;
    }
    a->ai_mode = (resp_mode_t)a->set.response_mode;
    snprintf(a->ai_question, sizeof(a->ai_question), "(imagem da camera)");
    uint32_t g = ai_client_start_image(a->p.ai, img.data, img.len, "Analise o conteudo matematico da imagem.", a->ai_mode, a->session_id,
                                       a->set.ai_provider);
    if (!g) { screens_message(a, ST_AI_RESPONSE, "Ocupado", "Aguarde a requisicao anterior terminar."); return; }
    a->ai_gen = g;
    if (a->p.wake_worker) a->p.wake_worker();
    app_push(a, &busy_new(0, g)->base);
}

#ifdef ESP_PLATFORM
static void preview_capture_cb(void *ctx) { (void)ctx; s_remote_capture = true; /* handled in cam_tick (UI task) */ }
#endif

static bool cam_key(view_t *v, app_t *a, keycode_t k, bool shift)
{
    (void)shift;
    camera_view_t *c = (camera_view_t *)v;
    camera_hal_t *h = a->p.cam;
    cam_state_t st = h->state(h);
    if (st == CAM_CAPTURED && !c->img.data) h->take_image(h, &c->img);
    if (c->img.data) st = CAM_CAPTURED; /* a held photo takes precedence over the sensor state */
    if (k == KEY_AC) { app_pop(a); return true; }
    if (st == CAM_ERROR && k == KEY_EQ) { h->start(h, c->res, a->set.jpeg_quality); return true; }
    if (st == CAM_READY) {
        if (k == KEY_LEFT || k == KEY_RIGHT) {
            int r = (int)c->res + (k == KEY_LEFT ? -1 : 1);
            if (r >= 0 && r < CAM_RES_COUNT) { c->res = (cam_res_t)r; a->set.resolution = (uint8_t)r; app_save_settings(a); h->start(h, c->res, a->set.jpeg_quality); }
            return true;
        }
        if (k == KEY_UP || k == KEY_DOWN) {
            int q = a->set.jpeg_quality + (k == KEY_UP ? -2 : 2);
            a->set.jpeg_quality = (uint8_t)(q < 4 ? 4 : q > 63 ? 63 : q);
            app_save_settings(a);
            return true;
        }
        if (k == KEY_EQ) { h->capture(h); return true; }
#ifdef ESP_PLATFORM
        if (k == KEY_MODE) {
            if (camera_preview_active()) camera_preview_stop();
            else camera_preview_start(h, c->code, preview_capture_cb, c);
            return true;
        }
#endif
    }
    if (st == CAM_CAPTURED) {
        if (k == KEY_DEL) { cam_image_free(&c->img); h->start(h, c->res, a->set.jpeg_quality); return true; }
        if (k == KEY_EQ && c->img.data) { cam_send(a, c); return true; }
    }
    return true;
}

static void cam_render(view_t *v, app_t *a, fb_t *fb)
{
    camera_view_t *c = (camera_view_t *)v;
    camera_hal_t *h = a->p.cam;
    char l[3][40];
    memset(l, 0, sizeof(l));
    uint16_t w, hh;
    cam_state_t st = h->state(h);
    if (st == CAM_CAPTURED && !c->img.data) h->take_image(h, &c->img);
    if (c->img.data) st = CAM_CAPTURED;
    switch (st) {
    case CAM_OFF: case CAM_STARTING: snprintf(l[0], 40, "Camera: iniciando..."); break;
    case CAM_READY:
        cam_res_size(c->res, &w, &hh);
        snprintf(l[0], 40, "Camera pronta");
        snprintf(l[1], 40, "%s %ux%u Q%u", cam_res_name(c->res), w, hh, a->set.jpeg_quality);
#ifdef ESP_PLATFORM
        if (camera_preview_active()) snprintf(l[2], 40, "Previa %s", c->code); else
#endif
        snprintf(l[2], 40, "= capturar");
        break;
    case CAM_CAPTURING: snprintf(l[0], 40, "Capturando..."); break;
    case CAM_CAPTURED:
        snprintf(l[0], 40, "Foto: %u KB", (unsigned)(c->img.len / 1024));
        snprintf(l[1], 40, "%ux%u", c->img.width, c->img.height);
        snprintf(l[2], 40, "= enviar DEL refazer");
        break;
    case CAM_ERROR:
        snprintf(l[0], 40, "Erro da camera:");
        snprintf(l[1], 40, "%.20s", h->error(h));
        snprintf(l[2], 40, "= tentar AC sair");
        break;
    }
    for (int i = 0; i < 3; i++) if (l[i][0]) fb_text(fb, 2, i * 8, l[i], NULL);
    fb_tiny(fb, 2, 26, "AC SAI");
}

static void cam_tick(view_t *v, app_t *a)
{
    camera_view_t *c = (camera_view_t *)v;
    if (s_remote_capture) {
        s_remote_capture = false;
        if (a->p.cam->state(a->p.cam) == CAM_READY && !c->img.data) a->p.cam->capture(a->p.cam);
    }
}

static void cam_dispose(view_t *v)
{
    camera_view_t *c = (camera_view_t *)v;
    cam_image_free(&c->img);
#ifdef ESP_PLATFORM
    camera_preview_stop();
#endif
    free(c);
}

static void cam_pop_hook(app_t *a) { if (a->p.cam) a->p.cam->stop(a->p.cam); }

static bool cam_key_wrap(view_t *v, app_t *a, keycode_t k, bool shift)
{
    if (k == KEY_AC) { cam_pop_hook(a); app_pop(a); return true; }
    return cam_key(v, a, k, shift);
}

void screens_open_camera(app_t *a)
{
    if (!a->p.cam) { screens_message(a, ST_CAMERA, "Camera", "Camera nao disponivel neste hardware/firmware."); return; }
    camera_view_t *c = calloc(1, sizeof(*c));
    if (!c) return;
    c->base = (view_t){ST_CAMERA, true, cam_key_wrap, cam_render, cam_tick, cam_dispose};
    c->res = (cam_res_t)(a->set.resolution < CAM_RES_COUNT ? a->set.resolution : CAM_RES_SVGA);
    app_push(a, &c->base);
    a->p.cam->start(a->p.cam, c->res, a->set.jpeg_quality);
}

/* ------------------------------ tools ------------------------------ */

static void line_to_doc(int kind, const char *text, void *u)
{
    doc_add((doc_t *)u, kind == 1 ? DOC_TITLE : kind == 2 ? DOC_MATH : DOC_TEXT, text, NULL);
}

static void step_to_doc(const char *rule, const char *expr, void *u)
{
    doc_add((doc_t *)u, DOC_MATH, expr, rule);
}

void screens_open_steps(app_t *a, const char *expr, bool prot)
{
    reader_view_t *r = reader_new(ST_MATH_TOOLS, prot || app_is_protected(a));
    if (!r) return;
    me_var_t vars[10] = {{"Ans", a->calc.ans}};
    static const char *const VN[9] = {"A", "B", "C", "D", "E", "F", "X", "Y", "M"};
    for (int i = 0; i < 9; i++) vars[i + 1] = (me_var_t){VN[i], a->calc.vars[i]};
    me_ctx_t ctx = {.angle = (me_angle_t)a->set.angle_deg, .vars = vars, .nvars = 10};
    double v;
    bool tr = false;
    doc_add(&r->doc, DOC_TITLE, "Resolucao (local)", NULL);
    me_err_t e = me_solve_steps(expr, &ctx, step_to_doc, &r->doc, &v, &tr);
    if (e != ME_OK) { doc_add(&r->doc, DOC_TITLE, "Erro", NULL); doc_add(&r->doc, DOC_TEXT, me_err_text(e), NULL); }
    else {
        char s[48];
        long n, d;
        doc_add(&r->doc, DOC_TITLE, "Resultado", NULL);
        me_format(v, 10, s, sizeof(s));
        doc_add(&r->doc, DOC_MATH, s, NULL);
        if (me_to_fraction(v, 9999, &n, &d) && d != 1) { snprintf(s, sizeof(s), "= %ld/%ld", n, d); doc_add(&r->doc, DOC_MATH, s, NULL); }
        if (tr) doc_add(&r->doc, DOC_TEXT, "Limite de etapas atingido.", NULL);
    }
    app_push(a, &r->base);
}

static reader_view_t *tool_reader(app_t *a, form_view_t *f)
{
    reader_view_t *r = reader_new(ST_MATH_TOOLS, f->base.prot);
    (void)a;
    return r;
}

static void steps_submit(app_t *a, form_view_t *f) { screens_open_steps(a, f->f[0].text, f->base.prot); }

static void linear_submit(app_t *a, form_view_t *f)
{
    double x[2], r0;
    for (int i = 0; i < 2; i++) if (!form_num(f, i, &x[i])) return;
    reader_view_t *r = tool_reader(a, f);
    if (!r) return;
    solve_linear(x[0], x[1], line_to_doc, &r->doc, &r0);
    app_push(a, &r->base);
}

static void quad_submit(app_t *a, form_view_t *f)
{
    double x[3];
    for (int i = 0; i < 3; i++) if (!form_num(f, i, &x[i])) return;
    reader_view_t *r = tool_reader(a, f);
    if (!r) return;
    solve_quadratic(x[0], x[1], x[2], line_to_doc, &r->doc);
    app_push(a, &r->base);
}

static void system_submit(app_t *a, form_view_t *f)
{
    int n = (int)f->arg;
    double A[16], b[4], x[4], v;
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) { if (!form_num(f, i * (n + 1) + j, &v)) return; A[i * n + j] = v; }
        if (!form_num(f, i * (n + 1) + n, &v)) return;
        b[i] = v;
    }
    reader_view_t *r = tool_reader(a, f);
    if (!r) return;
    solve_linear_system(n, A, b, x, line_to_doc, &r->doc);
    app_push(a, &r->base);
}

static void stats_submit(app_t *a, form_view_t *f)
{
    double d[100];
    int n = 0;
    char buf[96];
    snprintf(buf, sizeof(buf), "%s", f->f[0].text);
    for (char *tok = strtok(buf, ",;"); tok && n < 100; tok = strtok(NULL, ",;")) {
        me_ctx_t ctx = {.angle = ME_ANGLE_RAD, .vars = NULL, .nvars = 0};
        if (me_eval(tok, &ctx, &d[n]) != ME_OK) { snprintf(f->error, sizeof(f->error), "valor invalido"); return; }
        n++;
    }
    if (!n) { snprintf(f->error, sizeof(f->error), "sem dados"); return; }
    reader_view_t *r = tool_reader(a, f);
    if (!r) return;
    stats_t st;
    stats_compute(d, n, &st, line_to_doc, &r->doc);
    app_push(a, &r->base);
}

/* conversions */
static void conv_submit(app_t *a, form_view_t *f)
{
    const conv_category_t *c = &conv_categories[f->arg];
    double v, out;
    if (!form_num(f, 0, &v)) return;
    const char *from = c->units[f->f[1].idx].sym, *to = c->units[f->f[2].idx].sym;
    conv_err_t e = conv_convert(c->id, from, to, v, &out);
    if (e != CONV_OK) { snprintf(f->error, sizeof(f->error), e == CONV_ERR_ABS_ZERO ? "abaixo do zero absoluto" : "conversao invalida"); return; }
    reader_view_t *r = tool_reader(a, f);
    if (!r) return;
    char s1[40], s2[40], line[120];
    me_format(v, 10, s1, sizeof(s1));
    me_format(out, 10, s2, sizeof(s2));
    doc_add(&r->doc, DOC_TITLE, c->name, NULL);
    snprintf(line, sizeof(line), "%s %s = %s %s", s1, from, s2, to);
    doc_add(&r->doc, DOC_MATH, line, NULL);
    if (!c->affine) {
        me_format(c->units[f->f[1].idx].factor, 10, s1, sizeof(s1));
        snprintf(line, sizeof(line), "1 %s = %s %s", from, s1, c->base);
        doc_add(&r->doc, DOC_MATH, line, NULL);
        me_format(c->units[f->f[2].idx].factor, 10, s1, sizeof(s1));
        snprintf(line, sizeof(line), "1 %s = %s %s", to, s1, c->base);
        doc_add(&r->doc, DOC_MATH, line, NULL);
    } else doc_add(&r->doc, DOC_TEXT, "Conversao via kelvin (afim).", NULL);
    app_push(a, &r->base);
}

static int conv_cat_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return (int)conv_category_count; }
static void conv_cat_label(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)a; (void)m; snprintf(b, l, "%s", conv_categories[i].name); }
static void conv_cat_select(app_t *a, menu_view_t *m, int i)
{
    const conv_category_t *c = &conv_categories[i];
    form_view_t *f = form_new(ST_MATH_TOOLS, m->base.prot, c->name, conv_submit);
    if (!f) return;
    f->arg = i;
    f->step_through = false;
    form_add(f, "valor", FLD_NUM);
    /* option labels: unit symbols (static strings in the generated table) */
    static const char *opts[CONV_MAX_CATEGORIES][CONV_CATS_MAX_UNITS];
    for (size_t k = 0; k < c->nunits && k < CONV_CATS_MAX_UNITS; k++) opts[i][k] = c->units[k].sym;
    field_t *a1 = form_add(f, "de", FLD_CHOICE), *a2 = form_add(f, "para", FLD_CHOICE);
    a1->opts = a2->opts = opts[i];
    a1->nopts = a2->nopts = (uint8_t)c->nunits;
    a2->idx = c->nunits > 1 ? 1 : 0;
    app_push(a, &f->base);
}

/* formulas */
typedef struct { const formula_t *list[64]; int n; } flist_t;
static flist_t s_flist;

static void formula_apply_submit(app_t *a, form_view_t *f)
{
    const formula_t *fm = (const formula_t *)f->arg;
    double vals[8];
    for (size_t i = 0; i < fm->nvars && i < 8; i++) if (!form_num(f, (int)i, &vals[i])) return;
    reader_view_t *r = tool_reader(a, f);
    if (!r) return;
    double res;
    char line[160], s[40];
    doc_add(&r->doc, DOC_TITLE, fm->name, NULL);
    doc_add(&r->doc, DOC_MATH, fm->formula, NULL);
    doc_add(&r->doc, DOC_TEXT, "Dados:", NULL);
    for (size_t i = 0; i < fm->nvars && i < 8; i++) {
        me_format(vals[i], 10, s, sizeof(s));
        snprintf(line, sizeof(line), "%s = %s %s (%s)", fm->vars[i].sym, s, strcmp(fm->vars[i].unit, "-") ? fm->vars[i].unit : "", fm->vars[i].meaning);
        doc_add(&r->doc, DOC_MATH, line, NULL);
    }
    doc_add(&r->doc, DOC_TEXT, "Resolucao:", NULL);
    me_err_t e = formula_apply_steps(fm, vals, step_to_doc, &r->doc, &res);
    if (e == ME_OK) { me_format(res, 10, s, sizeof(s)); snprintf(line, sizeof(line), "%s = %s %s", fm->out, s, fm->units); doc_add(&r->doc, DOC_MATH, line, NULL); }
    else doc_add(&r->doc, DOC_TEXT, me_err_text(e), NULL);
    app_push(a, &r->base);
}

static void formula_enter(app_t *a, reader_view_t *r)
{
    const formula_t *fm = (const formula_t *)r->arg;
    form_view_t *f = form_new(ST_MATH_TOOLS, r->base.prot, fm->name, formula_apply_submit);
    if (!f) return;
    f->arg = (intptr_t)fm;
    for (size_t i = 0; i < fm->nvars && i < 8; i++) form_add(f, fm->vars[i].sym, FLD_NUM);
    app_push(a, &f->base);
}

static void formula_fav(app_t *a, reader_view_t *r)
{
    const formula_t *fm = (const formula_t *)r->arg;
    fav_formula_toggle(a->p.kv, fm->id);
    app_flash(a, fav_formula_is(a->p.kv, fm->id) ? "Favorita" : "Removida");
}

static void open_formula(app_t *a, const formula_t *fm, bool prot)
{
    reader_view_t *r = reader_new(ST_MATH_TOOLS, prot);
    if (!r) return;
    char line[200];
    r->arg = (intptr_t)fm;
    doc_add(&r->doc, DOC_TITLE, fm->name, NULL);
    doc_add(&r->doc, DOC_MATH, fm->formula, NULL);
    doc_add(&r->doc, DOC_TEXT, "Variaveis:", NULL);
    for (size_t i = 0; i < fm->nvars; i++) {
        snprintf(line, sizeof(line), "%s: %s%s%s%s", fm->vars[i].sym, fm->vars[i].meaning, strcmp(fm->vars[i].unit, "-") ? " [" : "",
                 strcmp(fm->vars[i].unit, "-") ? fm->vars[i].unit : "", strcmp(fm->vars[i].unit, "-") ? "]" : "");
        doc_add(&r->doc, DOC_TEXT, line, NULL);
    }
    snprintf(line, sizeof(line), "Unidades: %s", fm->units);
    doc_add(&r->doc, DOC_TEXT, line, NULL);
    doc_add(&r->doc, DOC_TEXT, "= aplicar  M+ favorita", NULL);
    r->on_enter = formula_enter;
    r->on_fav = formula_fav;
    app_push(a, &r->base);
}

static int fl_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return s_flist.n; }
static void fl_label(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)m; snprintf(b, l, "%s%s", fav_formula_is(a->p.kv, s_flist.list[i]->id) ? "*" : "", s_flist.list[i]->name); }
static void fl_select(app_t *a, menu_view_t *m, int i) { open_formula(a, s_flist.list[i], m->base.prot); }
static void fl_fav(app_t *a, menu_view_t *m, int i) { (void)m; fav_formula_toggle(a->p.kv, s_flist.list[i]->id); }

static int fc_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return (int)formula_category_count + 1; }
static void fc_label(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)a; (void)m; snprintf(b, l, "%s", i == 0 ? "Favoritas" : formula_categories[i - 1].name); }
static void fc_select(app_t *a, menu_view_t *m, int i)
{
    if (i == 0) {
        char ids[32][16];
        int n = fav_formula_list(a->p.kv, ids, 32);
        s_flist.n = 0;
        for (int k = 0; k < n; k++) { const formula_t *f = formula_get(ids[k]); if (f) s_flist.list[s_flist.n++] = f; }
    } else s_flist.n = (int)formula_by_category(formula_categories[i - 1].id, s_flist.list, 64);
    menu_view_t *l = menu_new(ST_MATH_TOOLS, m->base.prot, i == 0 ? "Favoritas" : formula_categories[i - 1].name);
    if (!l) return;
    l->count = fl_count; l->label = fl_label; l->select = fl_select; l->fav = fl_fav;
    app_push(a, &l->base);
}

/* tools menu */
static const char *const TOOLS[] = {"Resolver expressao", "Equacao 1o grau", "Equacao 2o grau", "Sistema 2x2", "Sistema 3x3", "Estatistica", "Formulas", "Conversoes"};
static int tools_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return 8; }
static void tools_label(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)a; (void)m; snprintf(b, l, "%s", TOOLS[i]); }
static void tools_select(app_t *a, menu_view_t *m, int i)
{
    bool prot = m->base.prot;
    form_view_t *f = NULL;
    static const char *const XYZ[] = {"x", "y", "z"};
    static char labels[3][4][16];
    switch (i) {
    case 0:
        f = form_new(ST_MATH_TOOLS, prot, "Expressao", steps_submit);
        if (f) { field_t *fl = form_add(f, "f", FLD_EXPR); calc_expr(&a->calc, fl->text, sizeof(fl->text)); }
        break;
    case 1:
        f = form_new(ST_MATH_TOOLS, prot, "ax+b=0", linear_submit);
        if (f) { form_add(f, "a", FLD_NUM); form_add(f, "b", FLD_NUM); }
        break;
    case 2:
        f = form_new(ST_MATH_TOOLS, prot, "ax2+bx+c=0", quad_submit);
        if (f) { form_add(f, "a", FLD_NUM); form_add(f, "b", FLD_NUM); form_add(f, "c", FLD_NUM); }
        break;
    case 3: case 4: {
        int n = i == 3 ? 2 : 3;
        f = form_new(ST_MATH_TOOLS, prot, n == 2 ? "Sistema 2x2" : "Sistema 3x3", system_submit);
        if (!f) break;
        f->arg = n;
        for (int r = 0; r < n; r++) {
            for (int c = 0; c <= n; c++) {
                snprintf(labels[r][c], sizeof(labels[r][c]), "L%d %s", r + 1, c < n ? XYZ[c] : "=");
                form_add(f, labels[r][c], FLD_NUM);
            }
        }
        break;
    }
    case 5:
        f = form_new(ST_MATH_TOOLS, prot, "Dados (virgula)", stats_submit);
        if (f) form_add(f, "x", FLD_LIST);
        break;
    case 6: {
        menu_view_t *fm = menu_new(ST_MATH_TOOLS, prot, "Formulas");
        if (!fm) return;
        fm->count = fc_count; fm->label = fc_label; fm->select = fc_select;
        app_push(a, &fm->base);
        return;
    }
    case 7: {
        menu_view_t *cm = menu_new(ST_MATH_TOOLS, prot, "Conversoes");
        if (!cm) return;
        cm->count = conv_cat_count; cm->label = conv_cat_label; cm->select = conv_cat_select;
        app_push(a, &cm->base);
        return;
    }
    }
    if (f) app_push(a, &f->base);
}

void app_open_tools(app_t *a, bool prot)
{
    menu_view_t *m = menu_new(ST_MATH_TOOLS, prot, "Ferramentas");
    if (!m) return;
    m->count = tools_count; m->label = tools_label; m->select = tools_select;
    app_push(a, &m->base);
}

/* ------------------------------ history / favorites ---------------- */

static int hist_count(app_t *a, menu_view_t *m) { (void)m; int n = history_count(&a->vault); return n ? n + 1 : 0; }
static void hist_label(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)m;
    if (i == history_count(&a->vault)) { snprintf(b, l, "Apagar tudo"); return; }
    cJSON *t = cJSON_GetObjectItem(history_get(&a->vault, i), "t");
    snprintf(b, l, "%s", cJSON_IsString(t) ? t->valuestring : "?");
}
static void hist_select(app_t *a, menu_view_t *m, int i)
{
    (void)m;
    if (i == history_count(&a->vault)) { history_clear(&a->vault); return; }
    cJSON *h = history_get(&a->vault, i);
    cJSON *q = cJSON_GetObjectItem(h, "q"), *r = cJSON_GetObjectItem(h, "r"), *md = cJSON_GetObjectItem(h, "m");
    reader_view_t *rv = reader_new(ST_AI_RESPONSE, true);
    if (!rv || !cJSON_IsString(r)) { if (rv) rv->base.dispose(&rv->base); return; }
    air_t air;
    if (air_parse(&air, r->valuestring, strlen(r->valuestring))) {
        air_to_doc(&air, cJSON_IsNumber(md) ? (resp_mode_t)md->valueint : RESP_SHORT, cJSON_IsString(q) ? q->valuestring : "", &rv->doc);
        air_free(&air);
    }
    rv->on_fav = resp_fav;
    app_push(a, &rv->base);
}
static void hist_del(app_t *a, menu_view_t *m, int i) { (void)m; if (i < history_count(&a->vault)) history_delete(&a->vault, i); }

void screens_open_history(app_t *a)
{
    menu_view_t *m = menu_new(ST_AUTHENTICATED, true, "Historico");
    if (!m) return;
    m->count = hist_count; m->label = hist_label; m->select = hist_select; m->del = hist_del;
    app_push(a, &m->base);
}

static int fav_count_cb(app_t *a, menu_view_t *m) { (void)m; return fav_count(&a->vault); }
static void fav_label_cb(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)m;
    cJSON *f = fav_get(&a->vault, i), *t = cJSON_GetObjectItem(f, "t"), *y = cJSON_GetObjectItem(f, "y");
    static const char *const P[] = {"R ", "P ", "V "};
    snprintf(b, l, "%s%s", P[cJSON_IsNumber(y) && y->valueint >= 0 && y->valueint < 3 ? y->valueint : 0], cJSON_IsString(t) ? t->valuestring : "?");
}
static void fav_select_cb(app_t *a, menu_view_t *m, int i)
{
    (void)m;
    cJSON *f = fav_get(&a->vault, i), *c = cJSON_GetObjectItem(f, "c"), *t = cJSON_GetObjectItem(f, "t");
    reader_view_t *r = reader_new(ST_AI_RESPONSE, true);
    if (!r) return;
    doc_add(&r->doc, DOC_TITLE, cJSON_IsString(t) ? t->valuestring : "", NULL);
    if (cJSON_IsString(c)) {
        char *copy = strdup(c->valuestring);
        for (char *line = copy ? strtok(copy, "\n") : NULL; line; line = strtok(NULL, "\n")) doc_add(&r->doc, DOC_TEXT, line, NULL);
        if (copy) { sec_wipe(copy, strlen(c->valuestring)); free(copy); }
    }
    app_push(a, &r->base);
}
static void fav_del_cb(app_t *a, menu_view_t *m, int i) { (void)m; fav_delete(&a->vault, i); }

void screens_open_favorites(app_t *a)
{
    menu_view_t *m = menu_new(ST_AUTHENTICATED, true, "Favoritos");
    if (!m) return;
    m->count = fav_count_cb; m->label = fav_label_cb; m->select = fav_select_cb; m->del = fav_del_cb;
    app_push(a, &m->base);
}

/* ------------------------------ PIN setup / change ----------------- */

static void pin_setup_submit(app_t *a, form_view_t *f)
{
    if (strcmp(f->f[0].text, f->f[1].text) != 0) { snprintf(f->error, sizeof(f->error), "PINs diferentes"); return; }
    size_t n = strlen(f->f[0].text);
    if (!auth_valid_format(&a->auth, f->f[0].text, n)) { snprintf(f->error, sizeof(f->error), "Use 6 a 8 digitos"); return; }
    app_begin_pin_setup(a, f->f[0].text, n);
    sec_wipe(f->f, sizeof(f->f));
}

void screens_open_pin_setup(app_t *a)
{
    form_view_t *f = form_new(ST_SETTINGS, true, "Criar PIN 6-8", pin_setup_submit);
    if (!f) return;
    form_add(f, "PIN", FLD_PIN);
    form_add(f, "Repita", FLD_PIN);
    app_push(a, &f->base);
}

static void pin_change_submit(app_t *a, form_view_t *f)
{
    if (strcmp(f->f[1].text, f->f[2].text) != 0) { snprintf(f->error, sizeof(f->error), "PINs diferentes"); return; }
    size_t n = strlen(f->f[1].text);
    if (!auth_valid_format(&a->auth, f->f[1].text, n)) { snprintf(f->error, sizeof(f->error), "Use 6 a 8 digitos"); return; }
    uint8_t key[AUTH_KEY_LEN];
    /* runs in the UI task: PIN change is rare and explicitly requested; ON still works afterwards */
    auth_result_t r = auth_verify(&a->auth, f->f[0].text, strlen(f->f[0].text), key, app_now(a) / 1000);
    if (r != AUTH_OK) { sec_wipe(f->f, sizeof(f->f)); snprintf(f->error, sizeof(f->error), "PIN atual incorreto"); return; }
    sec_wipe(key, sizeof(key));
    r = auth_set_pin(&a->auth, f->f[1].text, n, key);
    sec_wipe(f->f, sizeof(f->f));
    if (r == AUTH_OK) { vault_rekey(&a->vault, key); app_flash(a, "PIN alterado"); }
    sec_wipe(key, sizeof(key));
    app_pop(a);
}

/* ------------------------------ Wi-Fi ------------------------------ */

static int wifi_count(app_t *a, menu_view_t *m)
{
    (void)m;
    char s[WIFI_MAX_SAVED][33];
    return 3 + (a->p.wifi ? a->p.wifi->saved(a->p.wifi, s, WIFI_MAX_SAVED) : 0);
}
static void wifi_label(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)m;
    static const char *const F[] = {"Estado", "Conectar", "Adicionar rede"};
    if (i < 3) { snprintf(b, l, "%s", F[i]); return; }
    char s[WIFI_MAX_SAVED][33];
    int n = a->p.wifi->saved(a->p.wifi, s, WIFI_MAX_SAVED);
    snprintf(b, l, "Rede: %s", i - 3 < n ? s[i - 3] : "?");
}
static void wifi_value(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)m;
    b[0] = 0;
    if (i == 0) {
        wifi_state_t st = a->p.wifi->state(a->p.wifi);
        snprintf(b, l, "%s", st == WIFI_ST_CONNECTED ? a->p.wifi->ssid(a->p.wifi) : st == WIFI_ST_CONNECTING ? "..." : st == WIFI_ST_FAILED ? "falha" : "off");
    } else if (i >= 3) snprintf(b, l, "DEL");
}
static void wifi_pass_submit(app_t *a, editor_view_t *e, const char *pass)
{
    a->p.wifi->add(a->p.wifi, e->ctx, pass);
    a->p.wifi->connect(a->p.wifi);
    app_pop(a);
}
static void wifi_ssid_submit(app_t *a, editor_view_t *e, const char *ssid)
{
    (void)e;
    char s[33];
    snprintf(s, sizeof(s), "%s", ssid);
    app_pop(a);
    editor_view_t *p = editor_new(ST_TEXT_ENTRY, true, "Senha", wifi_pass_submit);
    if (!p) return;
    p->masked = true;
    p->method = a->set.text_method;
    snprintf(p->ctx, sizeof(p->ctx), "%s", s);
    app_push(a, &p->base);
}
static void wifi_select(app_t *a, menu_view_t *m, int i)
{
    (void)m;
    if (i == 1) a->p.wifi->connect(a->p.wifi);
    if (i == 2) {
        editor_view_t *e = editor_new(ST_TEXT_ENTRY, true, "SSID", wifi_ssid_submit);
        if (e) { e->method = a->set.text_method; app_push(a, &e->base); }
    }
}
static void wifi_del(app_t *a, menu_view_t *m, int i)
{
    (void)m;
    if (i < 3) return;
    char s[WIFI_MAX_SAVED][33];
    int n = a->p.wifi->saved(a->p.wifi, s, WIFI_MAX_SAVED);
    if (i - 3 < n) a->p.wifi->remove(a->p.wifi, s[i - 3]);
}

/* ------------------------------ settings --------------------------- */

enum { S_MODE, S_METHOD, S_LARGE, S_SIMPLE, S_SCROLL, S_REPEAT, S_INVERT, S_MULTITAP, S_AUTOLOCK, S_SLEEP, S_AIHIST, S_CALCHIST,
       S_CLEARHIST, S_COMBO, S_PIN, S_WIFI, S_CANCELS, S_DIAG, S_OTA, S_COUNT };
static const char *const SET_LABELS[S_COUNT] = {
    "Modo resposta", "Metodo texto", "Fonte grande", "Menus simples", "Rolagem (linhas)", "Repeticao teclas", "Inverter cores",
    "Multi-tap (ms)", "Bloqueio auto (s)", "Suspensao (s)", "Historico IA", "Historico calc.", "Apagar historico", "Combinacao acesso",
    "Alterar PIN", "Wi-Fi", "Req. canceladas", "Diagnostico", "Atualizacao (OTA)",
};

static int set_count(app_t *a, menu_view_t *m) { (void)a; (void)m; return S_COUNT; }
static void set_label(app_t *a, menu_view_t *m, int i, char *b, size_t l) { (void)a; (void)m; snprintf(b, l, "%s", SET_LABELS[i]); }
static void set_value(app_t *a, menu_view_t *m, int i, char *b, size_t l)
{
    (void)m;
    static const char *const REP[] = {"off", "lenta", "normal", "rapida"};
    static const char *const CMB[] = {"SSAA", "ASAS", "AASS"};
    settings_t *s = &a->set;
    b[0] = 0;
    switch (i) {
    case S_MODE: snprintf(b, l, "%s", settings_mode_name(s->response_mode)); break;
    case S_METHOD: snprintf(b, l, "%c", s->text_method); break;
    case S_LARGE: snprintf(b, l, "%s", s->large_font ? "sim" : "nao"); break;
    case S_SIMPLE: snprintf(b, l, "%s", s->simple_menus ? "sim" : "nao"); break;
    case S_SCROLL: snprintf(b, l, "%u", s->scroll_step); break;
    case S_REPEAT: snprintf(b, l, "%s", REP[s->key_repeat & 3]); break;
    case S_INVERT: snprintf(b, l, "%s", s->invert ? "sim" : "nao"); break;
    case S_MULTITAP: snprintf(b, l, "%u", s->multitap_ms); break;
    case S_AUTOLOCK: snprintf(b, l, "%u", s->auto_lock_s); break;
    case S_SLEEP: snprintf(b, l, "%u", s->sleep_s); break;
    case S_AIHIST: snprintf(b, l, "%s", s->ai_history ? "sim" : "nao"); break;
    case S_CALCHIST: snprintf(b, l, "%s", s->calc_history ? "sim" : "nao"); break;
    case S_COMBO: snprintf(b, l, "%s", CMB[s->auth_combo % COMBO_COUNT]); break;
    default: break;
    }
}

static uint16_t cycle16(uint16_t v, const uint16_t *opts, int n, int dir)
{
    int i = 0;
    while (i < n && opts[i] != v) i++;
    if (i == n) i = 0;
    return opts[(i + (dir < 0 ? n - 1 : 1)) % n];
}

static bool set_cycle(app_t *a, menu_view_t *m, int i, int dir)
{
    (void)m;
    settings_t *s = &a->set;
    static const uint16_t MT[] = {600, 900, 1200, 1500}, AL[] = {30, 60, 120, 300, 600}, SL[] = {60, 120, 300, 600, 0};
    switch (i) {
    case S_MODE: s->response_mode = (uint8_t)((s->response_mode + (dir < 0 ? 2 : 1)) % 3); break;
    case S_METHOD: s->text_method = s->text_method == 'A' ? 'B' : 'A'; break;
    case S_LARGE: s->large_font = !s->large_font; break;
    case S_SIMPLE: s->simple_menus = !s->simple_menus; break;
    case S_SCROLL: s->scroll_step = (uint8_t)(s->scroll_step % 3 + 1); break;
    case S_REPEAT: s->key_repeat = (uint8_t)((s->key_repeat + 1) % 4); break;
    case S_INVERT: s->invert = !s->invert; break;
    case S_MULTITAP: s->multitap_ms = cycle16(s->multitap_ms, MT, 4, dir); break;
    case S_AUTOLOCK: s->auto_lock_s = cycle16(s->auto_lock_s, AL, 5, dir); break;
    case S_SLEEP: s->sleep_s = cycle16(s->sleep_s, SL, 5, dir); break;
    case S_AIHIST: s->ai_history = !s->ai_history; break;
    case S_CALCHIST: s->calc_history = !s->calc_history; break;
    case S_COMBO: s->auth_combo = (uint8_t)((s->auth_combo + 1) % COMBO_COUNT); break;
    default: return false;
    }
    app_save_settings(a);
    return true;
}

static void set_select(app_t *a, menu_view_t *m, int i)
{
    (void)m;
    switch (i) {
    case S_CLEARHIST:
        history_clear(&a->vault);
        a->calc.nhist = 0;
        app_flash(a, "Apagado");
        break;
    case S_PIN: {
        form_view_t *f = form_new(ST_SETTINGS, true, "Alterar PIN", pin_change_submit);
        if (!f) return;
        form_add(f, "Atual", FLD_PIN);
        form_add(f, "Novo", FLD_PIN);
        form_add(f, "Repita", FLD_PIN);
        app_push(a, &f->base);
        break;
    }
    case S_WIFI: {
        if (!a->p.wifi) { screens_message(a, ST_SETTINGS, "Wi-Fi", "Wi-Fi indisponivel neste firmware."); return; }
        menu_view_t *w = menu_new(ST_SETTINGS, true, "Wi-Fi");
        if (!w) return;
        w->count = wifi_count; w->label = wifi_label; w->value = wifi_value; w->select = wifi_select; w->del = wifi_del;
        app_push(a, &w->base);
        break;
    }
    case S_CANCELS: {
        reader_view_t *r = reader_new(ST_SETTINGS, true);
        if (!r) return;
        doc_add(&r->doc, DOC_TITLE, "Canceladas", NULL);
        const ai_cancel_entry_t *e;
        int n = a->p.ai ? ai_client_cancel_log(a->p.ai, &e) : 0;
        static const char *const ST[] = {"cancelamento solicitado", "cancelado no servidor", "ja concluido no servidor", "desconhecido no servidor", "sem confirmacao (rede)"};
        for (int k = 0; k < n; k++) {
            char line[96];
            snprintf(line, sizeof(line), "%.8s: %s%s", e[k].id, ST[e[k].status], e[k].late_response_discarded ? " (resposta tardia descartada)" : "");
            doc_add(&r->doc, DOC_TEXT, line, NULL);
        }
        if (!n) doc_add(&r->doc, DOC_TEXT, "Nenhuma", NULL);
        app_push(a, &r->base);
        break;
    }
    case S_DIAG: {
        reader_view_t *r = reader_new(ST_SETTINGS, true);
        if (!r) return;
        char line[128];
        battery_reading_t b = {0};
        bool hb = a->p.battery && a->p.battery(&b) && b.supported;
        pl_stats_t ps = pl_get_stats();
        doc_add(&r->doc, DOC_TITLE, "Diagnostico", NULL);
        if (hb) snprintf(line, sizeof(line), "Bateria: %u%% %umV", b.percent, b.millivolts); else snprintf(line, sizeof(line), "Bateria: sem circuito de medicao");
        doc_add(&r->doc, DOC_TEXT, line, NULL);
        snprintf(line, sizeof(line), "Wi-Fi: %s", a->p.wifi && a->p.wifi->state(a->p.wifi) == WIFI_ST_CONNECTED ? a->p.wifi->ssid(a->p.wifi) : "desconectado");
        doc_add(&r->doc, DOC_TEXT, line, NULL);
        snprintf(line, sizeof(line), "Camera: %s", a->p.cam ? a->p.cam->diag(a->p.cam) : "n/d");
        doc_add(&r->doc, DOC_TEXT, line, NULL);
        snprintf(line, sizeof(line), "Bloqueio: ultimo %lu us, max %lu us (n=%lu)", (unsigned long)ps.last_us, (unsigned long)ps.max_us, (unsigned long)ps.count);
        doc_add(&r->doc, DOC_TEXT, line, NULL);
        if (a->p.ota) { snprintf(line, sizeof(line), "Firmware: %s", a->p.ota->current_version(a->p.ota)); doc_add(&r->doc, DOC_TEXT, line, NULL); }
        /* the same results go to the owner's server (no PIN, question, image or key is included) */
        if (a->p.ai && !a->aux_job) {
            cJSON *o = cJSON_CreateObject(), *res = cJSON_AddArrayToObject(o, "results");
            if (a->p.ota) cJSON_AddStringToObject(o, "firmware", a->p.ota->current_version(a->p.ota));
            struct { const char *t; bool ok; const char *d; } R[] = {
                {"battery", hb, hb ? "medicao ok" : "sem circuito"},
                {"wifi", a->p.wifi && a->p.wifi->state(a->p.wifi) == WIFI_ST_CONNECTED, NULL},
                {"camera", a->p.cam != NULL, a->p.cam ? a->p.cam->diag(a->p.cam) : "ausente"},
                {"storage", a->p.kv != NULL, NULL},
                {"privacy_lock", ps.max_us < 100000u, ps.count ? "medido" : "nao medido"},
            };
            for (size_t k = 0; k < sizeof(R) / sizeof(R[0]); k++) {
                cJSON *it = cJSON_CreateObject();
                cJSON_AddStringToObject(it, "test", R[k].t);
                cJSON_AddBoolToObject(it, "ok", R[k].ok);
                if (R[k].d) { char d[120]; snprintf(d, sizeof(d), "%.119s", R[k].d); cJSON_AddStringToObject(it, "detail", d); }
                cJSON_AddItemToArray(res, it);
            }
            char *j = cJSON_PrintUnformatted(o);
            cJSON_Delete(o);
            if (j && ai_client_aux_start(a->p.ai, "POST", "/api/v1/device/diagnostics", j)) {
                a->aux_job = 2;
                if (a->p.wake_worker) a->p.wake_worker();
                doc_add(&r->doc, DOC_TEXT, "Enviando resultado ao servidor...", NULL);
            }
            free(j);
        }
        app_push(a, &r->base);
        break;
    }
    case S_OTA:
        if (!a->p.ota) { screens_message(a, ST_SETTINGS, "OTA", "OTA indisponivel."); return; }
        a->p.ota->check(a->p.ota);
        app_push(a, &busy_new(1, 0)->base);
        break;
    default: break;
    }
}

void screens_open_settings(app_t *a)
{
    menu_view_t *m = menu_new(ST_SETTINGS, true, "Ajustes");
    if (!m) return;
    m->count = set_count; m->label = set_label; m->value = set_value; m->cycle = set_cycle; m->select = set_select;
    app_push(a, &m->base);
}
