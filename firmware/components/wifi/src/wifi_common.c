#include <string.h>

#include "wifi_manager.h"

int wifi_saved_add(wifi_saved_t *s, const char *ssid, const char *pass)
{
    size_t sl = strlen(ssid), pl = strlen(pass);
    if (sl == 0 || sl > 32 || pl > 64 || (pl > 0 && pl < 8)) return -1; /* WPA2 passphrase: 8..63 (64 hex) */
    wifi_saved_remove(s, ssid);
    if (s->n >= WIFI_MAX_SAVED) { /* drop the oldest */
        memset(&s->net[0], 0, sizeof(s->net[0]));
        memmove(&s->net[0], &s->net[1], sizeof(s->net[0]) * (WIFI_MAX_SAVED - 1));
        s->n--;
    }
    memset(&s->net[s->n], 0, sizeof(s->net[0]));
    memcpy(s->net[s->n].ssid, ssid, sl);
    memcpy(s->net[s->n].pass, pass, pl);
    s->n++;
    return 0;
}

int wifi_saved_remove(wifi_saved_t *s, const char *ssid)
{
    for (int i = 0; i < s->n; i++) {
        if (strcmp(s->net[i].ssid, ssid) == 0) {
            volatile char *p = s->net[i].pass;
            for (size_t k = 0; k < sizeof(s->net[i].pass); k++) p[k] = 0;
            memmove(&s->net[i], &s->net[i + 1], sizeof(s->net[0]) * (size_t)(s->n - i - 1));
            s->n--;
            memset(&s->net[s->n], 0, sizeof(s->net[0]));
            return 0;
        }
    }
    return -1;
}

uint32_t wifi_backoff_ms(uint32_t failures)
{
    uint32_t ms = 1000;
    for (uint32_t i = 0; i < failures && ms < 300000; i++) ms *= 2;
    return ms > 300000 ? 300000 : ms;
}
