/*
 * PIN authentication (C counterpart of simulator/js/core/auth.js).
 *  - stored verifier: SHA-256(first 32 bytes of PBKDF2-HMAC-SHA256(pin, salt, iter, 64))
 *  - last 32 bytes = data key for the encrypted vault (RAM only while unlocked)
 *  - no default PIN: first use requires creating one
 *  - failed attempts persisted; lockout with exponential backoff. The ESP32-S3
 *    has no battery-backed wall clock by default, so the remaining lockout
 *    time is persisted and only elapses while the device is powered.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "settings.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AUTH_SALT_LEN 16
#define AUTH_KEY_LEN 32

typedef struct {
    uint8_t min_len, max_len;
    uint32_t iterations;
    uint8_t max_attempts;
    uint32_t base_lock_s, max_lock_s;
} auth_policy_t;

typedef struct {
    kv_store_t *kv;
    auth_policy_t pol;
    uint32_t failures;
    uint32_t lock_remaining_s;
    uint32_t last_tick_s;
} auth_t;

typedef enum { AUTH_OK = 0, AUTH_WRONG, AUTH_LOCKED, AUTH_NO_PIN, AUTH_INVALID_FORMAT, AUTH_STORAGE, AUTH_CRYPTO } auth_result_t;

void auth_default_policy(auth_policy_t *p);
void auth_init(auth_t *a, kv_store_t *kv, const auth_policy_t *pol, uint32_t now_s);
bool auth_has_pin(auth_t *a);
bool auth_valid_format(const auth_t *a, const char *pin, size_t len);
/** Create/replace the PIN; returns AUTH_OK and the new data key. */
auth_result_t auth_set_pin(auth_t *a, const char *pin, size_t len, uint8_t data_key[AUTH_KEY_LEN]);
/** Verify; on AUTH_OK data_key is filled (caller must sec_wipe it). Wrong PINs never reveal anything else. */
auth_result_t auth_verify(auth_t *a, const char *pin, size_t len, uint8_t data_key[AUTH_KEY_LEN], uint32_t now_s);
/** Advance the lockout timer (call periodically). */
void auth_tick(auth_t *a, uint32_t now_s);
bool auth_is_locked(const auth_t *a);
uint32_t auth_failures(const auth_t *a);
void auth_clear(auth_t *a);

#ifdef __cplusplus
}
#endif
