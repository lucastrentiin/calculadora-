/*
 * Deterministic offline math engine (C port of simulator/js/core/mathEngine.js).
 * - own tokenizer + recursive descent parser, no dynamic code evaluation
 * - fixed-size node pool: no heap allocation, bounded recursion depth
 * - same grammar, precedence and error codes as the simulator
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ME_MAX_LEN 256     /* max expression length (bytes after normalisation) */
#define ME_MAX_NODES 256   /* AST node pool */
#define ME_MAX_DEPTH 64    /* nesting limit */
#define ME_MAX_STEPS 200   /* step-by-step limit */
#define ME_PRINT_MAX 768   /* printed expression buffer */

typedef enum {
    ME_OK = 0,
    ME_ERR_SYNTAX,
    ME_ERR_DOMAIN,
    ME_ERR_DIV_ZERO,
    ME_ERR_OVERFLOW,
    ME_ERR_UNKNOWN,
    ME_ERR_ARGS,
    ME_ERR_TOO_LONG,
    ME_ERR_DEPTH,
} me_err_t;

typedef enum { ME_ANGLE_RAD = 0, ME_ANGLE_DEG = 1 } me_angle_t;

typedef struct {
    const char *name;
    double value;
} me_var_t;

typedef struct {
    me_angle_t angle;
    const me_var_t *vars;
    size_t nvars;
} me_ctx_t;

/** Evaluate an expression. On error *out is untouched. */
me_err_t me_eval(const char *expr, const me_ctx_t *ctx, double *out);

/** Human readable (pt-BR, ASCII) error message. */
const char *me_err_text(me_err_t err);

/** Format like a calculator: `sig` significant digits, scientific outside 1e-9..1e10. */
void me_format(double v, int sig, char *buf, size_t len);

/** Best rational approximation with denominator <= max_den, only if (almost) exact. */
bool me_to_fraction(double x, long max_den, long *num, long *den);

/** Called for every step: rule description and the whole expression after the step. */
typedef void (*me_step_cb)(const char *rule, const char *expr, void *user);

/** Step-by-step reduction (leftmost innermost operation first). */
me_err_t me_solve_steps(const char *expr, const me_ctx_t *ctx, me_step_cb cb, void *user, double *out, bool *truncated);

/** Copy `src` replacing display glyphs (×, ÷, π, √, ², ³, −) by ASCII syntax. */
me_err_t me_normalize(const char *src, char *dst, size_t len);

#ifdef __cplusplus
}
#endif
