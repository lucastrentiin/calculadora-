/*
 * OTA updates (after the first validation flashed over USB).
 *  - HTTPS download with server certificate validation (esp_https_ota)
 *  - authenticity: Secure Boot v2 signed images (CONFIG_SECURE_SIGNED_APPS_*)
 *    are verified by the bootloader/app before boot; a manifest (version +
 *    SHA-256) is fetched from the backend first
 *  - two OTA slots + rollback (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE): the
 *    new image must call ota_mark_valid() after a successful self test,
 *    otherwise the bootloader returns to the previous image
 *  - settings live in NVS, which OTA never erases
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { OTA_IDLE = 0, OTA_CHECKING, OTA_UP_TO_DATE, OTA_AVAILABLE, OTA_DOWNLOADING, OTA_DONE, OTA_FAILED } ota_state_t;

typedef struct ota_hal {
    void (*check)(struct ota_hal *o);
    void (*apply)(struct ota_hal *o);
    ota_state_t (*state)(struct ota_hal *o);
    uint8_t (*progress)(struct ota_hal *o);
    const char *(*message)(struct ota_hal *o);   /* clear success/error text for the LCD */
    const char *(*current_version)(struct ota_hal *o);
    void *ctx;
} ota_hal_t;

/** Compare dotted versions "1.2.3"; returns <0, 0, >0. */
int ota_version_cmp(const char *a, const char *b);

#ifdef ESP_PLATFORM
ota_hal_t *ota_esp_create(const char *manifest_url, const char *ca_pem_or_null);
/** Call after boot self-test passes (cancels rollback). */
void ota_mark_valid(void);
#endif

#ifdef __cplusplus
}
#endif
