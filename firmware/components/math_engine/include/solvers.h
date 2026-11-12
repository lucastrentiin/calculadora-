/* Parametrised offline tools with step-by-step lines (subset of simulator/js/core/solvers.js). */
#pragma once
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* kind: 0 text, 1 title, 2 math (same values as math_renderer doc_kind_t) */
typedef void (*solver_line_cb)(int kind, const char *text, void *user);

typedef struct { int nroots; double roots[2]; double d, re, im; bool complex_roots, linear; } quad_result_t;

int solve_linear(double a, double b, solver_line_cb cb, void *u, double *x);      /* 0 unique, 1 none, 2 infinite */
quad_result_t solve_quadratic(double a, double b, double c, solver_line_cb cb, void *u);
/** n = 2..4, A row-major n*n. Returns 0 unique, 1 none, 2 infinite, -1 bad args. */
int solve_linear_system(int n, const double *A, const double *b, double *x, solver_line_cb cb, void *u);

typedef struct { int n; double sum, mean, median, min, max, var_p, var_s, sd_p, sd_s; } stats_t;
int stats_compute(const double *data, int n, stats_t *out, solver_line_cb cb, void *u);

#ifdef __cplusplus
}
#endif
