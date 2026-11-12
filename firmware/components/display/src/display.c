#include "display.h"

#include <stdio.h>
#include <string.h>

int display_init(display_t *d, display_driver_t *drv, uint8_t *storage, size_t len)
{
    memset(d, 0, sizeof(*d));
    d->drv = drv;
    if (!fb_init(&d->fb, drv->width, drv->height, storage, len)) return -1;
    return drv->init ? drv->init(drv) : 0;
}

int display_present(display_t *d)
{
    fb_t *fb = &d->fb;
    if (!fb_is_dirty(fb)) return 0;
    int r;
    if (d->drv->supports_partial) {
        r = d->drv->flush(d->drv, fb, fb->dx1, fb->dy1, fb->dx2, fb->dy2);
        d->partial_frames++;
    } else {
        r = d->drv->flush(d->drv, fb, 0, 0, fb->width, fb->height);
    }
    d->frames++;
    fb_reset_dirty(fb);
    return r;
}

int display_set_power(display_t *d, bool on) { return d->drv->set_power ? d->drv->set_power(d->drv, on) : 0; }

int display_set_invert(display_t *d, bool invert)
{
    if (d->drv->supports_invert && d->drv->set_invert) return d->drv->set_invert(d->drv, invert);
    d->sw_invert = invert; /* applied by the UI renderer */
    return 0;
}

/* ---------------- null driver ---------------- */
static int null_flush(display_driver_t *drv, const fb_t *fb, uint16_t a, uint16_t b, uint16_t c, uint16_t e)
{
    (void)drv; (void)fb; (void)a; (void)b; (void)c; (void)e;
    return 0;
}
static display_driver_t s_null = {.name = "null", .supports_partial = true, .flush = null_flush};

display_driver_t *display_driver_null(uint16_t w, uint16_t h)
{
    s_null.width = w;
    s_null.height = h;
    return &s_null;
}

/* ---------------- console mirror driver (bring-up) ---------------- */
typedef struct { void (*write_line)(const char *); } console_ctx_t;
static console_ctx_t s_console_ctx;

static int console_flush(display_driver_t *drv, const fb_t *fb, uint16_t x1, uint16_t y1, uint16_t x2, uint16_t y2)
{
    (void)x1; (void)x2; (void)y1; (void)y2;
    console_ctx_t *c = drv->ctx;
    char line[260];
    if (fb->width > sizeof(line) - 3) return -1;
    c->write_line("+--- LCD ---");
    /* two pixel rows per text line using half blocks would need UTF-8; keep pure ASCII */
    for (int y = 0; y < fb->height; y++) {
        int n = 0;
        line[n++] = '|';
        for (int x = 0; x < fb->width; x++) line[n++] = fb_get(fb, x, y) ? '#' : ' ';
        line[n++] = '|';
        line[n] = 0;
        c->write_line(line);
    }
    return 0;
}
static display_driver_t s_console = {.name = "console", .supports_partial = false, .flush = console_flush, .ctx = &s_console_ctx};

display_driver_t *display_driver_console(uint16_t w, uint16_t h, void (*write_line)(const char *))
{
    s_console.width = w;
    s_console.height = h;
    s_console_ctx.write_line = write_line;
    return &s_console;
}
