#include "ai_response.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "math_engine.h"

static const char *str(const cJSON *o, const char *k)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

/* Truncate a string field in place when it exceeds max (marks partial). */
static void limit(air_t *r, cJSON *o, const char *k, size_t max)
{
    cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    if (!v) return;
    if (!cJSON_IsString(v)) { cJSON_DeleteItemFromObjectCaseSensitive(o, k); r->partial = true; return; }
    if (strlen(v->valuestring) > max) { v->valuestring[max] = 0; r->partial = true; }
}

static void limit_array(air_t *r, cJSON *o, const char *k, int max)
{
    cJSON *a = cJSON_GetObjectItemCaseSensitive(o, k);
    if (!a) return;
    if (!cJSON_IsArray(a)) { cJSON_DeleteItemFromObjectCaseSensitive(o, k); r->partial = true; return; }
    while (cJSON_GetArraySize(a) > max) { cJSON_DeleteItemFromArray(a, cJSON_GetArraySize(a) - 1); r->partial = true; r->truncated = true; }
}

bool air_parse(air_t *r, const char *json, size_t len)
{
    memset(r, 0, sizeof(*r));
    if (len > 64 * 1024) { snprintf(r->error, sizeof(r->error), "resposta excede limite total"); return false; }
    r->root = cJSON_ParseWithLength(json, len);
    if (!cJSON_IsObject(r->root)) { snprintf(r->error, sizeof(r->error), "resposta nao e objeto JSON"); air_free(r); return false; }
    const cJSON *ver = cJSON_GetObjectItemCaseSensitive(r->root, "version");
    if (!cJSON_IsNumber(ver) || ver->valuedouble != 1) { snprintf(r->error, sizeof(r->error), "versao incompativel"); air_free(r); return false; }
    const char *st = str(r->root, "status");
    if (!st || (strcmp(st, "ok") && strcmp(st, "refused") && strcmp(st, "error"))) { snprintf(r->error, sizeof(r->error), "status invalido"); air_free(r); return false; }
    r->status = !strcmp(st, "ok") ? AIR_STATUS_OK : !strcmp(st, "refused") ? AIR_STATUS_REFUSED : AIR_STATUS_ERROR;
    const char *mode = str(r->root, "mode");
    r->mode = mode && !strcmp(mode, "fast") ? RESP_FAST : mode && !strcmp(mode, "full") ? RESP_FULL : RESP_SHORT;
    if (r->status == AIR_STATUS_OK && !str(r->root, "answer")) { snprintf(r->error, sizeof(r->error), "answer ausente"); air_free(r); return false; }
    limit(r, r->root, "answer", AIR_MAX_ANSWER);
    limit(r, r->root, "notes", AIR_MAX_FIELD);
    limit_array(r, r->root, "steps", AIR_MAX_STEPS);
    limit_array(r, r->root, "given", AIR_MAX_GIVEN);
    limit_array(r, r->root, "formulas", AIR_MAX_FORMULAS);
    cJSON *steps = cJSON_GetObjectItemCaseSensitive(r->root, "steps"), *s;
    cJSON_ArrayForEach(s, steps) { limit(r, s, "title", 200); limit(r, s, "math", AIR_MAX_FIELD); limit(r, s, "text", AIR_MAX_FIELD); }
    cJSON *given = cJSON_GetObjectItemCaseSensitive(r->root, "given");
    cJSON_ArrayForEach(s, given) { limit(r, s, "name", 100); limit(r, s, "value", 200); }
    cJSON *tr = cJSON_GetObjectItemCaseSensitive(r->root, "truncated");
    if (cJSON_IsTrue(tr)) r->truncated = true;
    return true;
}

void air_free(air_t *r)
{
    if (r->root) cJSON_Delete(r->root);
    r->root = NULL;
}

air_verify_t air_verify(const air_t *r, char *text, size_t len)
{
    const cJSON *chk = cJSON_GetObjectItemCaseSensitive(r->root, "check");
    const char *expr = cJSON_IsObject(chk) ? str(chk, "expression") : NULL;
    const cJSON *exp = cJSON_IsObject(chk) ? cJSON_GetObjectItemCaseSensitive(chk, "expected") : NULL;
    if (!expr || !cJSON_IsNumber(exp) || strlen(expr) > 256) { snprintf(text, len, "Sem verificacao local disponivel"); return AIR_VERIFY_NONE; }
    const char *ang = str(chk, "angle");
    me_ctx_t ctx = {.angle = ang && !strcmp(ang, "deg") ? ME_ANGLE_DEG : ME_ANGLE_RAD, .vars = NULL, .nvars = 0};
    double v;
    me_err_t e = me_eval(expr, &ctx, &v);
    if (e != ME_OK) { snprintf(text, len, "Verificacao local falhou: %s", me_err_text(e)); return AIR_VERIFY_ERROR; }
    double x = exp->valuedouble;
    char a[40], b[40];
    me_format(v, 10, a, sizeof(a));
    me_format(x, 10, b, sizeof(b));
    double tol = 1e-9 * fmax(1.0, fmax(fabs(x), fabs(v)));
    if (fabs(v - x) <= tol || strcmp(a, b) == 0) { snprintf(text, len, "Confere: %.180s = %s", expr, a); return AIR_VERIFY_MATCH; }
    snprintf(text, len, "DIVERGENCIA: local %s != IA %s", a, b);
    return AIR_VERIFY_MISMATCH;
}

void air_to_doc(const air_t *r, resp_mode_t mode, const char *question, doc_t *d)
{
    char line[256];
    if (question && *question) { doc_add(d, DOC_TITLE, "Pergunta", NULL); doc_add(d, DOC_TEXT, question, NULL); }
    const char *notes = str(r->root, "notes");
    if (r->status == AIR_STATUS_REFUSED) { doc_add(d, DOC_TITLE, "[IA] Recusado", NULL); doc_add(d, DOC_TEXT, notes ? notes : "Solicitacao recusada.", NULL); return; }
    if (r->status == AIR_STATUS_ERROR) { doc_add(d, DOC_TITLE, "[IA] Erro", NULL); doc_add(d, DOC_TEXT, notes ? notes : "Erro no servico.", NULL); return; }
    snprintf(line, sizeof(line), "[IA] Resultado (%s)", settings_mode_name(mode));
    doc_add(d, DOC_TITLE, line, NULL);
    doc_add(d, DOC_MATH, str(r->root, "answer"), NULL);
    if (mode != RESP_FAST) {
        cJSON *it;
        if (mode == RESP_FULL) {
            cJSON *given = cJSON_GetObjectItemCaseSensitive(r->root, "given");
            if (cJSON_GetArraySize(given)) {
                doc_add(d, DOC_TITLE, "Dados", NULL);
                cJSON_ArrayForEach(it, given) {
                    snprintf(line, sizeof(line), "%s = %s", str(it, "name") ? str(it, "name") : "?", str(it, "value") ? str(it, "value") : "?");
                    doc_add(d, DOC_MATH, line, NULL);
                }
            }
            cJSON *f = cJSON_GetObjectItemCaseSensitive(r->root, "formulas");
            if (cJSON_GetArraySize(f)) {
                doc_add(d, DOC_TITLE, "Formulas", NULL);
                cJSON_ArrayForEach(it, f) if (cJSON_IsString(it)) doc_add(d, DOC_MATH, it->valuestring, NULL);
            }
        }
        cJSON *steps = cJSON_GetObjectItemCaseSensitive(r->root, "steps");
        int n = cJSON_GetArraySize(steps), shown = mode == RESP_SHORT && n > 6 ? 6 : n, i = 0;
        if (n) doc_add(d, DOC_TITLE, "Etapas", NULL);
        cJSON_ArrayForEach(it, steps) {
            if (i >= shown) break;
            snprintf(line, sizeof(line), "%d. %.200s", i + 1, str(it, "title") ? str(it, "title") : "");
            doc_add(d, DOC_TEXT, line, NULL);
            const char *m = str(it, "math");
            if (m && *m) doc_add(d, DOC_MATH, m, NULL);
            const char *t = str(it, "text");
            if (mode == RESP_FULL && t && *t) doc_add(d, DOC_TEXT, t, NULL);
            i++;
        }
        if (shown < n) { snprintf(line, sizeof(line), "(%d etapas a mais no modo Completo)", n - shown); doc_add(d, DOC_TEXT, line, NULL); }
        if (mode == RESP_FULL && notes && *notes) { doc_add(d, DOC_TITLE, "Observacoes", NULL); doc_add(d, DOC_TEXT, notes, NULL); }
    }
    doc_add(d, DOC_TITLE, "[LOCAL] Verificacao", NULL);
    air_verify(r, line, sizeof(line));
    doc_add(d, DOC_TEXT, line, NULL);
    if (r->truncated) doc_add(d, DOC_TEXT, "Aviso: resposta truncada por limite de tamanho.", NULL);
    if (r->partial) doc_add(d, DOC_TEXT, "Aviso: campos fora do limite foram cortados.", NULL);
}
