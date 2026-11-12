/*
 * Terminal Matematico - ESP32-S3 entry point.
 *
 * Tasks:
 *   ui        (prio 6, core 0): keys -> app_key, app_tick, render, display flush
 *   ai_worker (prio 4, core 1): blocking HTTPS for the AI client
 *   crypto    (prio 3)        : PBKDF2 PIN verification (never blocks the UI)
 *   camera / keypad scan / Wi-Fi: inside their components
 *
 * Device credentials (device id + HMAC key for the backend) are provisioned
 * into the encrypted "mtdata" NVS partition (docs/PROVISIONING.md). Nothing
 * secret is compiled into the firmware.
 */
#include <string.h>
#include <sys/time.h>

#include "ai_client.h"
#include "app_state.h"
#include "camera_hal.h"
#include "display.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "keypad.h"
#include "nvs_flash.h"
#include "ota_update.h"
#include "power_manager.h"
#include "sdkconfig.h"
#include "security.h"
#include "settings.h"
#include "wifi_manager.h"

static const char *TAG = "main";

static display_t s_display;
static keypad_t s_keypad;
static app_t s_app;
static ai_client_t s_ai;
static TaskHandle_t s_ui_task;
static QueueHandle_t s_crypto_q;

#ifdef CONFIG_MT_BACKEND_PINNED_CA
extern const char backend_ca_pem_start[] asm("_binary_backend_ca_pem_start");
#define BACKEND_CA backend_ca_pem_start
#else
#define BACKEND_CA NULL
#endif

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static uint32_t now_unix(void) { struct timeval tv; gettimeofday(&tv, NULL); return (uint32_t)tv.tv_sec; }
static void log_event(const char *e) { ESP_LOGI("app", "%s", e); } /* events never carry PINs, questions or answers */
static void console_line(const char *l) { printf("%s\n", l); }
static void request_flush(void) { if (s_ui_task) xTaskNotifyGive(s_ui_task); }
static void wake_worker(void) { ai_client_wake_worker(); }

typedef struct { void (*fn)(void *); void *arg; } job_t;
static void crypto_task(void *p)
{
    (void)p;
    job_t j;
    for (;;) if (xQueueReceive(s_crypto_q, &j, portMAX_DELAY) == pdTRUE) { j.fn(j.arg); request_flush(); }
}
static void run_async(void (*fn)(void *), void *arg)
{
    job_t j = {fn, arg};
    if (xQueueSend(s_crypto_q, &j, 0) != pdTRUE) fn(arg); /* queue full: run inline rather than drop */
}

static esp_err_t init_storage(void)
{
    /* default "nvs" partition: Wi-Fi/PHY calibration. "mtdata": app data (encrypted when CONFIG_NVS_ENCRYPTION) */
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); e = nvs_flash_init(); }
    if (e != ESP_OK) return e;
#ifdef CONFIG_NVS_ENCRYPTION
    nvs_sec_cfg_t cfg;
    nvs_sec_scheme_t *scheme = nvs_flash_get_default_security_scheme(); /* HMAC or flash-encryption based, per menuconfig */
    if (!scheme) return ESP_ERR_INVALID_STATE;
    e = nvs_flash_read_security_cfg_v2(scheme, &cfg);
    if (e == ESP_ERR_NVS_SEC_HMAC_KEY_NOT_FOUND || e == ESP_ERR_NVS_KEYS_NOT_INITIALIZED) e = nvs_flash_generate_keys_v2(scheme, &cfg);
    if (e != ESP_OK) return e;
    e = nvs_flash_secure_init_partition("mtdata", &cfg);
#else
    ESP_LOGW(TAG, "NVS SEM criptografia (desenvolvimento). Ative CONFIG_NVS_ENCRYPTION em producao.");
    e = nvs_flash_init_partition("mtdata");
#endif
    return e;
}

static bool load_device_credentials(kv_store_t *kv, ai_client_cfg_t *cfg)
{
    /* written by tools/provision_device.js + nvs_partition_gen.py as NVS blobs */
    size_t l = sizeof(cfg->device_id) - 1, kl = sizeof(cfg->device_key);
    memset(cfg->device_id, 0, sizeof(cfg->device_id));
    if (kv->get(kv, "dev_id", cfg->device_id, &l) != KV_OK || l == 0) return false;
    if (kv->get(kv, "dev_key", cfg->device_key, &kl) != KV_OK || kl != sizeof(cfg->device_key)) { sec_wipe(cfg->device_key, sizeof(cfg->device_key)); return false; }
    /* optional overrides / remote access (provisioning CSV, never in source code) */
    struct { const char *key; char *dst; size_t cap; } opt[] = {
        {"lan_url", cfg->base_url, sizeof(cfg->base_url)}, {"remote_url", cfg->remote_url, sizeof(cfg->remote_url)},
        {"cf_id", cfg->cf_client_id, sizeof(cfg->cf_client_id)}, {"cf_secret", cfg->cf_client_secret, sizeof(cfg->cf_client_secret)},
    };
    for (size_t i = 0; i < sizeof(opt) / sizeof(opt[0]); i++) {
        char tmp[128];
        size_t n = sizeof(tmp) - 1;
        if (kv->get(kv, opt[i].key, tmp, &n) == KV_OK && n > 0 && n < opt[i].cap) { memcpy(opt[i].dst, tmp, n); opt[i].dst[n] = 0; }
        sec_wipe(tmp, sizeof(tmp));
    }
    return cfg->base_url[0] || cfg->remote_url[0];
}

static void ui_task(void *arg)
{
    (void)arg;
    key_event_t ev;
    TickType_t last_frame = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
        bool had_key = false;
        while (keypad_pop(&s_keypad, &ev)) {
            app_key(&s_app, ev.key);
            had_key = true;
            if (ev.key == KEY_ON) break; /* present the privacy lock frame immediately */
        }
        app_tick(&s_app);
        TickType_t now = xTaskGetTickCount();
        if (had_key || now - last_frame >= pdMS_TO_TICKS(100)) { /* keys: immediate; idle: 10 fps for blink/spinner */
            app_render(&s_app, &s_display.fb);
            display_present(&s_display);
            last_frame = now;
        }
        if (s_app.asleep) {
            display_set_power(&s_display, false);
            if (pm_enter_light_sleep() == 0) { /* woke up by a key */ }
            display_set_power(&s_display, true);
        }
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Terminal Matematico iniciando");
    if (pm_last_reset_was_power_issue()) ESP_LOGW(TAG, "recuperando de reinicio anormal; estado protegido nao e restaurado");

    ESP_ERROR_CHECK(init_storage());
    kv_store_t *kv = kv_nvs_open("mtdata", "mt");
    if (!kv) { ESP_LOGE(TAG, "armazenamento indisponivel: usando RAM"); kv = kv_memory_create(); }

    /* display */
    static uint8_t fb_mem[CONFIG_MT_DISPLAY_WIDTH * ((CONFIG_MT_DISPLAY_HEIGHT + 7) / 8)];
#ifdef CONFIG_MT_DISPLAY_CONSOLE
    display_driver_t *drv = display_driver_console(CONFIG_MT_DISPLAY_WIDTH, CONFIG_MT_DISPLAY_HEIGHT, console_line);
#else
    display_driver_t *drv = display_driver_null(CONFIG_MT_DISPLAY_WIDTH, CONFIG_MT_DISPLAY_HEIGHT);
    (void)console_line;
#endif
    ESP_ERROR_CHECK(display_init(&s_display, drv, fb_mem, sizeof(fb_mem)) == 0 ? ESP_OK : ESP_FAIL);

    /* keypad */
#ifdef CONFIG_MT_KEYPAD_MATRIX
    if (keypad_matrix_start(&s_keypad) != ESP_OK) keypad_console_start(&s_keypad);
#else
    keypad_console_start(&s_keypad);
#endif

    /* network (optional: the calculator never depends on it) */
    wifi_hal_t *wifi = wifi_manager_start(kv);
    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org"); /* time for request signatures */
    esp_netif_sntp_init(&sntp);

    ai_client_t *ai = NULL;
    ai_client_cfg_t acfg;
    memset(&acfg, 0, sizeof(acfg));
    snprintf(acfg.base_url, sizeof(acfg.base_url), "%s", CONFIG_MT_BACKEND_URL);
    snprintf(acfg.remote_url, sizeof(acfg.remote_url), "%s", CONFIG_MT_BACKEND_REMOTE_URL);
    snprintf(acfg.firmware, sizeof(acfg.firmware), "%s", esp_app_get_description()->version);
    if (load_device_credentials(kv, &acfg)) {
        acfg.transport = ai_transport_esp_create(BACKEND_CA);
        acfg.now_s = now_unix;
        ai_client_init(&s_ai, &acfg);
        ai_client_start_worker(&s_ai, 8192, 4);
        ai = &s_ai;
    } else {
        ESP_LOGW(TAG, "IA desativada: URL do backend ou credenciais do dispositivo ausentes (docs/PROVISIONING.md)");
    }
    sec_wipe(acfg.device_key, sizeof(acfg.device_key));

    camera_hal_t *cam = camera_esp_create();
#ifdef CONFIG_MT_OTA_ENABLE
    ota_hal_t *ota = ai ? ota_esp_create(ai, BACKEND_CA) : NULL;
#else
    ota_hal_t *ota = NULL;
#endif

    s_crypto_q = xQueueCreate(2, sizeof(job_t));
    xTaskCreate(crypto_task, "crypto", 6144, NULL, 3, NULL);

    app_platform_t p = {
        .kv = kv, .ai = ai, .cam = cam, .wifi = wifi, .ota = ota,
        .battery = battery_read, .now_ms = now_ms, .log = log_event,
        .run_async = run_async, .request_flush = request_flush, .wake_worker = wake_worker,
        .width = CONFIG_MT_DISPLAY_WIDTH, .height = CONFIG_MT_DISPLAY_HEIGHT,
    };
    auth_default_policy(&p.auth_policy);
    p.auth_policy.iterations = CONFIG_MT_PBKDF2_ITERATIONS;
    app_init(&s_app, &p);

    /* self-test passed (storage, display, app core): confirm a freshly installed OTA image */
    ota_mark_valid();

    xTaskCreatePinnedToCore(ui_task, "ui", 12288, NULL, 6, &s_ui_task, 0);
}
