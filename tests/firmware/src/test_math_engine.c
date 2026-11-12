#include "mt_test.h"
#include "math_engine.h"

static const me_ctx_t DEG = {.angle = ME_ANGLE_DEG, .vars = NULL, .nvars = 0};
static const me_ctx_t RAD = {.angle = ME_ANGLE_RAD, .vars = NULL, .nvars = 0};

static double V(const char *e, const me_ctx_t *c) { double v = NAN; me_err_t r = me_eval(e, c, &v); if (r) printf("  erro em %s: %s\n", e, me_err_text(r)); return v; }
static me_err_t E(const char *e, const me_ctx_t *c) { double v; return me_eval(e, c, &v); }
static const char *F(double v) { static char b[64]; me_format(v, 10, b, sizeof b); return b; }

TEST(precedence) {
    CHECK_NEAR(V("2+3*4", &RAD), 14, 0);
    CHECK_NEAR(V("2^3^2", &RAD), 512, 0);
    CHECK_NEAR(V("-2^2", &RAD), -4, 0);
    CHECK_NEAR(V("(-2)^2", &RAD), 4, 0);
    CHECK_NEAR(V("2^-1", &RAD), 0.5, 0);
    CHECK_NEAR(V("10-4-3", &RAD), 3, 0);
    CHECK_NEAR(V("100/10/5", &RAD), 2, 0);
    CHECK_NEAR(V("2pi", &RAD), 2 * 3.14159265358979, 1e-12);
    CHECK_NEAR(V("3(4+1)", &RAD), 15, 0);
    CHECK_NEAR(V("(1+2", &RAD), 3, 0);
}
TEST(functions) {
    CHECK_STR(F(V("sin(30)", &DEG)), "0.5");
    CHECK_STR(F(V("sin(180)", &DEG)), "0");
    CHECK_STR(F(V("tan(45)", &DEG)), "1");
    CHECK_STR(F(V("asin(0.5)", &DEG)), "30");
    CHECK_NEAR(V("sqrt(16)+cbrt(-27)", &RAD), 1, 1e-12);
    CHECK_NEAR(V("log(1000)+ln(e)+log2(8)", &RAD), 7, 1e-12);
    CHECK_NEAR(V("log(2,8)", &RAD), 3, 1e-12);
    CHECK_NEAR(V("root(4,81)", &RAD), 3, 1e-12);
    CHECK_NEAR(V("(-8)^(1/3)", &RAD), -2, 1e-12);
    CHECK_NEAR(V("5!", &RAD), 120, 0);
    CHECK_NEAR(V("nCr(5,2)+nPr(5,2)", &RAD), 30, 0);
    CHECK_NEAR(V("200+10%", &RAD), 220, 0);
    CHECK_NEAR(V("200-10%", &RAD), 180, 0);
    CHECK_NEAR(V("1.5E3*2", &RAD), 3000, 0);
    CHECK_NEAR(V("\xE2\x88\x9A(25)+3\xC2\xB2", &RAD), 14, 0);      /* √(25)+3² */
    CHECK_NEAR(V("6\xC3\x97" "7", &RAD), 42, 0);                   /* 6×7 */
}
TEST(variables) {
    me_var_t vars[] = {{"Ans", 21}, {"M", 4}};
    me_ctx_t c = {.angle = ME_ANGLE_RAD, .vars = vars, .nvars = 2};
    CHECK_NEAR(V("Ans*2+M", &c), 46, 0);
    CHECK_INT(E("foo", &c), ME_ERR_UNKNOWN);
}
TEST(errors) {
    CHECK_INT(E("1/0", &RAD), ME_ERR_DIV_ZERO);
    CHECK_INT(E("0^-1", &RAD), ME_ERR_DIV_ZERO);
    CHECK_INT(E("tan(90)", &DEG), ME_ERR_DOMAIN);
    CHECK_INT(E("sqrt(-1)", &RAD), ME_ERR_DOMAIN);
    CHECK_INT(E("ln(0)", &RAD), ME_ERR_DOMAIN);
    CHECK_INT(E("asin(2)", &RAD), ME_ERR_DOMAIN);
    CHECK_INT(E("3.5!", &RAD), ME_ERR_DOMAIN);
    CHECK_INT(E("171!", &RAD), ME_ERR_OVERFLOW);
    CHECK_INT(E("10^400", &RAD), ME_ERR_OVERFLOW);
    CHECK_INT(E("2+*3", &RAD), ME_ERR_SYNTAX);
    CHECK_INT(E("", &RAD), ME_ERR_SYNTAX);
    CHECK_INT(E("1..2", &RAD), ME_ERR_SYNTAX);
    CHECK_INT(E("(1+2))", &RAD), ME_ERR_SYNTAX);
    CHECK_INT(E("sin 30", &RAD), ME_ERR_SYNTAX);
    CHECK_INT(E("0^0", &RAD), ME_ERR_DOMAIN);
    char big[600]; memset(big, 0, sizeof big);
    for (int i = 0; i < 200; i++) strcat(big, "1+");
    strcat(big, "1");
    CHECK_INT(E(big, &RAD), ME_ERR_TOO_LONG);
    char deep[120]; memset(deep, '(', 100); deep[100] = '1'; deep[101] = 0;
    CHECK_INT(E(deep, &RAD), ME_ERR_DEPTH);
}
TEST(formatting) {
    CHECK_STR(F(0.1 + 0.2), "0.3");
    CHECK_STR(F(1.0 / 3), "0.3333333333");
    CHECK_STR(F(123456789012.0), "1.23456789E11");
    CHECK_STR(F(-0.0), "0");
    CHECK_STR(F(1e-12), "1E-12");
    CHECK_STR(F(0.000000001234), "0.000000001234");
    CHECK_STR(F(9999999999.0), "9999999999");
    long n, d;
    CHECK(me_to_fraction(0.75, 9999, &n, &d) && n == 3 && d == 4);
    CHECK(me_to_fraction(-2.0 / 3, 9999, &n, &d) && n == -2 && d == 3);
    CHECK(!me_to_fraction(3.141592653589793, 9999, &n, &d));
}
typedef struct { char exprs[16][128]; char rules[16][128]; int n; } steps_t;
static void cb(const char *rule, const char *expr, void *u) { steps_t *s = u; if (s->n < 16) { snprintf(s->exprs[s->n], 128, "%s", expr); snprintf(s->rules[s->n], 128, "%s", rule); s->n++; } }
TEST(steps) {
    steps_t s = {0};
    double v; bool tr;
    CHECK_INT(me_solve_steps("2+3*(4-1)^2/9", &RAD, cb, &s, &v, &tr), ME_OK);
    CHECK_NEAR(v, 5, 0);
    const char *exp[] = {"2+3*(4-1)^2/9", "2+3*3^2/9", "2+3*9/9", "2+27/9", "2+3", "5"};
    CHECK_INT(s.n, 6);
    for (int i = 0; i < 6 && i < s.n; i++) CHECK_STR(s.exprs[i], exp[i]);
    CHECK(strstr(s.rules[2], "Potencia") != NULL);
    memset(&s, 0, sizeof s);
    me_var_t r[] = {{"r", 2}};
    me_ctx_t c = {.angle = ME_ANGLE_RAD, .vars = r, .nvars = 1};
    CHECK_INT(me_solve_steps("2*pi*r", &c, cb, &s, &v, &tr), ME_OK);
    CHECK(strstr(s.rules[1], "Substituicao") != NULL);
    CHECK_NEAR(v, 4 * 3.14159265358979, 1e-12);
    memset(&s, 0, sizeof s);
    CHECK_INT(me_solve_steps("1/0", &RAD, cb, &s, &v, &tr), ME_ERR_DIV_ZERO);
    CHECK_INT(s.n, 0);
}

typedef struct { double E, F; } ef_t;
static void setv(void *u, const char *n, double v) { ef_t *x = u; if (n[0] == 'E') x->E = v; else x->F = v; }
static double rnd3(void *u) { (void)u; return 0.4279; }
static double fix2(void *u, double v) { (void)u; return round(v * 100) / 100; }
TEST(sci82ms) {
    static const me_ctx_t GRA = {.angle = ME_ANGLE_GRAD};
    double v;
    /* fractions a┘b┘c and sexagesimal input */
    CHECK_INT(me_eval("1\xE2\x94\x98" "2+1\xE2\x94\x98" "3", &RAD, &v), ME_OK); CHECK_NEAR(v, 5.0 / 6, 1e-12);
    CHECK_INT(me_eval("2|1|4", &RAD, &v), ME_OK); CHECK_NEAR(v, 2.25, 1e-12);
    CHECK_INT(me_eval("1|0", &RAD, &v), ME_ERR_DIV_ZERO);
    CHECK_INT(me_eval("12\xC2\xB0" "30\xC2\xB0", &RAD, &v), ME_OK); CHECK_NEAR(v, 12.5, 1e-12);
    CHECK_INT(me_eval("1@30@36@", &RAD, &v), ME_OK); CHECK_NEAR(v, 1.51, 1e-12);
    /* GRAD mode and DRG suffixes */
    CHECK_INT(me_eval("sin(100)", &GRA, &v), ME_OK); CHECK_NEAR(v, 1, 1e-12);
    CHECK_INT(me_eval("pi}", &DEG, &v), ME_OK); CHECK_NEAR(v, 180, 1e-9);
    CHECK_INT(me_eval("200~", &DEG, &v), ME_OK); CHECK_NEAR(v, 180, 1e-9);
    CHECK_INT(me_eval("90{", &RAD, &v), ME_OK); CHECK_NEAR(v, 3.14159265358979 / 2, 1e-12);
    /* infix nCr / nPr, binding tighter than multiplication */
    CHECK_INT(me_eval("5nCr2", &RAD, &v), ME_OK); CHECK_NEAR(v, 10, 0);
    CHECK_INT(me_eval("5 nPr 2", &RAD, &v), ME_OK); CHECK_NEAR(v, 20, 0);
    CHECK_INT(me_eval("2*5nCr2", &RAD, &v), ME_OK); CHECK_NEAR(v, 20, 0);
    CHECK_INT(me_eval("nCr(5,2)", &RAD, &v), ME_OK); CHECK_NEAR(v, 10, 0);
    /* hyperbolic, cube root */
    CHECK_INT(me_eval("cosh(0)+\xE2\x88\x9B" "27)", &RAD, &v), ME_OK); CHECK_NEAR(v, 4, 1e-12);
    /* Pol / Rec store E and F */
    ef_t ef = {0, 0};
    me_ctx_t c = {.angle = ME_ANGLE_DEG, .set_var = setv, .random = rnd3, .round = fix2, .user = &ef};
    CHECK_INT(me_eval("Pol(1,1)", &c, &v), ME_OK); CHECK_NEAR(v, sqrt(2), 1e-12); CHECK_NEAR(ef.F, 45, 1e-9);
    CHECK_INT(me_eval("Rec(2,60)", &c, &v), ME_OK); CHECK_NEAR(v, 1, 1e-12); CHECK_NEAR(ef.F, sqrt(3), 1e-12);
    CHECK_INT(me_eval("Pol(1)", &c, &v), ME_ERR_ARGS);
    /* Ran# and Rnd( need hooks */
    CHECK_INT(me_eval("Ran#", &c, &v), ME_OK); CHECK_NEAR(v, 0.427, 1e-12);
    CHECK_INT(me_eval("Ran#", &RAD, &v), ME_ERR_UNKNOWN);
    CHECK_INT(me_eval("Rnd(1/3)*3", &c, &v), ME_OK); CHECK_NEAR(v, 0.99, 1e-12);
    /* steps print infix combinations */
    steps_t s = {0}; bool tr;
    CHECK_INT(me_solve_steps("1+5nCr2", &RAD, cb, &s, &v, &tr), ME_OK);
    CHECK(strstr(s.exprs[0], "nCr") != NULL);
    CHECK_NEAR(v, 11, 0);
}

TEST_MAIN(RUN(precedence); RUN(functions); RUN(variables); RUN(errors); RUN(formatting); RUN(steps); RUN(sci82ms))
