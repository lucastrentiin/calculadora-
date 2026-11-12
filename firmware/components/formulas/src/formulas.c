#include "formulas.h"

#include <ctype.h>
#include <string.h>

const formula_t *formula_get(const char *id)
{
    for (size_t i = 0; i < formula_count; i++) if (strcmp(formula_list[i].id, id) == 0) return &formula_list[i];
    return NULL;
}

size_t formula_by_category(const char *cat, const formula_t **out, size_t max)
{
    size_t n = 0;
    for (size_t i = 0; i < formula_count && n < max; i++) if (strcmp(formula_list[i].cat, cat) == 0) out[n++] = &formula_list[i];
    return n;
}

/* Lowercase ASCII and fold the common Portuguese accented letters (UTF-8). */
static void fold(const char *s, char *d, size_t len)
{
    size_t o = 0;
    while (*s && o + 1 < len) {
        unsigned char c = (unsigned char)*s;
        if (c == 0xC3 && s[1]) {
            unsigned char n = (unsigned char)s[1] | 0x20; /* fold case of Latin-1 letters */
            char base = '?';
            if (n >= 0xA0 && n <= 0xA5) base = 'a';
            else if (n == 0xA7) base = 'c';
            else if (n >= 0xA8 && n <= 0xAB) base = 'e';
            else if (n >= 0xAC && n <= 0xAF) base = 'i';
            else if (n >= 0xB2 && n <= 0xB6) base = 'o';
            else if (n >= 0xB9 && n <= 0xBC) base = 'u';
            d[o++] = base;
            s += 2;
            continue;
        }
        d[o++] = (char)tolower(c);
        s++;
    }
    d[o] = 0;
}

size_t formula_search(const char *query, const formula_t **out, size_t max)
{
    char q[64], buf[160];
    fold(query, q, sizeof(q));
    /* trim */
    char *qs = q;
    while (*qs == ' ') qs++;
    size_t ql = strlen(qs);
    while (ql && qs[ql - 1] == ' ') qs[--ql] = 0;
    size_t n = 0;
    for (size_t i = 0; i < formula_count && n < max; i++) {
        const formula_t *f = &formula_list[i];
        bool hit = !*qs;
        if (!hit) { fold(f->name, buf, sizeof(buf)); hit = strstr(buf, qs) != NULL; }
        if (!hit) { fold(f->formula, buf, sizeof(buf)); hit = strstr(buf, qs) != NULL; }
        if (!hit) { fold(f->cat, buf, sizeof(buf)); hit = strstr(buf, qs) != NULL; }
        if (hit) out[n++] = f;
    }
    return n;
}

#define MAX_VARS 8

static void make_ctx(const formula_t *f, const double *values, me_var_t *vars, me_ctx_t *ctx)
{
    size_t n = f->nvars > MAX_VARS ? MAX_VARS : f->nvars;
    for (size_t i = 0; i < n; i++) { vars[i].name = f->vars[i].sym; vars[i].value = values[i]; }
    ctx->angle = f->angle_deg ? ME_ANGLE_DEG : ME_ANGLE_RAD;
    ctx->vars = vars;
    ctx->nvars = n;
}

me_err_t formula_apply(const formula_t *f, const double *values, double *result)
{
    me_var_t vars[MAX_VARS];
    me_ctx_t ctx;
    make_ctx(f, values, vars, &ctx);
    return me_eval(f->expr, &ctx, result);
}

me_err_t formula_apply_steps(const formula_t *f, const double *values, me_step_cb cb, void *user, double *result)
{
    me_var_t vars[MAX_VARS];
    me_ctx_t ctx;
    make_ctx(f, values, vars, &ctx);
    return me_solve_steps(f->expr, &ctx, cb, user, result, NULL);
}
