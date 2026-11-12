/*
 * Camera abstraction (asynchronous: the UI never blocks on the sensor).
 * ESP implementation: esp32-camera driver (OV3660 or compatible) in its own
 * task, frame buffers in PSRAM. Pins/clock come from Kconfig and have NO
 * defaults because the module/board has not been chosen (hardware/CAMERA.md).
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { CAM_RES_QVGA = 0, CAM_RES_VGA, CAM_RES_SVGA, CAM_RES_XGA, CAM_RES_UXGA, CAM_RES_QXGA, CAM_RES_COUNT } cam_res_t;
typedef enum { CAM_OFF = 0, CAM_STARTING, CAM_READY, CAM_CAPTURING, CAM_CAPTURED, CAM_ERROR } cam_state_t;

typedef struct {
    uint8_t *data;   /* JPEG, heap/PSRAM; free with cam_image_free() */
    size_t len;
    uint16_t width, height;
} cam_image_t;

typedef struct camera_hal {
    void (*start)(struct camera_hal *h, cam_res_t res, uint8_t jpeg_quality);
    void (*capture)(struct camera_hal *h);
    /** Move the captured image out (ownership to caller). */
    bool (*take_image)(struct camera_hal *h, cam_image_t *out);
    void (*stop)(struct camera_hal *h);         /* non-blocking: powers the sensor down asynchronously */
    cam_state_t (*state)(struct camera_hal *h);
    const char *(*error)(struct camera_hal *h);
    const char *(*diag)(struct camera_hal *h);  /* sensor id / last status, no image data */
    void *ctx;
} camera_hal_t;

const char *cam_res_name(cam_res_t r);
void cam_res_size(cam_res_t r, uint16_t *w, uint16_t *h);
void cam_image_free(cam_image_t *img); /* wipes then frees */

#ifdef ESP_PLATFORM
camera_hal_t *camera_esp_create(void);
/* Optional local preview page (see camera_preview.c / docs/CAMERA_PREVIEW.md) */
typedef void (*cam_preview_capture_cb)(void *ctx);
int camera_preview_start(camera_hal_t *cam, char code_out[9], cam_preview_capture_cb cb, void *ctx);
void camera_preview_stop(void);
bool camera_preview_active(void);
#endif

#ifdef __cplusplus
}
#endif
