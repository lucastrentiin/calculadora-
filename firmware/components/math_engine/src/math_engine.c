/*
 * Math engine implementation. See math_engine.h.
 * Grammar (identical to the simulator):
 *   expr    := term (('+'|'-') term)*
 *   term    := unary (('*'|'/') unary | <implicit> unary)*
 *   unary   := ('-'|'+') unary | power
 *   power   := postfix ('^' unary)?
 *   comb    := unary (('nCr'|'nPr') unary)*         (fx-82MS infix, binds tighter than * /)
 *   postfix := primary ('!'|'%'|'{'|'}'|'~')*         ({ } ~ = degree/radian/grad suffix)
 *   primary := number | const | var | func '(' args ')' | '(' expr ')'
 *   number  := digits ['.' digits] ['E' exp] [('|' digits){1,2}] | d '@' m ['@' s] ['@']
 */
#include "math_engine.h"

#include <ctype.h>
#include <stddef.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifndef M_E
#define M_E 2.71828182845904523536
#endif

/* ------------------------------------------------------------------ */
/* Tokens                                                             */
/* ------------------------------------------------------------------ */

typedef enum { T_NUM, T_ID, T_OP, T_LP, T_RP, T_COMMA, T_END } tok_type_t;

typedef struct {
    tok_type_t type;
    double num;
    char op;
    uint16_t pos, len; /* identifier span in the normalised string */
} tok_t;

#define MAX_TOKENS 160

/* ------------------------------------------------------------------ */
/* AST                                                                */
/* ------------------------------------------------------------------ */

typedef enum { N_NUM, N_PAREN, N_CONST, N_VAR, N_NEG, N_FACT, N_PCT, N_FN, N_BIN, N_ANG, N_EST } node_type_t;

typedef struct {
    uint8_t type;
    char op;          /* N_BIN */
    uint8_t fn;       /* N_FN: index in FUNCS; N_CONST: 0=pi 1=e */
    uint8_t nargs;
    int16_t a, b;     /* children (N_FN uses a,b as arg0,arg1) */
    double v;         /* N_NUM */
    char name[16];    /* N_VAR */
} node_t;

typedef struct {
    char src[ME_MAX_LEN + 1];
    tok_t toks[MAX_TOKENS];
    int ntok, p, depth;
    node_t nodes[ME_MAX_NODES];
    int nnodes;
    me_err_t err;
    const me_ctx_t *ctx;
} parser_t;

typedef struct { const char *name; uint8_t min, max; const char *rule; } func_t;

static const func_t FUNCS[] = {
    {"sin", 1, 1, "Seno"}, {"cos", 1, 1, "Cosseno"}, {"tan", 1, 1, "Tangente"},
    {"asin", 1, 1, "Arco-seno"}, {"acos", 1, 1, "Arco-cosseno"}, {"atan", 1, 1, "Arco-tangente"},
    {"sinh", 1, 1, "Seno hiperbolico"}, {"cosh", 1, 1, "Cosseno hiperbolico"}, {"tanh", 1, 1, "Tangente hiperbolica"},
    {"asinh", 1, 1, "Arco-seno hiperb."}, {"acosh", 1, 1, "Arco-cosseno hiperb."}, {"atanh", 1, 1, "Arco-tangente hiperb."},
    {"sqrt", 1, 1, "Raiz quadrada"}, {"cbrt", 1, 1, "Raiz cubica"}, {"root", 2, 2, "Raiz n-esima"},
    {"ln", 1, 1, "Logaritmo natural"}, {"log", 1, 2, "Logaritmo"}, {"log2", 1, 1, "Logaritmo base 2"},
    {"exp", 1, 1, "Exponencial"}, {"abs", 1, 1, "Valor absoluto"}, {"floor", 1, 1, "Piso"},
    {"ceil", 1, 1, "Teto"}, {"round", 1, 1, "Arredondamento"}, {"nCr", 2, 2, "Combinacao"}, {"nPr", 2, 2, "Arranjo"},
    {"Rnd", 1, 1, "Arredondamento (formato)"}, {"Pol", 2, 2, "Retangular para polar"}, {"Rec", 2, 2, "Polar para retangular"},
};
#define NFUNCS (sizeof(FUNCS) / sizeof(FUNCS[0]))

enum { F_SIN, F_COS, F_TAN, F_ASIN, F_ACOS, F_ATAN, F_SINH, F_COSH, F_TANH, F_ASINH, F_ACOSH, F_ATANH,
       F_SQRT, F_CBRT, F_ROOT, F_LN, F_LOG, F_LOG2, F_EXP, F_ABS, F_FLOOR, F_CEIL, F_ROUND, F_NCR, F_NPR,
       F_RND, F_POL, F_REC };

const char *me_err_text(me_err_t e)
{
    switch (e) {
    case ME_OK: return "OK";
    case ME_ERR_SYNTAX: return "Erro de sintaxe";
    case ME_ERR_DOMAIN: return "Erro de dominio";
    case ME_ERR_DIV_ZERO: return "Divisao por zero";
    case ME_ERR_OVERFLOW: return "Estouro numerico";
    case ME_ERR_UNKNOWN: return "Nome desconhecido";
    case ME_ERR_ARGS: return "Argumentos invalidos";
    case ME_ERR_TOO_LONG: return "Expressao longa demais";
    case ME_ERR_DEPTH: return "Aninhamento excessivo";
    }
    return "Erro";
}

/* ------------------------------------------------------------------ */
/* Normalisation (UTF-8 display glyphs -> ASCII syntax)               */
/* ------------------------------------------------------------------ */

me_err_t me_normalize(const char *s, char *d, size_t len)
{
    static const struct { const char *u; const char *a; } MAP[] = {
        {"\xC3\x97", "*"},           /* × */
        {"\xC2\xB7", "*"},           /* · */
        {"\xC3\xB7", "/"},           /* ÷ */
        {"\xE2\x88\x92", "-"},       /* − */
        {"\xCF\x80", "pi"},          /* π */
        {"\xE2\x88\x9A", "sqrt"},    /* √ */
        {"\xC2\xB2", "^2"},          /* ² */
        {"\xC2\xB3", "^3"},          /* ³ */
        {"\xE2\x88\x9B", "cbrt("},  /* ∛ */
        {"\xE2\x94\x98", "|"},      /* ┘ fraction separator */
        {"\xC2\xB0", "@"},           /* ° sexagesimal separator */
        {"\xE1\xB5\x92", "{"},      /* ᵒ degree suffix */
        {"\xCA\xB3", "}"},           /* ʳ radian suffix */
        {"\xE1\xB5\x8D", "~"},      /* ᵍ grad suffix */
        {"Ran#", "Ran_"},
    };
    size_t o = 0;
    while (*s) {
        bool done = false;
        for (size_t i = 0; i < sizeof(MAP) / sizeof(MAP[0]); i++) {
            size_t ul = strlen(MAP[i].u);
            if (strncmp(s, MAP[i].u, ul) == 0) {
                size_t al = strlen(MAP[i].a);
                if (o + al >= len) return ME_ERR_TOO_LONG;
                memcpy(d + o, MAP[i].a, al);
                o += al; s += ul; done = true;
                break;
            }
        }
        if (done) continue;
        if (o + 1 >= len) return ME_ERR_TOO_LONG;
        d[o++] = *s++;
    }
    d[o] = 0;
    return ME_OK;
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                          */
/* ------------------------------------------------------------------ */

static me_err_t tokenize(parser_t *P)
{
    const char *s = P->src;
    int i = 0, n = 0;
    int L = (int)strlen(s);
    while (i < L) {
        char c = s[i];
        if (n >= MAX_TOKENS - 1) return ME_ERR_TOO_LONG;
        if (c == ' ') { i++; continue; }
        if (isdigit((unsigned char)c) || (c == '.' && isdigit((unsigned char)s[i + 1]))) {
            int start = i;
            while (isdigit((unsigned char)s[i])) i++;
            if (s[i] == '.') { i++; while (isdigit((unsigned char)s[i])) i++; }
            if (s[i] == '.') return ME_ERR_SYNTAX;
            if (s[i] == 'E' && (s[i + 1] == '+' || s[i + 1] == '-' || isdigit((unsigned char)s[i + 1]))) {
                int j = i + 1;
                if (s[j] == '+' || s[j] == '-') j++;
                if (!isdigit((unsigned char)s[j])) return ME_ERR_SYNTAX;
                while (isdigit((unsigned char)s[j])) j++;
                i = j;
            }
            char buf[64];
            int l = i - start;
            if (l >= (int)sizeof(buf)) return ME_ERR_TOO_LONG;
            memcpy(buf, s + start, (size_t)l);
            buf[l] = 0;
            double v = strtod(buf, NULL);
            if (s[i] == '|' || s[i] == '@') {
                /* fraction a|b or a|b|c, or sexagesimal d@m@s@ (fx-82MS input forms) */
                char sep = s[i];
                double part[3] = {v, 0, 0};
                int np = 1;
                while (s[i] == sep && np < 3) {
                    int j = i + 1;
                    if (!isdigit((unsigned char)s[j]) && !(s[j] == '.' && sep == '@')) break;
                    char *end;
                    part[np++] = strtod(s + j, &end);
                    i = (int)(end - s);
                }
                if (sep == '@') {
                    if (s[i] == '@') i++; /* trailing degree mark */
                    if (np == 1 && s[start + l] != '@') return ME_ERR_SYNTAX;
                    v = part[0] + part[1] / 60.0 + part[2] / 3600.0;
                } else {
                    if (np < 2) return ME_ERR_SYNTAX;
                    if (s[i] == '|') return ME_ERR_SYNTAX;
                    double den = np == 3 ? part[2] : part[1];
                    if (den == 0) return ME_ERR_DIV_ZERO;
                    v = np == 3 ? part[0] + part[1] / den : part[0] / den;
                }
            }
            P->toks[n].type = T_NUM;
            P->toks[n].num = v;
            P->toks[n].pos = (uint16_t)start;
            n++;
            continue;
        }
        if (isalpha((unsigned char)c) || c == '_') {
            int start = i;
            while (isalnum((unsigned char)s[i]) || s[i] == '_') i++;
            /* infix nCr/nPr followed directly by digits/letters: "5nCr2" */
            if (i - start > 3 && s[start] == 'n' && (s[start + 1] == 'C' || s[start + 1] == 'P') && s[start + 2] == 'r') i = start + 3;
            P->toks[n].type = T_ID;
            P->toks[n].pos = (uint16_t)start;
            P->toks[n].len = (uint16_t)(i - start);
            n++;
            continue;
        }
        if (strchr("+-*/^!%{}~", c)) { P->toks[n].type = T_OP; P->toks[n].op = c; P->toks[n].pos = (uint16_t)i; n++; i++; continue; }
        if (c == '(') { P->toks[n].type = T_LP; n++; i++; continue; }
        if (c == ')') { P->toks[n].type = T_RP; n++; i++; continue; }
        if (c == ',' || c == ';') { P->toks[n].type = T_COMMA; n++; i++; continue; }
        return ME_ERR_SYNTAX;
    }
    P->toks[n].type = T_END;
    P->ntok = n + 1;
    return ME_OK;
}

/* ------------------------------------------------------------------ */
/* Parser                                                             */
/* ------------------------------------------------------------------ */

static int new_node(parser_t *P, node_type_t t)
{
    if (P->nnodes >= ME_MAX_NODES) { P->err = ME_ERR_TOO_LONG; return -1; }
    node_t *n = &P->nodes[P->nnodes];
    memset(n, 0, sizeof(*n));
    n->type = (uint8_t)t;
    n->a = n->b = -1;
    return P->nnodes++;
}

static const tok_t *peek(parser_t *P) { return &P->toks[P->p]; }
static const tok_t *next(parser_t *P) { return &P->toks[P->p++]; }
static bool enter(parser_t *P) { if (++P->depth > ME_MAX_DEPTH) { P->err = ME_ERR_DEPTH; return false; } return true; }
static void leave(parser_t *P) { P->depth--; }

static int parse_expr(parser_t *P);
static int parse_unary(parser_t *P);

static bool id_eq(parser_t *P, const tok_t *t, const char *name)
{
    size_t l = strlen(name);
    return t->len == l && strncmp(P->src + t->pos, name, l) == 0;
}

static bool var_known(parser_t *P, const char *name)
{
    if (!P->ctx) return false;
    for (size_t i = 0; i < P->ctx->nvars; i++) if (strcmp(P->ctx->vars[i].name, name) == 0) return true;
    return false;
}

static int parse_primary(parser_t *P)
{
    if (P->err) return -1;
    const tok_t *t = next(P);
    if (t->type == T_NUM) {
        if (!isfinite(t->num)) { P->err = ME_ERR_OVERFLOW; return -1; }
        int n = new_node(P, N_NUM);
        if (n >= 0) P->nodes[n].v = t->num;
        return n;
    }
    if (t->type == T_LP) {
        int e = parse_expr(P);
        if (P->err) return -1;
        if (peek(P)->type == T_RP) next(P);
        else if (peek(P)->type != T_END) { P->err = ME_ERR_SYNTAX; return -1; }
        int n = new_node(P, N_PAREN);
        if (n >= 0) P->nodes[n].a = (int16_t)e;
        return n;
    }
    if (t->type == T_ID) {
        for (size_t f = 0; f < NFUNCS; f++) {
            if (!id_eq(P, t, FUNCS[f].name)) continue;
            if ((f == F_NCR || f == F_NPR) && peek(P)->type != T_LP) break; /* infix form handled by parse_comb */
            if (peek(P)->type != T_LP) { P->err = ME_ERR_SYNTAX; return -1; }
            next(P);
            int args[2] = {-1, -1}, na = 0;
            if (!enter(P)) return -1;
            if (peek(P)->type != T_RP && peek(P)->type != T_END) {
                for (;;) {
                    int a = parse_expr(P);
                    if (P->err) return -1;
                    if (na >= 2) { P->err = ME_ERR_ARGS; return -1; }
                    args[na++] = a;
                    if (peek(P)->type != T_COMMA) break;
                    next(P);
                }
            }
            leave(P);
            if (peek(P)->type == T_RP) next(P);
            else if (peek(P)->type != T_END) { P->err = ME_ERR_SYNTAX; return -1; }
            if (na < FUNCS[f].min || na > FUNCS[f].max) { P->err = ME_ERR_ARGS; return -1; }
            int n = new_node(P, N_FN);
            if (n < 0) return -1;
            P->nodes[n].fn = (uint8_t)f;
            P->nodes[n].nargs = (uint8_t)na;
            P->nodes[n].a = (int16_t)args[0];
            P->nodes[n].b = (int16_t)args[1];
            return n;
        }
        if (id_eq(P, t, "pi") || id_eq(P, t, "e") || id_eq(P, t, "Ran_")) {
            int n = new_node(P, N_CONST);
            if (n >= 0) P->nodes[n].fn = id_eq(P, t, "pi") ? 0 : id_eq(P, t, "e") ? 1 : 2;
            return n;
        }
        if (t->len >= sizeof(((node_t *)0)->name)) { P->err = ME_ERR_UNKNOWN; return -1; }
        char name[16];
        memcpy(name, P->src + t->pos, t->len);
        name[t->len] = 0;
        if (!var_known(P, name)) { P->err = ME_ERR_UNKNOWN; return -1; }
        int n = new_node(P, N_VAR);
        if (n >= 0) strcpy(P->nodes[n].name, name);
        return n;
    }
    P->err = ME_ERR_SYNTAX;
    return -1;
}

static int parse_postfix(parser_t *P)
{
    int a = parse_primary(P);
    static const char *const EST[] = {"xhat", "xhat1", "xhat2", "yhat"};
    for (;;) {
        if (P->err) return -1;
        const tok_t *t = peek(P);
        int w = -1;
        for (int i = 0; t->type == T_ID && i < 4; i++) if (id_eq(P, t, EST[i])) w = i;
        if (w >= 0) {
            next(P);
            int n = new_node(P, N_EST);
            if (n < 0) return -1;
            P->nodes[n].a = (int16_t)a;
            P->nodes[n].fn = (uint8_t)w;
            a = n;
            continue;
        }
        if (!(t->type == T_OP && strchr("!%{}~", t->op))) break;
        char op = next(P)->op;
        int n = new_node(P, op == '!' ? N_FACT : op == '%' ? N_PCT : N_ANG);
        if (n < 0) return -1;
        P->nodes[n].a = (int16_t)a;
        P->nodes[n].op = op;
        a = n;
    }
    return a;
}

static int parse_power(parser_t *P)
{
    int base = parse_postfix(P);
    if (P->err) return -1;
    if (peek(P)->type == T_OP && peek(P)->op == '^') {
        next(P);
        if (!enter(P)) return -1;
        int e = parse_unary(P);
        leave(P);
        int n = new_node(P, N_BIN);
        if (n < 0) return -1;
        P->nodes[n].op = '^';
        P->nodes[n].a = (int16_t)base;
        P->nodes[n].b = (int16_t)e;
        return n;
    }
    return base;
}

static int parse_unary(parser_t *P)
{
    if (P->err) return -1;
    const tok_t *t = peek(P);
    if (t->type == T_OP && (t->op == '-' || t->op == '+')) {
        char op = next(P)->op;
        if (!enter(P)) return -1;
        int a = parse_unary(P);
        leave(P);
        if (op == '+') return a;
        int n = new_node(P, N_NEG);
        if (n >= 0) P->nodes[n].a = (int16_t)a;
        return n;
    }
    return parse_power(P);
}

static bool is_infix_comb(parser_t *P)
{
    const tok_t *t = peek(P);
    if (t->type != T_ID || !(id_eq(P, t, "nCr") || id_eq(P, t, "nPr"))) return false;
    return P->toks[P->p + 1].type != T_LP;
}

static int parse_comb(parser_t *P)
{
    int left = parse_unary(P);
    while (!P->err && is_infix_comb(P)) {
        char op = id_eq(P, next(P), "nCr") ? 'C' : 'P';
        int right = parse_unary(P);
        int n = new_node(P, N_BIN);
        if (n < 0) return -1;
        P->nodes[n].op = op;
        P->nodes[n].a = (int16_t)left;
        P->nodes[n].b = (int16_t)right;
        left = n;
    }
    return left;
}

static int parse_term(parser_t *P)
{
    int left = parse_comb(P);
    while (!P->err) {
        const tok_t *t = peek(P);
        char op;
        if (t->type == T_OP && (t->op == '*' || t->op == '/')) { op = t->op; next(P); }
        else if (t->type == T_NUM || t->type == T_ID || t->type == T_LP) op = '*'; /* implicit */
        else break;
        int right = parse_comb(P);
        int n = new_node(P, N_BIN);
        if (n < 0) return -1;
        P->nodes[n].op = op;
        P->nodes[n].a = (int16_t)left;
        P->nodes[n].b = (int16_t)right;
        left = n;
    }
    return left;
}

static int parse_expr(parser_t *P)
{
    if (!enter(P)) return -1;
    int left = parse_term(P);
    while (!P->err && peek(P)->type == T_OP && (peek(P)->op == '+' || peek(P)->op == '-')) {
        char op = next(P)->op;
        int right = parse_term(P);
        int n = new_node(P, N_BIN);
        if (n < 0) return -1;
        P->nodes[n].op = op;
        P->nodes[n].a = (int16_t)left;
        P->nodes[n].b = (int16_t)right;
        left = n;
    }
    leave(P);
    return left;
}

static me_err_t parse(parser_t *P, const char *expr, const me_ctx_t *ctx, int *root)
{
    memset(P, 0, offsetof(parser_t, toks));
    P->ctx = ctx;
    P->nnodes = 0;
    me_err_t e = me_normalize(expr, P->src, sizeof(P->src));
    if (e != ME_OK) return e;
    if (strlen(P->src) > ME_MAX_LEN) return ME_ERR_TOO_LONG;
    e = tokenize(P);
    if (e != ME_OK) return e;
    P->p = 0; P->depth = 0; P->err = ME_OK;
    int r = parse_expr(P);
    if (P->err) return P->err;
    if (peek(P)->type != T_END) return ME_ERR_SYNTAX;
    *root = r;
    return ME_OK;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                         */
/* ------------------------------------------------------------------ */

#define SNAP 1e-12
static double snap(double v) { return fabs(v) < SNAP ? 0.0 : v; }
static bool is_int(double v) { return isfinite(v) && fabs(v - round(v)) < 1e-9; }

static me_err_t chk(double v, double *out)
{
    if (isnan(v)) return ME_ERR_DOMAIN;
    if (!isfinite(v)) return ME_ERR_OVERFLOW;
    *out = (v == 0.0) ? 0.0 : v;
    return ME_OK;
}

static double to_rad(double x, const me_ctx_t *c)
{
    if (c && c->angle == ME_ANGLE_DEG) return fmod(x, 360.0) * M_PI / 180.0;
    if (c && c->angle == ME_ANGLE_GRAD) return fmod(x, 400.0) * M_PI / 200.0;
    return x;
}
static double from_rad(double x, const me_ctx_t *c)
{
    if (c && c->angle == ME_ANGLE_DEG) return x * 180.0 / M_PI;
    if (c && c->angle == ME_ANGLE_GRAD) return x * 200.0 / M_PI;
    return x;
}
/* DRG► suffix: value given in unit u ('{' deg, '}' rad, '~' grad) converted to the current angle unit */
static double angle_to_current(double x, char u, const me_ctx_t *c)
{
    double r = u == '{' ? x * M_PI / 180.0 : u == '~' ? x * M_PI / 200.0 : x;
    return from_rad(r, c);
}

static me_err_t factorial(double n, double *out)
{
    if (!is_int(n) || n < 0) return ME_ERR_DOMAIN;
    long k = lround(n);
    if (k > 170) return ME_ERR_OVERFLOW;
    double r = 1;
    for (long i = 2; i <= k; i++) r *= (double)i;
    *out = r;
    return ME_OK;
}

static me_err_t power(double a, double b, double *out)
{
    if (a == 0 && b == 0) return ME_ERR_DOMAIN;
    if (a == 0 && b < 0) return ME_ERR_DIV_ZERO;
    if (a < 0 && !is_int(b)) {
        long n, d;
        if (me_to_fraction(b, 99, &n, &d) && (d % 2) == 1) {
            double mag = pow(-a, (double)labs(n) / (double)d);
            double s = (n % 2 == 0) ? mag : -mag;
            *out = n < 0 ? 1.0 / s : s;
            return ME_OK;
        }
        return ME_ERR_DOMAIN;
    }
    *out = pow(a, b);
    return ME_OK;
}

static me_err_t apply_fn(int f, const double *x, int nargs, const me_ctx_t *c, double *out)
{
    double v = x[0];
    switch (f) {
    case F_SIN: *out = snap(sin(to_rad(v, c))); return ME_OK;
    case F_COS: *out = snap(cos(to_rad(v, c))); return ME_OK;
    case F_TAN: { double r = to_rad(v, c); if (fabs(cos(r)) < SNAP) return ME_ERR_DOMAIN; *out = snap(tan(r)); return ME_OK; }
    case F_ASIN: if (v < -1 || v > 1) return ME_ERR_DOMAIN; *out = from_rad(asin(v), c); return ME_OK;
    case F_ACOS: if (v < -1 || v > 1) return ME_ERR_DOMAIN; *out = from_rad(acos(v), c); return ME_OK;
    case F_ATAN: *out = from_rad(atan(v), c); return ME_OK;
    case F_SINH: *out = sinh(v); return ME_OK;
    case F_COSH: *out = cosh(v); return ME_OK;
    case F_TANH: *out = tanh(v); return ME_OK;
    case F_ASINH: *out = asinh(v); return ME_OK;
    case F_ACOSH: if (v < 1) return ME_ERR_DOMAIN; *out = acosh(v); return ME_OK;
    case F_ATANH: if (v <= -1 || v >= 1) return ME_ERR_DOMAIN; *out = atanh(v); return ME_OK;
    case F_SQRT: if (v < 0) return ME_ERR_DOMAIN; *out = sqrt(v); return ME_OK;
    case F_CBRT: *out = cbrt(v); return ME_OK;
    case F_ROOT: {
        double n = x[0], r = x[1];
        if (n == 0) return ME_ERR_DOMAIN;
        if (r < 0) { if (is_int(n) && (lround(n) % 2) != 0) { *out = -pow(-r, 1.0 / n); return ME_OK; } return ME_ERR_DOMAIN; }
        *out = pow(r, 1.0 / n);
        return ME_OK;
    }
    case F_LN: if (v <= 0) return ME_ERR_DOMAIN; *out = log(v); return ME_OK;
    case F_LOG:
        if (nargs == 2) {
            double b = x[0], y = x[1];
            if (b <= 0 || b == 1 || y <= 0) return ME_ERR_DOMAIN;
            *out = log(y) / log(b);
            return ME_OK;
        }
        if (v <= 0) return ME_ERR_DOMAIN;
        *out = log10(v);
        return ME_OK;
    case F_LOG2: if (v <= 0) return ME_ERR_DOMAIN; *out = log2(v); return ME_OK;
    case F_EXP: *out = exp(v); return ME_OK;
    case F_ABS: *out = fabs(v); return ME_OK;
    case F_FLOOR: *out = floor(v); return ME_OK;
    case F_CEIL: *out = ceil(v); return ME_OK;
    case F_ROUND: *out = floor(v + 0.5); return ME_OK; /* JS Math.round semantics */
    case F_NCR: case F_NPR: {
        double n = x[0], r = x[1];
        if (!is_int(n) || !is_int(r) || n < 0 || r < 0 || r > n) return ME_ERR_DOMAIN;
        if (f == F_NPR) {
            double a, b; me_err_t e;
            if ((e = factorial(n, &a)) != ME_OK) return e;
            if ((e = factorial(n - r, &b)) != ME_OK) return e;
            *out = a / b;
            return ME_OK;
        }
        double k = fmin(r, n - r), res = 1;
        for (double i = 1; i <= k; i++) res = res * (n - k + i) / i;
        *out = round(res);
        return ME_OK;
    }
    case F_RND:
        *out = (c && c->round) ? c->round(c->user, v) : v;
        return ME_OK;
    case F_POL: {
        double x0 = x[0], y0 = x[1];
        double r = hypot(x0, y0), th = from_rad(atan2(y0, x0), c);
        if (c && c->set_var) { c->set_var(c->user, "E", r); c->set_var(c->user, "F", th); }
        *out = r;
        return ME_OK;
    }
    case F_REC: {
        double r = x[0], th = to_rad(x[1], c);
        double xr = snap(r * cos(th)), yr = snap(r * sin(th));
        if (c && c->set_var) { c->set_var(c->user, "E", xr); c->set_var(c->user, "F", yr); }
        *out = xr;
        return ME_OK;
    }
    }
    return ME_ERR_UNKNOWN;
}

static me_err_t lookup(const me_ctx_t *c, const char *name, double *out)
{
    for (size_t i = 0; c && i < c->nvars; i++) {
        if (strcmp(c->vars[i].name, name) == 0) {
            if (!isfinite(c->vars[i].value)) return ME_ERR_DOMAIN; /* e.g. statistic without enough data */
            *out = c->vars[i].value;
            return ME_OK;
        }
    }
    return ME_ERR_UNKNOWN;
}

static me_err_t binop(char op, double a, double b, double *out)
{
    switch (op) {
    case '+': *out = a + b; return ME_OK;
    case '-': *out = a - b; return ME_OK;
    case '*': *out = a * b; return ME_OK;
    case '/': if (b == 0) return ME_ERR_DIV_ZERO; *out = a / b; return ME_OK;
    case '^': return power(a, b, out);
    case 'C': case 'P': { double x[2] = {a, b}; return apply_fn(op == 'C' ? F_NCR : F_NPR, x, 2, NULL, out); }
    }
    return ME_ERR_SYNTAX;
}

static me_err_t eval_node(const parser_t *P, int i, double *out)
{
    const node_t *n = &P->nodes[i];
    const me_ctx_t *c = P->ctx;
    double a, b, r;
    me_err_t e;
    switch (n->type) {
    case N_NUM: *out = n->v; return ME_OK;
    case N_PAREN: return eval_node(P, n->a, out);
    case N_CONST:
        if (n->fn == 2) {
            if (!c || !c->random) return ME_ERR_UNKNOWN;
            *out = floor(c->random(c->user) * 1000.0) / 1000.0;
            return ME_OK;
        }
        *out = n->fn == 0 ? M_PI : M_E;
        return ME_OK;
    case N_VAR: return lookup(c, n->name, out);
    case N_ANG: if ((e = eval_node(P, n->a, &a))) return e; return chk(angle_to_current(a, n->op, c), out);
    case N_EST:
        if ((e = eval_node(P, n->a, &a))) return e;
        if (!c || !c->estimate) return ME_ERR_SYNTAX;
        if ((e = c->estimate(c->user, n->fn, a, &r))) return e;
        return chk(r, out);
    case N_NEG: if ((e = eval_node(P, n->a, &a))) return e; return chk(-a, out);
    case N_FACT: if ((e = eval_node(P, n->a, &a))) return e; if ((e = factorial(a, &r))) return e; return chk(r, out);
    case N_PCT: if ((e = eval_node(P, n->a, &a))) return e; return chk(a / 100.0, out);
    case N_FN: {
        double args[2] = {0, 0};
        if ((e = eval_node(P, n->a, &args[0]))) return e;
        if (n->nargs == 2 && (e = eval_node(P, n->b, &args[1]))) return e;
        if ((e = apply_fn(n->fn, args, n->nargs, c, &r))) return e;
        return chk(r, out);
    }
    case N_BIN:
        if ((e = eval_node(P, n->a, &a))) return e;
        if ((n->op == '+' || n->op == '-') && P->nodes[n->b].type == N_PCT) {
            double p;
            if ((e = eval_node(P, P->nodes[n->b].a, &p))) return e;
            return chk(n->op == '+' ? a + a * p / 100.0 : a - a * p / 100.0, out);
        }
        if ((e = eval_node(P, n->b, &b))) return e;
        if ((e = binop(n->op, a, b, &r))) return e;
        return chk(r, out);
    }
    return ME_ERR_SYNTAX;
}

/* Parser state is large (~13 KB): keep it static on the MCU and protect it
 * with a lock if the engine is ever used from more than one task. */
static parser_t s_parser;

me_err_t me_eval(const char *expr, const me_ctx_t *ctx, double *out)
{
    parser_t *P = &s_parser;
    int root;
    me_err_t e = parse(P, expr, ctx, &root);
    if (e != ME_OK) return e;
    double v;
    e = eval_node(P, root, &v);
    if (e == ME_OK) *out = v;
    return e;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

static void trim_zeros(char *s)
{
    if (!strchr(s, '.')) return;
    size_t l = strlen(s);
    while (l > 0 && s[l - 1] == '0') s[--l] = 0;
    if (l > 0 && s[l - 1] == '.') s[--l] = 0;
}

void me_format(double v, int sig, char *buf, size_t len)
{
    if (isnan(v)) { snprintf(buf, len, "NaN"); return; }
    if (!isfinite(v)) { snprintf(buf, len, v > 0 ? "inf" : "-inf"); return; }
    if (v == 0) { snprintf(buf, len, "0"); return; }
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "%.*e", sig - 1, v);
    double rounded = strtod(tmp, NULL);
    int ex = (int)floor(log10(fabs(rounded)));
    if (ex >= sig || ex < -9) {
        char *epos = strchr(tmp, 'e');
        int e10 = atoi(epos + 1);
        *epos = 0;
        trim_zeros(tmp);
        snprintf(buf, len, "%sE%d", tmp, e10);
        return;
    }
    int dec = sig - 1 - ex;
    if (dec < 0) dec = 0;
    if (dec > 20) dec = 20;
    snprintf(tmp, sizeof(tmp), "%.*f", dec, rounded);
    trim_zeros(tmp);
    if (strcmp(tmp, "-0") == 0) strcpy(tmp, "0");
    snprintf(buf, len, "%s", tmp);
}

static long gcdl(long a, long b) { a = labs(a); b = labs(b); while (b) { long t = a % b; a = b; b = t; } return a; }

bool me_to_fraction(double x, long max_den, long *num, long *den)
{
    if (!isfinite(x)) return false;
    if (is_int(x)) { *num = lround(x); *den = 1; return true; }
    int sign = x < 0 ? -1 : 1;
    double v = fabs(x), b = v;
    long h1 = 1, h0 = 0, k1 = 0, k0 = 1;
    for (int i = 0; i < 40; i++) {
        double a = floor(b);
        if (a > 1e15) break;
        long h2 = (long)a * h1 + h0, k2 = (long)a * k1 + k0;
        if (k2 > max_den) break;
        h0 = h1; h1 = h2; k0 = k1; k1 = k2;
        if (fabs(v - (double)h1 / (double)k1) < 1e-10 * fmax(1.0, v)) {
            long g = gcdl(h1, k1);
            *num = sign * h1 / g;
            *den = k1 / g;
            return true;
        }
        double frac = b - a;
        if (frac < 1e-15) break;
        b = 1.0 / frac;
    }
    return false;
}

/* ------------------------------------------------------------------ */
/* Printing and step-by-step                                          */
/* ------------------------------------------------------------------ */

typedef struct { char *buf; size_t len, pos; bool overflow; } sb_t;

static void sb_put(sb_t *s, const char *t)
{
    size_t l = strlen(t);
    if (s->pos + l >= s->len) { s->overflow = true; return; }
    memcpy(s->buf + s->pos, t, l);
    s->pos += l;
    s->buf[s->pos] = 0;
}

static int prec(const parser_t *P, int i)
{
    const node_t *n = &P->nodes[i];
    switch (n->type) {
    case N_BIN: return (n->op == '+' || n->op == '-') ? 1 : n->op == '^' ? 4 : 2;
    case N_NEG: return 3;
    case N_FACT: case N_PCT: case N_ANG: case N_EST: return 5;
    case N_NUM: return n->v < 0 ? 3 : 6;
    default: return 6;
    }
}

static void print_node(const parser_t *P, int i, sb_t *s);

static void wrap(const parser_t *P, int i, bool parens, sb_t *s)
{
    if (parens) sb_put(s, "(");
    print_node(P, i, s);
    if (parens) sb_put(s, ")");
}

static void print_node(const parser_t *P, int i, sb_t *s)
{
    const node_t *n = &P->nodes[i];
    char num[40];
    switch (n->type) {
    case N_NUM: me_format(n->v, 10, num, sizeof(num)); sb_put(s, num); return;
    case N_PAREN: sb_put(s, "("); print_node(P, n->a, s); sb_put(s, ")"); return;
    case N_CONST: sb_put(s, n->fn == 0 ? "pi" : n->fn == 1 ? "e" : "Ran#"); return;
    case N_VAR: sb_put(s, n->name); return;
    case N_EST: { static const char *const EN[] = {"xhat", "xhat1", "xhat2", "yhat"}; wrap(P, n->a, prec(P, n->a) < 6, s); sb_put(s, EN[n->fn]); return; }
    case N_ANG: wrap(P, n->a, prec(P, n->a) < 6, s); sb_put(s, n->op == '{' ? "\xE1\xB5\x92" : n->op == '}' ? "\xCA\xB3" : "\xE1\xB5\x8D"); return;
    case N_NEG: {
        const node_t *c = &P->nodes[n->a];
        sb_put(s, "-");
        wrap(P, n->a, prec(P, n->a) < 3 || (c->type == N_NUM && c->v < 0) || c->type == N_NEG, s);
        return;
    }
    case N_FACT: wrap(P, n->a, prec(P, n->a) < 6, s); sb_put(s, "!"); return;
    case N_PCT: wrap(P, n->a, prec(P, n->a) < 6, s); sb_put(s, "%"); return;
    case N_FN:
        sb_put(s, FUNCS[n->fn].name);
        sb_put(s, "(");
        print_node(P, n->a, s);
        if (n->nargs == 2) { sb_put(s, ","); print_node(P, n->b, s); }
        sb_put(s, ")");
        return;
    case N_BIN: {
        int p = prec(P, i);
        const node_t *bn = &P->nodes[n->b];
        char op[8] = {n->op, 0};
        if (n->op == 'C' || n->op == 'P') snprintf(op, sizeof(op), " n%cr ", n->op);
        if (n->op == '^') {
            wrap(P, n->a, prec(P, n->a) <= 4, s);
            sb_put(s, op);
            wrap(P, n->b, prec(P, n->b) < 3, s);
        } else {
            wrap(P, n->a, prec(P, n->a) < p, s);
            sb_put(s, op);
            bool rp = prec(P, n->b) < p || (prec(P, n->b) == p && (n->op == '-' || n->op == '/')) ||
                      (bn->type == N_NUM && bn->v < 0) || bn->type == N_NEG;
            wrap(P, n->b, rp, s);
        }
        return;
    }
    }
}

static const char *op_rule(char op)
{
    switch (op) {
    case '+': return "Soma";
    case '-': return "Subtracao";
    case '*': return "Multiplicacao";
    case '/': return "Divisao";
    case '^': return "Potencia";
    case 'C': return "Combinacao";
    case 'P': return "Arranjo";
    }
    return "Calculo";
}

/* Replace node i by a number in place. */
static void make_num(parser_t *P, int i, double v)
{
    node_t *n = &P->nodes[i];
    n->type = N_NUM;
    n->v = v;
    n->a = n->b = -1;
}

static void strip_num_parens(parser_t *P, int i)
{
    node_t *n = &P->nodes[i];
    if (n->type == N_PAREN && P->nodes[n->a].type == N_NUM) { make_num(P, i, P->nodes[n->a].v); return; }
    if (n->type == N_NUM || n->type == N_CONST || n->type == N_VAR) return;
    if (n->a >= 0) strip_num_parens(P, n->a);
    if (n->b >= 0 && (n->type == N_BIN || (n->type == N_FN && n->nargs == 2))) strip_num_parens(P, n->b);
}

/* Returns 1 if a reduction happened (rule written), 0 if nothing to do, -err on error. */
static int reduce_once(parser_t *P, int i, char *rule, size_t rlen)
{
    node_t *n = &P->nodes[i];
    if (n->type == N_NUM) return 0;
    if (n->type == N_PAREN) {
        if (P->nodes[n->a].type == N_NUM) { make_num(P, i, P->nodes[n->a].v); snprintf(rule, rlen, "Remocao de parenteses"); return 1; }
        return reduce_once(P, n->a, rule, rlen);
    }
    int r;
    if (n->a >= 0 && (r = reduce_once(P, n->a, rule, rlen)) != 0) return r;
    bool has_b = n->b >= 0 && (n->type == N_BIN || (n->type == N_FN && n->nargs == 2));
    bool pct_rule = n->type == N_BIN && (n->op == '+' || n->op == '-') && P->nodes[n->b].type == N_PCT &&
                    P->nodes[P->nodes[n->b].a].type == N_NUM;
    if (has_b && !pct_rule && (r = reduce_once(P, n->b, rule, rlen)) != 0) return r;

    double v;
    me_err_t e = eval_node(P, i, &v);
    if (e != ME_OK) return -(int)e;
    char before[ME_PRINT_MAX];
    sb_t sb = {before, sizeof(before), 0, false};
    before[0] = 0;
    print_node(P, i, &sb);
    char vs[40];
    me_format(v, 10, vs, sizeof(vs));
    const char *name;
    if (n->type == N_BIN) name = pct_rule ? "Porcentagem" : op_rule(n->op);
    else if (n->type == N_FN) name = FUNCS[n->fn].rule;
    else if (n->type == N_NEG) name = "Sinal";
    else if (n->type == N_FACT) name = "Fatorial";
    else if (n->type == N_PCT) name = "Porcentagem";
    else if (n->type == N_ANG) name = "Conversao angular";
    else if (n->type == N_EST) name = "Estimativa";
    else if (n->type == N_CONST || n->type == N_VAR) name = "Substituicao";
    else name = "Calculo";
    snprintf(rule, rlen, "%s: %.*s = %s", name, 96, before, vs);
    make_num(P, i, v);
    return 1;
}

static void substitute(parser_t *P, int i, char *list, size_t len)
{
    node_t *n = &P->nodes[i];
    if (n->type == N_CONST || n->type == N_VAR) {
        double v = 0;
        const char *name = n->type == N_CONST ? (n->fn == 0 ? "pi" : n->fn == 1 ? "e" : "Ran#") : n->name;
        if (n->type == N_CONST) eval_node(P, i, &v);
        else lookup(P->ctx, n->name, &v);
        char item[48], vs[32];
        me_format(v, 10, vs, sizeof(vs));
        snprintf(item, sizeof(item), "%s=%s", name, vs);
        if (!strstr(list, item)) {
            if (list[0] && strlen(list) + 2 < len) strcat(list, ", ");
            if (strlen(list) + strlen(item) < len) strcat(list, item);
        }
        make_num(P, i, v);
        return;
    }
    if (n->type == N_NUM) return;
    if (n->a >= 0) substitute(P, n->a, list, len);
    if (n->b >= 0 && (n->type == N_BIN || (n->type == N_FN && n->nargs == 2))) substitute(P, n->b, list, len);
}

me_err_t me_solve_steps(const char *expr, const me_ctx_t *ctx, me_step_cb cb, void *user, double *out, bool *truncated)
{
    parser_t *P = &s_parser;
    int root;
    me_err_t e = parse(P, expr, ctx, &root);
    if (e != ME_OK) return e;
    double final;
    e = eval_node(P, root, &final); /* validate first: errors are reported before any step */
    if (e != ME_OK) return e;

    char text[ME_PRINT_MAX];
    sb_t sb = {text, sizeof(text), 0, false};
    text[0] = 0;
    print_node(P, root, &sb);
    if (cb) cb("Expressao original", text, user);

    char list[160] = "";
    substitute(P, root, list, sizeof(list));
    if (list[0]) {
        char rule[200];
        snprintf(rule, sizeof(rule), "Substituicao: %s", list);
        sb.pos = 0; text[0] = 0;
        print_node(P, root, &sb);
        if (cb) cb(rule, text, user);
    }
    int guard = 0;
    char rule[200];
    while (P->nodes[root].type != N_NUM && guard++ < ME_MAX_STEPS) {
        int r = reduce_once(P, root, rule, sizeof(rule));
        if (r < 0) return (me_err_t)(-r);
        if (r == 0) break;
        strip_num_parens(P, root);
        sb.pos = 0; text[0] = 0;
        print_node(P, root, &sb);
        if (cb) cb(rule, text, user);
    }
    if (truncated) *truncated = guard >= ME_MAX_STEPS;
    if (out) *out = P->nodes[root].type == N_NUM ? P->nodes[root].v : final;
    return ME_OK;
}
