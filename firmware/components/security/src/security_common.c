#include <string.h>

#include "security.h"

bool sec_ct_equal(const void *a, const void *b, size_t len)
{
    const volatile uint8_t *x = a, *y = b;
    uint8_t d = 0;
    for (size_t i = 0; i < len; i++) d |= (uint8_t)(x[i] ^ y[i]);
    return d == 0;
}

void sec_wipe(void *p, size_t len)
{
    volatile uint8_t *v = p;
    while (len--) *v++ = 0;
}

void sec_hex(const uint8_t *in, size_t len, char *out)
{
    static const char H[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) { out[2 * i] = H[in[i] >> 4]; out[2 * i + 1] = H[in[i] & 15]; }
    out[2 * len] = 0;
}

static int b64v(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

int sec_base64_decode(const char *in, uint8_t *out, size_t outlen)
{
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (; *in && *in != '='; in++) {
        int v = b64v(*in);
        if (v < 0) return -1;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (o >= outlen) return -1;
            out[o++] = (uint8_t)(acc >> bits);
        }
    }
    return (int)o;
}
