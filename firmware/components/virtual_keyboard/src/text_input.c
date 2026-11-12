#include "text_input.h"

#include <ctype.h>
#include <string.h>

/* ------------------------------ textbuf ------------------------------ */

void textbuf_init(textbuf_t *b, uint16_t max)
{
    memset(b, 0, sizeof(*b));
    b->max = (max == 0 || max > TEXTBUF_MAX) ? TEXTBUF_MAX : max;
}

bool textbuf_insert(textbuf_t *b, char c)
{
    if (b->len >= b->max) return false;
    memmove(&b->data[b->cursor + 1], &b->data[b->cursor], (size_t)(b->len - b->cursor));
    b->data[b->cursor++] = c;
    b->data[++b->len] = 0;
    return true;
}

bool textbuf_insert_str(textbuf_t *b, const char *s)
{
    while (*s) if (!textbuf_insert(b, *s++)) return false;
    return true;
}

void textbuf_replace_before_cursor(textbuf_t *b, char c) { if (b->cursor > 0) b->data[b->cursor - 1] = c; }

bool textbuf_backspace(textbuf_t *b)
{
    if (b->cursor == 0) return false;
    memmove(&b->data[b->cursor - 1], &b->data[b->cursor], (size_t)(b->len - b->cursor));
    b->cursor--;
    b->data[--b->len] = 0;
    return true;
}

void textbuf_left(textbuf_t *b) { if (b->cursor > 0) b->cursor--; }
void textbuf_right(textbuf_t *b) { if (b->cursor < b->len) b->cursor++; }

void textbuf_wipe(textbuf_t *b)
{
    volatile char *p = b->data;
    for (size_t i = 0; i < sizeof(b->data); i++) p[i] = 0;
    b->len = b->cursor = 0;
}

/* ------------------------------ multi-tap ---------------------------- */

static const char *const MT_MAP[10] = {
    " 0", ".,?!'-():;1", "abc2", "def3", "ghi4", "jkl5", "mno6", "pqrs7", "tuv8", "wxyz9",
};

void multitap_init(multitap_t *m, textbuf_t *buf, uint32_t timeout_ms)
{
    memset(m, 0, sizeof(*m));
    m->buf = buf;
    m->timeout_ms = timeout_ms ? timeout_ms : 900;
}

static char apply_case(const multitap_t *m, char c)
{
    return (m->mode == MT_CASE_UPPER || m->mode == MT_CASE_FIRST) ? (char)toupper((unsigned char)c) : c;
}

void multitap_commit(multitap_t *m)
{
    if (!m->pending) return;
    m->pending = false;
    if (m->mode == MT_CASE_FIRST) m->mode = MT_CASE_LOWER;
}

bool multitap_press(multitap_t *m, char digit, uint32_t now)
{
    if (digit < '0' || digit > '9') return false;
    const char *opts = MT_MAP[digit - '0'];
    size_t n = strlen(opts);
    if (m->mode == MT_CASE_NUM) { multitap_commit(m); return textbuf_insert(m->buf, digit); }
    if (m->pending && m->key == digit && now - m->at < m->timeout_ms) {
        m->idx = (uint8_t)((m->idx + 1) % n);
        m->at = now;
        textbuf_replace_before_cursor(m->buf, apply_case(m, opts[m->idx]));
        return true;
    }
    multitap_commit(m);
    if (!textbuf_insert(m->buf, apply_case(m, opts[0]))) return false;
    m->pending = true;
    m->key = digit;
    m->idx = 0;
    m->at = now;
    return true;
}

void multitap_tick(multitap_t *m, uint32_t now) { if (m->pending && now - m->at >= m->timeout_ms) multitap_commit(m); }

void multitap_cycle_case(multitap_t *m)
{
    multitap_commit(m);
    m->mode = (mt_case_t)((m->mode + 1) % 4);
}

const char *multitap_case_name(const multitap_t *m)
{
    static const char *const N[] = {"abc", "Abc", "ABC", "123"};
    return N[m->mode];
}

/* ------------------------------ virtual keyboard --------------------- */

#define K(c) {(const char[]){c, 0}, c, 1, VK_INSERT}
/* extra glyph cells: index into mt_font5x7_extra (generated order) + 0x80 */
#define X(i) {(const char[]){(char)(0x80 + (i)), 0}, (char)(0x80 + (i)), 1, VK_INSERT}

/* labels are cell strings: 0x88 up arrow, 0x86 left, 0x87 right, 0x9C triangle (see font EXTRA order) */
static const vk_key_t BOTTOM[] = {
    {"\x88", 0, 1, VK_SHIFT}, {"#", 0, 1, VK_PAGE}, {"_", ' ', 3, VK_INSERT}, {"\x86", 0, 1, VK_LEFT},
    {"\x87", 0, 1, VK_RIGHT}, {"<", 0, 1, VK_DEL}, {"\x9c", 0, 1, VK_OK},
};

static const vk_key_t P0R0[] = {K('q'), K('w'), K('e'), K('r'), K('t'), K('y'), K('u'), K('i'), K('o'), K('p')};
static const vk_key_t P0R1[] = {K('a'), K('s'), K('d'), K('f'), K('g'), K('h'), K('j'), K('k'), K('l'), K('?')};
static const vk_key_t P0R2[] = {K('z'), K('x'), K('c'), K('v'), K('b'), K('n'), K('m'), K(','), K('.'), K('-')};
static const vk_key_t P1R0[] = {K('1'), K('2'), K('3'), K('4'), K('5'), K('6'), K('7'), K('8'), K('9'), K('0')};
static const vk_key_t P1R1[] = {K('+'), K('-'), K('*'), K('/'), K('='), K('('), K(')'), K('^'), K('%'), K('.')};
static const vk_key_t P1R2[] = {K('!'), K('?'), K(':'), K(';'), K(','), K('\''), K('"'), K('@'), K('&'), K('$')};
/* math page: extra glyph order is defined by simulator/js/core/font.js EXTRA (π √ ² ° × ÷ ← → ↑ ↓ θ Σ µ Ω Δ ± ≠ ≤ ≥ ∞ α λ ρ · ³ ...) */
static const vk_key_t P2R0[] = {X(0), X(1), X(2), X(24), X(3), X(15), X(16), X(17), X(18), X(19)};
static const vk_key_t P2R1[] = {X(10), X(20), X(21), X(12), X(14), X(13), X(11), K('<'), K('>'), K('|')};
static const vk_key_t P2R2[] = {K('['), K(']'), K('{'), K('}'), K('_'), K('~'), K('\\'), K('x'), K('y'), K('z')};

typedef struct { const char *name; const vk_key_t *rows[3]; uint8_t n[3]; } vk_page_t;
static const vk_page_t PAGES[] = {
    {"abc", {P0R0, P0R1, P0R2}, {10, 10, 10}},
    {"123", {P1R0, P1R1, P1R2}, {10, 10, 10}},
    {"mat", {P2R0, P2R1, P2R2}, {10, 10, 10}},
};
#define NPAGES (sizeof(PAGES) / sizeof(PAGES[0]))

void vkbd_init(vkbd_t *k) { memset(k, 0, sizeof(*k)); }

const vk_key_t *vkbd_row(const vkbd_t *k, uint8_t row, uint8_t *count)
{
    if (row == 3) { *count = (uint8_t)(sizeof(BOTTOM) / sizeof(BOTTOM[0])); return BOTTOM; }
    *count = PAGES[k->page].n[row];
    return PAGES[k->page].rows[row];
}

const char *vkbd_page_name(const vkbd_t *k) { return PAGES[k->page].name; }

static uint8_t span_start(const vkbd_t *k, uint8_t row, uint8_t col)
{
    uint8_t n, s = 0;
    const vk_key_t *r = vkbd_row(k, row, &n);
    for (uint8_t i = 0; i < col && i < n; i++) s = (uint8_t)(s + r[i].width);
    return s;
}

static uint8_t key_at_cell(const vkbd_t *k, uint8_t row, uint8_t cell)
{
    uint8_t n, s = 0;
    const vk_key_t *r = vkbd_row(k, row, &n);
    for (uint8_t i = 0; i < n; i++) { s = (uint8_t)(s + r[i].width); if (cell < s) return i; }
    return (uint8_t)(n - 1);
}

void vkbd_move(vkbd_t *k, char dir)
{
    uint8_t n;
    vkbd_row(k, k->row, &n);
    if (dir == 'l') k->col = (uint8_t)((k->col + n - 1) % n);
    else if (dir == 'r') k->col = (uint8_t)((k->col + 1) % n);
    else {
        uint8_t cell = span_start(k, k->row, k->col);
        k->row = (uint8_t)(dir == 'u' ? (k->row + VK_ROWS - 1) % VK_ROWS : (k->row + 1) % VK_ROWS);
        k->col = key_at_cell(k, k->row, cell);
    }
}

vk_action_t vkbd_activate(vkbd_t *k, char *ch)
{
    uint8_t n;
    const vk_key_t *r = vkbd_row(k, k->row, &n);
    const vk_key_t *key = &r[k->col];
    switch (key->action) {
    case VK_SHIFT: k->shift = !k->shift; return VK_SHIFT;
    case VK_PAGE:
        k->page = (uint8_t)((k->page + 1) % NPAGES);
        k->shift = false;
        return VK_PAGE;
    case VK_INSERT: {
        char c = key->value;
        if (k->shift && (unsigned char)c < 0x80) { c = (char)toupper((unsigned char)c); k->shift = false; }
        *ch = c;
        return VK_INSERT;
    }
    default: return key->action;
    }
}
