#include "solvers.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "math_engine.h"

#define EPS 1e-12
#define T(k, ...) do { if (cb) { char _l[256]; snprintf(_l, sizeof _l, __VA_ARGS__); cb(k, _l, u); } } while (0)

static const char *F(double v, char *b) { me_format(v, 10, b, 40); return b; }

int solve_linear(double a, double b, solver_line_cb cb, void *u, double *x)
{
    char s1[40], s2[40];
    T(1, "Equacao do 1o grau");
    T(2, "%sx + %s = 0", F(a, s1), F(b, s2));
    if (fabs(a) < EPS) {
        if (fabs(b) < EPS) { T(0, "a = 0 e b = 0: infinitas solucoes."); return 2; }
        T(0, "a = 0 e b != 0: sem solucao.");
        return 1;
    }
    *x = -b / a;
    T(0, "Isolando x:");
    T(2, "x = -b/a = -(%s)/%s", F(b, s1), F(a, s2));
    T(2, "x = %s", F(*x, s1));
    return 0;
}

quad_result_t solve_quadratic(double a, double b, double c, solver_line_cb cb, void *u)
{
    quad_result_t r;
    memset(&r, 0, sizeof(r));
    char s1[40], s2[40], s3[40], s4[40];
    if (fabs(a) < EPS) {
        T(0, "a = 0: a equacao e do 1o grau.");
        double x;
        r.linear = true;
        if (solve_linear(b, c, cb, u, &x) == 0) { r.nroots = 1; r.roots[0] = x; }
        return r;
    }
    T(1, "Equacao do 2o grau");
    T(2, "%sx^2 + %sx + %s = 0", F(a, s1), F(b, s2), F(c, s3));
    T(0, "Dados:");
    T(2, "a = %s, b = %s, c = %s", F(a, s1), F(b, s2), F(c, s3));
    T(0, "Formula do discriminante:");
    T(2, "D = b^2 - 4ac");
    r.d = b * b - 4 * a * c;
    T(0, "Substituindo:");
    T(2, "D = (%s)^2 - 4*(%s)*(%s)", F(b, s1), F(a, s2), F(c, s3));
    T(2, "D = %s - (%s)", F(b * b, s1), F(4 * a * c, s2));
    T(2, "D = %s", F(r.d, s1));
    T(0, "Formula de Bhaskara:");
    T(2, "x = (-b +- sqrt(D)) / (2a)");
    if (fabs(r.d) < EPS * fmax(1, b * b)) {
        r.nroots = 1;
        r.roots[0] = -b / (2 * a);
        T(0, "D = 0: uma raiz real dupla.");
        T(2, "x = %s", F(r.roots[0], s1));
    } else if (r.d > 0) {
        double sq = sqrt(r.d), q = -0.5 * (b + (b >= 0 ? 1 : -1) * sq);
        double x1 = q / a, x2 = c / q;
        if (x1 > x2) { double t = x1; x1 = x2; x2 = t; }
        r.nroots = 2; r.roots[0] = x1; r.roots[1] = x2;
        T(0, "D > 0: duas raizes reais.");
        T(2, "sqrt(D) = %s", F(sq, s1));
        T(2, "x1 = (-(%s) - %s) / %s = %s", F(b, s1), F(sq, s2), F(2 * a, s3), F(x1, s4));
        T(2, "x2 = (-(%s) + %s) / %s = %s", F(b, s1), F(sq, s2), F(2 * a, s3), F(x2, s4));
    } else {
        r.complex_roots = true;
        r.re = -b / (2 * a);
        r.im = sqrt(-r.d) / fabs(2 * a);
        T(0, "D < 0: sem raizes reais; raizes complexas:");
        T(2, "x = %s +- %si", F(r.re, s1), F(r.im, s2));
    }
    if (r.nroots) T(0, "Verificacao:");
    for (int i = 0; i < r.nroots; i++) {
        double x = r.roots[i];
        T(2, "%s*(%s)^2 + %s*(%s) + %s = %s", F(a, s1), F(x, s2), F(b, s3), F(x, s4), F(c, s1), F(a * x * x + b * x + c, s3));
    }
    T(0, "Vertice:");
    T(2, "xv = %s, yv = %s", F(-b / (2 * a), s1), F(-r.d / (4 * a), s2));
    return r;
}

int solve_linear_system(int n, const double *A, const double *b, double *x, solver_line_cb cb, void *u)
{
    if (n < 2 || n > 4) return -1;
    double m[4][5];
    static const char *NM[] = {"x", "y", "z", "w"};
    char s1[40];
    for (int i = 0; i < n; i++) { for (int j = 0; j < n; j++) m[i][j] = A[i * n + j]; m[i][n] = b[i]; }
    T(1, "Sistema %dx%d (Gauss)", n, n);
    for (int col = 0; col < n; col++) {
        int p = col;
        for (int r = col + 1; r < n; r++) if (fabs(m[r][col]) > fabs(m[p][col])) p = r;
        if (fabs(m[p][col]) < EPS) continue;
        if (p != col) { for (int k = 0; k <= n; k++) { double t = m[p][k]; m[p][k] = m[col][k]; m[col][k] = t; } T(0, "Troca L%d <-> L%d", col + 1, p + 1); }
        for (int r = col + 1; r < n; r++) {
            double k = m[r][col] / m[col][col];
            if (fabs(k) < EPS) continue;
            for (int c = col; c <= n; c++) m[r][c] -= k * m[col][c];
            m[r][col] = 0;
            T(2, "L%d = L%d - (%s)L%d", r + 1, r + 1, F(k, s1), col + 1);
        }
    }
    for (int i = 0; i < n; i++) {
        if (fabs(m[i][i]) < EPS) {
            bool zero = true;
            for (int j = 0; j < n; j++) if (fabs(m[i][j]) > 1e-9) zero = false;
            if (zero && fabs(m[i][n]) > 1e-9) { T(0, "Sistema impossivel."); return 1; }
            T(0, "Sistema possivel e indeterminado.");
            return 2;
        }
    }
    T(0, "Substituicao regressiva:");
    for (int i = n - 1; i >= 0; i--) {
        double s = m[i][n];
        for (int j = i + 1; j < n; j++) s -= m[i][j] * x[j];
        x[i] = s / m[i][i];
        if (fabs(x[i]) < 1e-12) x[i] = 0;
        T(2, "%s = %s", NM[i], F(x[i], s1));
    }
    return 0;
}

static int cmp(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }

int stats_compute(const double *data, int n, stats_t *o, solver_line_cb cb, void *u)
{
    if (n <= 0 || n > 500) return -1;
    double *s = malloc(sizeof(double) * (size_t)n);
    if (!s) return -1;
    memcpy(s, data, sizeof(double) * (size_t)n);
    qsort(s, (size_t)n, sizeof(double), cmp);
    memset(o, 0, sizeof(*o));
    o->n = n;
    for (int i = 0; i < n; i++) o->sum += s[i];
    o->mean = o->sum / n;
    o->median = n % 2 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    o->min = s[0];
    o->max = s[n - 1];
    double ss = 0;
    for (int i = 0; i < n; i++) ss += (s[i] - o->mean) * (s[i] - o->mean);
    o->var_p = ss / n;
    o->var_s = n > 1 ? ss / (n - 1) : NAN;
    o->sd_p = sqrt(o->var_p);
    o->sd_s = sqrt(o->var_s);
    char a[40], b[40];
    T(1, "Estatistica descritiva");
    T(2, "n = %d", n);
    T(2, "soma = %s", F(o->sum, a));
    T(2, "media = %s / %d = %s", F(o->sum, a), n, F(o->mean, b));
    T(2, "mediana = %s", F(o->median, a));
    T(2, "min = %s  max = %s", F(o->min, a), F(o->max, b));
    T(2, "var pop = %s", F(o->var_p, a));
    T(2, "desvio pop = %s", F(o->sd_p, a));
    if (n > 1) { T(2, "var amostral = %s", F(o->var_s, a)); T(2, "desvio amostral = %s", F(o->sd_s, a)); }
    free(s);
    return 0;
}
