/* ESP-IDF backend (mbedTLS 3.x as shipped with ESP-IDF v5.x). */
#ifdef ESP_PLATFORM
#include "esp_random.h"
#include "mbedtls/gcm.h"
#include "mbedtls/md.h"
#include "mbedtls/pkcs5.h"
#include "security.h"

int sec_random(uint8_t *out, size_t len)
{
    /* True RNG when RF (Wi-Fi/BT) is on or the bootloader entropy source is enabled; see docs/SECURITY.md */
    esp_fill_random(out, len);
    return 0;
}

int sec_sha256(const uint8_t *in, size_t len, uint8_t out[SEC_SHA256_LEN])
{
    return mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), in, len, out);
}

int sec_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen, uint8_t out[SEC_SHA256_LEN])
{
    return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, klen, msg, mlen, out);
}

int sec_pbkdf2_sha256(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen, uint32_t it, uint8_t *out, size_t outlen)
{
    return mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, pw, pwlen, salt, slen, it, (uint32_t)outlen, out);
}

int sec_aes256_gcm_encrypt(const uint8_t key[32], const uint8_t iv[SEC_GCM_IV_LEN], const uint8_t *aad, size_t aadlen,
                           const uint8_t *pt, size_t len, uint8_t *ct, uint8_t tag[SEC_GCM_TAG_LEN])
{
    mbedtls_gcm_context g;
    mbedtls_gcm_init(&g);
    int r = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, key, 256);
    if (r == 0) r = mbedtls_gcm_crypt_and_tag(&g, MBEDTLS_GCM_ENCRYPT, len, iv, SEC_GCM_IV_LEN, aad, aadlen, pt, ct, SEC_GCM_TAG_LEN, tag);
    mbedtls_gcm_free(&g);
    return r;
}

int sec_aes256_gcm_decrypt(const uint8_t key[32], const uint8_t iv[SEC_GCM_IV_LEN], const uint8_t *aad, size_t aadlen,
                           const uint8_t *ct, size_t len, const uint8_t tag[SEC_GCM_TAG_LEN], uint8_t *pt)
{
    mbedtls_gcm_context g;
    mbedtls_gcm_init(&g);
    int r = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, key, 256);
    if (r == 0) r = mbedtls_gcm_auth_decrypt(&g, len, iv, SEC_GCM_IV_LEN, aad, aadlen, tag, SEC_GCM_TAG_LEN, ct, pt);
    mbedtls_gcm_free(&g);
    return r;
}
#endif
