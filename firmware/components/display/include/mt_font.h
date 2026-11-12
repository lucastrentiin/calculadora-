/* Bitmap fonts (data generated from simulator/js/core/font.js). */
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_FONT_CELL_W 6
#define MT_FONT_CELL_H 8
#define MT_TINY_CELL_W 4

typedef struct { uint32_t codepoint; uint8_t cols[5]; } mt_glyph_extra_t;
typedef struct { char ch; uint8_t cols[3]; } mt_glyph_tiny_t;

extern const uint8_t mt_font5x7_ascii[95][5];
extern const mt_glyph_extra_t mt_font5x7_extra[];
extern const size_t mt_font5x7_extra_count;
extern const mt_glyph_tiny_t mt_font3x5[];
extern const size_t mt_font3x5_count;

/** Decode one UTF-8 codepoint; returns bytes consumed (>=1). Invalid bytes -> '?'. */
size_t mt_utf8_decode(const char *s, uint32_t *cp);

/** Map a codepoint to something drawable: extra glyph, ASCII, accent-stripped ASCII or '?'. */
uint32_t mt_font_drawable(uint32_t cp);

/** 5x7 glyph columns for a drawable codepoint. */
const uint8_t *mt_font_glyph(uint32_t cp);

/** 3x5 glyph or NULL. */
const uint8_t *mt_font_tiny(char ch);

/** Number of drawable characters (cells) in a UTF-8 string. */
size_t mt_text_cells(const char *s);

/*
 * "Cell strings": one byte per screen cell. 0x20..0x7E are ASCII, 0x80+i is
 * extra glyph i. Text layout works on cell strings so that wrapping and
 * horizontal scrolling never split a multi-byte UTF-8 sequence.
 */
/** Convert UTF-8 to a NUL-terminated cell string; returns number of cells (truncates at len-1). */
size_t mt_to_cells(const char *utf8, char *out, size_t len);
/** Convert a cell string back to UTF-8 (for sending typed text). Returns bytes written. */
size_t mt_cells_to_utf8(const char *cells, size_t n, char *out, size_t len);
/** Glyph for one cell byte. */
const uint8_t *mt_cell_glyph(uint8_t cell);

#ifdef __cplusplus
}
#endif
