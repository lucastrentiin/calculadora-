#include "conversions.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const conv_category_t *conv_category(const char *id)
{
    for (size_t i = 0; i < conv_category_count; i++) if (strcmp(conv_categories[i].id, id) == 0) return &conv_categories[i];
    return NULL;
}

static const conv_unit_t *unit(const conv_category_t *c, const char *sym)
{
    for (size_t i = 0; i < c->nunits; i++) if (strcmp(c->units[i].sym, sym) == 0) return &c->units[i];
    return NULL;
}

static double to_kelvin(const char *u, double x)
{
    switch (u[0]) {
    case 'C': return x + 273.15;
    case 'F': return (x - 32.0) * 5.0 / 9.0 + 273.15;
    case 'R': return x * 5.0 / 9.0;
    default: return x;
    }
}
static double from_kelvin(const char *u, double k)
{
    switch (u[0]) {
    case 'C': return k - 273.15;
    case 'F': return (k - 273.15) * 9.0 / 5.0 + 32.0;
    case 'R': return k * 9.0 / 5.0;
    default: return k;
    }
}

/* Same noise removal as the simulator: 14 significant digits. */
static double prec14(double v)
{
    char b[40];
    snprintf(b, sizeof(b), "%.13e", v);
    return strtod(b, NULL);
}

conv_err_t conv_convert(const char *cat, const char *from, const char *to, double value, double *out)
{
    const conv_category_t *c = conv_category(cat);
    if (!c) return CONV_ERR_UNIT;
    const conv_unit_t *a = unit(c, from), *b = unit(c, to);
    if (!a || !b) return CONV_ERR_UNIT;
    if (!isfinite(value)) return CONV_ERR_VALUE;
    if (c->affine) {
        double k = to_kelvin(from, value);
        if (k < 0) return CONV_ERR_ABS_ZERO;
        *out = from_kelvin(to, k);
        return CONV_OK;
    }
    *out = prec14(value * a->factor / b->factor);
    return CONV_OK;
}
