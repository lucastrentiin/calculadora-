/*
 * Persistent configuration + key/value storage abstraction.
 *   kv_memory : RAM store (host tests, fallback when flash fails)
 *   kv_nvs    : ESP-IDF NVS partition. With CONFIG_NVS_ENCRYPTION the values
 *               are encrypted at rest (HMAC-based or flash-encryption-based
 *               scheme, see docs/SECURITY.md).
 * Keys follow NVS rules (<= 15 chars).
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KV_OK 0
#define KV_NOT_FOUND 1
#define KV_ERR (-1)

typedef struct kv_store {
    int (*get)(struct kv_store *kv, const char *key, void *buf, size_t *len); /* *len in: capacity, out: size */
    int (*set)(struct kv_store *kv, const char *key, const void *buf, size_t len);
    int (*erase)(struct kv_store *kv, const char *key);
    void *ctx;
} kv_store_t;

kv_store_t *kv_memory_create(void);
void kv_memory_destroy(kv_store_t *kv);
/** Test hook: make every write fail (simulates full flash / power loss). */
void kv_memory_fail_writes(kv_store_t *kv, bool fail);
#ifdef ESP_PLATFORM
/** Open a namespace in an NVS partition (e.g. "mtdata"); the partition must be initialised first. */
kv_store_t *kv_nvs_open(const char *partition, const char *nvs_namespace);
#endif

typedef enum { RESP_FAST = 0, RESP_SHORT = 1, RESP_FULL = 2 } resp_mode_t;
typedef enum { COMBO_SSAA = 0, COMBO_ASAS = 1, COMBO_MMSS = 2, COMBO_COUNT } auth_combo_t;

#define SETTINGS_VERSION 2

typedef struct {
    uint8_t version;
    uint8_t angle_deg;       /* 1 = degrees */
    uint8_t response_mode;   /* resp_mode_t */
    char text_method;        /* 'A' or 'B' */
    bool large_font, simple_menus, invert, ai_history, calc_history;
    uint8_t scroll_step;     /* 1..3 */
    uint8_t key_repeat;      /* 0 off, 1 slow, 2 normal, 3 fast */
    uint16_t multitap_ms;
    uint16_t auto_lock_s;
    uint16_t sleep_s;        /* 0 = never */
    uint8_t auth_combo;      /* auth_combo_t */
    uint8_t jpeg_quality;    /* esp32-camera scale: lower = better */
    uint8_t resolution;      /* index into camera resolution table */
} settings_t;

void settings_defaults(settings_t *s);
/** Loads settings; on missing/corrupt/old data falls back to defaults (returns KV_NOT_FOUND). */
int settings_load(kv_store_t *kv, settings_t *s);
int settings_save(kv_store_t *kv, const settings_t *s);
const char *settings_mode_name(uint8_t mode);

#ifdef __cplusplus
}
#endif
