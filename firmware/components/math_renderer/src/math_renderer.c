#include "math_renderer.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "mt_font.h"

static const char TRUNC_MSG[] = "[conteudo truncado: limite de memoria]";

static void secure_free(void *p, size_t n, bool wipe)
{
    if (!p) return;
    if (wipe) { volatile char *v = p; while (n--) *v++ = 0; }
    free(p);
}

void doc_init(doc_t *d, bool sensitive)
{
    memset(d, 0, sizeof(*d));
    d->sensitive = sensitive;
}

static char *to_cells_alloc(const char *utf8, size_t *out_len)
{
    size_t cap = strlen(utf8) + 1; /* cells never exceed bytes */
    char *c = malloc(cap);
    if (!c) return NULL;
    *out_len = mt_to_cells(utf8, c, cap);
    return c;
}

bool doc_add(doc_t *d, doc_kind_t kind, const char *utf8, const char *rule)
{
    if (d->truncated) return false;
    size_t need = strlen(utf8) + (rule ? strlen(rule) : 0);
    if (d->bytes + need > MR_MAX_DOC_BYTES) { d->truncated = true; return false; }
    if (d->nblocks == d->cap) {
        size_t nc = d->cap ? d->cap * 2 : 16;
        doc_block_t *nb = realloc(d->blocks, nc * sizeof(*nb));
        if (!nb) { d->truncated = true; return false; }
        d->blocks = nb;
        d->cap = nc;
    }
    doc_block_t *b = &d->blocks[d->nblocks];
    size_t l;
    b->kind = (uint8_t)kind;
    b->cells = to_cells_alloc(utf8, &l);
    b->rule = NULL;
    if (!b->cells) { d->truncated = true; return false; }
    if (rule && *rule) {
        b->rule = to_cells_alloc(rule, &l);
        if (!b->rule) { free(b->cells); d->truncated = true; return false; }
    }
    d->bytes += need;
    d->nblocks++;
    return true;
}

void doc_free(doc_t *d)
{
    for (size_t i = 0; i < d->nblocks; i++) {
        if (d->blocks[i].cells) secure_free(d->blocks[i].cells, strlen(d->blocks[i].cells), d->sensitive);
        if (d->blocks[i].rule) secure_free(d->blocks[i].rule, strlen(d->blocks[i].rule), d->sensitive);
    }
    free(d->blocks);
    memset(d, 0, sizeof(*d));
}

/* ------------------------------------------------------------------ */

void mr_wrap(const char *s, size_t n, uint16_t cols, void (*emit)(const char *, uint16_t, void *), void *u)
{
    if (cols < 1) cols = 1;
    size_t i = 0;
    if (n == 0) { emit(s, 0, u); return; }
    while (i < n) {
        if (s[i] == ' ') { i++; continue; }
        size_t start = i, last_break = 0;
        size_t j = i;
        while (j < n && j - start < cols) {
            if (s[j] == ' ') last_break = j;
            j++;
        }
        if (j >= n) { emit(s + start, (uint16_t)(n - start), u); return; }
        if (s[j] == ' ') { emit(s + start, (uint16_t)(j - start), u); i = j + 1; continue; }
        if (last_break > start) { emit(s + start, (uint16_t)(last_break - start), u); i = last_break + 1; continue; }
        emit(s + start, cols, u); /* hard split of a word longer than the line */
        i = start + cols;
    }
}

static bool is_word(char c) { return isalnum((unsigned char)c) || c == '_' || c == '.'; }

bool mr_is_breakpoint(const char *s, size_t n, size_t i)
{
    if (i == 0) return true;
    if (i >= n) return false;
    char a = s[i - 1], b = s[i];
    if (is_word(a) && is_word(b)) return false;
    if (b == '-' && a == 'E' && i >= 2 && isdigit((unsigned char)s[i - 2])) return false;
    if ((a == '-' || a == '+') && i >= 3 && s[i - 2] == 'E' && isdigit((unsigned char)s[i - 3])) return false;
    return true;
}

/* ------------------------------------------------------------------ */

typedef struct { reader_t *r; uint8_t kind; uint16_t block; bool full; } emit_ctx_t;

static void push_line(emit_ctx_t *c, const char *s, uint16_t len)
{
    reader_t *r = c->r;
    if (c->full) return;
    if (r->nlines >= MR_MAX_LINES) { c->full = true; return; }
    if (r->nlines == r->cap) {
        size_t nc = r->cap ? r->cap * 2 : 64;
        if (nc > MR_MAX_LINES + 1) nc = MR_MAX_LINES + 1;
        doc_line_t *nl = realloc(r->lines, nc * sizeof(*nl));
        if (!nl) { c->full = true; return; }
        r->lines = nl;
        r->cap = nc;
    }
    r->lines[r->nlines++] = (doc_line_t){s, len, c->kind, c->block};
}

static void emit_cb(const char *s, uint16_t len, void *u) { push_line(u, s, len); }

static bool layout(reader_t *r)
{
    r->nlines = 0;
    emit_ctx_t c = {r, 0, 0, false};
    for (size_t b = 0; b < r->doc->nblocks && !c.full; b++) {
        doc_block_t *blk = &r->doc->blocks[b];
        c.block = (uint16_t)b;
        if (blk->kind == DOC_SEP) { c.kind = DOC_SEP; push_line(&c, "", 0); continue; }
        if (blk->kind == DOC_MATH) {
            if (blk->rule) { c.kind = DOC_RULE; mr_wrap(blk->rule, strlen(blk->rule), r->cols, emit_cb, &c); }
            c.kind = DOC_MATH;
            push_line(&c, blk->cells, (uint16_t)strlen(blk->cells));
            continue;
        }
        c.kind = blk->kind;
        mr_wrap(blk->cells, strlen(blk->cells), r->cols, emit_cb, &c);
    }
    if (c.full || r->doc->truncated) {
        if (r->nlines >= MR_MAX_LINES) r->nlines = MR_MAX_LINES - 1;
        c.full = false;
        c.kind = DOC_TEXT;
        push_line(&c, TRUNC_MSG, (uint16_t)strlen(TRUNC_MSG));
    }
    return true;
}

static void ensure_visible(reader_t *r)
{
    if (r->cursor < r->top) r->top = r->cursor;
    if (r->cursor >= r->top + r->rows) r->top = r->cursor - r->rows + 1;
    size_t max_top = r->nlines > r->rows ? r->nlines - r->rows : 0;
    if (r->top > max_top) r->top = max_top;
}

bool reader_init(reader_t *r, doc_t *doc, uint16_t cols, uint16_t rows)
{
    memset(r, 0, sizeof(*r));
    r->doc = doc;
    r->cols = cols ? cols : 1;
    r->rows = rows ? rows : 1;
    return layout(r);
}

bool reader_relayout(reader_t *r, uint16_t cols, uint16_t rows)
{
    uint16_t block = r->nlines ? r->lines[r->cursor].block : 0;
    r->cols = cols; r->rows = rows;
    layout(r);
    r->cursor = 0;
    for (size_t i = 0; i < r->nlines; i++) if (r->lines[i].block == block) { r->cursor = i; break; }
    r->hoff = 0;
    ensure_visible(r);
    return true;
}

void reader_free(reader_t *r) { free(r->lines); memset(r, 0, sizeof(*r)); }

void reader_move(reader_t *r, int delta)
{
    if (!r->nlines) return;
    long c = (long)r->cursor + delta;
    if (c < 0) c = 0;
    if (c > (long)r->nlines - 1) c = (long)r->nlines - 1;
    if ((size_t)c != r->cursor) { r->cursor = (size_t)c; r->hoff = 0; }
    ensure_visible(r);
}

void reader_page(reader_t *r, int dir) { reader_move(r, dir * (r->rows > 1 ? r->rows - 1 : 1)); }
void reader_home(reader_t *r) { r->cursor = r->top = r->hoff = 0; }
void reader_end(reader_t *r) { reader_move(r, (int)r->nlines); }

bool reader_can_scroll_right(const reader_t *r)
{
    if (!r->nlines) return false;
    const doc_line_t *l = &r->lines[r->cursor];
    return l->kind == DOC_MATH && l->len > r->hoff + r->cols;
}

bool reader_scroll_h(reader_t *r, int dir)
{
    if (!r->nlines) return false;
    const doc_line_t *l = &r->lines[r->cursor];
    if (l->kind != DOC_MATH) return false;
    size_t step = r->cols > 4 ? r->cols - 4 : 1;
    if (dir > 0) {
        if (!reader_can_scroll_right(r)) return false;
        size_t next = r->hoff;
        for (size_t i = r->hoff + 1; i <= r->hoff + step && i < l->len; i++) if (mr_is_breakpoint(l->text, l->len, i)) next = i;
        if (next == r->hoff) { /* token wider than the window: go to the next breakpoint */
            next = r->hoff + 1;
            while (next < l->len && !mr_is_breakpoint(l->text, l->len, next)) next++;
        }
        r->hoff = next;
        return true;
    }
    if (r->hoff == 0) return false;
    size_t limit = r->hoff > step ? r->hoff - step : 0, prev = 0;
    for (size_t i = limit; i < r->hoff; i++) if (mr_is_breakpoint(l->text, l->len, i)) { prev = i; break; }
    r->hoff = prev;
    return true;
}

bool reader_row(const reader_t *r, uint16_t i, reader_row_t *o)
{
    size_t li = r->top + i;
    if (i >= r->rows || li >= r->nlines) return false;
    const doc_line_t *l = &r->lines[li];
    size_t off = (li == r->cursor && l->kind == DOC_MATH) ? r->hoff : 0;
    if (off > l->len) off = l->len;
    o->text = l->text + off;
    o->len = (uint16_t)((l->len - off) > r->cols ? r->cols : (l->len - off));
    o->kind = l->kind;
    o->focused = li == r->cursor;
    o->left_more = off > 0;
    o->right_more = l->kind == DOC_MATH && l->len - off > r->cols;
    return true;
}

static void arrow_right(fb_t *fb, int x, int y) { fb_vline(fb, x, y, 5); fb_vline(fb, x + 1, y + 1, 3); fb_set(fb, x + 2, y + 2, true); }
static void arrow_left(fb_t *fb, int x, int y) { fb_set(fb, x, y + 2, true); fb_vline(fb, x + 1, y + 1, 3); fb_vline(fb, x + 2, y, 5); }

void reader_render(const reader_t *r, fb_t *fb, uint8_t scale, int x0)
{
    int ch = 8 * scale, cw = 6 * scale;
    for (uint16_t i = 0; i < r->rows; i++) {
        reader_row_t row;
        if (!reader_row(r, i, &row)) break;
        int y = i * ch;
        fb_cells(fb, x0, y, row.text, row.len, scale, false);
        if (row.kind == DOC_TITLE) fb_hline(fb, x0, y + ch - 1, (row.len ? row.len : 1) * cw);
        if (row.kind == DOC_RULE) for (int x = x0; x < x0 + row.len * cw; x += 2) fb_set(fb, x, y + ch - 1, true);
        if (row.focused) { if (row.left_more) arrow_left(fb, 0, y + 1); else fb_vline(fb, 0, y, ch - 1); }
        if (row.right_more) arrow_right(fb, fb->width - 5, y + 1);
    }
    if (r->nlines > r->rows) {
        int h = fb->height, x = fb->width - 2;
        fb_vline(fb, x + 1, 0, h);
        int bh = (int)(h * r->rows / r->nlines); if (bh < 2) bh = 2;
        size_t span = r->nlines - r->rows;
        int by = (int)((h - bh) * r->top / (span ? span : 1));
        fb_fill_rect(fb, x, by, 1, bh, true);
    }
}
