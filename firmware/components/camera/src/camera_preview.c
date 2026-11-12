/*
 * Optional phone preview of the camera on the LOCAL network.
 *  - only started from the protected CAMERA screen (after PIN authentication)
 *  - random 8-character session code shown on the LCD; every request must
 *    carry it (?c=CODE). 5 wrong codes or 120 s -> session ends automatically
 *  - low resolution MJPEG stream + capture button; nothing is stored
 *  - the server listens on the station interface only while the session lives;
 *    it is never exposed to the internet (no port forwarding, no cloud relay)
 * Limitations (docs/CAMERA_PREVIEW.md): plain HTTP on the LAN (no TLS: phones
 * reject self-signed certificates), ~1-5 fps depending on Wi-Fi/hotspot,
 * phone hotspots often isolate clients (preview then unavailable, the device
 * keeps working without it).
 */
#include "sdkconfig.h"
#ifdef CONFIG_MT_CAM_PREVIEW
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "camera_hal.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "security.h"

bool camera_esp_grab_preview(uint8_t **buf, size_t *len, void **fb_out);
void camera_esp_release_preview(void *fb);

static const char *TAG = "preview";
static httpd_handle_t s_srv;
static char s_code[9];
static int s_bad;
static int64_t s_started;
static cam_preview_capture_cb s_cb;
static void *s_cb_ctx;
static esp_timer_handle_t s_timer;

static const char PAGE[] =
    "<!doctype html><html><head><meta name=viewport content='width=device-width'><title>Previa</title></head>"
    "<body style='margin:0;background:#111;color:#eee;font-family:sans-serif;text-align:center'>"
    "<p id=s>conectado</p><img id=v style='width:100%;max-width:640px'><p><button id=b style='font-size:24px;padding:16px 32px'>Capturar</button></p>"
    "<script>var q=location.search;document.getElementById('v').src='/stream'+q;"
    "document.getElementById('b').onclick=function(){fetch('/capture'+q,{method:'POST'}).then(function(r){document.getElementById('s').textContent=r.ok?'capturado':'sessao encerrada'})};"
    "document.getElementById('v').onerror=function(){document.getElementById('s').textContent='desconectado'}</script></body></html>";

static bool authorised(httpd_req_t *req)
{
    char q[48], c[16];
    if (!s_code[0]) return false;
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK || httpd_query_key_value(q, "c", c, sizeof(c)) != ESP_OK ||
        strlen(c) != 8 || !sec_ct_equal(c, s_code, 8)) {
        if (++s_bad >= 5) { ESP_LOGW(TAG, "codigo incorreto repetido: encerrando"); camera_preview_stop(); }
        return false;
    }
    return true;
}

static esp_err_t page_h(httpd_req_t *req)
{
    if (!authorised(req)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "codigo invalido");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, PAGE, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t stream_h(httpd_req_t *req)
{
    if (!authorised(req)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "codigo invalido");
    httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=mtframe");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    char hdr[80];
    while (s_code[0]) {
        uint8_t *buf; size_t len; void *fb;
        if (!camera_esp_grab_preview(&buf, &len, &fb)) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        int hl = snprintf(hdr, sizeof(hdr), "\r\n--mtframe\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", (unsigned)len);
        esp_err_t e = httpd_resp_send_chunk(req, hdr, hl);
        if (e == ESP_OK) e = httpd_resp_send_chunk(req, (const char *)buf, (ssize_t)len);
        camera_esp_release_preview(fb);
        if (e != ESP_OK) break;
        vTaskDelay(pdMS_TO_TICKS(150));
    }
    return ESP_OK;
}

static esp_err_t capture_h(httpd_req_t *req)
{
    if (!authorised(req)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "codigo invalido");
    if (s_cb) s_cb(s_cb_ctx);
    return httpd_resp_send(req, "ok", 2);
}

static void expire_cb(void *arg) { (void)arg; camera_preview_stop(); }

int camera_preview_start(camera_hal_t *cam, char code_out[9], cam_preview_capture_cb cb, void *ctx)
{
    (void)cam;
    if (s_srv) camera_preview_stop();
    static const char A[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; /* no ambiguous 0/O/1/I */
    uint8_t r[8];
    sec_random(r, sizeof(r));
    for (int i = 0; i < 8; i++) s_code[i] = A[r[i] % 32];
    s_code[8] = 0;
    memcpy(code_out, s_code, 9);
    s_bad = 0;
    s_cb = cb;
    s_cb_ctx = ctx;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_open_sockets = 2;
    cfg.lru_purge_enable = true;
    if (httpd_start(&s_srv, &cfg) != ESP_OK) { s_code[0] = 0; return -1; }
    const httpd_uri_t u1 = {.uri = "/", .method = HTTP_GET, .handler = page_h};
    const httpd_uri_t u2 = {.uri = "/stream", .method = HTTP_GET, .handler = stream_h};
    const httpd_uri_t u3 = {.uri = "/capture", .method = HTTP_POST, .handler = capture_h};
    httpd_register_uri_handler(s_srv, &u1);
    httpd_register_uri_handler(s_srv, &u2);
    httpd_register_uri_handler(s_srv, &u3);
    const esp_timer_create_args_t ta = {.callback = expire_cb, .name = "pv_expire"};
    if (!s_timer) esp_timer_create(&ta, &s_timer);
    esp_timer_start_once(s_timer, 120 * 1000000LL);
    s_started = esp_timer_get_time();
    ESP_LOGI(TAG, "previa ativa por 120 s"); /* the code itself is never logged */
    return 0;
}

void camera_preview_stop(void)
{
    sec_wipe(s_code, sizeof(s_code));
    if (s_timer) esp_timer_stop(s_timer);
    if (s_srv) { httpd_stop(s_srv); s_srv = NULL; }
}

bool camera_preview_active(void) { return s_srv != NULL; }
#else
#include "camera_hal.h"
int camera_preview_start(camera_hal_t *cam, char code_out[9], cam_preview_capture_cb cb, void *ctx)
{
    (void)cam; (void)cb; (void)ctx;
    code_out[0] = 0;
    return -1;
}
void camera_preview_stop(void) {}
bool camera_preview_active(void) { return false; }
#endif
