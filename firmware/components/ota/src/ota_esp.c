/*
 * OTA over HTTPS from the owner's home server (protocol mt1).
 * 1) GET /api/v1/updates/manifest (HMAC-signed like every device request)
 *    -> {"version","url":"/api/v1/updates/firmware?version=...","sha256","size"}
 *    Only versions the owner approved in the dashboard are published.
 * 2) if newer: esp_https_ota (TLS validated, signed GET) writes the inactive slot
 * 3) with Secure Boot v2 the image signature is verified before it can boot;
 *    the SHA-256 of the download is compared with the manifest as well
 * 4) next boot runs in PENDING_VERIFY; main calls ota_mark_valid() after the
 *    self-test, otherwise the bootloader rolls back automatically
 */
#ifdef ESP_PLATFORM
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "ai_client.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "ota_update.h"
#include "sdkconfig.h"
#include "security.h"

static const char *TAG = "ota";

typedef struct {
    volatile ota_state_t state;
    volatile uint8_t progress;
    char msg[48];
    ai_client_t *ai;
    char base[128];
    char new_path[160];
    char new_url[300];
    char new_version[32];
    char sha256[65];
    const char *ca;
} ota_ctx_t;

static ota_ctx_t s;

static void set_msg(ota_state_t st, const char *m) { snprintf(s.msg, sizeof(s.msg), "%s", m); s.state = st; }

static void check_task(void *arg)
{
    (void)arg;
    char *buf = NULL;
    size_t n = 0;
    int st = 0;
    if (!s.ai || ai_client_request_ex(s.ai, "GET", "/api/v1/updates/manifest", NULL, (const uint8_t *)"", 0, &buf, &n, &st, s.base, sizeof(s.base)) != 0 ||
        st != 200) {
        free(buf);
        set_msg(OTA_FAILED, st == 401 ? "Dispositivo nao autorizado" : "Falha ao obter manifesto");
        vTaskDelete(NULL);
    }
    cJSON *j = cJSON_ParseWithLength(buf, n);
    free(buf);
    cJSON *v = cJSON_GetObjectItem(j, "version"), *u = cJSON_GetObjectItem(j, "url"), *h = cJSON_GetObjectItem(j, "sha256");
    if (cJSON_IsNull(v) || (v && !cJSON_IsString(v))) { cJSON_Delete(j); set_msg(OTA_UP_TO_DATE, "Nenhuma versao aprovada"); vTaskDelete(NULL); }
    if (!cJSON_IsString(v) || !cJSON_IsString(u) || !cJSON_IsString(h) || strlen(h->valuestring) != 64 ||
        strncmp(u->valuestring, "/api/v1/updates/firmware?", 25) != 0 || strlen(u->valuestring) >= sizeof(s.new_path)) {
        cJSON_Delete(j);
        set_msg(OTA_FAILED, "Manifesto invalido");
        vTaskDelete(NULL);
    }
    snprintf(s.new_version, sizeof(s.new_version), "%s", v->valuestring);
    snprintf(s.new_path, sizeof(s.new_path), "%s", u->valuestring); /* same server that answered (never a third-party URL) */
    snprintf(s.new_url, sizeof(s.new_url), "%s%s", s.base, s.new_path);
    snprintf(s.sha256, sizeof(s.sha256), "%s", h->valuestring);
    cJSON_Delete(j);
    const esp_app_desc_t *cur = esp_app_get_description();
    if (ota_version_cmp(s.new_version, cur->version) <= 0) set_msg(OTA_UP_TO_DATE, "Firmware atualizado");
    else set_msg(OTA_AVAILABLE, "Nova versao disponivel");
    vTaskDelete(NULL);
}

/* esp_https_ota creates the HTTP client itself: add the mt1 signature headers here */
static esp_err_t sign_download(esp_http_client_handle_t h)
{
    ai_auth_t a;
    if (ai_client_auth(s.ai, "GET", s.new_path, (const uint8_t *)"", 0, &a) != 0) return ESP_FAIL;
    for (int i = 0; i < a.n; i++) esp_http_client_set_header(h, a.h[i].name, a.h[i].value);
    sec_wipe(&a, sizeof(a));
    return ESP_OK;
}

static void apply_task(void *arg)
{
    (void)arg;
    esp_http_client_config_t http = {.url = s.new_url, .timeout_ms = 15000, .keep_alive_enable = true};
    bool lan = s.ai && s.ai->cfg.base_url[0] && strcmp(s.base, s.ai->cfg.base_url) == 0;
    if (s.ca && lan) http.cert_pem = s.ca; else http.crt_bundle_attach = esp_crt_bundle_attach;
    esp_https_ota_config_t cfg = {.http_config = &http, .http_client_init_cb = sign_download};
#ifndef CONFIG_MT_ALLOW_HTTP
    if (strncmp(s.new_url, "https://", 8) != 0) { set_msg(OTA_FAILED, "URL sem HTTPS recusada"); vTaskDelete(NULL); }
#endif
    esp_https_ota_handle_t h = NULL;
    set_msg(OTA_DOWNLOADING, "Baixando");
    if (esp_https_ota_begin(&cfg, &h) != ESP_OK) { set_msg(OTA_FAILED, "Falha ao iniciar (TLS?)"); vTaskDelete(NULL); }
    esp_err_t e;
    while ((e = esp_https_ota_perform(h)) == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
        int total = esp_https_ota_get_image_size(h), got = esp_https_ota_get_image_len_read(h);
        if (total > 0) s.progress = (uint8_t)((int64_t)got * 100 / total);
    }
    if (e != ESP_OK || !esp_https_ota_is_complete_data_received(h)) {
        esp_https_ota_abort(h);
        set_msg(OTA_FAILED, "Download incompleto; versao atual mantida");
        vTaskDelete(NULL);
    }
    /* compare image hash with the manifest before switching the boot slot */
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    uint8_t sha[32];
    char hex[65];
    esp_partition_get_sha256(part, sha);
    for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", sha[i]);
    /* esp_partition_get_sha256 hashes the app image as written (incl. appended digest);
       the manifest must publish the same value (see tools/ in docs/OTA.md) */
    if (strcasecmp(hex, s.sha256) != 0) {
        esp_https_ota_abort(h);
        set_msg(OTA_FAILED, "Hash divergente; versao atual mantida");
        vTaskDelete(NULL);
    }
    e = esp_https_ota_finish(h); /* validates the image (and its signature with Secure Boot v2) */
    if (e != ESP_OK) set_msg(OTA_FAILED, e == ESP_ERR_OTA_VALIDATE_FAILED ? "Imagem invalida/assinatura" : "Falha ao finalizar");
    else { s.progress = 100; set_msg(OTA_DONE, "Atualizado: reinicie"); }
    vTaskDelete(NULL);
}

static void h_check(ota_hal_t *o) { (void)o; set_msg(OTA_CHECKING, "Verificando..."); xTaskCreate(check_task, "ota_check", 6144, NULL, 3, NULL); }
static void h_apply(ota_hal_t *o) { (void)o; if (s.state == OTA_AVAILABLE) { s.state = OTA_DOWNLOADING; xTaskCreate(apply_task, "ota_apply", 8192, NULL, 3, NULL); } }
static ota_state_t h_state(ota_hal_t *o) { (void)o; return s.state; }
static uint8_t h_progress(ota_hal_t *o) { (void)o; return s.progress; }
static const char *h_msg(ota_hal_t *o) { (void)o; return s.msg; }
static const char *h_version(ota_hal_t *o) { (void)o; return esp_app_get_description()->version; }

static ota_hal_t s_hal = {h_check, h_apply, h_state, h_progress, h_msg, h_version, NULL};

ota_hal_t *ota_esp_create(ai_client_t *ai, const char *ca)
{
    s.ai = ai;
    s.ca = ca;
    set_msg(OTA_IDLE, "OTA");
    return &s_hal;
}

void ota_mark_valid(void)
{
    esp_ota_img_states_t st;
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "nova imagem validada (rollback cancelado)");
    }
}
#endif
