#include <stdlib.h>

#include "ota_update.h"

int ota_version_cmp(const char *a, const char *b)
{
    while (*a || *b) {
        long x = strtol(a, (char **)&a, 10), y = strtol(b, (char **)&b, 10);
        if (x != y) return x < y ? -1 : 1;
        if (*a == '.') a++;
        if (*b == '.') b++;
        if (!*a && !*b) break;
        if ((*a && *a != '.' && (*a < '0' || *a > '9')) || (*b && *b != '.' && (*b < '0' || *b > '9'))) break;
    }
    return 0;
}
