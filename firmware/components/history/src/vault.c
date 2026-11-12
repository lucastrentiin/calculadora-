#include "vault.h"

#include <stdlib.h>
#include <string.h>

#include "security.h"

static const unsigned char MAGIC[4] = {'M', 'T', 'V', 1};
static const char AAD[] = "mt-vault-v1";
#define HDR (4 + SEC_GCM_IV_LEN + SEC_GCM_TAG_LEN)

static cJSON *empty_root(void)
{
    cJSON *r = cJSON_CreateObject();
    cJSON_AddItemToObject(r, "h", cJSON_CreateArray());
    cJSON_AddItemToObject(r, "f", cJSON_CreateArray());
    return r;
}

int vault_open(vault_t *v, kv_store_t *kv, const unsigned char key[32])
{
    memset(v, 0, sizeof(*v));
    v->kv = kv;
    memcpy(v->key, key, 32);
    v->open = true;
    size_t len = 0;
    if (kv->get(kv, "vault", NULL, &len) != KV_OK || len < HDR) { v->root = empty_root(); return 0; }
    unsigned char *blob = malloc(len), *pt = malloc(len - HDR + 1);
    if (!blob || !pt) { free(blob); free(pt); v->root = empty_root(); return -1; }
    size_t got = len;
    int r = kv->get(kv, "vault", blob, &got);
    cJSON *root = NULL;
    if (r == KV_OK && got == len && memcmp(blob, MAGIC, 4) == 0 &&
        sec_aes256_gcm_decrypt(v->key, blob + 4, (const uint8_t *)AAD, sizeof(AAD) - 1, blob + HDR, len - HDR, blob + 4 + SEC_GCM_IV_LEN, pt) == 0) {
        pt[len - HDR] = 0;
        root = cJSON_Parse((const char *)pt);
    }
    sec_wipe(pt, len - HDR + 1);
    free(pt);
    free(blob);
    if (!root || !cJSON_IsArray(cJSON_GetObjectItem(root, "h")) || !cJSON_IsArray(cJSON_GetObjectItem(root, "f"))) {
        cJSON_Delete(root);
        v->root = empty_root();
        v->corrupt = true;
        return 1;
    }
    v->root = root;
    return 0;
}

int vault_save(vault_t *v)
{
    if (!v->open || !v->root) return -1;
    char *json = cJSON_PrintUnformatted(v->root);
    if (!json) return -1;
    size_t n = strlen(json);
    /* keep within budget: drop oldest history entries */
    while (n > VAULT_MAX_BYTES && cJSON_GetArraySize(cJSON_GetObjectItem(v->root, "h")) > 0) {
        sec_wipe(json, n);
        free(json);
        cJSON *h = cJSON_GetObjectItem(v->root, "h");
        cJSON_DeleteItemFromArray(h, cJSON_GetArraySize(h) - 1);
        json = cJSON_PrintUnformatted(v->root);
        if (!json) return -1;
        n = strlen(json);
    }
    unsigned char *blob = malloc(HDR + n);
    if (!blob) { sec_wipe(json, n); free(json); return -1; }
    memcpy(blob, MAGIC, 4);
    int r = sec_random(blob + 4, SEC_GCM_IV_LEN);
    if (r == 0) r = sec_aes256_gcm_encrypt(v->key, blob + 4, (const uint8_t *)AAD, sizeof(AAD) - 1, (const uint8_t *)json, n, blob + HDR, blob + 4 + SEC_GCM_IV_LEN);
    sec_wipe(json, n);
    free(json);
    if (r == 0) r = v->kv->set(v->kv, "vault", blob, HDR + n) == KV_OK ? 0 : -1;
    free(blob);
    if (r == 0) v->corrupt = false;
    return r;
}

int vault_rekey(vault_t *v, const unsigned char nk[32])
{
    memcpy(v->key, nk, 32);
    return vault_save(v);
}

static void wipe_json(cJSON *n)
{
    for (; n; n = n->next) {
        if (n->valuestring) sec_wipe(n->valuestring, strlen(n->valuestring));
        if (n->child) wipe_json(n->child);
    }
}

void vault_close(vault_t *v)
{
    if (v->root) { wipe_json(v->root); cJSON_Delete(v->root); }
    sec_wipe(v->key, sizeof(v->key));
    v->root = NULL;
    v->open = false;
}

/* ------------------------------ history ------------------------------ */

int history_add(vault_t *v, const char *title, const char *q, const char *resp, int mode)
{
    if (!v->open) return -1;
    cJSON *h = cJSON_GetObjectItem(v->root, "h");
    cJSON *it = cJSON_CreateObject();
    cJSON_AddStringToObject(it, "t", title);
    cJSON_AddStringToObject(it, "q", q);
    cJSON_AddStringToObject(it, "r", resp);
    cJSON_AddNumberToObject(it, "m", mode);
    cJSON_InsertItemInArray(h, 0, it);
    while (cJSON_GetArraySize(h) > HISTORY_MAX) cJSON_DeleteItemFromArray(h, cJSON_GetArraySize(h) - 1);
    return vault_save(v);
}

int history_count(const vault_t *v) { return v->open ? cJSON_GetArraySize(cJSON_GetObjectItem(v->root, "h")) : 0; }
cJSON *history_get(const vault_t *v, int i) { return v->open ? cJSON_GetArrayItem(cJSON_GetObjectItem(v->root, "h"), i) : NULL; }

int history_delete(vault_t *v, int i)
{
    if (!v->open || i < 0 || i >= history_count(v)) return -1;
    cJSON *h = cJSON_GetObjectItem(v->root, "h");
    cJSON *it = cJSON_DetachItemFromArray(h, i);
    wipe_json(it);
    cJSON_Delete(it);
    return vault_save(v);
}

int history_clear(vault_t *v)
{
    if (!v->open) return -1;
    while (history_count(v)) {
        cJSON *it = cJSON_DetachItemFromArray(cJSON_GetObjectItem(v->root, "h"), 0);
        wipe_json(it);
        cJSON_Delete(it);
    }
    return vault_save(v);
}
