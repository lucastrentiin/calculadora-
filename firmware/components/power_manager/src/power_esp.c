/*
 * ESP-IDF power pieces: battery ADC (only when a divider exists), light sleep
 * with keypad wake-up, reset-reason inspection for power-loss recovery.
 */
#ifdef ESP_PLATFORM
#include <string.h>

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "keypad.h"
#include "power_manager.h"
#include "sdkconfig.h"

static const char *TAG = "power";

#ifdef CONFIG_MT_BATTERY_ADC
static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;
static bool s_ready;

static bool init_adc(void)
{
    if (s_ready) return true;
    if (CONFIG_MT_BATTERY_ADC_CHANNEL < 0 || CONFIG_MT_BATTERY_DIV_NUM <= 0 || CONFIG_MT_BATTERY_DIV_DEN <= 0) return false;
    adc_oneshot_unit_init_cfg_t u = {.unit_id = ADC_UNIT_1};
    if (adc_oneshot_new_unit(&u, &s_adc) != ESP_OK) return false;
    adc_oneshot_chan_cfg_t c = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_oneshot_config_channel(s_adc, (adc_channel_t)CONFIG_MT_BATTERY_ADC_CHANNEL, &c) != ESP_OK) return false;
    adc_cali_curve_fitting_config_t cc = {.unit_id = ADC_UNIT_1, .chan = (adc_channel_t)CONFIG_MT_BATTERY_ADC_CHANNEL,
                                          .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_cali_create_scheme_curve_fitting(&cc, &s_cali) != ESP_OK) s_cali = NULL;
    s_ready = true;
    return true;
}

bool battery_read(battery_reading_t *out)
{
    memset(out, 0, sizeof(*out));
    if (!init_adc()) return false;
    int raw = 0, mv = 0, acc = 0;
    for (int i = 0; i < 8; i++) { adc_oneshot_read(s_adc, (adc_channel_t)CONFIG_MT_BATTERY_ADC_CHANNEL, &raw); acc += raw; }
    raw = acc / 8;
    if (!s_cali || adc_cali_raw_to_voltage(s_cali, raw, &mv) != ESP_OK) return false; /* uncalibrated: do not guess */
    out->supported = true;
    out->millivolts = (uint16_t)(mv * CONFIG_MT_BATTERY_DIV_NUM / CONFIG_MT_BATTERY_DIV_DEN);
    out->percent = battery_percent_from_mv(out->millivolts);
    out->charging = false; /* needs a charger status pin: not defined yet */
    return true;
}
#else
bool battery_read(battery_reading_t *out)
{
    memset(out, 0, sizeof(*out)); /* no measurement circuit configured */
    return false;
}
#endif

int pm_enter_light_sleep(void)
{
#ifdef CONFIG_MT_KEYPAD_MATRIX
    if (keypad_matrix_prepare_sleep() != 0) return -1;
    esp_sleep_enable_gpio_wakeup();
    esp_err_t e = esp_light_sleep_start();
    keypad_matrix_after_sleep();
    return e == ESP_OK ? 0 : -1;
#else
    return -1; /* console keypad: no GPIO wake source, stay awake */
#endif
}

bool pm_last_reset_was_power_issue(void)
{
    esp_reset_reason_t r = esp_reset_reason();
    if (r == ESP_RST_BROWNOUT) ESP_LOGW(TAG, "reinicio por brown-out (alimentacao insuficiente)");
    return r == ESP_RST_BROWNOUT || r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT;
}
#endif
