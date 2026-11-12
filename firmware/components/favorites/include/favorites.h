/*
 * Favorites: formulas (non-private, plain KV list of ids) and private items
 * (resolutions, questions, results) stored in the encrypted vault.
 */
#pragma once
#include <stdbool.h>

#include "settings.h"
#include "vault.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { FAV_RESOLUTION = 0, FAV_QUESTION = 1, FAV_RESULT = 2 } fav_type_t;

/* formula favorites (available offline without PIN) */
bool fav_formula_is(kv_store_t *kv, const char *id);
int fav_formula_toggle(kv_store_t *kv, const char *id);
int fav_formula_list(kv_store_t *kv, char ids[][16], int max);

/* private favorites (vault must be open) */
int fav_add(vault_t *v, fav_type_t type, const char *title, const char *content);
int fav_count(const vault_t *v);
cJSON *fav_get(const vault_t *v, int i); /* {"y":type,"t":title,"c":content} */
int fav_delete(vault_t *v, int i);

#ifdef __cplusplus
}
#endif
