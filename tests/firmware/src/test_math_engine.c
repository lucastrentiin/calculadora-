#include "mt_test.h"
#include "math_engine.h"

static const me_ctx_t DEG = {ME_ANGLE_DEG, NULL, 0};
static const me_ctx_t RAD = {ME_ANGLE_RAD, NULL, 0};

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
    me_ctx_t c = {ME_ANGLE_RAD, vars, 2};
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
    me_ctx_t c = {ME_ANGLE_RAD, r, 1};
    CHECK_INT(me_solve_steps("2*pi*r", &c, cb, &s, &v, &tr), ME_OK);
    CHECK(strstr(s.rules[1], "Substituicao") != NULL);
    CHECK_NEAR(v, 4 * 3.14159265358979, 1e-12);
    memset(&s, 0, sizeof s);
    CHECK_INT(me_solve_steps("1/0", &RAD, cb, &s, &v, &tr), ME_ERR_DIV_ZERO);
    CHECK_INT(s.n, 0);
}

TEST_MAIN(RUN(precedence); RUN(functions); RUN(variables); RUN(errors); RUN(formatting); RUN(steps))
