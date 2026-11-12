/*
 * 1-bit framebuffer, page-organised (8 vertical pixels per byte, LSB on top),
 * which is the native memory layout of most monochrome LCD controllers.
 * Resolution is a runtime parameter: nothing assumes 128x32.
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t width, height;
    uint8_t *buf;            /* width * ceil(height/8) bytes */
    /* dirty rectangle for partial updates; x2/y2 exclusive; empty when x2 == 0 */
    uint16_t dx1, dy1, dx2, dy2;
} fb_t;

typedef struct { bool invert; uint8_t scale; } fb_text_opts_t;

bool fb_init(fb_t *fb, uint16_t w, uint16_t h, uint8_t *storage, size_t storage_len);
size_t fb_bytes(uint16_t w, uint16_t h);
void fb_clear(fb_t *fb);
void fb_mark_dirty(fb_t *fb, int x, int y, int w, int h);
void fb_reset_dirty(fb_t *fb);
bool fb_is_dirty(const fb_t *fb);
void fb_set(fb_t *fb, int x, int y, bool on);
bool fb_get(const fb_t *fb, int x, int y);
void fb_fill_rect(fb_t *fb, int x, int y, int w, int h, bool on);
void fb_invert_rect(fb_t *fb, int x, int y, int w, int h);
void fb_hline(fb_t *fb, int x, int y, int w);
void fb_vline(fb_t *fb, int x, int y, int h);
void fb_rect(fb_t *fb, int x, int y, int w, int h);
/** Draw UTF-8 text with the 5x7 font; returns width in pixels. */
int fb_text(fb_t *fb, int x, int y, const char *utf8, const fb_text_opts_t *opts);
/** Draw at most `max_cells` characters starting at character index `first`. */
int fb_text_slice(fb_t *fb, int x, int y, const char *utf8, size_t first, size_t max_cells, uint8_t scale);
/** Draw `n` cells of a cell string (see mt_font.h). */
int fb_cells(fb_t *fb, int x, int y, const char *cells, size_t n, uint8_t scale, bool invert);
/** Draw text with the 3x5 font (status bar). */
int fb_tiny(fb_t *fb, int x, int y, const char *ascii);

#ifdef __cplusplus
}
#endif
