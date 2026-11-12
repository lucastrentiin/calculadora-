#include "mt_test.h"
#include "fakes.h"
#include "ai_response.h"
#include "security.h"

static ai_client_t C;
static void setup(void) {
    ai_client_cfg_t cfg; memset(&cfg, 0, sizeof cfg);
    strcpy(cfg.base_url, "https://backend.test"); strcpy(cfg.device_id, "dev-1");
    memset(cfg.device_key, 5, 32); cfg.transport = &g_transport; cfg.now_s = fake_now_s;
    ai_client_init(&C, &cfg); memset(&g_net, 0, sizeof g_net);
}

TEST(signature_matches_backend_format) {
    char sig[65]; uint8_t key[32]; memset(key, 0, 32);
    CHECK_INT(ai_sign(key, "POST", "/v1/ask", "1700000000", "00112233445566778899aabb", (const uint8_t *)"{}", 2, sig), 0);
    CHECK_INT(strlen(sig), 64);
    /* reference computed with backend/src/deviceAuth.ts signRequest() (Node crypto) */
    CHECK_STR(sig, "6564c910d2da6c2cd130bf5bd8ca879ca89ac2906717771db37dd52969a46d39");
}

TEST(text_request_roundtrip) {
    setup();
    g_net.reply = "{\"version\":1,\"request_id\":\"x\",\"mode\":\"short\",\"status\":\"ok\",\"answer\":\"42\",\"steps\":[],\"check\":{\"expression\":\"6*7\",\"expected\":42,\"angle\":\"rad\"}}";
    uint32_t g = ai_client_start_text(&C, "quanto e 6*7?", RESP_SHORT);
    CHECK(g > 0);
    CHECK_INT(ai_client_start_text(&C, "outra", RESP_SHORT), 0); /* one at a time */
    ai_result_t r; CHECK(!ai_client_poll(&C, g, &r));
    CHECK(ai_client_run_pending(&C));
    CHECK_STR(g_net.last_url, "https://backend.test/v1/ask");
    CHECK(strstr(g_net.last_body, "\"mode\":\"short\"") != NULL);
    CHECK(ai_client_poll(&C, g, &r));
    CHECK_INT(r.kind, AI_RESULT_OK); CHECK(r.was_sent);
    air_t air; CHECK(air_parse(&air, r.body, r.body_len));
    char t[128]; CHECK_INT(air_verify(&air, t, sizeof t), AIR_VERIFY_MATCH);
    air_free(&air); ai_client_free_result(&r);
}

TEST(cancel_before_send_has_no_remote_cancel) {
    setup();
    uint32_t g = ai_client_start_text(&C, "q", RESP_FAST);
    ai_client_cancel(&C);
    ai_client_run_pending(&C);
    ai_result_t r; CHECK(!ai_client_poll(&C, g, &r));
    CHECK_INT(g_net.calls, 0); CHECK_INT(g_net.cancel_calls, 0);
    const ai_cancel_entry_t *e; CHECK_INT(ai_client_cancel_log(&C, &e), 0);
}

static ai_client_t *s_cancel_target;
static void cancel_during_wait(void *u, ai_phase_t p) { (void)u; (void)p; }
TEST(cancel_after_send_is_tracked_and_late_response_discarded) {
    setup();
    g_net.reply = "{\"version\":1,\"status\":\"ok\",\"answer\":\"segredo\"}";
    uint32_t g = ai_client_start_text(&C, "q", RESP_FAST);
    /* emulate: worker sent the request, then the UI cancels before the response is delivered */
    atomic_store(&C.sent, true);
    ai_client_cancel(&C);
    (void)s_cancel_target; (void)cancel_during_wait;
    ai_client_run_pending(&C); /* job aborted (gen changed) + remote cancel issued */
    ai_result_t r; CHECK(!ai_client_poll(&C, g, &r));
    CHECK_INT(g_net.cancel_calls, 1);
    const ai_cancel_entry_t *e; CHECK_INT(ai_client_cancel_log(&C, &e), 1);
    CHECK_INT(e[0].status, AI_CANCEL_CONFIRMED);
}

TEST(transport_and_http_errors) {
    setup();
    g_net.fail = 1;
    uint32_t g = ai_client_start_text(&C, "q", RESP_FAST);
    ai_client_run_pending(&C);
    ai_result_t r; CHECK(ai_client_poll(&C, g, &r)); CHECK_INT(r.kind, AI_RESULT_TRANSPORT_ERROR); ai_client_free_result(&r);
    g_net.fail = 0; g_net.status = 503; g_net.reply = "{\"error\":\"ocupado\"}";
    g = ai_client_start_text(&C, "q", RESP_FAST);
    ai_client_run_pending(&C);
    CHECK(ai_client_poll(&C, g, &r)); CHECK_INT(r.kind, AI_RESULT_HTTP_ERROR); CHECK_INT(r.http_status, 503); ai_client_free_result(&r);
}

TEST(image_request) {
    setup();
    g_net.reply = "{\"version\":1,\"status\":\"ok\",\"answer\":\"ok\"}";
    uint8_t *img = malloc(100); memset(img, 0xAB, 100);
    uint32_t g = ai_client_start_image(&C, img, 100, "resolva", RESP_FULL);
    CHECK(g > 0);
    ai_client_run_pending(&C);
    CHECK_STR(g_net.last_url, "https://backend.test/v1/image");
    ai_result_t r; CHECK(ai_client_poll(&C, g, &r)); ai_client_free_result(&r);
}

TEST(response_validation) {
    air_t a;
    CHECK(!air_parse(&a, "not json", 8));
    CHECK(!air_parse(&a, "{\"version\":2,\"status\":\"ok\",\"answer\":\"x\"}", 41));
    const char *noans = "{\"version\":1,\"status\":\"ok\"}";
    CHECK(!air_parse(&a, noans, strlen(noans)));
    const char *types = "{\"version\":1,\"status\":\"ok\",\"answer\":{\"x\":1}}";
    CHECK(!air_parse(&a, types, strlen(types)));
    /* many steps -> kept up to the limit and flagged */
    static char big[200000]; strcpy(big, "{\"version\":1,\"status\":\"ok\",\"mode\":\"full\",\"answer\":\"a\",\"steps\":[");
    for (int i = 0; i < 120; i++) strcat(big, i ? ",{\"title\":\"t\",\"math\":\"1+1\",\"text\":\"x\"}" : "{\"title\":\"t\",\"math\":\"1+1\",\"text\":\"x\"}");
    strcat(big, "],\"check\":{\"expression\":\"1+1\",\"expected\":3}}");
    CHECK(air_parse(&a, big, strlen(big)));
    CHECK(a.truncated);
    char t[128]; CHECK_INT(air_verify(&a, t, sizeof t), AIR_VERIFY_MISMATCH);
    doc_t d; doc_init(&d, true);
    air_to_doc(&a, RESP_FULL, "pergunta", &d);
    int ia = 0, local = 0;
    for (size_t i = 0; i < d.nblocks; i++) { if (!strncmp(d.blocks[i].cells, "[IA]", 4)) ia++; if (!strncmp(d.blocks[i].cells, "[LOCAL]", 7)) local++; }
    CHECK(ia == 1 && local == 1);
    doc_t s; doc_init(&s, true); air_to_doc(&a, RESP_SHORT, NULL, &s); CHECK(s.nblocks < d.nblocks);
    doc_t f; doc_init(&f, true); air_to_doc(&a, RESP_FAST, NULL, &f); CHECK(f.nblocks < s.nblocks);
    doc_free(&d); doc_free(&s); doc_free(&f); air_free(&a);
    const char *evil = "{\"version\":1,\"status\":\"ok\",\"answer\":\"1\",\"check\":{\"expression\":\"system(1)\",\"expected\":1}}";
    CHECK(air_parse(&a, evil, strlen(evil))); CHECK_INT(air_verify(&a, t, sizeof t), AIR_VERIFY_ERROR); air_free(&a);
}

TEST_MAIN(RUN(signature_matches_backend_format); RUN(text_request_roundtrip); RUN(cancel_before_send_has_no_remote_cancel);
          RUN(cancel_after_send_is_tracked_and_late_response_discarded); RUN(transport_and_http_errors); RUN(image_request); RUN(response_validation))
