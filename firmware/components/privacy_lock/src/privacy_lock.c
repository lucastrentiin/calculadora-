#include "privacy_lock.h"

#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_timer.h"
uint64_t pl_now_us(void) { return (uint64_t)esp_timer_get_time(); }
#else
#include <time.h>
uint64_t pl_now_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}
#endif

typedef struct { const char *name; pl_prio_t prio; pl_hook_t fn; void *ctx; } hook_t;

static hook_t s_hooks[PL_MAX_HOOKS];
static int s_n;
static pl_stats_t s_stats;

int pl_register(const char *name, pl_prio_t prio, pl_hook_t fn, void *ctx)
{
    if (s_n >= PL_MAX_HOOKS || !fn) return -1;
    /* insertion sort by priority, stable */
    int i = s_n;
    while (i > 0 && s_hooks[i - 1].prio > prio) { s_hooks[i] = s_hooks[i - 1]; i--; }
    s_hooks[i] = (hook_t){name, prio, fn, ctx};
    s_n++;
    return 0;
}

void pl_reset(void)
{
    memset(s_hooks, 0, sizeof(s_hooks));
    s_n = 0;
    memset(&s_stats, 0, sizeof(s_stats));
}

uint32_t pl_engage(pl_reason_t reason, uint64_t t0)
{
    uint64_t start = t0 ? t0 : pl_now_us();
    for (int i = 0; i < s_n; i++) s_hooks[i].fn(s_hooks[i].ctx, reason);
    uint32_t us = (uint32_t)(pl_now_us() - start);
    s_stats.count++;
    s_stats.last_us = us;
    if (us > s_stats.max_us) s_stats.max_us = us;
    s_stats.last_reason = reason;
    return us;
}

pl_stats_t pl_get_stats(void) { return s_stats; }
