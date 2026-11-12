/*
 * Response contract v1 (same as backend/src/schema.ts and the simulator):
 * strict validation with size limits, local deterministic verification,
 * conversion to a reader document honouring the response mode.
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"
#include "math_renderer.h"
#include "settings.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AIR_MAX_ANSWER 1000
#define AIR_MAX_FIELD 2000
#define AIR_MAX_STEPS 80
#define AIR_MAX_GIVEN 30
#define AIR_MAX_FORMULAS 20

typedef enum { AIR_STATUS_OK = 0, AIR_STATUS_REFUSED, AIR_STATUS_ERROR } air_status_t;
typedef enum { AIR_VERIFY_NONE = 0, AIR_VERIFY_MATCH, AIR_VERIFY_MISMATCH, AIR_VERIFY_ERROR } air_verify_t;

typedef struct {
    cJSON *root;          /* owned */
    air_status_t status;
    resp_mode_t mode;
    bool partial;         /* some limits exceeded (content cut) */
    bool truncated;       /* server-side truncation flag */
    char error[96];
} air_t;

/** Parse + validate. Returns false on fatal problems (error[] explains). */
bool air_parse(air_t *r, const char *json, size_t len);
void air_free(air_t *r);
/** Recompute check.expression locally. text receives a human readable verdict. */
air_verify_t air_verify(const air_t *r, char *text, size_t len);
/** Build the reader document ([IA] parts and [LOCAL] verification clearly separated). */
void air_to_doc(const air_t *r, resp_mode_t mode, const char *question, doc_t *doc);

#ifdef __cplusplus
}
#endif
