/* NVS-backed key/value store (ESP-IDF only). */
#ifdef ESP_PLATFORM
#include <stdlib.h>

#include "esp_log.h"
#include "nvs.h"
#include "settings.h"

static const char *TAG = "kv_nvs";

typedef struct { nvs_handle_t h; } nvs_ctx_t;

static int nvs_get_cb(kv_store_t *kv, const char *key, void *buf, size_t *len)
{
    nvs_ctx_t *c = kv->ctx;
    esp_err_t e = nvs_get_blob(c->h, key, buf, len);
    if (e == ESP_ERR_NVS_NOT_FOUND) return KV_NOT_FOUND;
    return e == ESP_OK ? KV_OK : KV_ERR;
}

static int nvs_set_cb(kv_store_t *kv, const char *key, const void *buf, size_t len)
{
    nvs_ctx_t *c = kv->ctx;
    esp_err_t e = nvs_set_blob(c->h, key, buf, len);
    if (e == ESP_OK) e = nvs_commit(c->h);
    if (e != ESP_OK) ESP_LOGW(TAG, "falha ao gravar chave (%s)", esp_err_to_name(e)); /* never log values */
    return e == ESP_OK ? KV_OK : KV_ERR;
}

static int nvs_erase_cb(kv_store_t *kv, const char *key)
{
    nvs_ctx_t *c = kv->ctx;
    esp_err_t e = nvs_erase_key(c->h, key);
    if (e == ESP_OK) e = nvs_commit(c->h);
    if (e == ESP_ERR_NVS_NOT_FOUND) return KV_NOT_FOUND;
    return e == ESP_OK ? KV_OK : KV_ERR;
}

kv_store_t *kv_nvs_open(const char *partition, const char *ns)
{
    kv_store_t *kv = calloc(1, sizeof(*kv));
    nvs_ctx_t *c = calloc(1, sizeof(*c));
    if (!kv || !c) { free(kv); free(c); return NULL; }
    if (nvs_open_from_partition(partition, ns, NVS_READWRITE, &c->h) != ESP_OK) { free(kv); free(c); return NULL; }
    kv->get = nvs_get_cb;
    kv->set = nvs_set_cb;
    kv->erase = nvs_erase_cb;
    kv->ctx = c;
    return kv;
}
#endif
