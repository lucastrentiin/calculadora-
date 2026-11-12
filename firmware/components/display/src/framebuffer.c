#include "framebuffer.h"

#include <string.h>

#include "mt_font.h"

size_t fb_bytes(uint16_t w, uint16_t h) { return (size_t)w * ((h + 7u) / 8u); }

bool fb_init(fb_t *fb, uint16_t w, uint16_t h, uint8_t *storage, size_t len)
{
    if (!fb || !storage || w == 0 || h == 0 || len < fb_bytes(w, h)) return false;
    fb->width = w;
    fb->height = h;
    fb->buf = storage;
    fb_clear(fb);
    return true;
}

void fb_reset_dirty(fb_t *fb) { fb->dx1 = fb->dy1 = fb->dx2 = fb->dy2 = 0; }
bool fb_is_dirty(const fb_t *fb) { return fb->dx2 > fb->dx1 && fb->dy2 > fb->dy1; }

void fb_mark_dirty(fb_t *fb, int x, int y, int w, int h)
{
    int x1 = x < 0 ? 0 : x, y1 = y < 0 ? 0 : y;
    int x2 = x + w > fb->width ? fb->width : x + w;
    int y2 = y + h > fb->height ? fb->height : y + h;
    if (x2 <= x1 || y2 <= y1) return;
    if (!fb_is_dirty(fb)) { fb->dx1 = (uint16_t)x1; fb->dy1 = (uint16_t)y1; fb->dx2 = (uint16_t)x2; fb->dy2 = (uint16_t)y2; return; }
    if (x1 < fb->dx1) fb->dx1 = (uint16_t)x1;
    if (y1 < fb->dy1) fb->dy1 = (uint16_t)y1;
    if (x2 > fb->dx2) fb->dx2 = (uint16_t)x2;
    if (y2 > fb->dy2) fb->dy2 = (uint16_t)y2;
}

void fb_clear(fb_t *fb)
{
    memset(fb->buf, 0, fb_bytes(fb->width, fb->height));
    fb_mark_dirty(fb, 0, 0, fb->width, fb->height);
}

void fb_set(fb_t *fb, int x, int y, bool on)
{
    if (x < 0 || y < 0 || x >= fb->width || y >= fb->height) return;
    uint8_t *b = &fb->buf[(size_t)(y >> 3) * fb->width + (size_t)x];
    uint8_t m = (uint8_t)(1u << (y & 7));
    uint8_t nv = on ? (uint8_t)(*b | m) : (uint8_t)(*b & ~m);
    if (nv != *b) { *b = nv; fb_mark_dirty(fb, x, y, 1, 1); }
}

bool fb_get(const fb_t *fb, int x, int y)
{
    if (x < 0 || y < 0 || x >= fb->width || y >= fb->height) return false;
    return (fb->buf[(size_t)(y >> 3) * fb->width + (size_t)x] >> (y & 7)) & 1u;
}

void fb_fill_rect(fb_t *fb, int x, int y, int w, int h, bool on)
{
    for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) fb_set(fb, i, j, on);
}

void fb_invert_rect(fb_t *fb, int x, int y, int w, int h)
{
    for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) {
        if (i < 0 || j < 0 || i >= fb->width || j >= fb->height) continue;
        fb_set(fb, i, j, !fb_get(fb, i, j));
    }
}

void fb_hline(fb_t *fb, int x, int y, int w) { fb_fill_rect(fb, x, y, w, 1, true); }
void fb_vline(fb_t *fb, int x, int y, int h) { fb_fill_rect(fb, x, y, 1, h, true); }
void fb_rect(fb_t *fb, int x, int y, int w, int h)
{
    fb_hline(fb, x, y, w); fb_hline(fb, x, y + h - 1, w);
    fb_vline(fb, x, y, h); fb_vline(fb, x + w - 1, y, h);
}

static int draw_cols(fb_t *fb, int x, int y, const uint8_t *g, uint8_t scale, bool invert)
{
    if (invert) fb_fill_rect(fb, x, y, MT_FONT_CELL_W * scale, MT_FONT_CELL_H * scale, true);
    for (int cx = 0; cx < 5; cx++)
        for (int cy = 0; cy < 7; cy++)
            if (g[cx] & (1u << cy)) fb_fill_rect(fb, x + cx * scale, y + cy * scale, scale, scale, !invert);
    return MT_FONT_CELL_W * scale;
}

static int draw_glyph(fb_t *fb, int x, int y, uint32_t cp, uint8_t scale, bool invert)
{
    return draw_cols(fb, x, y, mt_font_glyph(cp), scale, invert);
}

int fb_cells(fb_t *fb, int x, int y, const char *cells, size_t n, uint8_t scale, bool invert)
{
    int cx = x;
    if (!scale) scale = 1;
    for (size_t i = 0; i < n && cells[i] && cx < fb->width; i++) cx += draw_cols(fb, cx, y, mt_cell_glyph((uint8_t)cells[i]), scale, invert);
    return cx - x;
}

int fb_text(fb_t *fb, int x, int y, const char *s, const fb_text_opts_t *o)
{
    uint8_t scale = (o && o->scale) ? o->scale : 1;
    bool inv = o && o->invert;
    int cx = x;
    while (*s && cx < fb->width) {
        uint32_t cp;
        s += mt_utf8_decode(s, &cp);
        cx += draw_glyph(fb, cx, y, mt_font_drawable(cp), scale, inv);
    }
    return cx - x;
}

int fb_text_slice(fb_t *fb, int x, int y, const char *s, size_t first, size_t max_cells, uint8_t scale)
{
    size_t idx = 0, drawn = 0;
    int cx = x;
    if (!scale) scale = 1;
    while (*s && drawn < max_cells) {
        uint32_t cp;
        s += mt_utf8_decode(s, &cp);
        if (idx++ < first) continue;
        cx += draw_glyph(fb, cx, y, mt_font_drawable(cp), scale, false);
        drawn++;
    }
    return cx - x;
}

int fb_tiny(fb_t *fb, int x, int y, const char *s)
{
    int cx = x;
    for (; *s; s++) {
        const uint8_t *g = mt_font_tiny(*s);
        if (g) for (int i = 0; i < 3; i++) for (int j = 0; j < 5; j++) if (g[i] & (1u << j)) fb_set(fb, cx + i, y + j, true);
        cx += MT_TINY_CELL_W;
    }
    return cx - x;
}
