/*
 * Encrypted private store (history of AI queries, favorites).
 * Blob layout in KV key "vault": 'M','T','V',1 | IV(12) | TAG(16) | AES-256-GCM(JSON)
 * The key is the data key derived from the PIN (authentication.h): data is
 * unreadable without the PIN and the key only lives in RAM while unlocked.
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"
#include "settings.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VAULT_MAX_BYTES (48 * 1024)
#define HISTORY_MAX 100
#define FAVORITES_MAX 100

typedef struct {
    kv_store_t *kv;
    unsigned char key[32];
    cJSON *root;      /* {"h":[...], "f":[...]} */
    bool open, corrupt;
} vault_t;

/** Open with the data key (copied). Missing vault -> empty; undecryptable -> empty + corrupt (blob kept). */
int vault_open(vault_t *v, kv_store_t *kv, const unsigned char key[32]);
int vault_save(vault_t *v);
/** Re-encrypt with a new key (PIN change). */
int vault_rekey(vault_t *v, const unsigned char new_key[32]);
/** Wipe key and contents from RAM. */
void vault_close(vault_t *v);

/* history (newest first) */
int history_add(vault_t *v, const char *title, const char *question, const char *response_json, int mode);
int history_count(const vault_t *v);
cJSON *history_get(const vault_t *v, int i); /* borrowed: {"t","q","r","m"} */
int history_delete(vault_t *v, int i);
int history_clear(vault_t *v);

#ifdef __cplusplus
}
#endif
