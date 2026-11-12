/*
 * Thin wrapper over a trusted crypto library. No algorithm is implemented here.
 *   ESP-IDF : mbedTLS (hardware SHA/AES on the ESP32-S3) + esp_fill_random (HW RNG)
 *   host    : OpenSSL (tests only)
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SEC_SHA256_LEN 32
#define SEC_GCM_IV_LEN 12
#define SEC_GCM_TAG_LEN 16

int sec_random(uint8_t *out, size_t len);
int sec_sha256(const uint8_t *in, size_t len, uint8_t out[SEC_SHA256_LEN]);
int sec_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen, uint8_t out[SEC_SHA256_LEN]);
int sec_pbkdf2_sha256(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen, uint32_t iterations, uint8_t *out, size_t outlen);
int sec_aes256_gcm_encrypt(const uint8_t key[32], const uint8_t iv[SEC_GCM_IV_LEN], const uint8_t *aad, size_t aadlen,
                           const uint8_t *pt, size_t len, uint8_t *ct, uint8_t tag[SEC_GCM_TAG_LEN]);
/** Returns 0 only when the tag authenticates. */
int sec_aes256_gcm_decrypt(const uint8_t key[32], const uint8_t iv[SEC_GCM_IV_LEN], const uint8_t *aad, size_t aadlen,
                           const uint8_t *ct, size_t len, const uint8_t tag[SEC_GCM_TAG_LEN], uint8_t *pt);

/** Constant-time comparison. */
bool sec_ct_equal(const void *a, const void *b, size_t len);
/** Zeroise memory in a way the compiler cannot optimise away. */
void sec_wipe(void *p, size_t len);
/** Lowercase hex encoding; out must hold 2*len+1 bytes. */
void sec_hex(const uint8_t *in, size_t len, char *out);
/** Base64 (standard alphabet) decode; returns decoded length or -1. */
int sec_base64_decode(const char *in, uint8_t *out, size_t outlen);

#ifdef __cplusplus
}
#endif
