#include "mt_font.h"

#include <ctype.h>

size_t mt_utf8_decode(const char *s, uint32_t *cp)
{
    const unsigned char *u = (const unsigned char *)s;
    if (u[0] < 0x80) { *cp = u[0]; return 1; }
    if ((u[0] & 0xE0) == 0xC0 && (u[1] & 0xC0) == 0x80) { *cp = ((uint32_t)(u[0] & 0x1F) << 6) | (u[1] & 0x3F); return 2; }
    if ((u[0] & 0xF0) == 0xE0 && (u[1] & 0xC0) == 0x80 && (u[2] & 0xC0) == 0x80) {
        *cp = ((uint32_t)(u[0] & 0x0F) << 12) | ((uint32_t)(u[1] & 0x3F) << 6) | (u[2] & 0x3F);
        return 3;
    }
    if ((u[0] & 0xF8) == 0xF0 && (u[1] & 0xC0) == 0x80 && (u[2] & 0xC0) == 0x80 && (u[3] & 0xC0) == 0x80) {
        *cp = ((uint32_t)(u[0] & 0x07) << 18) | ((uint32_t)(u[1] & 0x3F) << 12) | ((uint32_t)(u[2] & 0x3F) << 6) | (u[3] & 0x3F);
        return 4;
    }
    *cp = '?';
    return 1;
}

static const mt_glyph_extra_t *find_extra(uint32_t cp)
{
    for (size_t i = 0; i < mt_font5x7_extra_count; i++) if (mt_font5x7_extra[i].codepoint == cp) return &mt_font5x7_extra[i];
    return NULL;
}

/* Latin-1 supplement letters used in Portuguese -> base letter */
static uint32_t strip_accent(uint32_t cp)
{
    static const char *map_lower = "aaaaaaaceeeeiiiidnooooo/ouuuuyty"; /* U+00E0..U+00FF */
    static const char *map_upper = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYTs"; /* U+00C0..U+00DF */
    if (cp >= 0xE0 && cp <= 0xFF) return (uint32_t)map_lower[cp - 0xE0];
    if (cp >= 0xC0 && cp <= 0xDF) return (uint32_t)map_upper[cp - 0xC0];
    if (cp == 0x2212) return '-';           /* minus sign */
    if (cp == 0x2018 || cp == 0x2019) return '\'';
    if (cp == 0x201C || cp == 0x201D) return '"';
    return '?';
}

uint32_t mt_font_drawable(uint32_t cp)
{
    if (find_extra(cp)) return cp;
    if (cp >= 0x20 && cp <= 0x7E) return cp;
    if (cp == '\n' || cp == '\t') return ' ';
    return strip_accent(cp);
}

const uint8_t *mt_font_glyph(uint32_t cp)
{
    const mt_glyph_extra_t *e = find_extra(cp);
    if (e) return e->cols;
    if (cp >= 0x20 && cp <= 0x7E) return mt_font5x7_ascii[cp - 0x20];
    return mt_font5x7_ascii['?' - 0x20];
}

const uint8_t *mt_font_tiny(char ch)
{
    char c = (char)toupper((unsigned char)ch);
    for (size_t i = 0; i < mt_font3x5_count; i++) if (mt_font3x5[i].ch == c) return mt_font3x5[i].cols;
    return NULL;
}

size_t mt_text_cells(const char *s)
{
    size_t n = 0;
    while (*s) { uint32_t cp; s += mt_utf8_decode(s, &cp); n++; }
    return n;
}

size_t mt_to_cells(const char *s, char *out, size_t len)
{
    size_t n = 0;
    if (!len) return 0;
    while (*s && n + 1 < len) {
        uint32_t cp;
        s += mt_utf8_decode(s, &cp);
        cp = mt_font_drawable(cp);
        if (cp >= 0x20 && cp <= 0x7E) { out[n++] = (char)cp; continue; }
        size_t i;
        for (i = 0; i < mt_font5x7_extra_count && i < 0x7F; i++) if (mt_font5x7_extra[i].codepoint == cp) break;
        out[n++] = (i < mt_font5x7_extra_count && i < 0x7F) ? (char)(0x80 + i) : '?';
    }
    out[n] = 0;
    return n;
}

const uint8_t *mt_cell_glyph(uint8_t c)
{
    if (c >= 0x80 && (size_t)(c - 0x80) < mt_font5x7_extra_count) return mt_font5x7_extra[c - 0x80].cols;
    if (c >= 0x20 && c <= 0x7E) return mt_font5x7_ascii[c - 0x20];
    return mt_font5x7_ascii['?' - 0x20];
}

size_t mt_cells_to_utf8(const char *cells, size_t n, char *out, size_t len)
{
    size_t o = 0;
    if (!len) return 0;
    for (size_t i = 0; i < n && cells[i]; i++) {
        uint8_t c = (uint8_t)cells[i];
        uint32_t cp = c;
        if (c >= 0x80) cp = ((size_t)(c - 0x80) < mt_font5x7_extra_count) ? mt_font5x7_extra[c - 0x80].codepoint : '?';
        char tmp[4];
        size_t l;
        if (cp < 0x80) { tmp[0] = (char)cp; l = 1; }
        else if (cp < 0x800) { tmp[0] = (char)(0xC0 | (cp >> 6)); tmp[1] = (char)(0x80 | (cp & 0x3F)); l = 2; }
        else { tmp[0] = (char)(0xE0 | (cp >> 12)); tmp[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); tmp[2] = (char)(0x80 | (cp & 0x3F)); l = 3; }
        if (o + l + 1 > len) break;
        for (size_t k = 0; k < l; k++) out[o++] = tmp[k];
    }
    out[o] = 0;
    return o;
}
