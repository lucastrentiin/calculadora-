/* Camera disabled in menuconfig (CONFIG_MT_CAMERA_ENABLE=n). */
#ifdef ESP_PLATFORM
#include "camera_hal.h"

camera_hal_t *camera_esp_create(void) { return NULL; }
int camera_preview_start(camera_hal_t *cam, char code_out[9], cam_preview_capture_cb cb, void *ctx)
{
    (void)cam; (void)cb; (void)ctx;
    code_out[0] = 0;
    return -1;
}
void camera_preview_stop(void) {}
bool camera_preview_active(void) { return false; }
#endif
