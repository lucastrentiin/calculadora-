#include "ai_client.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "security.h"

static const char *const MODE_STR[] = {"fast", "short", "full"};

int ai_sign(const uint8_t key[32], const char *method, const char *path, const char *ts, const char *nonce,
            const uint8_t *body, size_t len, char sig_hex[65])
{
    uint8_t h[32], mac[32];
    char hh[65];
    if (sec_sha256(body ? body : (const uint8_t *)"", len, h) != 0) return -1;
    sec_hex(h, 32, hh);
    size_t ml = strlen(method) + strlen(path) + strlen(ts) + strlen(nonce) + 64 + 5;
    char *msg = malloc(ml);
    if (!msg) return -1;
    snprintf(msg, ml, "%s\n%s\n%s\n%s\n%s", method, path, ts, nonce, hh);
    int r = sec_hmac_sha256(key, 32, (const uint8_t *)msg, strlen(msg), mac);
    free(msg);
    if (r == 0) sec_hex(mac, 32, sig_hex);
    sec_wipe(mac, sizeof(mac));
    return r;
}

int ai_client_init(ai_client_t *c, const ai_client_cfg_t *cfg)
{
    memset(c, 0, sizeof(*c));
    c->cfg = *cfg;
    atomic_store(&c->gen, 1);
    return 0;
}

static void new_request_id(char out[AI_REQ_ID_LEN + 1])
{
    uint8_t r[16];
    sec_random(r, sizeof(r));
    sec_hex(r, sizeof(r), out);
}

static void drop_body(ai_client_t *c)
{
    if (c->body) { sec_wipe(c->body, c->body_len); free(c->body); }
    c->body = NULL;
    c->body_len = 0;
}

static uint32_t queue_job(ai_client_t *c)
{
    uint32_t g = atomic_fetch_add(&c->gen, 1) + 1;
    atomic_store(&c->sent, false);
    atomic_store(&c->phase, AI_PHASE_QUEUED);
    atomic_store(&c->job_gen, g);
    return g;
}

static void set_job_meta(ai_client_t *c, const char *session_id, const char *provider)
{
    snprintf(c->session_id, sizeof(c->session_id), "%s", session_id ? session_id : "");
    /* provider ids are [a-z_] (validated by the server too) */
    size_t o = 0;
    for (const char *p = provider && *provider ? provider : "auto"; *p && o < sizeof(c->provider) - 1; p++)
        if ((*p >= 'a' && *p <= 'z') || *p == '_') c->provider[o++] = *p;
    c->provider[o] = 0;
    if (o < 2) strcpy(c->provider, "auto");
}

uint32_t ai_client_start_text(ai_client_t *c, const char *q, resp_mode_t mode, const char *session_id, const char *provider)
{
    if (atomic_load(&c->job_gen)) return 0; /* one request at a time */
    if (!q || !*q || strlen(q) > AI_MAX_QUESTION || mode > RESP_FULL) return 0;
    drop_body(c);
    new_request_id(c->req_id);
    set_job_meta(c, session_id, provider);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "request_id", c->req_id);
    if (c->session_id[0]) cJSON_AddStringToObject(o, "session_id", c->session_id);
    cJSON_AddStringToObject(o, "question", q);
    cJSON_AddStringToObject(o, "mode", MODE_STR[mode]);
    cJSON_AddStringToObject(o, "provider", c->provider);
    char *json = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (!json) return 0;
    c->body = (uint8_t *)json;
    c->body_len = strlen(json);
    strcpy(c->path, "/api/v1/ai/ask");
    strcpy(c->content_type, "application/json");
    c->mode_hdr[0] = 0;
    c->prompt_b64[0] = 0;
    return queue_job(c);
}

static void b64(const uint8_t *in, size_t len, char *out, size_t outlen)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < len && o + 5 < outlen; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < len ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < len ? in[i + 2] : 0);
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = i + 1 < len ? T[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? T[v & 63] : '=';
    }
    out[o] = 0;
}

uint32_t ai_client_start_image(ai_client_t *c, uint8_t *jpeg, size_t len, const char *prompt, resp_mode_t mode,
                               const char *session_id, const char *provider)
{
    if (atomic_load(&c->job_gen) || !jpeg || len < 4 || mode > RESP_FULL) {
        if (jpeg) { sec_wipe(jpeg, len); free(jpeg); }
        return 0;
    }
    drop_body(c);
    new_request_id(c->req_id);
    set_job_meta(c, session_id, provider);
    c->body = jpeg;
    c->body_len = len;
    strcpy(c->path, "/api/v1/ai/vision");
    strcpy(c->content_type, "image/jpeg");
    snprintf(c->mode_hdr, sizeof(c->mode_hdr), "%s", MODE_STR[mode]);
    size_t pl = prompt ? strlen(prompt) : 0;
    if (pl > 45) pl = 45; /* header budget */
    b64((const uint8_t *)(prompt ? prompt : ""), pl, c->prompt_b64, sizeof(c->prompt_b64));
    return queue_job(c);
}

static void log_cancel(ai_client_t *c, const char *id, ai_cancel_status_t st)
{
    uint32_t n = atomic_load(&c->ncancels);
    ai_cancel_entry_t *e = &c->cancels[n % AI_CANCEL_LOG];
    memset(e, 0, sizeof(*e));
    strncpy(e->id, id, AI_REQ_ID_LEN);
    e->status = st;
    atomic_store(&c->ncancels, n + 1);
}

static ai_cancel_entry_t *find_cancel(ai_client_t *c, const char *id)
{
    uint32_t n = atomic_load(&c->ncancels);
    for (uint32_t i = 0; i < n && i < AI_CANCEL_LOG; i++) if (strcmp(c->cancels[i].id, id) == 0) return &c->cancels[i];
    return NULL;
}

void ai_client_cancel(ai_client_t *c)
{
    uint32_t job = atomic_load(&c->job_gen);
    if (!job) return;
    atomic_fetch_add(&c->gen, 1); /* invalidates job: worker aborts, result is discarded */
    if (atomic_load(&c->sent)) {
        log_cancel(c, c->req_id, AI_CANCEL_REQUESTED);
        memcpy(c->pending_cancel, c->req_id, sizeof(c->pending_cancel));
        atomic_store(&c->cancel_pending, true);
    }
}

bool ai_client_poll(ai_client_t *c, uint32_t gen, ai_result_t *out)
{
    if (atomic_load(&c->result_gen) != gen || gen != atomic_load(&c->gen)) return false;
    *out = c->result;
    memset(&c->result, 0, sizeof(c->result));
    atomic_store(&c->result_gen, 0);
    return true;
}

ai_phase_t ai_client_phase(const ai_client_t *c) { return (ai_phase_t)atomic_load(&((ai_client_t *)c)->phase); }
bool ai_client_was_sent(const ai_client_t *c) { return atomic_load(&((ai_client_t *)c)->sent); }

int ai_client_cancel_log(const ai_client_t *c, const ai_cancel_entry_t **e)
{
    *e = c->cancels;
    uint32_t n = atomic_load(&((ai_client_t *)c)->ncancels);
    return n > AI_CANCEL_LOG ? AI_CANCEL_LOG : (int)n;
}

void ai_client_free_result(ai_result_t *r)
{
    if (r->body) { sec_wipe(r->body, r->body_len); free(r->body); }
    memset(r, 0, sizeof(*r));
}

/* ------------------------------ worker ------------------------------- */

typedef struct { ai_client_t *c; uint32_t gen; } job_ctx_t;

static bool should_abort(void *u) { job_ctx_t *j = u; return atomic_load(&j->c->gen) != j->gen; }
static void on_phase(void *u, ai_phase_t p)
{
    job_ctx_t *j = u;
    if (atomic_load(&j->c->gen) != j->gen) return;
    atomic_store(&j->c->phase, p);
    if (p >= AI_PHASE_SENT) atomic_store(&j->c->sent, true);
}

int ai_client_auth(const ai_client_t *c, const char *method, const char *path_q, const uint8_t *body, size_t len, ai_auth_t *a)
{
    uint8_t nonce[12];
    memset(a, 0, sizeof(*a));
    snprintf(a->ts, sizeof(a->ts), "%lu", (unsigned long)(c->cfg.now_s ? c->cfg.now_s() : 0));
    sec_random(nonce, sizeof(nonce));
    sec_hex(nonce, sizeof(nonce), a->nonce);
    if (ai_sign(c->cfg.device_key, method, path_q, a->ts, a->nonce, body, len, a->sig) != 0) return -1;
    a->h[a->n++] = (ai_header_t){"X-Protocol", "mt1"};
    a->h[a->n++] = (ai_header_t){"X-Device-Id", c->cfg.device_id};
    a->h[a->n++] = (ai_header_t){"X-Timestamp", a->ts};
    a->h[a->n++] = (ai_header_t){"X-Nonce", a->nonce};
    a->h[a->n++] = (ai_header_t){"X-Signature", a->sig};
    if (c->cfg.firmware[0]) a->h[a->n++] = (ai_header_t){"X-Firmware", c->cfg.firmware};
    if (c->cfg.cf_client_id[0] && c->cfg.cf_client_secret[0]) {
        a->h[a->n++] = (ai_header_t){"CF-Access-Client-Id", c->cfg.cf_client_id};
        a->h[a->n++] = (ai_header_t){"CF-Access-Client-Secret", c->cfg.cf_client_secret};
    }
    return 0;
}

/* One signed request to base+path. extra headers appended after the auth set. */
static int send_one(ai_client_t *c, const char *base, const char *method, const char *path_q, const char *ctype,
                    const ai_header_t *extra, int nextra, const uint8_t *body, size_t len, job_ctx_t *j,
                    char **resp, size_t *resp_len, int *status)
{
    ai_auth_t a;
    char url[256];
    if (ai_client_auth(c, method, path_q, body, len, &a) != 0) return -1;
    if (ctype && a.n < AI_MAX_HEADERS) a.h[a.n++] = (ai_header_t){"Content-Type", ctype};
    for (int i = 0; i < nextra && a.n < AI_MAX_HEADERS; i++) a.h[a.n++] = extra[i];
    snprintf(url, sizeof(url), "%s%s", base, path_q);
    *resp = NULL;
    *resp_len = 0;
    *status = 0;
    int r = c->cfg.transport->request(c->cfg.transport, method, url, a.h, a.n, body, len, j ? should_abort : NULL, j ? on_phase : NULL, j,
                                      resp, resp_len, status);
    sec_wipe(&a, sizeof(a));
    return r;
}

/* LAN first; the remote URL only if nothing was sent (never re-send a billable request). */
static int send_failover(ai_client_t *c, const char *method, const char *path_q, const char *ctype, const ai_header_t *extra, int nextra,
                         const uint8_t *body, size_t len, job_ctx_t *j, char **resp, size_t *resp_len, int *status, bool *remote,
                         char *used, size_t used_len)
{
    const char *urls[2] = {c->cfg.base_url, c->cfg.remote_url};
    int r = -1;
    *remote = false;
    for (int i = 0; i < 2; i++) {
        if (!urls[i][0]) continue;
        if (j) { atomic_store(&c->sent, false); }
        r = send_one(c, urls[i], method, path_q, ctype, extra, nextra, body, len, j, resp, resp_len, status);
        if (r == 0) { if (used) snprintf(used, used_len, "%s", urls[i]); *remote = i == 1; return 0; }
        if (r == -2) return r;
        if (j && atomic_load(&c->sent)) return r; /* request left the device: no automatic re-send */
        free(*resp);
        *resp = NULL;
    }
    return r;
}

int ai_client_request(ai_client_t *c, const char *method, const char *path_q, const char *ctype, const uint8_t *body, size_t len,
                      char **resp, size_t *resp_len, int *status)
{
    return ai_client_request_ex(c, method, path_q, ctype, body, len, resp, resp_len, status, NULL, 0);
}

int ai_client_request_ex(ai_client_t *c, const char *method, const char *path_q, const char *ctype, const uint8_t *body, size_t len,
                         char **resp, size_t *resp_len, int *status, char *used_base, size_t used_len)
{
    bool remote;
    if (!c || !c->cfg.transport) return -1;
    return send_failover(c, method, path_q, ctype, NULL, 0, body, len, NULL, resp, resp_len, status, &remote, used_base, used_len);
}

static int page_count(const char *json, size_t len)
{
    cJSON *o = cJSON_ParseWithLength(json, len);
    cJSON *p = cJSON_GetObjectItem(cJSON_GetObjectItem(o, "page"), "count");
    int n = cJSON_IsNumber(p) ? p->valueint : 1;
    cJSON_Delete(o);
    return n < 1 ? 1 : n;
}

/* Fetch pages 1..count-1 and append their steps to page 0 (bounded). */
static void merge_pages(ai_client_t *c, job_ctx_t *j, char **resp, size_t *rl)
{
    int count = page_count(*resp, *rl);
    if (count <= 1) return;
    cJSON *root = cJSON_ParseWithLength(*resp, *rl);
    cJSON *steps = cJSON_GetObjectItem(root, "steps");
    if (!root || !cJSON_IsArray(steps)) { cJSON_Delete(root); return; }
    bool partial = count > AI_MAX_PAGES;
    for (int i = 1; i < count && i < AI_MAX_PAGES; i++) {
        if (should_abort(j)) { partial = true; break; }
        char path[96], *pr = NULL;
        size_t pl = 0;
        int st = 0;
        snprintf(path, sizeof(path), "/api/v1/requests/%s?page=%d", c->req_id, i);
        if (send_one(c, c->used_url, "GET", path, NULL, NULL, 0, (const uint8_t *)"", 0, NULL, &pr, &pl, &st) != 0 || st != 200 ||
            *rl + pl > AI_MAX_RESPONSE) { free(pr); partial = true; break; }
        cJSON *po = cJSON_ParseWithLength(pr, pl);
        cJSON *ps = cJSON_GetObjectItem(po, "steps");
        cJSON *it;
        while (cJSON_IsArray(ps) && (it = cJSON_DetachItemFromArray(ps, 0)) != NULL) cJSON_AddItemToArray(steps, it);
        cJSON_Delete(po);
        sec_wipe(pr, pl);
        free(pr);
    }
    if (partial) { cJSON_DeleteItemFromObject(root, "truncated"); cJSON_AddBoolToObject(root, "truncated", true); }
    cJSON_DeleteItemFromObject(root, "page");
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!out) return;
    sec_wipe(*resp, *rl);
    free(*resp);
    *resp = out;
    *rl = strlen(out);
}

static void run_remote_cancel(ai_client_t *c)
{
    char id[AI_REQ_ID_LEN + 1], body[80];
    memcpy(id, c->pending_cancel, sizeof(id));
    atomic_store(&c->cancel_pending, false);
    snprintf(body, sizeof(body), "{\"request_id\":\"%s\"}", id);
    char *resp = NULL;
    size_t rl = 0;
    int st = 0, r;
    if (c->used_url[0]) r = send_one(c, c->used_url, "POST", "/api/v1/requests/cancel", "application/json", NULL, 0, (const uint8_t *)body, strlen(body), NULL, &resp, &rl, &st);
    else { bool rem; r = send_failover(c, "POST", "/api/v1/requests/cancel", "application/json", NULL, 0, (const uint8_t *)body, strlen(body), NULL, &resp, &rl, &st, &rem, NULL, 0); }
    ai_cancel_entry_t *e = find_cancel(c, id);
    ai_cancel_status_t s = AI_CANCEL_NO_CONFIRMATION;
    if (r == 0 && st == 200 && resp) {
        cJSON *o = cJSON_ParseWithLength(resp, rl);
        cJSON *status = cJSON_GetObjectItem(o, "status");
        if (cJSON_IsString(status)) {
            if (strstr(status->valuestring, "concluido")) s = AI_CANCEL_ALREADY_DONE;
            else if (strstr(status->valuestring, "cancelado")) s = AI_CANCEL_CONFIRMED;
            else s = AI_CANCEL_UNKNOWN;
        }
        cJSON_Delete(o);
    }
    free(resp);
    if (e) e->status = s;
}

static int run_job(ai_client_t *c, job_ctx_t *j, char **resp, size_t *rl, int *st, bool *remote)
{
    ai_header_t ex[4];
    int nex = 0;
    if (c->mode_hdr[0]) {
        ex[nex++] = (ai_header_t){"X-Request-Id", c->req_id};
        ex[nex++] = (ai_header_t){"X-Mode", c->mode_hdr};
        ex[nex++] = (ai_header_t){"X-Provider", c->provider};
        if (c->session_id[0]) ex[nex++] = (ai_header_t){"X-Session-Id", c->session_id};
    }
    c->used_url[0] = 0;
    int r = send_failover(c, "POST", c->path, c->content_type, ex, nex, c->body, c->body_len, j, resp, rl, st, remote, c->used_url, sizeof(c->used_url));
    drop_body(c); /* question / image no longer needed on the device */
    /* 202: the server keeps working; long-poll the same server (never another one) */
    char path[96];
    snprintf(path, sizeof(path), "/api/v1/requests/%s?wait=%d", c->req_id, AI_POLL_WAIT_MS);
    for (int polls = 0; r == 0 && *st == 202 && polls < AI_MAX_POLLS; polls++) {
        if (should_abort(j)) return -2;
        atomic_store(&c->phase, AI_PHASE_WAITING);
        sec_wipe(*resp, *rl);
        free(*resp);
        *resp = NULL;
        r = send_one(c, c->used_url, "GET", path, NULL, NULL, 0, (const uint8_t *)"", 0, j, resp, rl, st);
    }
    if (r == 0 && *st == 202) { *st = 504; } /* gave up waiting: reported as an HTTP error, request stays cancellable */
    if (r == 0 && *st == 200 && *resp) merge_pages(c, j, resp, rl);
    return r;
}

bool ai_client_aux_start(ai_client_t *c, const char *method, const char *path, const char *json)
{
    if (!c || atomic_load(&c->aux.state) == AI_AUX_PENDING || strlen(path) >= sizeof(c->aux.path)) return false;
    free(c->aux.resp);
    free(c->aux.body);
    c->aux.resp = NULL;
    c->aux.body = json ? strdup(json) : NULL;
    c->aux.len = json ? strlen(json) : 0;
    if (json && !c->aux.body) return false;
    snprintf(c->aux.method, sizeof(c->aux.method), "%s", method);
    snprintf(c->aux.path, sizeof(c->aux.path), "%s", path);
    atomic_store(&c->aux.state, AI_AUX_PENDING);
    return true;
}

ai_aux_state_t ai_client_aux_poll(ai_client_t *c, char **resp, size_t *len, int *status)
{
    ai_aux_state_t s = (ai_aux_state_t)atomic_load(&c->aux.state);
    if (s == AI_AUX_DONE || s == AI_AUX_FAILED) {
        if (resp) *resp = c->aux.resp; else free(c->aux.resp);
        if (len) *len = c->aux.resp_len;
        if (status) *status = c->aux.http_status;
        c->aux.resp = NULL;
        c->aux.resp_len = 0;
        atomic_store(&c->aux.state, AI_AUX_IDLE);
    }
    return s;
}

static void run_aux(ai_client_t *c)
{
    char *resp = NULL;
    size_t rl = 0;
    int st = 0;
    int r = ai_client_request(c, c->aux.method, c->aux.path, c->aux.body ? "application/json" : NULL,
                              (const uint8_t *)(c->aux.body ? c->aux.body : ""), c->aux.len, &resp, &rl, &st);
    free(c->aux.body);
    c->aux.body = NULL;
    c->aux.resp = resp;
    c->aux.resp_len = rl;
    c->aux.http_status = st;
    atomic_store(&c->aux.state, r == 0 && st >= 200 && st < 300 ? AI_AUX_DONE : AI_AUX_FAILED);
}

bool ai_client_run_pending(ai_client_t *c)
{
    bool did = false;
    uint32_t g = atomic_load(&c->job_gen);
    if (g) {
        did = true;
        job_ctx_t j = {c, g};
        char *resp = NULL;
        size_t rl = 0;
        int st = 0;
        int r = -2;
        bool remote = false;
        if (atomic_load(&c->gen) == g) {
            atomic_store(&c->phase, AI_PHASE_CONNECTING);
            r = run_job(c, &j, &resp, &rl, &st, &remote);
        }
        drop_body(c);
        if (atomic_load(&c->gen) == g) {
            ai_result_t res = {0};
            res.was_sent = atomic_load(&c->sent);
            res.http_status = st;
            res.body = resp;
            res.body_len = rl;
            res.via_remote = remote;
            memcpy(res.session_id, c->session_id, sizeof(res.session_id));
            res.kind = r != 0 ? AI_RESULT_TRANSPORT_ERROR : (st == 200 ? AI_RESULT_OK : AI_RESULT_HTTP_ERROR);
            c->result = res;
            atomic_store(&c->phase, AI_PHASE_DONE);
            atomic_store(&c->result_gen, g);
        } else {
            /* cancelled while in flight: discard, never deliver */
            if (resp) {
                ai_cancel_entry_t *e = find_cancel(c, c->req_id);
                if (e) e->late_response_discarded = true;
                sec_wipe(resp, rl);
                free(resp);
            }
            atomic_store(&c->phase, AI_PHASE_IDLE);
        }
        atomic_store(&c->job_gen, 0);
    }
    if (atomic_load(&c->cancel_pending)) { run_remote_cancel(c); did = true; }
    if (!atomic_load(&c->job_gen) && atomic_load(&c->aux.state) == AI_AUX_PENDING) { run_aux(c); did = true; }
    return did;
}
