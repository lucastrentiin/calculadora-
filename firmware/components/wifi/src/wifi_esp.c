/*
 * Wi-Fi manager on ESP-IDF.
 *  - credentials kept in our own KV ("mtdata" NVS partition, encrypted when
 *    NVS encryption is enabled); the driver uses RAM storage only
 *  - round-robin over saved networks with exponential backoff
 *  - modem power save while connected; radio fully off on request
 *  - phone provisioning: SoftAP + protocomm security 1 with a random
 *    proof-of-possession shown on the LCD (wifi_provisioning manager)
 */
#ifdef ESP_PLATFORM
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "security.h"
#include "settings.h"
#include "wifi_manager.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_softap.h"

static const char *TAG = "wifi";

typedef struct {
    kv_store_t *kv;
    wifi_saved_t saved;
    volatile wifi_state_t state;
    char ssid[33];
    char error[40];
    int idx;
    uint32_t failures;
    bool started;
    esp_timer_handle_t retry;
} wifi_ctx_t;

static wifi_ctx_t s;

static void save(void) { s.kv->set(s.kv, "wifi_saved", &s.saved, sizeof(s.saved)); }

static void load(void)
{
    size_t len = sizeof(s.saved);
    if (s.kv->get(s.kv, "wifi_saved", &s.saved, &len) != KV_OK || len != sizeof(s.saved) || s.saved.n > WIFI_MAX_SAVED) memset(&s.saved, 0, sizeof(s.saved));
}

static void try_connect(void)
{
    if (!s.saved.n) { s.state = WIFI_ST_OFF; snprintf(s.error, sizeof(s.error), "nenhuma rede salva"); return; }
    if (!s.started) { esp_wifi_start(); s.started = true; }
    s.idx %= s.saved.n;
    wifi_config_t wc = {0};
    memcpy(wc.sta.ssid, s.saved.net[s.idx].ssid, strlen(s.saved.net[s.idx].ssid));
    memcpy(wc.sta.password, s.saved.net[s.idx].pass, strlen(s.saved.net[s.idx].pass));
    wc.sta.threshold.authmode = s.saved.net[s.idx].pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable = true;
    esp_wifi_set_config(WIFI_IF_STA, &wc);
    sec_wipe(&wc, sizeof(wc));
    snprintf(s.ssid, sizeof(s.ssid), "%s", s.saved.net[s.idx].ssid);
    s.state = WIFI_ST_CONNECTING;
    esp_wifi_connect();
}

static void retry_cb(void *arg) { (void)arg; try_connect(); }

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s.state == WIFI_ST_OFF) return; /* radio intentionally off */
        wifi_event_sta_disconnected_t *d = data;
        snprintf(s.error, sizeof(s.error), "desconectado (motivo %d)", d ? d->reason : -1);
        s.state = WIFI_ST_FAILED;
        s.failures++;
        s.idx++;
        esp_timer_start_once(s.retry, (uint64_t)wifi_backoff_ms(s.failures) * 1000u);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        s.state = WIFI_ST_CONNECTED;
        s.failures = 0;
        s.error[0] = 0;
        esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
        ESP_LOGI(TAG, "conectado"); /* SSID/IP not logged in production builds */
    } else if (base == WIFI_PROV_EVENT && id == WIFI_PROV_CRED_RECV) {
        wifi_sta_config_t *c = data;
        char ssid[33] = {0}, pass[65] = {0};
        memcpy(ssid, c->ssid, sizeof(c->ssid) < 32 ? sizeof(c->ssid) : 32);
        memcpy(pass, c->password, 64);
        wifi_saved_add(&s.saved, ssid, pass);
        save();
        sec_wipe(pass, sizeof(pass));
    } else if (base == WIFI_PROV_EVENT && id == WIFI_PROV_END) {
        wifi_prov_mgr_deinit();
    }
}

static wifi_state_t h_state(wifi_hal_t *w) { (void)w; return s.state; }
static const char *h_ssid(wifi_hal_t *w) { (void)w; return s.ssid; }
static int8_t h_rssi(wifi_hal_t *w)
{
    (void)w;
    wifi_ap_record_t ap;
    return esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0;
}
static const char *h_error(wifi_hal_t *w) { (void)w; return s.error; }
static int h_saved(wifi_hal_t *w, char out[][33], int max)
{
    (void)w;
    int n = 0;
    for (; n < s.saved.n && n < max; n++) memcpy(out[n], s.saved.net[n].ssid, 33);
    return n;
}
static int h_add(wifi_hal_t *w, const char *ssid, const char *pass)
{
    (void)w;
    int r = wifi_saved_add(&s.saved, ssid, pass);
    if (r == 0) { save(); s.idx = s.saved.n - 1; }
    return r;
}
static int h_remove(wifi_hal_t *w, const char *ssid)
{
    (void)w;
    int r = wifi_saved_remove(&s.saved, ssid);
    if (r == 0) save();
    if (r == 0 && strcmp(ssid, s.ssid) == 0) { s.state = WIFI_ST_OFF; esp_wifi_disconnect(); }
    return r;
}
static void h_connect(wifi_hal_t *w) { (void)w; s.failures = 0; esp_timer_stop(s.retry); try_connect(); }
static void h_off(wifi_hal_t *w)
{
    (void)w;
    s.state = WIFI_ST_OFF;
    esp_timer_stop(s.retry);
    if (s.started) { esp_wifi_stop(); s.started = false; }
}

static wifi_hal_t s_hal = {h_state, h_ssid, h_rssi, h_error, h_saved, h_add, h_remove, h_connect, h_off, NULL};

wifi_hal_t *wifi_manager_start(kv_store_t *kv)
{
    s.kv = kv;
    load();
    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t e = esp_event_loop_create_default();
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(e);
    esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap(); /* used only by phone provisioning */
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL));
    const esp_timer_create_args_t ta = {.callback = retry_cb, .name = "wifi_retry"};
    ESP_ERROR_CHECK(esp_timer_create(&ta, &s.retry));
    s.state = WIFI_ST_OFF;
    if (s.saved.n) try_connect();
    return &s_hal;
}

int wifi_manager_start_provisioning(char pop_out[9])
{
    static const char A[] = "abcdefghjkmnpqrstuvwxyz23456789";
    uint8_t r[8];
    sec_random(r, sizeof(r));
    for (int i = 0; i < 8; i++) pop_out[i] = A[r[i] % 31];
    pop_out[8] = 0;
    wifi_prov_mgr_config_t cfg = {.scheme = wifi_prov_scheme_softap, .scheme_event_handler = WIFI_PROV_EVENT_HANDLER_NONE};
    if (wifi_prov_mgr_init(cfg) != ESP_OK) return -1;
    if (!s.started) { esp_wifi_start(); s.started = true; }
    /* service name derived from the random PoP so it does not reveal the device identity */
    char service[16];
    snprintf(service, sizeof(service), "MT-%c%c%c%c", pop_out[0], pop_out[1], pop_out[2], pop_out[3]);
    esp_err_t e = wifi_prov_mgr_start_provisioning(WIFI_PROV_SECURITY_1, (const void *)pop_out, service, NULL);
    return e == ESP_OK ? 0 : -1;
}
#endif
