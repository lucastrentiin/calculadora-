#include <stdlib.h>
#include <string.h>

#include "camera_hal.h"

static const struct { const char *name; uint16_t w, h; } RES[CAM_RES_COUNT] = {
    {"QVGA", 320, 240}, {"VGA", 640, 480}, {"SVGA", 800, 600}, {"XGA", 1024, 768}, {"UXGA", 1600, 1200}, {"QXGA", 2048, 1536},
};

const char *cam_res_name(cam_res_t r) { return r < CAM_RES_COUNT ? RES[r].name : "?"; }

void cam_res_size(cam_res_t r, uint16_t *w, uint16_t *h)
{
    if (r >= CAM_RES_COUNT) r = CAM_RES_SVGA;
    *w = RES[r].w;
    *h = RES[r].h;
}

void cam_image_free(cam_image_t *img)
{
    if (img->data) {
        volatile uint8_t *p = img->data;
        for (size_t i = 0; i < img->len; i++) p[i] = 0;
        free(img->data);
    }
    memset(img, 0, sizeof(*img));
}
