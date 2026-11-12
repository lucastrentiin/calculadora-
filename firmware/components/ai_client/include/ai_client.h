/*
 * AI client (device side). The device never holds the AI provider key: it
 * talks HTTPS to the project backend with a per-device HMAC key.
 *
 * Concurrency model (privacy-lock friendly):
 *   - the UI task calls ai_client_start_*() / ai_client_cancel() / ai_client_poll()
 *     and NEVER blocks on the network
 *   - a worker (FreeRTOS task on the device, direct call in host tests) runs
 *     ai_client_run_pending() which performs the blocking transfer through an
 *     ai_transport_t and checks the abort flag between chunks
 *   - every request has a generation number; cancel bumps it so a late
 *     response is discarded and never reaches the screen
 *   - when a cancelled request had already been sent, the worker issues an
 *     explicit POST /v1/requests/<id>/cancel and records the outcome
 */
#pragma once
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "settings.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AI_REQ_ID_LEN 32
#define AI_MAX_QUESTION 4000
#define AI_MAX_RESPONSE (96 * 1024)
#define AI_CANCEL_LOG 8

typedef enum { AI_PHASE_IDLE = 0, AI_PHASE_QUEUED, AI_PHASE_CONNECTING, AI_PHASE_SENDING, AI_PHASE_SENT, AI_PHASE_WAITING, AI_PHASE_RECEIVING, AI_PHASE_DONE } ai_phase_t;

typedef enum { AI_CANCEL_REQUESTED = 0, AI_CANCEL_CONFIRMED, AI_CANCEL_ALREADY_DONE, AI_CANCEL_UNKNOWN, AI_CANCEL_NO_CONFIRMATION } ai_cancel_status_t;

typedef struct { const char *name; const char *value; } ai_header_t;

typedef struct ai_transport {
    /* Blocking POST. Must call should_abort(u) between chunks and return -2 when it is true.
     * on_phase(u, phase) reports progress. *resp is malloc'd (caller frees). Returns 0 on transport success. */
    int (*post)(struct ai_transport *t, const char *url, const ai_header_t *hdrs, int nhdrs, const uint8_t *body, size_t len,
                bool (*should_abort)(void *u), void (*on_phase)(void *u, ai_phase_t p), void *u,
                char **resp, size_t *resp_len, int *http_status);
    void *ctx;
} ai_transport_t;

typedef struct {
    char base_url[128];         /* https://... (http only allowed in host tests) */
    char device_id[65];
    uint8_t device_key[32];
    ai_transport_t *transport;
    uint32_t (*now_s)(void);    /* unix time for the signature (SNTP on the device) */
} ai_client_cfg_t;

typedef struct {
    char id[AI_REQ_ID_LEN + 1];
    ai_cancel_status_t status;
    bool late_response_discarded;
} ai_cancel_entry_t;

typedef enum { AI_RESULT_NONE = 0, AI_RESULT_OK, AI_RESULT_HTTP_ERROR, AI_RESULT_TRANSPORT_ERROR } ai_result_kind_t;

typedef struct {
    ai_result_kind_t kind;
    int http_status;
    char *body;                 /* JSON (malloc'd) for AI_RESULT_OK, error JSON otherwise */
    size_t body_len;
    bool was_sent;
} ai_result_t;

typedef struct {
    ai_client_cfg_t cfg;
    /* current job (written by UI before publishing gen, read by worker) */
    char req_id[AI_REQ_ID_LEN + 1];
    char path[32];
    char content_type[24];
    uint8_t *body;
    size_t body_len;
    char mode_hdr[8];
    char prompt_b64[64];
    _Atomic uint32_t gen;        /* current generation (UI) */
    _Atomic uint32_t job_gen;    /* generation of the queued job (0 = none) */
    _Atomic uint32_t phase;
    _Atomic bool sent;
    /* result slot */
    _Atomic uint32_t result_gen;
    ai_result_t result;
    /* explicit remote cancellation */
    ai_cancel_entry_t cancels[AI_CANCEL_LOG];
    _Atomic uint32_t ncancels;
    char pending_cancel[AI_REQ_ID_LEN + 1];
    _Atomic bool cancel_pending;
} ai_client_t;

int ai_client_init(ai_client_t *c, const ai_client_cfg_t *cfg);
/** Queue a text question; returns generation (>0) or 0 on error. Body is built immediately. */
uint32_t ai_client_start_text(ai_client_t *c, const char *question_utf8, resp_mode_t mode);
/** Queue a JPEG (ownership of `jpeg` passes to the client, wiped after use). */
uint32_t ai_client_start_image(ai_client_t *c, uint8_t *jpeg, size_t len, const char *prompt_utf8, resp_mode_t mode);
/** Cancel the current request (non-blocking). */
void ai_client_cancel(ai_client_t *c);
/** Fetch the result of generation `gen` if ready (ownership of body passes to caller). */
bool ai_client_poll(ai_client_t *c, uint32_t gen, ai_result_t *out);
ai_phase_t ai_client_phase(const ai_client_t *c);
bool ai_client_was_sent(const ai_client_t *c);
/** Worker side: run queued job and pending remote cancellations. Returns true if work was done. */
bool ai_client_run_pending(ai_client_t *c);
int ai_client_cancel_log(const ai_client_t *c, const ai_cancel_entry_t **entries);
void ai_client_free_result(ai_result_t *r);

/** Signature helper (exposed for tests): hex HMAC over METHOD\nPATH\nTS\nNONCE\nhex(sha256(body)). */
int ai_sign(const uint8_t key[32], const char *method, const char *path, const char *ts, const char *nonce,
            const uint8_t *body, size_t len, char sig_hex[65]);

#ifdef ESP_PLATFORM
/** HTTPS transport over esp_http_client with certificate validation (CA bundle or pinned PEM). */
ai_transport_t *ai_transport_esp_create(const char *ca_pem_or_null);
/** Start the worker task. */
int ai_client_start_worker(ai_client_t *c, uint32_t stack, int prio);
/** Notify the worker that a job or a remote cancellation is pending. */
void ai_client_wake_worker(void);
#endif

#ifdef __cplusplus
}
#endif
