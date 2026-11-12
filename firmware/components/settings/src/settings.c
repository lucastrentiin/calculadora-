#include "settings.h"

#include <stdlib.h>
#include <string.h>

void settings_defaults(settings_t *s)
{
    memset(s, 0, sizeof(*s));
    s->version = SETTINGS_VERSION;
    s->angle_deg = 1;
    s->response_mode = RESP_SHORT;
    s->text_method = 'A';
    s->ai_history = true;
    s->calc_history = true;
    s->scroll_step = 1;
    s->key_repeat = 2;
    s->multitap_ms = 900;
    s->auto_lock_s = 120;
    s->sleep_s = 300;
    s->auth_combo = COMBO_SSAA;
    s->jpeg_quality = 12;
    s->resolution = 2; /* SVGA */
}

static bool valid(const settings_t *s)
{
    return s->version == SETTINGS_VERSION && s->response_mode <= RESP_FULL && (s->text_method == 'A' || s->text_method == 'B') &&
           s->scroll_step >= 1 && s->scroll_step <= 3 && s->key_repeat <= 3 && s->auth_combo < COMBO_COUNT &&
           s->multitap_ms >= 300 && s->multitap_ms <= 3000 && s->auto_lock_s >= 15 && s->resolution < 6;
}

int settings_load(kv_store_t *kv, settings_t *s)
{
    settings_t tmp;
    size_t len = sizeof(tmp);
    if (kv && kv->get(kv, "settings", &tmp, &len) == KV_OK && len == sizeof(tmp) && valid(&tmp)) {
        *s = tmp;
        return KV_OK;
    }
    settings_defaults(s);
    return KV_NOT_FOUND;
}

int settings_save(kv_store_t *kv, const settings_t *s)
{
    if (!kv) return KV_ERR;
    return kv->set(kv, "settings", s, sizeof(*s));
}

const char *settings_mode_name(uint8_t m)
{
    static const char *const N[] = {"Rapido", "Curto", "Completo"};
    return m <= RESP_FULL ? N[m] : "?";
}

/* ------------------------------ memory KV ---------------------------- */

typedef struct mem_entry { char key[16]; uint8_t *val; size_t len; struct mem_entry *next; } mem_entry_t;
typedef struct { mem_entry_t *head; bool fail; } mem_ctx_t;

static mem_entry_t *find(mem_ctx_t *c, const char *k)
{
    for (mem_entry_t *e = c->head; e; e = e->next) if (strcmp(e->key, k) == 0) return e;
    return NULL;
}

static int mem_get(kv_store_t *kv, const char *key, void *buf, size_t *len)
{
    mem_entry_t *e = find(kv->ctx, key);
    if (!e) return KV_NOT_FOUND;
    if (!buf) { *len = e->len; return KV_OK; }
    if (*len < e->len) { *len = e->len; return KV_ERR; }
    memcpy(buf, e->val, e->len);
    *len = e->len;
    return KV_OK;
}

static int mem_set(kv_store_t *kv, const char *key, const void *buf, size_t len)
{
    mem_ctx_t *c = kv->ctx;
    if (c->fail || strlen(key) > 15) return KV_ERR;
    mem_entry_t *e = find(c, key);
    uint8_t *v = malloc(len ? len : 1);
    if (!v) return KV_ERR;
    memcpy(v, buf, len);
    if (!e) {
        e = calloc(1, sizeof(*e));
        if (!e) { free(v); return KV_ERR; }
        strcpy(e->key, key);
        e->next = c->head;
        c->head = e;
    } else {
        memset(e->val, 0, e->len);
        free(e->val);
    }
    e->val = v;
    e->len = len;
    return KV_OK;
}

static int mem_erase(kv_store_t *kv, const char *key)
{
    mem_ctx_t *c = kv->ctx;
    for (mem_entry_t **pp = &c->head; *pp; pp = &(*pp)->next) {
        if (strcmp((*pp)->key, key) == 0) {
            mem_entry_t *e = *pp;
            *pp = e->next;
            memset(e->val, 0, e->len);
            free(e->val);
            free(e);
            return KV_OK;
        }
    }
    return KV_NOT_FOUND;
}

kv_store_t *kv_memory_create(void)
{
    kv_store_t *kv = calloc(1, sizeof(*kv));
    mem_ctx_t *c = calloc(1, sizeof(*c));
    if (!kv || !c) { free(kv); free(c); return NULL; }
    kv->get = mem_get;
    kv->set = mem_set;
    kv->erase = mem_erase;
    kv->ctx = c;
    return kv;
}

void kv_memory_fail_writes(kv_store_t *kv, bool fail) { ((mem_ctx_t *)kv->ctx)->fail = fail; }

void kv_memory_destroy(kv_store_t *kv)
{
    if (!kv) return;
    mem_ctx_t *c = kv->ctx;
    while (c->head) mem_erase(kv, c->head->key);
    free(c);
    free(kv);
}
