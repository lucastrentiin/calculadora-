/*
 * Matrix keypad scan over GPIO (ESP-IDF). All pins and the key map come from
 * Kconfig and have no defaults: until the keypad is chosen this driver
 * refuses to start (ESP_ERR_INVALID_STATE) and the console driver is used.
 * Scan: columns are driven low one at a time (open-drain), rows read with
 * pull-ups; period 5 ms; debounce/repeat in keypad_core.c.
 */
#ifdef ESP_PLATFORM
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "keypad.h"
#include "sdkconfig.h"

__attribute__((unused)) static const char *TAG = "keypad";

#ifdef CONFIG_MT_KEYPAD_MATRIX
#define MAX_LINES 12
static int s_rows[MAX_LINES], s_cols[MAX_LINES], s_nrows, s_ncols;
static keycode_t s_map[KEYPAD_MAX_KEYS];
static keypad_t *s_kp;
static esp_timer_handle_t s_timer;

static int parse_ints(const char *s, int *out, int max)
{
    int n = 0;
    while (*s && n < max) {
        while (*s == ' ' || *s == ',') s++;
        if (!*s) break;
        char *end;
        long v = strtol(s, &end, 10);
        if (end == s || v < 0 || v >= GPIO_NUM_MAX) return -1;
        out[n++] = (int)v;
        s = end;
    }
    return n;
}

static int parse_keymap(const char *s, keycode_t *out, int max)
{
    char name[16];
    int n = 0;
    while (*s && n < max) {
        while (*s == ' ' || *s == ',') s++;
        if (!*s) break;
        int l = 0;
        while (*s && *s != ',' && l < (int)sizeof(name) - 1) name[l++] = *s++;
        while (l && name[l - 1] == ' ') l--;
        name[l] = 0;
        keycode_t k = strcmp(name, "-") == 0 ? KEY_NONE : key_from_name(name);
        if (k == KEY_NONE && strcmp(name, "-") != 0) { ESP_LOGE(TAG, "tecla desconhecida no mapa: %s", name); return -1; }
        out[n++] = k;
    }
    return n;
}

static void scan_cb(void *arg)
{
    uint8_t pressed[KEYPAD_MAX_KEYS] = {0};
    for (int c = 0; c < s_ncols; c++) {
        gpio_set_level(s_cols[c], 0);
        esp_rom_delay_us(3); /* settle; must be validated with the real wiring/capacitance */
        for (int r = 0; r < s_nrows; r++) pressed[r * s_ncols + c] = gpio_get_level(s_rows[r]) == 0;
        gpio_set_level(s_cols[c], 1);
    }
    keypad_scan_update(s_kp, pressed, (uint32_t)(esp_timer_get_time() / 1000));
}

int keypad_matrix_start(keypad_t *k)
{
    s_nrows = parse_ints(CONFIG_MT_KEYPAD_ROW_GPIOS, s_rows, MAX_LINES);
    s_ncols = parse_ints(CONFIG_MT_KEYPAD_COL_GPIOS, s_cols, MAX_LINES);
    int nmap = parse_keymap(CONFIG_MT_KEYPAD_KEYMAP, s_map, KEYPAD_MAX_KEYS);
    if (s_nrows <= 0 || s_ncols <= 0 || nmap != s_nrows * s_ncols || nmap > KEYPAD_MAX_KEYS) {
        ESP_LOGW(TAG, "teclado matricial nao configurado (linhas/colunas/mapa no menuconfig)");
        return ESP_ERR_INVALID_STATE;
    }
    for (int r = 0; r < s_nrows; r++) {
        gpio_config_t io = {.pin_bit_mask = 1ULL << s_rows[r], .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE};
        ESP_ERROR_CHECK(gpio_config(&io));
    }
    for (int c = 0; c < s_ncols; c++) {
        gpio_config_t io = {.pin_bit_mask = 1ULL << s_cols[c], .mode = GPIO_MODE_OUTPUT_OD};
        ESP_ERROR_CHECK(gpio_config(&io));
        gpio_set_level(s_cols[c], 1);
    }
    s_kp = k;
    keypad_init(k, s_map, (uint8_t)nmap, NULL);
    const esp_timer_create_args_t args = {.callback = scan_cb, .name = "kp_scan"};
    ESP_ERROR_CHECK(esp_timer_create(&args, &s_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(s_timer, 5000));
    ESP_LOGI(TAG, "matriz %dx%d ativa", s_nrows, s_ncols);
    return ESP_OK;
}

/** Prepare light sleep: all columns low so any key pulls a row low (wake source). */
int keypad_matrix_prepare_sleep(void)
{
    if (!s_nrows) return ESP_ERR_INVALID_STATE;
    for (int c = 0; c < s_ncols; c++) gpio_set_level(s_cols[c], 0);
    for (int r = 0; r < s_nrows; r++) gpio_wakeup_enable(s_rows[r], GPIO_INTR_LOW_LEVEL);
    return ESP_OK;
}
void keypad_matrix_after_sleep(void)
{
    for (int r = 0; r < s_nrows; r++) gpio_wakeup_disable(s_rows[r]);
    for (int c = 0; c < s_ncols; c++) gpio_set_level(s_cols[c], 1);
}
#else
int keypad_matrix_start(keypad_t *k) { (void)k; return ESP_ERR_NOT_SUPPORTED; }
int keypad_matrix_prepare_sleep(void) { return ESP_ERR_NOT_SUPPORTED; }
void keypad_matrix_after_sleep(void) {}
#endif
#endif
