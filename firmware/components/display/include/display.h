/*
 * Display abstraction. The LCD controller has NOT been chosen yet, so the
 * firmware talks to a driver through this vtable. Drivers provided:
 *   - display_driver_null    : discards frames (tests, headless builds)
 *   - display_driver_console : mirrors the framebuffer as ASCII art on the
 *                              serial console (hardware bring-up without LCD)
 * A real controller driver must implement display_driver_t; see
 * hardware/DISPLAY.md for the data required (controller, bus, pins, init
 * sequence, contrast/bias, page layout, refresh rate).
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "framebuffer.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct display_driver {
    const char *name;
    uint16_t width, height;
    bool supports_partial;      /* can flush a dirty rectangle */
    bool supports_invert;       /* hardware inversion (high contrast) */
    int (*init)(struct display_driver *drv);
    /* Copy (part of) the framebuffer to the panel. x2/y2 exclusive. */
    int (*flush)(struct display_driver *drv, const fb_t *fb, uint16_t x1, uint16_t y1, uint16_t x2, uint16_t y2);
    int (*set_power)(struct display_driver *drv, bool on);
    int (*set_contrast)(struct display_driver *drv, uint8_t level);
    int (*set_invert)(struct display_driver *drv, bool invert);
    void *ctx;
} display_driver_t;

typedef struct {
    display_driver_t *drv;
    fb_t fb;
    bool sw_invert;  /* software inversion when the panel cannot invert */
    uint32_t frames, partial_frames;
} display_t;

int display_init(display_t *d, display_driver_t *drv, uint8_t *fb_storage, size_t fb_len);
/** Flush only what changed (or full frame when partial updates are unsupported). */
int display_present(display_t *d);
int display_set_power(display_t *d, bool on);
int display_set_invert(display_t *d, bool invert);

display_driver_t *display_driver_null(uint16_t w, uint16_t h);
display_driver_t *display_driver_console(uint16_t w, uint16_t h, void (*write_line)(const char *line));

#ifdef __cplusplus
}
#endif
