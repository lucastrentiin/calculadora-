/* Minimal test harness for host-side firmware tests (no external deps). */
#pragma once
#include <math.h>
#include <stdio.h>
#include <string.h>

extern int mt_failures, mt_checks;
#define CHECK(cond) do { mt_checks++; if (!(cond)) { mt_failures++; printf("  FALHA %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_STR(a, b) do { mt_checks++; const char *_a = (a), *_b = (b); if (strcmp(_a, _b) != 0) { mt_failures++; printf("  FALHA %s:%d: \"%s\" != \"%s\"\n", __FILE__, __LINE__, _a, _b); } } while (0)
#define CHECK_NEAR(a, b, eps) do { mt_checks++; double _a = (a), _b = (b); if (!(fabs(_a - _b) <= (eps) * fmax(1.0, fabs(_b)))) { mt_failures++; printf("  FALHA %s:%d: %.15g != %.15g\n", __FILE__, __LINE__, _a, _b); } } while (0)
#define CHECK_INT(a, b) do { mt_checks++; long _a = (long)(a), _b = (long)(b); if (_a != _b) { mt_failures++; printf("  FALHA %s:%d: %ld != %ld (%s)\n", __FILE__, __LINE__, _a, _b, #a); } } while (0)
#define TEST(name) static void name(void)
#define RUN(name) do { printf("- %s\n", #name); name(); } while (0)
#define TEST_MAIN(body) int mt_failures = 0, mt_checks = 0; int main(void) { body; printf("%d verificacoes, %d falhas\n", mt_checks, mt_failures); return mt_failures ? 1 : 0; }
