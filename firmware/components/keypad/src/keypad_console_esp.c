/*
 * Serial console keypad (bring-up): characters typed in `idf.py monitor`
 * become logical keys (mapping in keypad_console_map()). Shifted keys are
 * emitted as SHIFT followed by the key.
 */
#ifdef ESP_PLATFORM
#include <stdio.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "keypad.h"

static keypad_t *s_kp;

static void console_task(void *arg)
{
    (void)arg;
    for (;;) {
        int ch = getchar(); /* non-blocking VFS console: returns EOF when idle */
        if (ch == EOF) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        bool shift;
        keycode_t k = keypad_console_map(ch, &shift);
        if (k == KEY_NONE) continue;
        uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        if (shift) keypad_push(s_kp, KEY_SHIFT, now);
        keypad_push(s_kp, k, now);
    }
}

int keypad_console_start(keypad_t *k)
{
    s_kp = k;
    keypad_init(k, NULL, 0, NULL);
    ESP_LOGI("keypad", "teclado pelo console serial: digitos, + - * / ^ ( ), Enter '=', Esc AC, O=ON S=SHIFT A=ALPHA M=MENU, u/d/h/o setas");
    return xTaskCreate(console_task, "kp_console", 3072, NULL, 4, NULL) == pdPASS ? 0 : -1;
}
#endif
