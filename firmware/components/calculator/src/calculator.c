/*
 * NORMAL-state scientific calculator. Behaviour mirrors
 * simulator/js/core/sciCalc.js (the executable reference); both are covered
 * by tests (tests/simulator/dexin.test.js, tests/firmware/src/test_calculator.c).
 */
#include "calculator.h"

#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mt_font.h"

#ifdef ESP_PLATFORM
#include "esp_random.h"
#endif

static const char *const VAR_NAMES[CALC_NVARS] = {"A", "B", "C", "D", "E", "F", "X", "Y", "M"};
enum { V_A, V_B, V_C, V_D, V_E, V_F, V_X, V_Y, V_M };

/* ------------------------------ menus ------------------------------ */
enum {
    MN_NONE = 0, MN_MODE, MN_REG1, MN_REG2, MN_ANGLE, MN_FMT, MN_FIX, MN_SCI, MN_NORM, MN_DISP, MN_DISP1, MN_DISP2,
    MN_CLR, MN_DRG, MN_SSUM, MN_SSUM2, MN_SSUM3, MN_SVAR, MN_SVAR2, MN_SVAR3, MN_SVAR4,
};

/* ------------------------------ key map ---------------------------- */
/* [primary, shift, alpha]; "@X" = action, otherwise token text (engine syntax). */
typedef struct { keycode_t k; const char *p, *s, *a; } keymap_t;
static const keymap_t KEYMAP[] = {
    {KEY_K0, "0", "Rnd(", NULL}, {KEY_K1, "1", "@SSUM", NULL}, {KEY_K2, "2", "@SVAR", NULL}, {KEY_K3, "3", NULL, NULL},
    {KEY_K4, "4", NULL, NULL}, {KEY_K5, "5", NULL, NULL}, {KEY_K6, "6", NULL, NULL}, {KEY_K7, "7", NULL, NULL},
    {KEY_K8, "8", NULL, NULL}, {KEY_K9, "9", NULL, NULL},
    {KEY_DOT, ".", "Ran#", NULL}, {KEY_EXP, "E", "pi", NULL}, {KEY_ANS, "Ans", "@DRG", NULL},
    {KEY_ADD, "+", NULL, NULL}, {KEY_SUB, "-", NULL, NULL}, {KEY_MUL, "*", NULL, NULL}, {KEY_DIV, "/", NULL, NULL},
    {KEY_NEG, "@NEG", NULL, "A"}, {KEY_DMS, "@", "@DMSBACK", "B"}, {KEY_HYP, "@HYP", NULL, "C"},
    {KEY_SIN, "sin(", "asin(", "D"}, {KEY_COS, "cos(", "acos(", "E"}, {KEY_TAN, "tan(", "atan(", "F"},
    {KEY_LPAREN, "(", NULL, NULL}, {KEY_RPAREN, ")", NULL, "X"}, {KEY_COMMA, ",", ";", "Y"},
    {KEY_STO, "@MPLUS", "@MMINUS", "M"}, {KEY_RCL, "@RCL", "@STO", NULL}, {KEY_ENG, "@ENG", "@ENGBACK", NULL},
    {KEY_INV, "^(-1)", "!", NULL}, {KEY_NCR, " nCr ", " nPr ", NULL}, {KEY_POL, "Pol(", "Rec(", NULL},
    {KEY_CUBE, "^3", "cbrt(", NULL}, {KEY_FRAC, "@ABC", "@DC", NULL}, {KEY_SQRT, "sqrt(", NULL, NULL},
    {KEY_SQR, "^2", NULL, NULL}, {KEY_POW, "^", "root(", NULL}, {KEY_LOG, "log(", "10^(", NULL}, {KEY_LN, "ln(", "e^(", NULL},
    {KEY_PERCENT, "%", NULL, NULL}, {KEY_PI, "pi", NULL, NULL}, {KEY_VARX, "X", NULL, NULL},
    {KEY_EQ, "@EQ", "@PCT", NULL}, {KEY_DEL, "@DEL", "@INS", NULL}, {KEY_AC, "@AC", "@OFF", NULL},
    {KEY_MODE, "@MODE", "@CLR", NULL},
};
#define NKEYMAP (sizeof(KEYMAP) / sizeof(KEYMAP[0]))

static const keymap_t *find_key(keycode_t k)
{
    for (size_t i = 0; i < NKEYMAP; i++) if (KEYMAP[i].k == k) return &KEYMAP[i];
    return NULL;
}

static int var_index(const char *name)
{
    for (int i = 0; i < CALC_NVARS; i++) if (name && !strcmp(VAR_NAMES[i], name)) return i;
    return -1;
}

const char *calc_err_name(me_err_t e)
{
    switch (e) {
    case ME_OK: return "";
    case ME_ERR_DOMAIN: case ME_ERR_DIV_ZERO: case ME_ERR_OVERFLOW: return "Math ERROR";
    case ME_ERR_ARGS: return "Arg ERROR";
    case ME_ERR_DEPTH: case ME_ERR_TOO_LONG: return "Stack ERROR";
    case ME_ERR_SYNTAX: case ME_ERR_UNKNOWN: default: return "Syntax ERROR";
    }
}

/* ------------------------------ init ------------------------------- */

void calc_init(calculator_t *c)
{
    memset(c, 0, sizeof(*c));
    c->cfg.angle = ME_ANGLE_DEG;
    c->hist_idx = -1;
    c->data_idx = -1;
    c->err_tok = -1;
}

void calc_clear(calculator_t *c)
{
    c->ntok = c->cursor = 0;
    c->evaluated = c->has_result = false;
    c->err = ME_OK;
    c->err_tok = -1;
    c->label = NULL;
    c->hoff = 0;
    c->hist_idx = -1;
    c->view = VIEW_DEC;
    c->eng_shift = 0;
    c->pending = 0;
    c->menu = MN_NONE;
    c->hyp = false;
    c->data_idx = -1;
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

/* ------------------------------ statistics ------------------------- */

typedef struct {
    double n, sx, sx2, sy, sy2, sxy, sx3, sx2y, sx4;
    double xbar, xsn, xsn1, ybar, ysn, ysn1, A, B, C, r;
} stats_t;

static void compute_stats(const calculator_t *c, stats_t *o)
{
    memset(o, 0, sizeof(*o));
    bool reg = c->cfg.mode == CALC_REG;
    uint8_t t = c->cfg.reg;
    double sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0;
    for (int i = 0; i < c->ndata; i++) {
        const calc_data_t *d = &c->data[i];
        double f = d->f, x = d->x, y = d->y;
        o->n += f; o->sx += f * x; o->sx2 += f * x * x;
        if (reg) {
            o->sy += f * y; o->sy2 += f * y * y; o->sxy += f * x * y;
            o->sx3 += f * x * x * x; o->sx2y += f * x * x * y; o->sx4 += f * x * x * x * x;
            double X = (t == REG_LOG || t == REG_PWR) ? log(x) : t == REG_INV ? 1.0 / x : x;
            double Y = (t == REG_EXP || t == REG_PWR) ? log(y) : y;
            sX += f * X; sY += f * Y; sXX += f * X * X; sYY += f * Y * Y; sXY += f * X * Y;
        }
    }
    double n = o->n;
    o->xbar = o->xsn = o->xsn1 = o->ybar = o->ysn = o->ysn1 = o->A = o->B = o->C = o->r = NAN;
    if (n >= 1) {
        o->xbar = o->sx / n;
        o->xsn = sqrt(fmax(0, o->sx2 / n - o->xbar * o->xbar));
        if (reg) { o->ybar = o->sy / n; o->ysn = sqrt(fmax(0, o->sy2 / n - o->ybar * o->ybar)); }
    }
    if (n >= 2) {
        o->xsn1 = sqrt(fmax(0, (o->sx2 - o->sx * o->sx / n) / (n - 1)));
        if (reg) o->ysn1 = sqrt(fmax(0, (o->sy2 - o->sy * o->sy / n) / (n - 1)));
    }
    if (!reg) return;
    if (t == REG_QUAD) {
        if (n < 3) return;
        double Sxx = o->sx2 - o->sx * o->sx / n, Sxy = o->sxy - o->sx * o->sy / n, Sxx2 = o->sx3 - o->sx * o->sx2 / n;
        double Sx2x2 = o->sx4 - o->sx2 * o->sx2 / n, Sx2y = o->sx2y - o->sx2 * o->sy / n;
        double den = Sxx * Sx2x2 - Sxx2 * Sxx2;
        if (fabs(den) < 1e-300) return;
        o->B = (Sxy * Sx2x2 - Sx2y * Sxx2) / den;
        o->C = (Sx2y * Sxx - Sxy * Sxx2) / den;
        o->A = (o->sy - o->B * o->sx - o->C * o->sx2) / n;
        return;
    }
    if (n < 2) return;
    double SXX = sXX - sX * sX / n, SYY = sYY - sY * sY / n, SXY = sXY - sX * sY / n;
    if (SXX == 0) return;
    o->B = SXY / SXX;
    double a = (sY - o->B * sX) / n;
    o->A = (t == REG_EXP || t == REG_PWR) ? exp(a) : a;
    if (SXX * SYY > 0) o->r = SXY / sqrt(SXX * SYY);
}

/* ------------------------------ formatting ------------------------- */

static void exp_form(double v, int sig, bool trim, char *out, size_t len)
{
    char m[48];
    snprintf(m, sizeof(m), "%.*e", sig - 1 < 0 ? 0 : sig - 1, v);
    char *e = strchr(m, 'e');
    if (!e) { snprintf(out, len, "%s", m); return; }
    int ex = atoi(e + 1);
    *e = 0;
    if (trim && strchr(m, '.')) {
        size_t l = strlen(m);
        while (l && m[l - 1] == '0') m[--l] = 0;
        if (l && m[l - 1] == '.') m[--l] = 0;
    }
    snprintf(out, len, "%sE%s%02d", m, ex < 0 ? "-" : "", ex < 0 ? -ex : ex);
}

void calc_format(const calculator_t *c, double v, char *out, size_t len)
{
    double a = fabs(v);
    if (v == 0) { snprintf(out, len, "0"); return; }
    switch (c->cfg.disp) {
    case DISP_FIX:
        if (a >= 1e10) { exp_form(v, 10, true, out, len); return; }
        snprintf(out, len, "%.*f", c->cfg.digits, v);
        return;
    case DISP_SCI: exp_form(v, c->cfg.digits ? c->cfg.digits : 10, false, out, len); return;
    default: {
        double low = c->cfg.disp == DISP_NORM2 ? 1e-9 : 1e-2;
        if (a >= 1e10 || a < low) { exp_form(v, 10, true, out, len); return; }
        me_format(v, 10, out, len);
        return;
    }
    }
}

/* Rnd(: round to what the display shows */
static double rnd_hook(void *user, double v)
{
    const calculator_t *c = user;
    char b[48];
    if (c->cfg.disp == DISP_FIX && fabs(v) < 1e10) snprintf(b, sizeof(b), "%.*f", c->cfg.digits, v);
    else if (c->cfg.disp == DISP_SCI) snprintf(b, sizeof(b), "%.*e", (c->cfg.digits ? c->cfg.digits : 10) - 1, v);
    else snprintf(b, sizeof(b), "%.9e", v);
    return strtod(b, NULL);
}

static double rng_default(void)
{
#ifdef ESP_PLATFORM
    return (double)(esp_random() % 1000u) / 1000.0;
#else
    return (double)(rand() % 1000) / 1000.0;
#endif
}
static double random_hook(void *user)
{
    const calculator_t *c = user;
    return c->random ? c->random() : rng_default();
}

static void setvar_hook(void *user, const char *name, double v)
{
    calculator_t *c = user;
    int i = var_index(name);
    if (i >= 0) { c->vars[i] = v; c->state_dirty = true; }
}

static me_err_t estimate_hook(void *user, int which, double v, double *out)
{
    const calculator_t *c = user;
    if (c->cfg.mode != CALC_REG) return ME_ERR_SYNTAX;
    stats_t s;
    compute_stats(c, &s);
    double A = s.A, B = s.B;
    if (!isfinite(A) || !isfinite(B)) return ME_ERR_DOMAIN;
    uint8_t t = c->cfg.reg;
    if (which == 3) { /* yhat */
        switch (t) {
        case REG_LIN: *out = A + B * v; break;
        case REG_LOG: if (v <= 0) return ME_ERR_DOMAIN; *out = A + B * log(v); break;
        case REG_EXP: *out = A * exp(B * v); break;
        case REG_PWR: *out = A * pow(v, B); break;
        case REG_INV: if (v == 0) return ME_ERR_DIV_ZERO; *out = A + B / v; break;
        default: *out = A + B * v + s.C * v * v; break;
        }
        return ME_OK;
    }
    if (t == REG_QUAD) {
        double C = s.C, D = B * B - 4 * C * (A - v);
        if (D < 0 || C == 0 || which == 0) return ME_ERR_DOMAIN;
        *out = which == 2 ? (-B - sqrt(D)) / (2 * C) : (-B + sqrt(D)) / (2 * C);
        return ME_OK;
    }
    if (which != 0 || B == 0) return ME_ERR_DOMAIN;
    switch (t) {
    case REG_LIN: *out = (v - A) / B; break;
    case REG_LOG: *out = exp((v - A) / B); break;
    case REG_EXP: if (v / A <= 0) return ME_ERR_DOMAIN; *out = log(v / A) / B; break;
    case REG_PWR: if (v / A < 0) return ME_ERR_DOMAIN; *out = pow(v / A, 1 / B); break;
    case REG_INV: if (v == A) return ME_ERR_DIV_ZERO; *out = B / (v - A); break;
    default: return ME_ERR_SYNTAX;
    }
    return ME_OK;
}

#define CTX_MAXVARS (CALC_NVARS + 1 + 19)
typedef struct { me_var_t v[CTX_MAXVARS]; me_ctx_t ctx; } calc_ctx_t;

static void make_ctx(calculator_t *c, calc_ctx_t *x)
{
    size_t n = 0;
    x->v[n++] = (me_var_t){"Ans", c->ans};
    for (int i = 0; i < CALC_NVARS; i++) x->v[n++] = (me_var_t){VAR_NAMES[i], c->vars[i]};
    if (c->cfg.mode != CALC_COMP) {
        stats_t s;
        compute_stats(c, &s);
        const struct { const char *name; double v; } S[] = {
            {"n", s.n}, {"sumx", s.sx}, {"sumx2", s.sx2}, {"sumy", s.sy}, {"sumy2", s.sy2}, {"sumxy", s.sxy},
            {"sumx3", s.sx3}, {"sumx2y", s.sx2y}, {"sumx4", s.sx4}, {"xbar", s.xbar}, {"xsn", s.xsn}, {"xsn1", s.xsn1},
            {"ybar", s.ybar}, {"ysn", s.ysn}, {"ysn1", s.ysn1}, {"regA", s.A}, {"regB", s.B}, {"regC", s.C},
            {"regr", c->cfg.reg == REG_QUAD ? NAN : s.r},
        };
        for (size_t i = 0; i < sizeof(S) / sizeof(S[0]) && n < CTX_MAXVARS; i++) x->v[n++] = (me_var_t){S[i].name, S[i].v};
    }
    x->ctx = (me_ctx_t){.angle = (me_angle_t)c->cfg.angle, .vars = x->v, .nvars = n, .set_var = setvar_hook,
                        .random = random_hook, .round = rnd_hook, .estimate = estimate_hook, .user = c};
}

static me_err_t calc_eval_str(calculator_t *c, const char *e, double *v)
{
    calc_ctx_t x;
    make_ctx(c, &x);
    return me_eval(e, &x.ctx, v);
}

/* ------------------------------ editing ---------------------------- */

static bool continues_ans(const char *t)
{
    return strchr("+-*/^%!", t[0]) != NULL || !strcmp(t, " nCr ") || !strcmp(t, " nPr ") ||
           !strcmp(t, "xhat") || !strcmp(t, "xhat1") || !strcmp(t, "xhat2") || !strcmp(t, "yhat") ||
           !strcmp(t, "{") || !strcmp(t, "}") || !strcmp(t, "~");
}

static void put(calculator_t *c, const char *t, bool fresh)
{
    if (c->evaluated) {
        bool cont = !fresh && continues_ans(t);
        c->ntok = 0;
        if (cont) c->tok[c->ntok++] = "Ans";
        c->cursor = c->ntok;
        c->evaluated = c->has_result = false;
        c->err = ME_OK;
        c->label = NULL;
        c->view = VIEW_DEC;
        c->eng_shift = 0;
    }
    char e[ME_MAX_LEN + 1];
    calc_expr(c, e, sizeof(e));
    if (strlen(e) + strlen(t) > ME_MAX_LEN) return;
    if (!c->insert && c->cursor < c->ntok) {
        c->tok[c->cursor++] = t;
    } else {
        if (c->ntok >= CALC_MAX_TOKENS) return;
        memmove(&c->tok[c->cursor + 1], &c->tok[c->cursor], (size_t)(c->ntok - c->cursor) * sizeof(c->tok[0]));
        c->tok[c->cursor++] = t;
        c->ntok++;
    }
    c->hist_idx = -1;
}

static void set_label(calculator_t *c, const char *fmt_text)
{
    snprintf(c->label_buf, sizeof(c->label_buf), "%s", fmt_text);
    c->label = c->label_buf;
    c->evaluated = true;
    c->has_result = true;
    c->err = ME_OK;
    c->ntok = c->cursor = 0;
}

static void locate_error(calculator_t *c, const char *e)
{
    /* best effort: the engine reports no position; put the cursor at the end
     * for syntax errors and at the start for math errors (like the original
     * puts it where the calculation stopped). */
    (void)e;
    c->err_tok = (int16_t)(c->err == ME_ERR_SYNTAX || c->err == ME_ERR_UNKNOWN ? c->ntok : 0);
}

static void evaluate(calculator_t *c, bool percent)
{
    if (!c->ntok) return;
    char e[ME_MAX_LEN + 2];
    calc_expr(c, e, sizeof(e) - 1);
    if (percent) strcat(e, "%");
    double v = 0;
    c->err = calc_eval_str(c, e, &v);
    c->evaluated = true;
    c->view = VIEW_DEC;
    c->eng_shift = 0;
    c->label = NULL;
    c->has_result = c->err == ME_OK;
    if (c->err != ME_OK) { locate_error(c, e); return; }
    c->result = v;
    c->ans = v;
    long n, d;
    if (strchr(e, '|') && me_to_fraction(v, 99999, &n, &d) && d != 1) c->view = VIEW_FRAC; /* fraction in -> fraction out */
    memmove(&c->history[1], &c->history[0], sizeof(c->history[0]) * (CALC_HISTORY - 1));
    snprintf(c->history[0].expr, sizeof(c->history[0].expr), "%s", e);
    c->history[0].value = v;
    if (c->nhist < CALC_HISTORY) c->nhist++;
    c->state_dirty = true;
}

/* Re-tokenise a history string (one token per character, keeps known multi-char tokens). */
static const char *const MULTI[] = {"Ans", "asin(", "acos(", "atan(", "sinh(", "cosh(", "tanh(", "asinh(", "acosh(", "atanh(",
                                    "sin(", "cos(", "tan(", "sqrt(", "cbrt(", "root(", "log(", "ln(", "10^(", "e^(", "Pol(", "Rec(",
                                    "Rnd(", "Ran#", "^(-1)", " nCr ", " nPr ", "pi", "xhat1", "xhat2", "xhat", "yhat",
                                    "sumx2y", "sumx2", "sumx3", "sumx4", "sumxy", "sumx", "sumy2", "sumy", "xsn1", "xsn",
                                    "ysn1", "ysn", "xbar", "ybar", "regA", "regB", "regC", "regr", "^2", "^3"};
static const char *char_token(char ch)
{
    static char pool[128][2];
    unsigned char u = (unsigned char)ch;
    if (u >= 128) return "?";
    pool[u][0] = ch;
    pool[u][1] = 0;
    return pool[u];
}
static void load_tokens(calculator_t *c, const char *p)
{
    c->ntok = 0;
    while (*p && c->ntok < CALC_MAX_TOKENS) {
        const char *t = NULL;
        for (size_t i = 0; i < sizeof(MULTI) / sizeof(MULTI[0]); i++)
            if (!strncmp(p, MULTI[i], strlen(MULTI[i]))) { t = MULTI[i]; break; }
        if (!t) t = char_token(*p);
        c->tok[c->ntok++] = t;
        p += strlen(t);
    }
    c->cursor = c->ntok;
}

static void browse(calculator_t *c, int dir)
{
    if (!c->nhist) return;
    int i = c->hist_idx + (dir < 0 ? 1 : -1);
    if (i < 0) i = 0;
    if (i >= c->nhist) i = c->nhist - 1;
    c->hist_idx = (int8_t)i;
    load_tokens(c, c->history[i].expr);
    c->evaluated = true;
    c->has_result = true;
    c->err = ME_OK;
    c->label = NULL;
    c->view = VIEW_DEC;
    c->result = c->history[i].value; /* REPLAY shows the stored result */
}

static bool current_value(calculator_t *c, double *v)
{
    if (c->evaluated && c->has_result && !c->label) { *v = c->result; return true; }
    if (!c->ntok) { *v = c->ans; return true; }
    char e[ME_MAX_LEN + 1];
    calc_expr(c, e, sizeof(e));
    c->err = calc_eval_str(c, e, v);
    if (c->err != ME_OK) { c->evaluated = true; c->has_result = false; c->label = NULL; return false; }
    c->ans = *v;
    return true;
}

static void data_view(calculator_t *c)
{
    char b[72], x[24], y[24];
    const calc_data_t *d = (c->data_idx >= 0 && c->data_idx < c->ndata) ? &c->data[c->data_idx] : NULL;
    if (!d) { set_label(c, "sem dados"); return; }
    calc_format(c, d->x, x, sizeof(x));
    if (c->cfg.mode == CALC_REG) { calc_format(c, d->y, y, sizeof(y)); snprintf(b, sizeof(b), "x%d=%s y%d=%s", c->data_idx + 1, x, c->data_idx + 1, y); }
    else snprintf(b, sizeof(b), "x%d=%s F=%g", c->data_idx + 1, x, d->f);
    set_label(c, b);
}

static void add_data(calculator_t *c)
{
    char e[ME_MAX_LEN + 1];
    calc_expr(c, e, sizeof(e));
    if (!e[0]) return;
    char *semi = strchr(e, ';');
    double f = 1, x = 0, y = 0;
    me_err_t err = ME_OK;
    if (semi) { *semi = 0; err = calc_eval_str(c, semi + 1, &f); }
    char *comma = strchr(e, ',');
    if (!err) {
        if (c->cfg.mode == CALC_REG) {
            if (!comma) err = ME_ERR_SYNTAX;
            else { *comma = 0; err = calc_eval_str(c, e, &x); if (!err) err = calc_eval_str(c, comma + 1, &y); }
        } else if (comma) err = ME_ERR_SYNTAX;
        else err = calc_eval_str(c, e, &x);
    }
    if (err) { c->err = err; c->evaluated = true; c->has_result = false; c->label = NULL; return; }
    if (c->ndata >= CALC_MAX_DATA) { set_label(c, "Data Full"); return; }
    c->data[c->ndata++] = (calc_data_t){x, y, f};
    c->state_dirty = true;
    c->data_idx = -1;
    char b[16];
    snprintf(b, sizeof(b), "n=%d", c->ndata);
    set_label(c, b);
}

static void edit_data(calculator_t *c)
{
    char e[ME_MAX_LEN + 1];
    double v;
    calc_expr(c, e, sizeof(e));
    if (calc_eval_str(c, e, &v) == ME_OK && c->data_idx < c->ndata) { c->data[c->data_idx].x = v; c->state_dirty = true; }
    data_view(c);
}

static void reset_mode(calculator_t *c)
{
    c->cfg = (calc_cfg_t){.angle = ME_ANGLE_DEG, .mode = CALC_COMP, .reg = REG_LIN, .disp = DISP_NORM1};
    c->ndata = 0;
    c->cfg_dirty = c->state_dirty = true;
}

/* ------------------------------ menus ------------------------------ */

static const char *menu_line(const calculator_t *c, int line)
{
    bool reg = c->cfg.mode == CALC_REG, quad = c->cfg.reg == REG_QUAD;
    switch (c->menu) {
    case MN_MODE: return line ? " 1    2   3" : "COMP SD  REG";
    case MN_REG1: return line ? " 1    2    3  >" : "Lin  Log  Exp";
    case MN_REG2: return line ? "<1    2    3" : "Pwr  Inv  Quad";
    case MN_ANGLE: return line ? " 1    2    3" : "Deg  Rad  Gra";
    case MN_FMT: return line ? " 1    2    3" : "Fix  Sci  Norm";
    case MN_FIX: return line ? "" : "Fix 0~9?";
    case MN_SCI: return line ? "" : "Sci 0~9?";
    case MN_NORM: return line ? "" : "Norm 1~2?";
    case MN_DISP: return line ? " 1" : "Disp";
    case MN_DISP1: return line ? " 1     2   >" : "ab/c  d/c";
    case MN_DISP2: return line ? "<1     2" : "Dot   Comma";
    case MN_CLR: return line ? " 1     2    3" : (c->cfg.mode == CALC_COMP ? "Mcl  Mode  All" : "Scl  Mode  All");
    case MN_DRG: return line ? "1    2    3" : "D    R    G";
    case MN_SSUM: return line ? (reg ? " 1    2   3  >" : " 1    2   3") : "\xCE\xA3x\xC2\xB2  \xCE\xA3x   n";
    case MN_SSUM2: return line ? (quad ? "<1    2   3  >" : "<1    2   3") : "\xCE\xA3y\xC2\xB2  \xCE\xA3y  \xCE\xA3xy";
    case MN_SSUM3: return line ? "<1    2   3" : "\xCE\xA3x\xC2\xB3 \xCE\xA3x\xC2\xB2y \xCE\xA3x\xE2\x81\xB4";
    case MN_SVAR: return line ? (reg ? " 1    2   3  >" : " 1    2   3") : "\xEE\x80\x80   x\xCF\x83n  x\xCF\x83n-1";
    case MN_SVAR2: return line ? "<1    2   3  >" : "\xC8\xB3   y\xCF\x83n  y\xCF\x83n-1";
    case MN_SVAR3: return line ? "<1    2   3  >" : (quad ? "A    B    C" : "A    B    r");
    case MN_SVAR4: return line ? (quad ? "<1    2   3" : "<1    2") : (quad ? "\xEE\x80\x81" "1  \xEE\x80\x81" "2   \xC5\xB7" : "\xEE\x80\x81    \xC5\xB7");
    default: return "";
    }
}

static void pick_var(calculator_t *c, const char *const *list, int n, int count)
{
    if (n < 1 || n > count) return;
    c->menu = MN_NONE;
    put(c, list[n - 1], false);
}

static void flash(calculator_t *c, const char *t) { set_label(c, t); }

static void menu_key(calculator_t *c, keycode_t k)
{
    bool reg = c->cfg.mode == CALC_REG, quad = c->cfg.reg == REG_QUAD;
    if (k == KEY_AC) { c->menu = MN_NONE; return; }
    if (k == KEY_MODE) {
        switch (c->menu) {
        case MN_MODE: c->menu = MN_ANGLE; return;
        case MN_ANGLE: c->menu = MN_FMT; return;
        case MN_FMT: c->menu = MN_DISP; return;
        case MN_DISP: c->menu = MN_MODE; return;
        default: return;
        }
    }
    if (k == KEY_RIGHT) {
        switch (c->menu) {
        case MN_REG1: c->menu = MN_REG2; return;
        case MN_DISP1: c->menu = MN_DISP2; return;
        case MN_SSUM: if (reg) c->menu = MN_SSUM2; return;
        case MN_SSUM2: if (quad) c->menu = MN_SSUM3; return;
        case MN_SVAR: if (reg) c->menu = MN_SVAR2; return;
        case MN_SVAR2: c->menu = MN_SVAR3; return;
        case MN_SVAR3: c->menu = MN_SVAR4; return;
        default: return;
        }
    }
    if (k == KEY_LEFT) {
        switch (c->menu) {
        case MN_REG2: c->menu = MN_REG1; return;
        case MN_DISP2: c->menu = MN_DISP1; return;
        case MN_SSUM2: c->menu = MN_SSUM; return;
        case MN_SSUM3: c->menu = MN_SSUM2; return;
        case MN_SVAR2: c->menu = MN_SVAR; return;
        case MN_SVAR3: c->menu = MN_SVAR2; return;
        case MN_SVAR4: c->menu = MN_SVAR3; return;
        default: return;
        }
    }
    if (!key_is_digit(k)) return;
    int n = k - KEY_K0;
    static const char *const SS1[] = {"sumx2", "sumx", "n"}, *const SS2[] = {"sumy2", "sumy", "sumxy"},
                             *const SS3[] = {"sumx3", "sumx2y", "sumx4"}, *const SV1[] = {"xbar", "xsn", "xsn1"},
                             *const SV2[] = {"ybar", "ysn", "ysn1"}, *const SV3L[] = {"regA", "regB", "regr"},
                             *const SV3Q[] = {"regA", "regB", "regC"}, *const SV4L[] = {"xhat", "yhat"},
                             *const SV4Q[] = {"xhat1", "xhat2", "yhat"}, *const DRG[] = {"{", "}", "~"};
    switch (c->menu) {
    case MN_MODE:
        if (n == 1) { c->cfg.mode = CALC_COMP; }
        else if (n == 2) { c->cfg.mode = CALC_SD; c->ndata = 0; }
        else if (n == 3) { c->menu = MN_REG1; return; }
        else return;
        break;
    case MN_REG1: case MN_REG2:
        if (n < 1 || n > 3) return;
        c->cfg.mode = CALC_REG;
        c->cfg.reg = (uint8_t)((c->menu == MN_REG1 ? 0 : 3) + n - 1);
        c->ndata = 0;
        break;
    case MN_ANGLE:
        if (n < 1 || n > 3) return;
        c->cfg.angle = (uint8_t)(n == 1 ? ME_ANGLE_DEG : n == 2 ? ME_ANGLE_RAD : ME_ANGLE_GRAD);
        break;
    case MN_FMT:
        if (n == 1) c->menu = MN_FIX; else if (n == 2) c->menu = MN_SCI; else if (n == 3) c->menu = MN_NORM;
        return;
    case MN_FIX: c->cfg.disp = DISP_FIX; c->cfg.digits = (uint8_t)n; break;
    case MN_SCI: c->cfg.disp = DISP_SCI; c->cfg.digits = (uint8_t)n; break;
    case MN_NORM: if (n != 1 && n != 2) return; c->cfg.disp = n == 1 ? DISP_NORM1 : DISP_NORM2; break;
    case MN_DISP: if (n == 1) c->menu = MN_DISP1; return;
    case MN_DISP1: if (n != 1 && n != 2) return; c->cfg.frac_dc = n == 2; break;
    case MN_DISP2: if (n != 1 && n != 2) return; c->cfg.dec_comma = n == 2; break;
    case MN_CLR:
        c->menu = MN_NONE;
        if (n == 1) {
            if (c->cfg.mode == CALC_COMP) memset(c->vars, 0, sizeof(c->vars)); else c->ndata = 0;
            c->state_dirty = true;
            flash(c, c->cfg.mode == CALC_COMP ? "Mcl" : "Scl");
        } else if (n == 2) { reset_mode(c); flash(c, "Mode Clear"); }
        else if (n == 3) {
            reset_mode(c);
            memset(c->vars, 0, sizeof(c->vars));
            c->ans = 0;
            c->nhist = 0;
            flash(c, "All Clear");
        } else c->menu = MN_CLR;
        return;
    case MN_DRG: if (n >= 1 && n <= 3) { c->menu = MN_NONE; put(c, DRG[n - 1], false); } return;
    case MN_SSUM: pick_var(c, SS1, n, 3); return;
    case MN_SSUM2: pick_var(c, SS2, n, 3); return;
    case MN_SSUM3: pick_var(c, SS3, n, 3); return;
    case MN_SVAR: pick_var(c, SV1, n, 3); return;
    case MN_SVAR2: pick_var(c, SV2, n, 3); return;
    case MN_SVAR3: pick_var(c, quad ? SV3Q : SV3L, n, 3); return;
    case MN_SVAR4: if (quad) pick_var(c, SV4Q, n, 3); else pick_var(c, SV4L, n, 2); return;
    default: return;
    }
    c->menu = MN_NONE;
    c->cfg_dirty = true;
}

/* ------------------------------ fractions / DMS / ENG -------------- */

static bool frac_text(const calculator_t *c, double v, char *out, size_t len)
{
    long n, d;
    if (!me_to_fraction(v, 99999, &n, &d) || d == 1) return false;
    const char *sep = "\xE2\x94\x98"; /* ┘ */
    long an = labs(n);
    const char *sg = n < 0 ? "-" : "";
    char b[48];
    if (!c->cfg.frac_dc && an > d) snprintf(b, sizeof(b), "%s%ld%s%ld%s%ld", sg, an / d, sep, an % d, sep, d);
    else snprintf(b, sizeof(b), "%s%ld%s%ld", sg, an, sep, d);
    int cells = 0;
    for (const char *p = b; *p; p++) if (*p >= '0' && *p <= '9') cells++;
    cells += (!c->cfg.frac_dc && an > d) ? 2 : 1; /* separators */
    if (cells > 10) return false;                 /* fx-style display limit */
    snprintf(out, len, "%s", b);
    return true;
}

static void dms_text(double v, char *out, size_t len)
{
    const char *sg = v < 0 ? "-" : "";
    double a = fabs(v);
    long d = (long)floor(a);
    long mm = (long)floor((a - (double)d) * 60.0);
    double ss = round((((a - (double)d) * 60.0 - (double)mm) * 60.0) * 100.0) / 100.0;
    if (ss >= 60) { ss = 0; mm++; }
    if (mm >= 60) { mm = 0; d++; }
    char s[24];
    me_format(ss, 10, s, sizeof(s));
    snprintf(out, len, "%s%ld\xC2\xB0%ld\xC2\xB0%s", sg, d, mm, s);
}

static void eng_text(const calculator_t *c, double v, char *out, size_t len)
{
    if (v == 0) { snprintf(out, len, "0"); return; }
    int e = (int)floor(floor(log10(fabs(v))) / 3.0) * 3 + c->eng_shift * 3;
    double m = v / pow(10, e);
    char ms[32];
    me_format(m, 10, ms, sizeof(ms));
    snprintf(out, len, "%sE%s%02d", ms, e < 0 ? "-" : "", e < 0 ? -e : e);
}

void calc_result_text(const calculator_t *c, char *out, size_t len)
{
    out[0] = 0;
    if (!c->evaluated) return;
    if (c->err != ME_OK) { snprintf(out, len, "%s", calc_err_name(c->err)); return; }
    if (c->label) { snprintf(out, len, "%s", c->label); return; }
    if (!c->has_result) return;
    char t[64];
    if (c->view == VIEW_FRAC && frac_text(c, c->result, t, sizeof(t))) {}
    else if (c->view == VIEW_DMS) dms_text(c->result, t, sizeof(t));
    else if (c->view == VIEW_ENG) eng_text(c, c->result, t, sizeof(t));
    else calc_format(c, c->result, t, sizeof(t));
    if (c->cfg.dec_comma) for (char *p = t; *p; p++) if (*p == '.') *p = ',';
    snprintf(out, len, "%s", t);
}

/* ------------------------------ actions ---------------------------- */

static void action(calculator_t *c, const char *a)
{
    bool ok_res = c->evaluated && c->has_result && !c->label && c->err == ME_OK;
    if (!strcmp(a, "EQ")) {
        if (c->data_idx >= 0 && c->ntok) { edit_data(c); return; }
        evaluate(c, false);
    } else if (!strcmp(a, "PCT")) evaluate(c, true);
    else if (!strcmp(a, "NEG")) put(c, "-", true); /* (−) never continues from Ans */
    else if (!strcmp(a, "DEL")) {
        if (c->evaluated) { c->evaluated = c->has_result = false; c->label = NULL; c->err = ME_OK; c->cursor = c->ntok; return; }
        if (!c->insert && c->cursor < c->ntok) {
            memmove(&c->tok[c->cursor], &c->tok[c->cursor + 1], (size_t)(c->ntok - c->cursor - 1) * sizeof(c->tok[0]));
            c->ntok--;
        } else if (c->cursor > 0) {
            memmove(&c->tok[c->cursor - 1], &c->tok[c->cursor], (size_t)(c->ntok - c->cursor) * sizeof(c->tok[0]));
            c->cursor--;
            c->ntok--;
        }
    } else if (!strcmp(a, "INS")) c->insert = !c->insert;
    else if (!strcmp(a, "AC")) calc_clear(c);
    else if (!strcmp(a, "OFF")) c->off_request = true;
    else if (!strcmp(a, "MODE")) c->menu = MN_MODE;
    else if (!strcmp(a, "CLR")) c->menu = MN_CLR;
    else if (!strcmp(a, "DRG")) c->menu = MN_DRG;
    else if (!strcmp(a, "SSUM")) { if (c->cfg.mode != CALC_COMP) c->menu = MN_SSUM; }
    else if (!strcmp(a, "SVAR")) { if (c->cfg.mode != CALC_COMP) c->menu = MN_SVAR; }
    else if (!strcmp(a, "HYP")) c->hyp = !c->hyp;
    else if (!strcmp(a, "STO")) c->pending = 'S';
    else if (!strcmp(a, "RCL")) c->pending = 'R';
    else if (!strcmp(a, "MPLUS") || !strcmp(a, "MMINUS")) {
        bool plus = a[1] == 'P';
        if (c->cfg.mode != CALC_COMP) {
            if (plus) { add_data(c); return; } /* DT */
            int i = c->data_idx >= 0 ? c->data_idx : c->ndata - 1; /* CL */
            if (i >= 0 && i < c->ndata) {
                memmove(&c->data[i], &c->data[i + 1], (size_t)(c->ndata - i - 1) * sizeof(c->data[0]));
                c->ndata--;
            }
            c->data_idx = -1;
            c->state_dirty = true;
            char b[16];
            snprintf(b, sizeof(b), "n=%d", c->ndata);
            flash(c, b);
            return;
        }
        double v;
        if (!current_value(c, &v)) return;
        c->vars[V_M] += plus ? v : -v;
        c->state_dirty = true;
        c->evaluated = c->has_result = true;
        c->label = NULL;
        c->result = v;
    } else if (!strcmp(a, "ENG") || !strcmp(a, "ENGBACK")) {
        if (!ok_res) return;
        if (c->view == VIEW_ENG) c->eng_shift = (int8_t)(c->eng_shift + (a[3] ? 1 : -1));
        c->view = VIEW_ENG;
    } else if (!strcmp(a, "ABC")) {
        char t[48];
        if (ok_res) c->view = c->view == VIEW_FRAC ? VIEW_DEC : (frac_text(c, c->result, t, sizeof(t)) ? VIEW_FRAC : VIEW_DEC);
        else put(c, "|", false);
    } else if (!strcmp(a, "DC")) {
        if (ok_res && c->view == VIEW_FRAC) { c->cfg.frac_dc = !c->cfg.frac_dc; c->cfg_dirty = true; }
    } else if (!strcmp(a, "DMSBACK")) {
        if (ok_res) c->view = c->view == VIEW_DMS ? VIEW_DEC : VIEW_DMS;
    }
}

bool calc_key(calculator_t *c, keycode_t k, bool shift, bool alpha)
{
    if (c->menu) { menu_key(c, k); return true; }
    if (c->pending) {
        const keymap_t *m = find_key(k);
        char mode = (char)c->pending;
        c->pending = 0;
        int vi = m ? var_index(m->a) : -1;
        if (vi < 0) return true;
        if (mode == 'S') {
            double v;
            if (!current_value(c, &v)) return true;
            c->vars[vi] = v;
            c->ans = v;
            c->state_dirty = true;
            c->evaluated = c->has_result = true;
            c->label = NULL;
            c->result = v;
        } else {
            c->tok[0] = VAR_NAMES[vi];
            c->ntok = c->cursor = 1;
            c->evaluated = c->has_result = true;
            c->err = ME_OK;
            c->label = NULL;
            c->result = c->ans = c->vars[vi];
        }
        return true;
    }
    if ((k == KEY_UP || k == KEY_DOWN) && c->cfg.mode != CALC_COMP && c->ndata && (!c->ntok || c->data_idx >= 0)) {
        int i = c->data_idx < 0 ? (k == KEY_UP ? c->ndata - 1 : 0) : c->data_idx + (k == KEY_UP ? -1 : 1);
        if (i < 0) i = 0;
        if (i >= c->ndata) i = c->ndata - 1;
        c->data_idx = (int16_t)i;
        data_view(c);
        return true;
    }
    if (c->evaluated && c->err != ME_OK && (k == KEY_LEFT || k == KEY_RIGHT)) {
        /* go back to the expression with the cursor at the error */
        c->evaluated = c->has_result = false;
        c->cursor = (uint8_t)(c->err_tok >= 0 && c->err_tok <= c->ntok ? c->err_tok : c->ntok);
        c->err = ME_OK;
        return true;
    }
    switch (k) {
    case KEY_LEFT:
        if (c->evaluated) { c->evaluated = c->has_result = false; c->label = NULL; c->cursor = c->ntok; }
        else if (c->cursor) c->cursor--;
        return true;
    case KEY_RIGHT:
        if (c->evaluated) { c->evaluated = c->has_result = false; c->label = NULL; c->cursor = 0; }
        else if (c->cursor < c->ntok) c->cursor++;
        return true;
    case KEY_UP: browse(c, -1); return true;
    case KEY_DOWN: browse(c, 1); return true;
    default: break;
    }
    const keymap_t *m = find_key(k);
    if (!m) return false;
    const char *act = (alpha && m->a) ? m->a : shift ? m->s : m->p;
    if (!act) return true;
    if (alpha && m->a) { put(c, act, false); return true; }
    if (act[0] == '@' && act[1]) { action(c, act + 1); return true; }
    if (c->hyp) {
        static const struct { const char *from, *to; } H[] = {
            {"sin(", "sinh("}, {"cos(", "cosh("}, {"tan(", "tanh("}, {"asin(", "asinh("}, {"acos(", "acosh("}, {"atan(", "atanh("}};
        for (size_t i = 0; i < 6; i++) if (!strcmp(act, H[i].from)) { act = H[i].to; c->hyp = false; break; }
    }
    put(c, act, false);
    return true;
}

/* ------------------------------ rendering -------------------------- */

void calc_indicators(const calculator_t *c, bool shift, bool alpha, char *out, size_t len)
{
    static const char *const ANG[] = {"R", "D", "G"};
    snprintf(out, len, "%s%s%s%s%s%s%s%s%s%s%s",
             shift ? "S " : "", alpha ? "A " : "", c->vars[V_M] != 0 ? "M " : "",
             c->pending == 'S' ? "STO " : c->pending == 'R' ? "RCL " : "",
             c->cfg.mode == CALC_SD ? "SD " : c->cfg.mode == CALC_REG ? "REG " : "",
             ANG[c->cfg.angle < 3 ? c->cfg.angle : 1],
             c->cfg.disp == DISP_FIX ? " FIX" : c->cfg.disp == DISP_SCI ? " SCI" : "",
             c->hyp ? " HYP" : "", c->insert ? " INS" : "", (c->nhist && c->evaluated) ? " ^" : "", "");
}

/* Display form of internal tokens (UTF-8). */
static const char *pretty(const char *t)
{
    static const struct { const char *t, *p; } P[] = {
        {"sqrt(", "\xE2\x88\x9A("}, {"cbrt(", "\xE2\x88\x9B("}, {"pi", "\xCF\x80"}, {"*", "\xC3\x97"}, {"/", "\xC3\xB7"},
        {"^2", "\xC2\xB2"}, {"^3", "\xC2\xB3"}, {"^(-1)", "\xE2\x81\xBB\xC2\xB9"}, {"|", "\xE2\x94\x98"}, {"@", "\xC2\xB0"},
        {"{", "\xE1\xB5\x92"}, {"}", "\xCA\xB3"}, {"~", "\xE1\xB5\x8D"}, {" nCr ", "C"}, {" nPr ", "P"},
        {"sumx2", "\xCE\xA3x\xC2\xB2"}, {"sumx", "\xCE\xA3x"}, {"sumy2", "\xCE\xA3y\xC2\xB2"}, {"sumy", "\xCE\xA3y"},
        {"sumxy", "\xCE\xA3xy"}, {"sumx3", "\xCE\xA3x\xC2\xB3"}, {"sumx2y", "\xCE\xA3x\xC2\xB2y"}, {"sumx4", "\xCE\xA3x\xE2\x81\xB4"},
        {"xbar", "\xEE\x80\x80"}, {"xsn", "x\xCF\x83n"}, {"xsn1", "x\xCF\x83n-1"}, {"ybar", "\xC8\xB3"}, {"ysn", "y\xCF\x83n"},
        {"ysn1", "y\xCF\x83n-1"}, {"regA", "A"}, {"regB", "B"}, {"regC", "C"}, {"regr", "r"}, {"xhat", "\xEE\x80\x81"},
        {"xhat1", "\xEE\x80\x81" "1"}, {"xhat2", "\xEE\x80\x81" "2"}, {"yhat", "\xC5\xB7"},
    };
    for (size_t i = 0; i < sizeof(P) / sizeof(P[0]); i++) if (!strcmp(t, P[i].t)) return P[i].p;
    return t;
}

void calc_render(calculator_t *c, fb_t *fb, int y_expr, int y_res, uint8_t res_scale, bool cursor_on)
{
    if (c->menu) {
        fb_text(fb, 2, y_expr + 2, menu_line(c, 0), NULL);
        fb_text(fb, 2, y_res - 2, menu_line(c, 1), NULL);
        return;
    }
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
    if (!c->evaluated && cursor_on) {
        int x = 1 + (int)(cur - c->hoff) * 6;
        if (c->insert) fb_vline(fb, x, y_expr, 8);
        else fb_hline(fb, x + 1, y_expr + 7, 5); /* overwrite cursor: underline */
    }
    char r[64];
    calc_result_text(c, r, sizeof(r));
    if (!r[0]) return;
    if (c->err != ME_OK) { fb_text(fb, 2, y_res, r, NULL); return; }
    uint8_t s = res_scale;
    int w1 = (int)mt_text_cells(r) * 6;
    if (w1 * s > fb->width - 2) s = 1;
    int w = w1 * s;
    fb_text_opts_t o = {false, s};
    fb_text(fb, fb->width - w - 1 < 0 ? 0 : fb->width - w - 1, s == 2 ? y_res - 8 : y_res, r, &o);
}

/* ------------------------------ persistence ------------------------ */

typedef struct {
    uint8_t version, ndata;
    double ans;
    double vars[CALC_NVARS];
    calc_data_t data[CALC_MAX_DATA];
} calc_blob_t;

int calc_save(const calculator_t *c, kv_store_t *kv)
{
    if (!kv) return KV_ERR;
    calc_blob_t *b = calloc(1, sizeof(*b));
    if (!b) return KV_ERR;
    b->version = 1;
    b->ndata = c->ndata;
    b->ans = c->ans;
    memcpy(b->vars, c->vars, sizeof(b->vars));
    memcpy(b->data, c->data, sizeof(c->data[0]) * c->ndata);
    size_t len = offsetof(calc_blob_t, data) + sizeof(c->data[0]) * c->ndata;
    int r = kv->set(kv, "calc", b, len);
    free(b);
    return r;
}

int calc_load(calculator_t *c, kv_store_t *kv)
{
    if (!kv) return KV_ERR;
    calc_blob_t *b = calloc(1, sizeof(*b));
    if (!b) return KV_ERR;
    size_t len = sizeof(*b);
    int r = kv->get(kv, "calc", b, &len);
    if (r == KV_OK && b->version == 1 && b->ndata <= CALC_MAX_DATA &&
        len == offsetof(calc_blob_t, data) + sizeof(b->data[0]) * b->ndata) {
        c->ans = isfinite(b->ans) ? b->ans : 0;
        for (int i = 0; i < CALC_NVARS; i++) c->vars[i] = isfinite(b->vars[i]) ? b->vars[i] : 0;
        memcpy(c->data, b->data, sizeof(b->data[0]) * b->ndata);
        c->ndata = b->ndata;
    } else if (r == KV_OK) r = KV_NOT_FOUND;
    free(b);
    return r;
}
