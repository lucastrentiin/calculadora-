#include "favorites.h"

#include <string.h>

#include "security.h"

#define FORMULA_KEY "fav_formulas"
#define MAX_FORMULA_FAVS 32

typedef struct { uint8_t n; char ids[MAX_FORMULA_FAVS][16]; } formula_favs_t;

static void load(kv_store_t *kv, formula_favs_t *f)
{
    size_t len = sizeof(*f);
    if (kv->get(kv, FORMULA_KEY, f, &len) != KV_OK || len != sizeof(*f) || f->n > MAX_FORMULA_FAVS) memset(f, 0, sizeof(*f));
}

bool fav_formula_is(kv_store_t *kv, const char *id)
{
    formula_favs_t f;
    load(kv, &f);
    for (int i = 0; i < f.n; i++) if (strncmp(f.ids[i], id, 15) == 0) return true;
    return false;
}

int fav_formula_toggle(kv_store_t *kv, const char *id)
{
    formula_favs_t f;
    load(kv, &f);
    for (int i = 0; i < f.n; i++) {
        if (strncmp(f.ids[i], id, 15) == 0) {
            memmove(f.ids[i], f.ids[i + 1], (size_t)(f.n - i - 1) * 16);
            f.n--;
            return kv->set(kv, FORMULA_KEY, &f, sizeof(f));
        }
    }
    if (f.n >= MAX_FORMULA_FAVS) return -1;
    strncpy(f.ids[f.n], id, 15);
    f.ids[f.n][15] = 0;
    f.n++;
    return kv->set(kv, FORMULA_KEY, &f, sizeof(f));
}

int fav_formula_list(kv_store_t *kv, char ids[][16], int max)
{
    formula_favs_t f;
    load(kv, &f);
    int n = f.n < max ? f.n : max;
    for (int i = 0; i < n; i++) memcpy(ids[i], f.ids[i], 16);
    return n;
}

int fav_add(vault_t *v, fav_type_t type, const char *title, const char *content)
{
    if (!v->open) return -1;
    cJSON *f = cJSON_GetObjectItem(v->root, "f");
    cJSON *it = cJSON_CreateObject();
    cJSON_AddNumberToObject(it, "y", type);
    cJSON_AddStringToObject(it, "t", title);
    cJSON_AddStringToObject(it, "c", content);
    cJSON_InsertItemInArray(f, 0, it);
    while (cJSON_GetArraySize(f) > FAVORITES_MAX) cJSON_DeleteItemFromArray(f, cJSON_GetArraySize(f) - 1);
    return vault_save(v);
}

int fav_count(const vault_t *v) { return v->open ? cJSON_GetArraySize(cJSON_GetObjectItem(v->root, "f")) : 0; }
cJSON *fav_get(const vault_t *v, int i) { return v->open ? cJSON_GetArrayItem(cJSON_GetObjectItem(v->root, "f"), i) : NULL; }

int fav_delete(vault_t *v, int i)
{
    if (!v->open || i < 0 || i >= fav_count(v)) return -1;
    cJSON *it = cJSON_DetachItemFromArray(cJSON_GetObjectItem(v->root, "f"), i);
    cJSON *c = cJSON_GetObjectItem(it, "c");
    if (c && c->valuestring) sec_wipe(c->valuestring, strlen(c->valuestring));
    cJSON_Delete(it);
    return vault_save(v);
}
