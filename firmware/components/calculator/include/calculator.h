/*
 * NORMAL-state scientific calculator (fx-82MS-class behaviour used by the
 * DEXIN KK-82MS-B reference, see docs/DEXIN_COMPAT.md). C port of
 * simulator/js/core/sciCalc.js: token editing with overwrite/insert, Ans,
 * variables A-F X Y M, STO/RCL, M+/M-, REPLAY, MODE/CLR menus,
 * Deg/Rad/Gra, Fix/Sci/Norm/ENG, a┘b┘c fractions, DMS, SD/REG statistics.
 * Works without Wi-Fi, server or authentication.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "framebuffer.h"
#include "keypad.h"
#include "math_engine.h"
#include "settings.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CALC_MAX_TOKENS 128
#define CALC_HISTORY 20
#define CALC_MAX_DATA 80
#define CALC_NVARS 9 /* A B C D E F X Y M */

typedef enum { CALC_COMP = 0, CALC_SD = 1, CALC_REG = 2 } calc_mode_t;
typedef enum { REG_LIN = 0, REG_LOG, REG_EXP, REG_PWR, REG_INV, REG_QUAD } calc_reg_t;
typedef enum { DISP_NORM1 = 0, DISP_NORM2, DISP_FIX, DISP_SCI } calc_disp_t;
typedef enum { VIEW_DEC = 0, VIEW_FRAC, VIEW_DMS, VIEW_ENG } calc_view_t;

typedef struct {
    uint8_t angle;     /* me_angle_t */
    uint8_t mode;      /* calc_mode_t */
    uint8_t reg;       /* calc_reg_t */
    uint8_t disp;      /* calc_disp_t */
    uint8_t digits;    /* Fix 0-9, Sci 0-9 (0 = 10) */
    bool frac_dc;      /* d/c instead of a┘b┘c */
    bool dec_comma;    /* decimal comma */
} calc_cfg_t;

typedef struct { double x, y, f; } calc_data_t;

typedef struct {
    calc_cfg_t cfg;
    const char *tok[CALC_MAX_TOKENS]; /* static token strings */
    uint8_t ntok, cursor;
    bool insert;                      /* default: overwrite (like the original) */
    bool evaluated, has_result, hyp;
    me_err_t err;
    int16_t err_tok;                  /* token index of the error (-1 unknown) */
    const char *label;                /* text result such as "n=3", "Mcl" */
    char label_buf[72];
    double result, ans;
    double vars[CALC_NVARS];
    uint8_t view;                     /* calc_view_t */
    int8_t eng_shift;
    uint8_t pending;                  /* 0, 'S' (STO) or 'R' (RCL) */
    uint8_t menu;                     /* 0 = none, see calculator.c */
    uint16_t hoff;
    int8_t hist_idx;
    struct { char expr[ME_MAX_LEN + 2]; double value; } history[CALC_HISTORY];
    uint8_t nhist;
    calc_data_t data[CALC_MAX_DATA];
    uint8_t ndata;
    int16_t data_idx;
    bool cfg_dirty;                   /* caller should persist cfg */
    bool state_dirty;                 /* caller should persist vars/data */
    bool off_request;                 /* SHIFT AC (OFF) */
    double (*random)(void);           /* NULL: platform default */
} calculator_t;

void calc_init(calculator_t *c);
void calc_clear(calculator_t *c);
/** Handle a key with modifiers already resolved. Returns true when consumed. */
bool calc_key(calculator_t *c, keycode_t k, bool shift, bool alpha);
/** Current expression text (ASCII engine syntax). */
void calc_expr(const calculator_t *c, char *out, size_t len);
/** Result/error text for display (UTF-8). */
void calc_result_text(const calculator_t *c, char *out, size_t len);
/** fx-style error name for an engine error. */
const char *calc_err_name(me_err_t e);
/** Status indicators ("S A M SD D FIX ...") into out. */
void calc_indicators(const calculator_t *c, bool shift, bool alpha, char *out, size_t len);
/** Render the calculator below the indicator row. */
void calc_render(calculator_t *c, fb_t *fb, int y_expr, int y_res, uint8_t res_scale, bool cursor_on);
/** Format a number with the current display setting (Fix/Sci/Norm). */
void calc_format(const calculator_t *c, double v, char *out, size_t len);

/** Persistence of vars, Ans and statistic data (NVS key "calc"). */
int calc_save(const calculator_t *c, kv_store_t *kv);
int calc_load(calculator_t *c, kv_store_t *kv);

#ifdef __cplusplus
}
#endif
