/*
 * Wi-Fi manager.
 *  - saved networks in NVS (encrypted when NVS encryption is enabled)
 *  - automatic reconnection with exponential backoff
 *  - radio off when no network feature is in use (power)
 *  - configuration: on-device (text editor) or phone provisioning over
 *    SoftAP with protocomm security 1/2 (wifi_provisioning component)
 * The calculator never depends on Wi-Fi.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WIFI_MAX_SAVED 5

typedef enum { WIFI_ST_OFF = 0, WIFI_ST_CONNECTING, WIFI_ST_CONNECTED, WIFI_ST_FAILED } wifi_state_t;

typedef struct wifi_hal {
    wifi_state_t (*state)(struct wifi_hal *w);
    const char *(*ssid)(struct wifi_hal *w);
    int8_t (*rssi)(struct wifi_hal *w);
    const char *(*error)(struct wifi_hal *w);
    int (*saved)(struct wifi_hal *w, char ssids[][33], int max);
    int (*add)(struct wifi_hal *w, const char *ssid, const char *pass); /* pass is wiped by caller */
    int (*remove)(struct wifi_hal *w, const char *ssid);
    void (*connect)(struct wifi_hal *w);
    void (*radio_off)(struct wifi_hal *w);
    void *ctx;
} wifi_hal_t;

/** Saved-network list serialisation (portable, tested on host). */
typedef struct { uint8_t n; struct { char ssid[33]; char pass[65]; } net[WIFI_MAX_SAVED]; } wifi_saved_t;
int wifi_saved_add(wifi_saved_t *s, const char *ssid, const char *pass);
int wifi_saved_remove(wifi_saved_t *s, const char *ssid);
/** Backoff in ms for the n-th consecutive failure (1 s .. 5 min). */
uint32_t wifi_backoff_ms(uint32_t failures);

#ifdef ESP_PLATFORM
#include "settings.h"
/** Start the manager; saved networks are kept in `kv` (encrypted NVS partition). */
wifi_hal_t *wifi_manager_start(kv_store_t *kv);
/** Start phone provisioning (SoftAP + protocomm). pop = proof-of-possession shown on the LCD. */
int wifi_manager_start_provisioning(char pop_out[9]);
#endif

#ifdef __cplusplus
}
#endif
