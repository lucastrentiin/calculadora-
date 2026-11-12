/*
 * Camera HAL over esp32-camera (OV3660 or compatible sensor).
 * A dedicated task owns the driver; the UI only posts commands, so sensor
 * init (hundreds of ms) never blocks key handling. Frame buffers live in
 * PSRAM. Images are never written to flash. The sensor is de-initialised
 * (and powered down through PWDN when wired) after use.
 */
#include <stdlib.h>
#include <string.h>

#include "camera_hal.h"
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "camera";

typedef enum { CMD_START, CMD_CAPTURE, CMD_STOP } cmd_t;
typedef struct { cmd_t cmd; cam_res_t res; uint8_t quality; } msg_t;

typedef struct {
    volatile cam_state_t state;
    char error[48];
    char diag[48];
    cam_image_t img;
    bool initialised;
    QueueHandle_t q;
    SemaphoreHandle_t lock;
} cam_ctx_t;

static cam_ctx_t s;

static framesize_t to_framesize(cam_res_t r)
{
    static const framesize_t M[CAM_RES_COUNT] = {FRAMESIZE_QVGA, FRAMESIZE_VGA, FRAMESIZE_SVGA, FRAMESIZE_XGA, FRAMESIZE_UXGA, FRAMESIZE_QXGA};
    return r < CAM_RES_COUNT ? M[r] : FRAMESIZE_SVGA;
}

static int parse_data_pins(int out[8])
{
    const char *p = CONFIG_MT_CAM_PIN_DATA;
    int n = 0;
    while (*p && n < 8) {
        while (*p == ' ' || *p == ',') p++;
        if (!*p) break;
        char *e;
        long v = strtol(p, &e, 10);
        if (e == p) return -1;
        out[n++] = (int)v;
        p = e;
    }
    return n;
}

static esp_err_t do_init(cam_res_t res, uint8_t quality)
{
    int d[8];
    if (parse_data_pins(d) != 8 || CONFIG_MT_CAM_PIN_XCLK < 0 || CONFIG_MT_CAM_PIN_SIOD < 0 || CONFIG_MT_CAM_PIN_SIOC < 0 ||
        CONFIG_MT_CAM_PIN_VSYNC < 0 || CONFIG_MT_CAM_PIN_HREF < 0 || CONFIG_MT_CAM_PIN_PCLK < 0 || CONFIG_MT_CAM_XCLK_HZ <= 0) {
        snprintf(s.error, sizeof(s.error), "pinos da camera nao configurados");
        return ESP_ERR_INVALID_STATE;
    }
    camera_config_t cfg = {
        .pin_pwdn = CONFIG_MT_CAM_PIN_PWDN,
        .pin_reset = CONFIG_MT_CAM_PIN_RESET,
        .pin_xclk = CONFIG_MT_CAM_PIN_XCLK,
        .pin_sccb_sda = CONFIG_MT_CAM_PIN_SIOD,
        .pin_sccb_scl = CONFIG_MT_CAM_PIN_SIOC,
        .pin_d7 = d[7], .pin_d6 = d[6], .pin_d5 = d[5], .pin_d4 = d[4],
        .pin_d3 = d[3], .pin_d2 = d[2], .pin_d1 = d[1], .pin_d0 = d[0],
        .pin_vsync = CONFIG_MT_CAM_PIN_VSYNC,
        .pin_href = CONFIG_MT_CAM_PIN_HREF,
        .pin_pclk = CONFIG_MT_CAM_PIN_PCLK,
        .xclk_freq_hz = CONFIG_MT_CAM_XCLK_HZ,
        .ledc_timer = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,
        .pixel_format = PIXFORMAT_JPEG,
        .frame_size = to_framesize(res),
        .jpeg_quality = quality,
        .fb_count = 2,
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST,
    };
    esp_err_t e = esp_camera_init(&cfg);
    if (e != ESP_OK) { snprintf(s.error, sizeof(s.error), "init falhou (%s)", esp_err_to_name(e)); return e; }
    sensor_t *sn = esp_camera_sensor_get();
    snprintf(s.diag, sizeof(s.diag), "sensor PID 0x%04x %s", sn ? sn->id.PID : 0, sn && sn->id.PID == OV3660_PID ? "(OV3660)" : "");
    s.initialised = true;
    return ESP_OK;
}

static void do_deinit(void)
{
    if (s.initialised) { esp_camera_deinit(); s.initialised = false; }
}

static void cam_task(void *arg)
{
    (void)arg;
    msg_t m;
    for (;;) {
        if (xQueueReceive(s.q, &m, portMAX_DELAY) != pdTRUE) continue;
        switch (m.cmd) {
        case CMD_START:
            s.state = CAM_STARTING;
            do_deinit();
            s.state = do_init(m.res, m.quality) == ESP_OK ? CAM_READY : CAM_ERROR;
            break;
        case CMD_CAPTURE: {
            if (!s.initialised) { s.state = CAM_ERROR; snprintf(s.error, sizeof(s.error), "camera desligada"); break; }
            s.state = CAM_CAPTURING;
            camera_fb_t *fb = esp_camera_fb_get();
            if (fb) { esp_camera_fb_return(fb); fb = esp_camera_fb_get(); } /* drop a stale frame (GRAB_LATEST) */
            if (!fb || fb->format != PIXFORMAT_JPEG || fb->len < 4) {
                if (fb) esp_camera_fb_return(fb);
                snprintf(s.error, sizeof(s.error), "falha de captura");
                s.state = CAM_ERROR;
                break;
            }
            uint8_t *copy = heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (!copy) { esp_camera_fb_return(fb); snprintf(s.error, sizeof(s.error), "sem memoria (PSRAM)"); s.state = CAM_ERROR; break; }
            memcpy(copy, fb->buf, fb->len);
            xSemaphoreTake(s.lock, portMAX_DELAY);
            cam_image_free(&s.img);
            s.img = (cam_image_t){copy, fb->len, (uint16_t)fb->width, (uint16_t)fb->height};
            xSemaphoreGive(s.lock);
            esp_camera_fb_return(fb);
            s.state = CAM_CAPTURED;
            break;
        }
        case CMD_STOP:
            do_deinit();
            xSemaphoreTake(s.lock, portMAX_DELAY);
            cam_image_free(&s.img);
            xSemaphoreGive(s.lock);
            s.state = CAM_OFF;
            break;
        }
    }
}

static void h_start(camera_hal_t *h, cam_res_t r, uint8_t q) { (void)h; s.state = CAM_STARTING; msg_t m = {CMD_START, r, q}; xQueueSend(s.q, &m, 0); }
static void h_capture(camera_hal_t *h) { (void)h; msg_t m = {CMD_CAPTURE, 0, 0}; xQueueSend(s.q, &m, 0); }
static void h_stop(camera_hal_t *h) { (void)h; msg_t m = {CMD_STOP, 0, 0}; xQueueSend(s.q, &m, 0); }
static cam_state_t h_state(camera_hal_t *h) { (void)h; return s.state; }
static const char *h_error(camera_hal_t *h) { (void)h; return s.error; }
static const char *h_diag(camera_hal_t *h) { (void)h; return s.diag[0] ? s.diag : "nao iniciada"; }
static bool h_take(camera_hal_t *h, cam_image_t *out)
{
    (void)h;
    bool ok = false;
    xSemaphoreTake(s.lock, portMAX_DELAY);
    if (s.img.data) { *out = s.img; memset(&s.img, 0, sizeof(s.img)); ok = true; s.state = CAM_READY; }
    xSemaphoreGive(s.lock);
    return ok;
}

static camera_hal_t s_hal = {h_start, h_capture, h_take, h_stop, h_state, h_error, h_diag, NULL};

camera_hal_t *camera_esp_create(void)
{
    s.q = xQueueCreate(4, sizeof(msg_t));
    s.lock = xSemaphoreCreateMutex();
    if (!s.q || !s.lock || xTaskCreate(cam_task, "camera", 4096, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "falha ao criar tarefa da camera");
        return NULL;
    }
    return &s_hal;
}

/* used by camera_preview.c */
bool camera_esp_grab_preview(uint8_t **buf, size_t *len, void **fb_out)
{
    if (!s.initialised || s.state == CAM_CAPTURING) return false;
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) return false;
    *buf = fb->buf;
    *len = fb->len;
    *fb_out = fb;
    return true;
}
void camera_esp_release_preview(void *fb) { esp_camera_fb_return((camera_fb_t *)fb); }
