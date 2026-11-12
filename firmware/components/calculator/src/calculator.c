#include "calculator.h"

#include <stdio.h>
#include <string.h>

#include "mt_font.h"

void calc_init(calculator_t *c) { memset(c, 0, sizeof(*c)); c->hist_idx = -1; }

void calc_clear(calculator_t *c)
{
    c->ntok = c->cursor = 0;
    c->evaluated = c->has_result = false;
    c->err = ME_OK;
    c->hoff = 0;
    c->hist_idx = -1;
}

static const char *key_token(keycode_t k, bool shift)
{
    if (shift) {
        switch (k) {
        case KEY_SIN: return "asin(";
        case KEY_COS: return "acos(";
        case KEY_TAN: return "atan(";
        case KEY_LOG: return "10^(";
        case KEY_LN: return "e^(";
        case KEY_SQRT: return "cbrt(";
        case KEY_POW: return "root(";
        case KEY_RPAREN: return "!";
        case KEY_MUL: return "nCr(";
        case KEY_DIV: return "nPr(";
        case KEY_DOT: return ",";
        default: break;
        }
    }
    static const char *const D[] = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"};
    if (key_is_digit(k)) return D[k - KEY_K0];
    switch (k) {
    case KEY_DOT: return ".";
    case KEY_ADD: return "+";
    case KEY_SUB: case KEY_NEG: return "-";
    case KEY_MUL: return "*";
    case KEY_DIV: return "/";
    case KEY_LPAREN: return "(";
    case KEY_RPAREN: return ")";
    case KEY_EXP: return "E";
    case KEY_ANS: return "Ans";
    case KEY_PI: return "pi";
    case KEY_PERCENT: return "%";
    case KEY_SQR: return "^2";
    case KEY_INV: return "^(-1)";
    case KEY_POW: return "^";
    case KEY_SQRT: return "sqrt(";
    case KEY_SIN: return "sin(";
    case KEY_COS: return "cos(";
    case KEY_TAN: return "tan(";
    case KEY_LOG: return "log(";
    case KEY_LN: return "ln(";
    case KEY_VARX: return "x";
    case KEY_COMMA: return ",";
    default: return NULL;
    }
}

void calc_expr(const calculator_t *c, char *out, size_t len)
{
    size_t o = 0;
    out[0] = 0;
    for (int i = 0; i < c->ntok; i++) {
        size_t l = strlen(c->tok[i]);
        if (o + l + 1 > len) break;
        memcpy(out + o, c->tok[i], l);
        o += l;
        out[o] = 0;
    }
}

static void insert(calculator_t *c, const char *t)
{
    if (c->evaluated) {
        bool cont = strchr("+-*/^%!", t[0]) != NULL;
        c->ntok = 0;
        if (cont) c->tok[c->ntok++] = "Ans";
        c->cursor = c->ntok;
        c->evaluated = false;
        c->has_result = false;
        c->err = ME_OK;
    }
    char e[ME_MAX_LEN + 1];
    calc_expr(c, e, sizeof(e));
    if (c->ntok >= CALC_MAX_TOKENS || strlen(e) + strlen(t) > ME_MAX_LEN) return;
    memmove(&c->tok[c->cursor + 1], &c->tok[c->cursor], (size_t)(c->ntok - c->cursor) * sizeof(c->tok[0]));
    c->tok[c->cursor++] = t;
    c->ntok++;
    c->hist_idx = -1;
}

static void evaluate(calculator_t *c, me_angle_t angle)
{
    if (!c->ntok) return;
    char e[ME_MAX_LEN + 1];
    calc_expr(c, e, sizeof(e));
    me_var_t vars[2] = {{"Ans", c->ans}, {"M", c->mem}};
    me_ctx_t ctx = {angle, vars, 2};
    double v;
    c->err = me_eval(e, &ctx, &v);
    c->evaluated = true;
    c->has_result = c->err == ME_OK;
    if (c->err == ME_OK) {
        c->result = v;
        c->ans = v;
        memmove(&c->history[1], &c->history[0], sizeof(c->history[0]) * (CALC_HISTORY - 1));
        snprintf(c->history[0].expr, sizeof(c->history[0].expr), "%s", e);
        c->history[0].value = v;
        if (c->nhist < CALC_HISTORY) c->nhist++;
    }
}

/* Re-tokenise a history string one character at a time (good enough for DEL editing). */
static const char *char_token(char ch)
{
    static char pool[128][2];
    unsigned char u = (unsigned char)ch;
    if (u >= 128) return "?";
    pool[u][0] = ch;
    pool[u][1] = 0;
    return pool[u];
}

static void browse(calculator_t *c, int dir)
{
    if (!c->nhist) return;
    int i = c->hist_idx + (dir < 0 ? 1 : -1);
    if (i < 0) i = 0;
    if (i >= c->nhist) i = c->nhist - 1;
    c->hist_idx = (int8_t)i;
    c->ntok = 0;
    for (const char *p = c->history[i].expr; *p && c->ntok < CALC_MAX_TOKENS; p++) c->tok[c->ntok++] = char_token(*p);
    c->cursor = c->ntok;
    c->evaluated = true;
    c->has_result = true;
    c->err = ME_OK;
    c->result = c->history[i].value;
}

bool calc_key(calculator_t *c, keycode_t k, bool shift, me_angle_t angle)
{
    const char *t = key_token(k, shift);
    if (t) { insert(c, t); return true; }
    switch (k) {
    case KEY_EQ: evaluate(c, angle); return true;
    case KEY_DEL:
        if (c->evaluated) { c->evaluated = false; c->has_result = false; c->err = ME_OK; c->cursor = c->ntok; return true; }
        if (c->cursor > 0) {
            memmove(&c->tok[c->cursor - 1], &c->tok[c->cursor], (size_t)(c->ntok - c->cursor) * sizeof(c->tok[0]));
            c->cursor--;
            c->ntok--;
        }
        return true;
    case KEY_AC: calc_clear(c); return true;
    case KEY_LEFT: if (c->evaluated) { c->evaluated = false; c->has_result = false; c->cursor = c->ntok; } else if (c->cursor) c->cursor--; return true;
    case KEY_RIGHT: if (c->evaluated) { c->evaluated = false; c->has_result = false; c->cursor = c->ntok; } else if (c->cursor < c->ntok) c->cursor++; return true;
    case KEY_UP: browse(c, -1); return true;
    case KEY_DOWN: browse(c, 1); return true;
    case KEY_FRAC: c->show_fraction = !c->show_fraction; return true;
    case KEY_STO: {
        double v = c->result;
        if (!(c->evaluated && c->has_result)) {
            char e[ME_MAX_LEN + 1];
            calc_expr(c, e, sizeof(e));
            me_var_t vars[2] = {{"Ans", c->ans}, {"M", c->mem}};
            me_ctx_t ctx = {angle, vars, 2};
            if (me_eval(e, &ctx, &v) != ME_OK) return true;
        }
        c->mem = shift ? c->mem - v : c->mem + v;
        return true;
    }
    case KEY_RCL: if (shift) c->mem = 0; else insert(c, "M"); return true;
    default: return false;
    }
}

void calc_result_text(const calculator_t *c, char *out, size_t len)
{
    out[0] = 0;
    if (!c->evaluated) return;
    if (c->err != ME_OK) { snprintf(out, len, "%s", me_err_text(c->err)); return; }
    long n, d;
    if (c->show_fraction && me_to_fraction(c->result, 9999, &n, &d) && d != 1) { snprintf(out, len, "%ld/%ld", n, d); return; }
    me_format(c->result, 10, out, len);
}

/* Display form: sqrt( -> √(, pi -> π, * -> ×, / -> ÷ (UTF-8). */
static const char *pretty(const char *t)
{
    if (!strcmp(t, "sqrt(")) return "\xE2\x88\x9A(";
    if (!strcmp(t, "pi")) return "\xCF\x80";
    if (!strcmp(t, "*")) return "\xC3\x97";
    if (!strcmp(t, "/")) return "\xC3\xB7";
    return t;
}

void calc_render(calculator_t *c, fb_t *fb, int y_expr, int y_res, uint8_t res_scale, bool cursor_on)
{
    char cells[ME_MAX_LEN * 2 + 1];
    size_t n = 0, cur = 0;
    for (int i = 0; i < c->ntok; i++) {
        if (i == c->cursor) cur = n;
        n += mt_to_cells(pretty(c->tok[i]), cells + n, sizeof(cells) - n);
    }
    if (c->cursor == c->ntok) cur = n;
    int cols = (fb->width - 4) / 6;
    if (cur < c->hoff) c->hoff = (uint16_t)cur;
    if ((int)cur > c->hoff + cols - 1) c->hoff = (uint16_t)(cur - (size_t)cols + 1);
    if (c->evaluated) c->hoff = (uint16_t)(n > (size_t)cols ? n - (size_t)cols : 0);
    fb_cells(fb, 2, y_expr, cells + c->hoff, (size_t)cols, 1, false);
    if (c->hoff > 0) { fb_set(fb, 0, y_expr + 3, true); fb_vline(fb, 1, y_expr + 2, 3); }
    if (n - c->hoff > (size_t)cols) { fb_vline(fb, fb->width - 2, y_expr + 2, 3); fb_set(fb, fb->width - 1, y_expr + 3, true); }
    if (!c->evaluated && cursor_on) fb_vline(fb, 1 + (int)(cur - c->hoff) * 6, y_expr, 8);
    char r[48];
    calc_result_text(c, r, sizeof(r));
    if (!r[0]) return;
    if (c->err != ME_OK) { fb_text(fb, 2, y_res, r, NULL); return; }
    uint8_t s = res_scale;
    if ((int)strlen(r) * 6 * s > fb->width - 2) s = 1;
    int w = (int)strlen(r) * 6 * s;
    fb_text_opts_t o = {false, s};
    fb_text(fb, fb->width - w - 1, s == 2 ? y_res - 8 : y_res, r, &o);
}
