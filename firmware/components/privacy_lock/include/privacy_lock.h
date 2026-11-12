/*
 * PRIVACY_LOCK orchestration. Modules register non-blocking hooks; engaging
 * the lock runs them in priority order (UI first) and measures the latency.
 * Hooks MUST NOT block: they only set flags, bump generations, post messages
 * or wipe RAM. Network/camera teardown continues asynchronously afterwards.
 * Target: visible return to NORMAL < 100 ms on the final hardware (measured
 * here from key event to end of hooks, and in app_state up to display flush).
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { PL_PRIO_UI = 0, PL_PRIO_CANCEL = 1, PL_PRIO_WIPE = 2 } pl_prio_t;
typedef enum { PL_REASON_KEY = 0, PL_REASON_MENU, PL_REASON_INACTIVITY, PL_REASON_SLEEP, PL_REASON_BATTERY } pl_reason_t;

typedef void (*pl_hook_t)(void *ctx, pl_reason_t reason);

typedef struct {
    uint32_t count;
    uint32_t last_us, max_us;
    pl_reason_t last_reason;
} pl_stats_t;

#define PL_MAX_HOOKS 16

int pl_register(const char *name, pl_prio_t prio, pl_hook_t fn, void *ctx);
void pl_reset(void); /* tests */
/** Run all hooks; t0_us = timestamp of the triggering event (0 = now). Returns elapsed us. */
uint32_t pl_engage(pl_reason_t reason, uint64_t t0_us);
pl_stats_t pl_get_stats(void);
/** Monotonic microseconds (esp_timer on the device, clock_gettime on host). */
uint64_t pl_now_us(void);

#ifdef __cplusplus
}
#endif
