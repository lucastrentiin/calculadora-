/* Offline unit conversions (factors generated from simulator/js/core/units.js). */
#pragma once
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CONV_MAX_CATEGORIES 16
#define CONV_CATS_MAX_UNITS 16

typedef struct { const char *sym, *name; double factor; } conv_unit_t; /* factor to the base unit */
typedef struct {
    const char *id, *name, *base;
    bool affine;              /* temperature */
    const conv_unit_t *units;
    size_t nunits;
} conv_category_t;

extern const conv_category_t conv_categories[];
extern const size_t conv_category_count;

typedef enum { CONV_OK = 0, CONV_ERR_UNIT, CONV_ERR_VALUE, CONV_ERR_ABS_ZERO } conv_err_t;

const conv_category_t *conv_category(const char *id);
conv_err_t conv_convert(const char *cat, const char *from, const char *to, double value, double *out);

#ifdef __cplusplus
}
#endif
