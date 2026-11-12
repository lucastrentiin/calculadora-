/*
 * OTA over HTTPS.
 * 1) GET manifest JSON {"version":"x.y.z","url":"https://.../fw.bin","sha256":"<hex>"}
 * 2) if newer: esp_https_ota (TLS validated) writes the inactive slot
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

static const char *TAG = "ota";

typedef struct {
    volatile ota_state_t state;
    volatile uint8_t progress;
    char msg[48];
    char manifest_url[160];
    char new_url[200];
    char new_version[32];
    char sha256[65];
    const char *ca;
} ota_ctx_t;

static ota_ctx_t s;

static void set_msg(ota_state_t st, const char *m) { snprintf(s.msg, sizeof(s.msg), "%s", m); s.state = st; }

static esp_err_t http_get(const char *url, char *buf, size_t cap, size_t *out)
{
    esp_http_client_config_t cfg = {.url = url, .timeout_ms = 10000};
    if (s.ca) cfg.cert_pem = s.ca; else cfg.crt_bundle_attach = esp_crt_bundle_attach;
    esp_http_client_handle_t h = esp_http_client_init(&cfg);
    if (!h) return ESP_FAIL;
    esp_err_t e = esp_http_client_open(h, 0);
    size_t n = 0;
    if (e == ESP_OK && esp_http_client_fetch_headers(h) >= 0 && esp_http_client_get_status_code(h) == 200) {
        int r;
        while (n < cap - 1 && (r = esp_http_client_read(h, buf + n, (int)(cap - 1 - n))) > 0) n += (size_t)r;
    } else e = ESP_FAIL;
    buf[n] = 0;
    *out = n;
    esp_http_client_close(h);
    esp_http_client_cleanup(h);
    return e;
}

static void check_task(void *arg)
{
    (void)arg;
    char *buf = malloc(2048);
    size_t n = 0;
    if (!buf || strncmp(s.manifest_url, "https://", 8) != 0 || http_get(s.manifest_url, buf, 2048, &n) != ESP_OK) {
        set_msg(OTA_FAILED, "Falha ao obter manifesto");
        free(buf);
        vTaskDelete(NULL);
    }
    cJSON *j = cJSON_ParseWithLength(buf, n);
    free(buf);
    cJSON *v = cJSON_GetObjectItem(j, "version"), *u = cJSON_GetObjectItem(j, "url"), *h = cJSON_GetObjectItem(j, "sha256");
    if (!cJSON_IsString(v) || !cJSON_IsString(u) || !cJSON_IsString(h) || strlen(h->valuestring) != 64 || strncmp(u->valuestring, "https://", 8) != 0) {
        cJSON_Delete(j);
        set_msg(OTA_FAILED, "Manifesto invalido");
        vTaskDelete(NULL);
    }
    snprintf(s.new_version, sizeof(s.new_version), "%s", v->valuestring);
    snprintf(s.new_url, sizeof(s.new_url), "%s", u->valuestring);
    snprintf(s.sha256, sizeof(s.sha256), "%s", h->valuestring);
    cJSON_Delete(j);
    const esp_app_desc_t *cur = esp_app_get_description();
    if (ota_version_cmp(s.new_version, cur->version) <= 0) set_msg(OTA_UP_TO_DATE, "Firmware atualizado");
    else set_msg(OTA_AVAILABLE, "Nova versao disponivel");
    vTaskDelete(NULL);
}

static void apply_task(void *arg)
{
    (void)arg;
    esp_http_client_config_t http = {.url = s.new_url, .timeout_ms = 15000, .keep_alive_enable = true};
    if (s.ca) http.cert_pem = s.ca; else http.crt_bundle_attach = esp_crt_bundle_attach;
    esp_https_ota_config_t cfg = {.http_config = &http};
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

ota_hal_t *ota_esp_create(const char *manifest_url, const char *ca)
{
    snprintf(s.manifest_url, sizeof(s.manifest_url), "%s", manifest_url ? manifest_url : "");
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
