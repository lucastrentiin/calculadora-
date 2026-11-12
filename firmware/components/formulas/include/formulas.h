/* Offline formula library (data generated from simulator/js/core/formulas.js). */
#pragma once
#include <stdbool.h>
#include <stddef.h>

#include "math_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct { const char *id, *name; } formula_category_t;
typedef struct { const char *sym, *meaning, *unit; double example; } formula_var_t;
typedef struct {
    const char *id, *cat, *name, *formula, *out, *expr, *units;
    bool angle_deg;
    const formula_var_t *vars;
    size_t nvars;
    double example_out;
} formula_t;

extern const formula_category_t formula_categories[];
extern const size_t formula_category_count;
extern const formula_t formula_list[];
extern const size_t formula_count;

const formula_t *formula_get(const char *id);
/** Fill `out` with pointers to formulas of a category; returns count. */
size_t formula_by_category(const char *cat, const formula_t **out, size_t max);
/** Case/accent-insensitive search in name, formula and category. */
size_t formula_search(const char *query, const formula_t **out, size_t max);
/** Evaluate a formula with variable values (same order as f->vars). */
me_err_t formula_apply(const formula_t *f, const double *values, double *result);
/** Same, emitting step-by-step lines through the math engine callback. */
me_err_t formula_apply_steps(const formula_t *f, const double *values, me_step_cb cb, void *user, double *result);

#ifdef __cplusplus
}
#endif
