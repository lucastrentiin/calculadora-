/* Host backend for unit tests (OpenSSL 3). Never linked into the firmware. */
#ifndef ESP_PLATFORM
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include "security.h"

int sec_random(uint8_t *out, size_t len) { return RAND_bytes(out, (int)len) == 1 ? 0 : -1; }

int sec_sha256(const uint8_t *in, size_t len, uint8_t out[SEC_SHA256_LEN]) { return SHA256(in, len, out) ? 0 : -1; }

int sec_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen, uint8_t out[SEC_SHA256_LEN])
{
    unsigned int ol = 0;
    return HMAC(EVP_sha256(), key, (int)klen, msg, mlen, out, &ol) && ol == 32 ? 0 : -1;
}

int sec_pbkdf2_sha256(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen, uint32_t it, uint8_t *out, size_t outlen)
{
    return PKCS5_PBKDF2_HMAC((const char *)pw, (int)pwlen, salt, (int)slen, (int)it, EVP_sha256(), (int)outlen, out) == 1 ? 0 : -1;
}

static int gcm(int enc, const uint8_t *key, const uint8_t *iv, const uint8_t *aad, size_t aadlen, const uint8_t *in, size_t len,
               uint8_t *out, uint8_t *tag)
{
    EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
    int ok = 0, l = 0;
    if (!c) return -1;
    ok = EVP_CipherInit_ex(c, EVP_aes_256_gcm(), NULL, NULL, NULL, enc) &&
         EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_IVLEN, SEC_GCM_IV_LEN, NULL) &&
         EVP_CipherInit_ex(c, NULL, NULL, key, iv, enc);
    if (ok && aadlen) ok = EVP_CipherUpdate(c, NULL, &l, aad, (int)aadlen);
    if (ok && len) ok = EVP_CipherUpdate(c, out, &l, in, (int)len);
    if (ok && !enc) ok = EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_TAG, SEC_GCM_TAG_LEN, tag);
    if (ok) ok = EVP_CipherFinal_ex(c, out + (len ? l : 0), &l);
    if (ok && enc) ok = EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_GET_TAG, SEC_GCM_TAG_LEN, tag);
    EVP_CIPHER_CTX_free(c);
    return ok ? 0 : -1;
}

int sec_aes256_gcm_encrypt(const uint8_t key[32], const uint8_t iv[SEC_GCM_IV_LEN], const uint8_t *aad, size_t aadlen,
                           const uint8_t *pt, size_t len, uint8_t *ct, uint8_t tag[SEC_GCM_TAG_LEN])
{
    return gcm(1, key, iv, aad, aadlen, pt, len, ct, tag);
}

int sec_aes256_gcm_decrypt(const uint8_t key[32], const uint8_t iv[SEC_GCM_IV_LEN], const uint8_t *aad, size_t aadlen,
                           const uint8_t *ct, size_t len, const uint8_t tag[SEC_GCM_TAG_LEN], uint8_t *pt)
{
    return gcm(0, key, iv, aad, aadlen, ct, len, pt, (uint8_t *)tag);
}
#endif
