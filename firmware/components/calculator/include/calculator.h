/*
 * Conventional calculator (NORMAL state): token-based expression editing,
 * Ans, memory, fraction display, local history. Works without Wi-Fi.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "framebuffer.h"
#include "keypad.h"
#include "math_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CALC_MAX_TOKENS 128
#define CALC_HISTORY 20

typedef struct {
    const char *tok[CALC_MAX_TOKENS]; /* static token strings */
    uint8_t ntok, cursor;
    bool evaluated, show_fraction, has_result;
    me_err_t err;
    double result, ans, mem;
    uint16_t hoff;
    int8_t hist_idx;
    struct { char expr[ME_MAX_LEN + 1]; double value; } history[CALC_HISTORY];
    uint8_t nhist;
} calculator_t;

void calc_init(calculator_t *c);
void calc_clear(calculator_t *c);
/** Handle a key (shift already resolved). Returns true when consumed. */
bool calc_key(calculator_t *c, keycode_t k, bool shift, me_angle_t angle);
/** Current expression text (ASCII syntax). */
void calc_expr(const calculator_t *c, char *out, size_t len);
/** Result/error text for display. */
void calc_result_text(const calculator_t *c, char *out, size_t len);
/** Render expression row (y_expr) and result row (y_res); scale 2 = large result. */
void calc_render(calculator_t *c, fb_t *fb, int y_expr, int y_res, uint8_t res_scale, bool cursor_on);

#ifdef __cplusplus
}
#endif
