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

uint32_t ai_client_start_text(ai_client_t *c, const char *q, resp_mode_t mode)
{
    if (atomic_load(&c->job_gen)) return 0; /* one request at a time */
    if (!q || !*q || strlen(q) > AI_MAX_QUESTION || mode > RESP_FULL) return 0;
    drop_body(c);
    new_request_id(c->req_id);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "request_id", c->req_id);
    cJSON_AddStringToObject(o, "question", q);
    cJSON_AddStringToObject(o, "mode", MODE_STR[mode]);
    char *json = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (!json) return 0;
    c->body = (uint8_t *)json;
    c->body_len = strlen(json);
    strcpy(c->path, "/v1/ask");
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

uint32_t ai_client_start_image(ai_client_t *c, uint8_t *jpeg, size_t len, const char *prompt, resp_mode_t mode)
{
    if (atomic_load(&c->job_gen) || !jpeg || len < 4 || mode > RESP_FULL) {
        if (jpeg) { sec_wipe(jpeg, len); free(jpeg); }
        return 0;
    }
    drop_body(c);
    new_request_id(c->req_id);
    c->body = jpeg;
    c->body_len = len;
    strcpy(c->path, "/v1/image");
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

static int do_post(ai_client_t *c, const char *path, const char *ctype, const uint8_t *body, size_t len, const char *mode, const char *prompt,
                   const char *req_id, job_ctx_t *j, char **resp, size_t *resp_len, int *status)
{
    char ts[16], nonce_hex[25], sig[65], url[192];
    uint8_t nonce[12];
    snprintf(ts, sizeof(ts), "%lu", (unsigned long)c->cfg.now_s());
    sec_random(nonce, sizeof(nonce));
    sec_hex(nonce, sizeof(nonce), nonce_hex);
    if (ai_sign(c->cfg.device_key, "POST", path, ts, nonce_hex, body, len, sig) != 0) return -1;
    snprintf(url, sizeof(url), "%s%s", c->cfg.base_url, path);
    ai_header_t h[8];
    int n = 0;
    h[n++] = (ai_header_t){"X-Device-Id", c->cfg.device_id};
    h[n++] = (ai_header_t){"X-Timestamp", ts};
    h[n++] = (ai_header_t){"X-Nonce", nonce_hex};
    h[n++] = (ai_header_t){"X-Signature", sig};
    if (ctype) h[n++] = (ai_header_t){"Content-Type", ctype};
    if (mode && *mode) { h[n++] = (ai_header_t){"X-Request-Id", req_id}; h[n++] = (ai_header_t){"X-Mode", mode}; }
    if (prompt && *prompt) h[n++] = (ai_header_t){"X-Prompt", prompt};
    return c->cfg.transport->post(c->cfg.transport, url, h, n, body, len, j ? should_abort : NULL, j ? on_phase : NULL, j, resp, resp_len, status);
}

static bool never_abort(void *u) { (void)u; return false; }

static void run_remote_cancel(ai_client_t *c)
{
    char id[AI_REQ_ID_LEN + 1], path[64];
    memcpy(id, c->pending_cancel, sizeof(id));
    atomic_store(&c->cancel_pending, false);
    snprintf(path, sizeof(path), "/v1/requests/%s/cancel", id);
    char *resp = NULL;
    size_t rl = 0;
    int st = 0;
    job_ctx_t dummy = {c, 0};
    (void)dummy;
    int r = do_post(c, path, NULL, (const uint8_t *)"", 0, NULL, NULL, id, NULL, &resp, &rl, &st);
    (void)never_abort;
    ai_cancel_entry_t *e = find_cancel(c, id);
    ai_cancel_status_t s = AI_CANCEL_NO_CONFIRMATION;
    if (r == 0 && st == 200 && resp) {
        cJSON *o = cJSON_ParseWithLength(resp, rl);
        cJSON *status = cJSON_GetObjectItem(o, "status");
        if (cJSON_IsString(status)) {
            if (strstr(status->valuestring, "cancelado")) s = AI_CANCEL_CONFIRMED;
            else if (strstr(status->valuestring, "concluido")) s = AI_CANCEL_ALREADY_DONE;
            else s = AI_CANCEL_UNKNOWN;
        }
        cJSON_Delete(o);
    }
    free(resp);
    if (e) e->status = s;
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
        if (atomic_load(&c->gen) == g) {
            atomic_store(&c->phase, AI_PHASE_CONNECTING);
            r = do_post(c, c->path, c->content_type, c->body, c->body_len, c->mode_hdr, c->prompt_b64, c->req_id, &j, &resp, &rl, &st);
        }
        drop_body(c);
        if (atomic_load(&c->gen) == g) {
            ai_result_t res = {0};
            res.was_sent = atomic_load(&c->sent);
            res.http_status = st;
            res.body = resp;
            res.body_len = rl;
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
    return did;
}
