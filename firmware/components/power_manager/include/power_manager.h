/*
 * Power management.
 *   - portable policy: inactivity -> display off/light sleep, battery thresholds
 *   - battery HAL: NOT available unless a measurement circuit exists
 *     (CONFIG_MT_BATTERY_ADC). The ESP32-S3 cannot measure a Li-Po without an
 *     external divider/fuel gauge; without it the UI shows no battery level.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool supported;     /* false = no measurement circuit */
    uint8_t percent;
    uint16_t millivolts;
    bool charging;      /* only if a charger status line is wired */
} battery_reading_t;

typedef enum {
    PM_ACT_NONE = 0,
    PM_ACT_DISPLAY_OFF,     /* inactivity: blank display, keep RAM state */
    PM_ACT_LIGHT_SLEEP,     /* longer inactivity: CPU light sleep, wake on key */
    PM_ACT_LOW_BATTERY,     /* warn, stop camera/Wi-Fi heavy work */
    PM_ACT_CRITICAL,        /* lock, save state, deep sleep / shutdown */
} pm_action_t;

typedef struct {
    uint16_t sleep_s;          /* 0 = never */
    uint16_t light_sleep_extra_s;
    uint8_t low_pct, critical_pct;
    uint16_t critical_mv;      /* brown-out guard when percent is unreliable */
} pm_policy_t;

typedef struct {
    pm_policy_t pol;
    uint32_t last_activity_ms;
    bool display_off, light_sleep, low_warned;
} pm_state_t;

void pm_init(pm_state_t *s, const pm_policy_t *p, uint32_t now_ms);
void pm_activity(pm_state_t *s, uint32_t now_ms);
/** Evaluate policy; `busy` = network/camera work in progress (prevents sleep). */
pm_action_t pm_evaluate(pm_state_t *s, uint32_t now_ms, const battery_reading_t *bat, bool busy);

/** Battery HAL (returns false when no circuit is configured). */
bool battery_read(battery_reading_t *out);
/** Convert a Li-Po open-circuit voltage to an approximate percentage (rough table). */
uint8_t battery_percent_from_mv(uint16_t mv);

#ifdef ESP_PLATFORM
/** Configure wake sources (keypad GPIOs from Kconfig) and enter light sleep. */
int pm_enter_light_sleep(void);
/** Reset reason was brown-out / power loss? Used to show a recovery notice. */
bool pm_last_reset_was_power_issue(void);
#endif

#ifdef __cplusplus
}
#endif
