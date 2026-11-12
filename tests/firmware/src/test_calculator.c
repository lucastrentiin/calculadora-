/* NORMAL-mode calculator (C) — same scenarios as tests/simulator/dexin.test.js. */
#include "mt_test.h"
#include "calculator.h"

static calculator_t C;
static double fixed_rng(void) { return 0.427; }
static void reset(void) { calc_init(&C); C.random = fixed_rng; }

/* key helpers: N = normal, S = shift, A = alpha */
static void N(keycode_t k) { calc_key(&C, k, false, false); }
static void S(keycode_t k) { calc_key(&C, k, true, false); }
static void A(keycode_t k) { calc_key(&C, k, false, true); }
static void seq(const keycode_t *k, int n) { for (int i = 0; i < n; i++) N(k[i]); }
#define SEQ(...) do { const keycode_t _k[] = {__VA_ARGS__}; seq(_k, (int)(sizeof _k / sizeof _k[0])); } while (0)
static const char *R(void) { static char b[64]; calc_result_text(&C, b, sizeof b); return b; }

TEST(arithmetic_ans_neg) {
    reset();
    SEQ(KEY_K2, KEY_ADD, KEY_K3, KEY_MUL, KEY_K4, KEY_EQ); CHECK_STR(R(), "14");
    SEQ(KEY_K1, KEY_DOT, KEY_K5, KEY_EXP, KEY_K3, KEY_EQ); CHECK_STR(R(), "1500");
    SEQ(KEY_MUL, KEY_K2, KEY_EQ); CHECK_STR(R(), "3000");
    SEQ(KEY_NEG, KEY_K2, KEY_POW, KEY_K2, KEY_EQ); CHECK_STR(R(), "-4");
}
TEST(fractions) {
    reset();
    SEQ(KEY_K1, KEY_FRAC, KEY_K2, KEY_ADD, KEY_K1, KEY_FRAC, KEY_K3, KEY_EQ); CHECK_STR(R(), "5\xE2\x94\x98" "6");
    N(KEY_FRAC); CHECK_STR(R(), "0.8333333333");
    N(KEY_FRAC); CHECK_STR(R(), "5\xE2\x94\x98" "6");
    SEQ(KEY_K2, KEY_FRAC, KEY_K1, KEY_FRAC, KEY_K4, KEY_EQ); CHECK_STR(R(), "2\xE2\x94\x98" "1\xE2\x94\x98" "4");
    S(KEY_FRAC); CHECK_STR(R(), "9\xE2\x94\x98" "4");
}
TEST(powers_roots) {
    reset();
    SEQ(KEY_K2, KEY_CUBE, KEY_EQ); CHECK_STR(R(), "8");
    SEQ(KEY_K4, KEY_INV, KEY_EQ); CHECK_STR(R(), "0.25");
    S(KEY_CUBE); SEQ(KEY_K2, KEY_K7, KEY_RPAREN, KEY_EQ); CHECK_STR(R(), "3");
    S(KEY_POW); SEQ(KEY_K4, KEY_COMMA, KEY_K8, KEY_K1, KEY_RPAREN, KEY_EQ); CHECK_STR(R(), "3");
    SEQ(KEY_K5); S(KEY_INV); N(KEY_EQ); CHECK_STR(R(), "120");
}
TEST(angles_hyp_drg_dms) {
    reset();
    SEQ(KEY_SIN, KEY_K3, KEY_K0, KEY_EQ); CHECK_STR(R(), "0.5");
    SEQ(KEY_MODE, KEY_MODE, KEY_K3); CHECK_INT(C.cfg.angle, ME_ANGLE_GRAD); CHECK(C.cfg_dirty);
    SEQ(KEY_SIN, KEY_K1, KEY_K0, KEY_K0, KEY_EQ); CHECK_STR(R(), "1");
    SEQ(KEY_MODE, KEY_MODE, KEY_K1);
    SEQ(KEY_HYP, KEY_COS, KEY_K0, KEY_EQ); CHECK_STR(R(), "1");
    S(KEY_EXP); S(KEY_ANS); SEQ(KEY_K2, KEY_EQ); CHECK_STR(R(), "180");
    SEQ(KEY_K1, KEY_K2, KEY_DMS, KEY_K3, KEY_K0, KEY_DMS, KEY_EQ); CHECK_STR(R(), "12.5");
    S(KEY_DMS); CHECK_STR(R(), "12\xC2\xB0" "30\xC2\xB0" "0");
}
TEST(ncr_pol_ran_rnd) {
    reset();
    SEQ(KEY_K5, KEY_NCR, KEY_K2, KEY_EQ); CHECK_STR(R(), "10");
    N(KEY_K5); S(KEY_NCR); SEQ(KEY_K2, KEY_EQ); CHECK_STR(R(), "20");
    SEQ(KEY_POL, KEY_K1, KEY_COMMA, KEY_K1, KEY_RPAREN, KEY_EQ); CHECK_STR(R(), "1.414213562");
    CHECK_NEAR(C.vars[5], 45, 1e-9);
    SEQ(KEY_RCL, KEY_TAN); CHECK_STR(R(), "45");
    S(KEY_DOT); N(KEY_EQ); CHECK_STR(R(), "0.427");
    SEQ(KEY_MODE, KEY_MODE, KEY_MODE, KEY_K1, KEY_K2);
    S(KEY_K0); SEQ(KEY_K1, KEY_DIV, KEY_K3, KEY_RPAREN, KEY_MUL, KEY_K3, KEY_EQ); CHECK_STR(R(), "0.99");
}
TEST(memories_vars) {
    reset();
    SEQ(KEY_K7, KEY_EQ); S(KEY_RCL); N(KEY_NEG); CHECK_NEAR(C.vars[0], 7, 0); CHECK(C.state_dirty);
    N(KEY_AC); A(KEY_NEG); SEQ(KEY_MUL, KEY_K2, KEY_EQ); CHECK_STR(R(), "14");
    SEQ(KEY_K3, KEY_STO); N(KEY_K2); S(KEY_STO); CHECK_NEAR(C.vars[8], 1, 0);
    SEQ(KEY_AC, KEY_RCL, KEY_STO); CHECK_STR(R(), "1");
}
TEST(percent_formats) {
    reset();
    SEQ(KEY_K1, KEY_K5, KEY_K0, KEY_K0, KEY_MUL, KEY_K1, KEY_K2); S(KEY_EQ); CHECK_STR(R(), "180");
    SEQ(KEY_K1, KEY_DIV, KEY_K3, KEY_EQ); CHECK_STR(R(), "0.3333333333");
    SEQ(KEY_MODE, KEY_MODE, KEY_MODE, KEY_K1, KEY_K3); CHECK_STR(R(), "0.333");
    SEQ(KEY_MODE, KEY_MODE, KEY_MODE, KEY_K2, KEY_K4); CHECK_STR(R(), "3.333E-01");
    SEQ(KEY_MODE, KEY_MODE, KEY_MODE, KEY_K3, KEY_K1);
    SEQ(KEY_K1, KEY_DIV, KEY_K2, KEY_K0, KEY_K0, KEY_EQ); CHECK_STR(R(), "5E-03");
    SEQ(KEY_MODE, KEY_MODE, KEY_MODE, KEY_K3, KEY_K2); CHECK_STR(R(), "0.005");
    SEQ(KEY_K1, KEY_K2, KEY_K3, KEY_K4, KEY_K5, KEY_EQ, KEY_ENG); CHECK_STR(R(), "12.345E03");
    N(KEY_ENG); CHECK_STR(R(), "12345E00");
    S(KEY_ENG); CHECK_STR(R(), "12.345E03");
    SEQ(KEY_MODE, KEY_MODE, KEY_MODE, KEY_MODE, KEY_K1, KEY_RIGHT, KEY_K2); CHECK(C.cfg.dec_comma);
    SEQ(KEY_K1, KEY_DIV, KEY_K4, KEY_EQ); CHECK_STR(R(), "0,25");
}
TEST(sd_mode) {
    reset();
    SEQ(KEY_MODE, KEY_K2); CHECK_INT(C.cfg.mode, CALC_SD);
    SEQ(KEY_K2, KEY_STO, KEY_K4, KEY_STO, KEY_K4, KEY_STO, KEY_K5); S(KEY_COMMA); SEQ(KEY_K2, KEY_STO);
    CHECK_STR(R(), "n=4");
    S(KEY_K1); SEQ(KEY_K3, KEY_EQ); CHECK_STR(R(), "5");
    S(KEY_K1); SEQ(KEY_K2, KEY_EQ); CHECK_STR(R(), "20");
    S(KEY_K2); SEQ(KEY_K1, KEY_EQ); CHECK_STR(R(), "4");
    S(KEY_K2); SEQ(KEY_K2, KEY_EQ); CHECK_STR(R(), "1.095445115");
    S(KEY_K2); SEQ(KEY_K3, KEY_EQ); CHECK_STR(R(), "1.224744871");
    N(KEY_AC); S(KEY_STO); CHECK_INT(C.ndata, 3);
    S(KEY_MODE); N(KEY_K1); CHECK_INT(C.ndata, 0);
}
TEST(reg_mode) {
    reset();
    SEQ(KEY_MODE, KEY_K3, KEY_K1); CHECK_INT(C.cfg.mode, CALC_REG);
    SEQ(KEY_K1, KEY_COMMA, KEY_K3, KEY_STO, KEY_K2, KEY_COMMA, KEY_K5, KEY_STO, KEY_K3, KEY_COMMA, KEY_K7, KEY_STO);
    S(KEY_K2); SEQ(KEY_RIGHT, KEY_RIGHT, KEY_K1, KEY_EQ); CHECK_STR(R(), "1");
    S(KEY_K2); SEQ(KEY_RIGHT, KEY_RIGHT, KEY_K2, KEY_EQ); CHECK_STR(R(), "2");
    S(KEY_K2); SEQ(KEY_RIGHT, KEY_RIGHT, KEY_K3, KEY_EQ); CHECK_STR(R(), "1");
    SEQ(KEY_K1, KEY_K0); S(KEY_K2); SEQ(KEY_RIGHT, KEY_RIGHT, KEY_RIGHT, KEY_K2, KEY_EQ); CHECK_STR(R(), "21");
    SEQ(KEY_K2, KEY_K1); S(KEY_K2); SEQ(KEY_RIGHT, KEY_RIGHT, KEY_RIGHT, KEY_K1, KEY_EQ); CHECK_STR(R(), "10");
    SEQ(KEY_MODE, KEY_K3, KEY_RIGHT, KEY_K3); CHECK_INT(C.cfg.reg, REG_QUAD);
    SEQ(KEY_K0, KEY_COMMA, KEY_K1, KEY_STO, KEY_K1, KEY_COMMA, KEY_K2, KEY_STO, KEY_K2, KEY_COMMA, KEY_K5, KEY_STO,
        KEY_K3, KEY_COMMA, KEY_K1, KEY_K0, KEY_STO);
    S(KEY_K2); SEQ(KEY_RIGHT, KEY_RIGHT, KEY_K3, KEY_EQ); CHECK_STR(R(), "1");
}
TEST(editing_errors_replay_clr) {
    reset();
    SEQ(KEY_K1, KEY_K2, KEY_K3, KEY_LEFT, KEY_LEFT, KEY_K9);
    char e[64]; calc_expr(&C, e, sizeof e); CHECK_STR(e, "193");
    S(KEY_DEL); SEQ(KEY_LEFT, KEY_K5); calc_expr(&C, e, sizeof e); CHECK_STR(e, "1593");
    SEQ(KEY_AC, KEY_K1, KEY_MUL, KEY_DIV, KEY_K2, KEY_EQ); CHECK_STR(R(), "Syntax ERROR");
    N(KEY_LEFT); CHECK(!C.evaluated);
    SEQ(KEY_AC, KEY_K1, KEY_DIV, KEY_K0, KEY_EQ); CHECK_STR(R(), "Math ERROR");
    SEQ(KEY_AC, KEY_POL, KEY_K1, KEY_RPAREN, KEY_EQ); CHECK_STR(R(), "Arg ERROR");
    N(KEY_AC); for (int i = 0; i < 70; i++) N(KEY_LPAREN); SEQ(KEY_K1, KEY_EQ); CHECK_STR(R(), "Stack ERROR");
    SEQ(KEY_AC, KEY_K2, KEY_EQ, KEY_K3, KEY_EQ, KEY_UP); CHECK_STR(R(), "3");
    N(KEY_UP); CHECK_STR(R(), "2");
    SEQ(KEY_K5, KEY_STO); CHECK_NEAR(C.vars[8], 5, 0);
    S(KEY_MODE); N(KEY_K1); CHECK_NEAR(C.vars[8], 0, 0);
    SEQ(KEY_MODE, KEY_MODE, KEY_K2); S(KEY_MODE); N(KEY_K2); CHECK_INT(C.cfg.angle, ME_ANGLE_DEG);
    S(KEY_AC); CHECK(C.off_request);
}
TEST(persistence) {
    reset();
    kv_store_t *kv = kv_memory_create();
    SEQ(KEY_K9, KEY_EQ); S(KEY_RCL); N(KEY_RPAREN);
    SEQ(KEY_MODE, KEY_K2, KEY_K4, KEY_STO);
    CHECK_INT(calc_save(&C, kv), KV_OK);
    calculator_t saved = C;
    calc_init(&C);
    CHECK_INT(calc_load(&C, kv), KV_OK);
    CHECK_NEAR(C.vars[6], 9, 0); CHECK_INT(C.ndata, 1); CHECK_NEAR(C.ans, saved.ans, 0);
    kv_memory_destroy(kv);
}

TEST_MAIN(RUN(arithmetic_ans_neg); RUN(fractions); RUN(powers_roots); RUN(angles_hyp_drg_dms); RUN(ncr_pol_ran_rnd);
          RUN(memories_vars); RUN(percent_formats); RUN(sd_mode); RUN(reg_mode); RUN(editing_errors_replay_clr); RUN(persistence))
