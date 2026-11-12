#include "power_manager.h"

#include <string.h>

void pm_init(pm_state_t *s, const pm_policy_t *p, uint32_t now)
{
    memset(s, 0, sizeof(*s));
    s->pol = *p;
    s->last_activity_ms = now;
}

void pm_activity(pm_state_t *s, uint32_t now)
{
    s->last_activity_ms = now;
    s->display_off = false;
    s->light_sleep = false;
}

pm_action_t pm_evaluate(pm_state_t *s, uint32_t now, const battery_reading_t *b, bool busy)
{
    if (b && b->supported && !b->charging) {
        if (b->percent <= s->pol.critical_pct || (s->pol.critical_mv && b->millivolts && b->millivolts <= s->pol.critical_mv)) return PM_ACT_CRITICAL;
        if (b->percent <= s->pol.low_pct && !s->low_warned) { s->low_warned = true; return PM_ACT_LOW_BATTERY; }
        if (b->percent > s->pol.low_pct + 5) s->low_warned = false; /* hysteresis */
    }
    if (busy || s->pol.sleep_s == 0) return PM_ACT_NONE;
    uint32_t idle = now - s->last_activity_ms;
    if (!s->display_off && idle >= (uint32_t)s->pol.sleep_s * 1000u) { s->display_off = true; return PM_ACT_DISPLAY_OFF; }
    if (s->display_off && !s->light_sleep && idle >= ((uint32_t)s->pol.sleep_s + s->pol.light_sleep_extra_s) * 1000u) {
        s->light_sleep = true;
        return PM_ACT_LIGHT_SLEEP;
    }
    return PM_ACT_NONE;
}

uint8_t battery_percent_from_mv(uint16_t mv)
{
    /* Typical single-cell Li-Po resting voltage curve; must be calibrated for the chosen cell. */
    static const uint16_t MV[] = {3300, 3500, 3600, 3700, 3750, 3800, 3850, 3900, 4000, 4100, 4200};
    static const uint8_t PCT[] = {0, 5, 10, 20, 30, 40, 50, 60, 75, 90, 100};
    if (mv <= MV[0]) return 0;
    for (int i = 1; i < 11; i++) {
        if (mv <= MV[i]) return (uint8_t)(PCT[i - 1] + (uint32_t)(PCT[i] - PCT[i - 1]) * (mv - MV[i - 1]) / (MV[i] - MV[i - 1]));
    }
    return 100;
}

#ifndef ESP_PLATFORM
/* host: no battery circuit; tests use their own readings */
bool battery_read(battery_reading_t *out) { memset(out, 0, sizeof(*out)); return false; }
#endif
