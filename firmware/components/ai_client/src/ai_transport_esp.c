/*
 * HTTPS transport for the AI client (esp_http_client).
 *  - server certificate validated with the ESP-IDF CA bundle or a pinned CA
 *  - plain http:// rejected unless CONFIG_MT_ALLOW_HTTP (development)
 *  - body written in chunks; abort flag checked between chunks and while
 *    waiting for headers (short socket timeout + total deadline)
 *  - response capped at AI_MAX_RESPONSE bytes, stored in PSRAM when available
 *  - GET (long polling) uses the same abort/deadline handling
 * NOTE: the abort latency while blocked in the TLS stack is bounded by the
 * socket timeout (1 s). The UI never waits for it (generation counter), so the
 * privacy lock is not delayed; this must still be measured on the hardware.
 */
#ifdef ESP_PLATFORM
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "ai_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "ai_https";

typedef struct { const char *ca_pem; char lan_prefix[128]; } esp_tr_ctx_t;
static esp_tr_ctx_t s_ctx;

static int esp_request(ai_transport_t *t, const char *method, const char *url, const ai_header_t *hdrs, int nh, const uint8_t *body, size_t len,
                       bool (*should_abort)(void *), void (*on_phase)(void *, ai_phase_t), void *u, char **resp, size_t *resp_len, int *status)
{
    esp_tr_ctx_t *c = t->ctx;
    *resp = NULL;
    *resp_len = 0;
    *status = 0;
#ifndef CONFIG_MT_ALLOW_HTTP
    if (strncmp(url, "https://", 8) != 0) { ESP_LOGE(TAG, "URL sem HTTPS recusada"); return -1; }
#endif
    esp_http_client_config_t cfg = {
        .url = url,
        .method = strcmp(method, "GET") == 0 ? HTTP_METHOD_GET : HTTP_METHOD_POST,
        .timeout_ms = 1000,
        .buffer_size = 2048,
        .buffer_size_tx = 1024,
        .keep_alive_enable = false,
    };
    /* pinned local CA only for the LAN server; the remote (Cloudflare) hostname uses the public CA bundle */
    bool lan = c->lan_prefix[0] && strncmp(url, c->lan_prefix, strlen(c->lan_prefix)) == 0;
    if (c->ca_pem && (lan || !c->lan_prefix[0])) cfg.cert_pem = c->ca_pem;
    else cfg.crt_bundle_attach = esp_crt_bundle_attach;
    if (on_phase) on_phase(u, AI_PHASE_CONNECTING);
    esp_http_client_handle_t h = esp_http_client_init(&cfg);
    if (!h) return -1;
    for (int i = 0; i < nh; i++) esp_http_client_set_header(h, hdrs[i].name, hdrs[i].value);
    int rc = -1;
    int64_t deadline = esp_timer_get_time() + (int64_t)CONFIG_MT_AI_TIMEOUT_MS * 1000;
    if (esp_http_client_open(h, (int)len) != ESP_OK) goto out;
    if (on_phase) on_phase(u, AI_PHASE_SENDING);
    for (size_t off = 0; off < len;) {
        if (should_abort && should_abort(u)) { rc = -2; goto out; }
        int n = esp_http_client_write(h, (const char *)body + off, (int)((len - off) > 4096 ? 4096 : (len - off)));
        if (n <= 0) goto out;
        off += (size_t)n;
    }
    if (on_phase) on_phase(u, AI_PHASE_SENT);
    if (on_phase) on_phase(u, AI_PHASE_WAITING);
    int64_t cl;
    for (;;) {
        cl = esp_http_client_fetch_headers(h);
        if (cl != -ESP_ERR_HTTP_EAGAIN) break;
        if ((should_abort && should_abort(u)) || esp_timer_get_time() > deadline) { rc = -2; goto out; }
    }
    if (cl < 0) goto out;
    *status = esp_http_client_get_status_code(h);
    if (on_phase) on_phase(u, AI_PHASE_RECEIVING);
    size_t cap = 4096, n = 0;
    char *buf = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!buf) buf = malloc(cap);
    if (!buf) goto out;
    for (;;) {
        if (should_abort && should_abort(u)) { free(buf); rc = -2; goto out; }
        if (esp_timer_get_time() > deadline) { free(buf); goto out; }
        if (n + 1024 + 1 > cap) {
            if (cap >= AI_MAX_RESPONSE) { free(buf); goto out; } /* oversize response */
            size_t nc = cap * 2 > AI_MAX_RESPONSE ? AI_MAX_RESPONSE : cap * 2;
            char *nb = heap_caps_realloc(buf, nc, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (!nb) nb = realloc(buf, nc);
            if (!nb) { free(buf); goto out; }
            buf = nb;
            cap = nc;
        }
        int r = esp_http_client_read(h, buf + n, (int)(cap - n - 1));
        if (r == -ESP_ERR_HTTP_EAGAIN) continue;
        if (r < 0) { free(buf); goto out; }
        if (r == 0) break;
        n += (size_t)r;
    }
    buf[n] = 0;
    *resp = buf;
    *resp_len = n;
    rc = 0;
out:
    esp_http_client_close(h);
    esp_http_client_cleanup(h);
    return rc;
}

static ai_transport_t s_tr = {esp_request, &s_ctx};

ai_transport_t *ai_transport_esp_create(const char *ca_pem, const char *lan_url)
{
    s_ctx.ca_pem = ca_pem;
    snprintf(s_ctx.lan_prefix, sizeof(s_ctx.lan_prefix), "%s", lan_url ? lan_url : "");
    return &s_tr;
}

static TaskHandle_t s_worker;

static void worker(void *arg)
{
    ai_client_t *c = arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(500));
        while (ai_client_run_pending(c)) {}
    }
}

int ai_client_start_worker(ai_client_t *c, uint32_t stack, int prio)
{
    return xTaskCreatePinnedToCore(worker, "ai_worker", stack, c, prio, &s_worker, 1) == pdPASS ? 0 : -1;
}

void ai_client_wake_worker(void)
{
    if (s_worker) xTaskNotifyGive(s_worker);
}
#endif
