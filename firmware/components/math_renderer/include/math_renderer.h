/*
 * Document model + 2-D reader for long content on small displays
 * (C counterpart of simulator/js/core/textLayout.js):
 *  - prose is word-wrapped (nothing is dropped; long words are hard-split)
 *  - math lines are never wrapped; horizontal scrolling snaps to token
 *    boundaries so numbers/names/operators are never cut ambiguously
 *  - memory limits are explicit (MR_MAX_DOC_BYTES / MR_MAX_LINES) and a
 *    visible "truncated" marker is added when they are hit
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "framebuffer.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MR_MAX_DOC_BYTES 64000
#define MR_MAX_LINES 4000

typedef enum { DOC_TEXT = 0, DOC_TITLE, DOC_MATH, DOC_RULE, DOC_SEP } doc_kind_t;

typedef struct {
    uint8_t kind;
    char *cells;      /* cell string, owned */
    char *rule;       /* optional annotation for math blocks (cell string), owned */
} doc_block_t;

typedef struct {
    doc_block_t *blocks;
    size_t nblocks, cap;
    size_t bytes;
    bool truncated;
    bool sensitive;   /* wipe memory on free */
} doc_t;

typedef struct {
    const char *text; /* points into a block (not NUL terminated) */
    uint16_t len;
    uint8_t kind;
    uint16_t block;
} doc_line_t;

typedef struct {
    doc_t *doc;
    doc_line_t *lines;
    size_t nlines, cap;
    size_t cursor, top, hoff;
    uint16_t cols, rows;
} reader_t;

typedef struct {
    const char *text;
    uint16_t len;
    uint8_t kind;
    bool focused, left_more, right_more;
} reader_row_t;

void doc_init(doc_t *d, bool sensitive);
/** Append a block (UTF-8). Returns false when the memory limit was reached (doc marked truncated). */
bool doc_add(doc_t *d, doc_kind_t kind, const char *utf8, const char *rule_utf8);
void doc_free(doc_t *d);

/** Word wrap a cell string; calls emit(start,len) for each line. */
void mr_wrap(const char *cells, size_t n, uint16_t cols, void (*emit)(const char *s, uint16_t len, void *u), void *u);
/** Is `i` a legal place to start showing a math line? */
bool mr_is_breakpoint(const char *cells, size_t n, size_t i);

bool reader_init(reader_t *r, doc_t *doc, uint16_t cols, uint16_t rows);
bool reader_relayout(reader_t *r, uint16_t cols, uint16_t rows);
void reader_free(reader_t *r);
void reader_move(reader_t *r, int delta);
void reader_page(reader_t *r, int dir);
void reader_home(reader_t *r);
void reader_end(reader_t *r);
bool reader_scroll_h(reader_t *r, int dir);
bool reader_can_scroll_right(const reader_t *r);
/** Row `i` of the viewport (0..rows-1); returns false past the end. */
bool reader_row(const reader_t *r, uint16_t i, reader_row_t *out);
/** Render the viewport with focus bar, continuity arrows and scrollbar. */
void reader_render(const reader_t *r, fb_t *fb, uint8_t scale, int x0);

#ifdef __cplusplus
}
#endif
