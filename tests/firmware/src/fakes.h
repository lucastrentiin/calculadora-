/* Fake platform pieces for host tests (transport, camera, Wi-Fi, clock). */
#pragma once
#include <stdlib.h>
#include <string.h>

#include "ai_client.h"
#include "camera_hal.h"
#include "wifi_manager.h"

static uint32_t g_now_ms = 1000000;
__attribute__((unused)) static uint32_t fake_now_ms(void) { return g_now_ms; }
static uint32_t fake_now_s(void) { return 1700000000u + g_now_ms / 1000; }

/* ---- transport ---- */
typedef struct {
    const char *reply;      /* body returned */
    int status;
    int fail;               /* 1 = transport error on every URL */
    int fail_lan_unsent;    /* LAN URL fails before sending (failover test) */
    int fail_lan_sent;      /* LAN URL fails after the request left (must NOT fail over) */
    int pending_polls;      /* first POST answers 202, then N polls answer 202 before `reply` */
    const char *pages[4];   /* replies for ?page=1.. */
    int abort_after_send;   /* emulate long wait: report SENT then poll abort */
    char last_url[192], last_sig[80], last_body[512], last_method[8], first_url[192];
    char hdr_session[40], hdr_provider[40], hdr_proto[8], hdr_cf[40];
    int calls, cancel_calls, polls, page_calls;
} fake_net_t;
static fake_net_t g_net;

static int fake_post(ai_transport_t *t, const char *method, const char *url, const ai_header_t *h, int nh, const uint8_t *body, size_t len,
                     bool (*abort)(void *), void (*phase)(void *, ai_phase_t), void *u, char **resp, size_t *rl, int *st)
{
    (void)t;
    g_net.calls++;
    if (g_net.calls == 1) snprintf(g_net.first_url, sizeof g_net.first_url, "%s", url);
    snprintf(g_net.last_url, sizeof g_net.last_url, "%s", url);
    snprintf(g_net.last_method, sizeof g_net.last_method, "%s", method);
    for (int i = 0; i < nh; i++) {
        if (!strcmp(h[i].name, "X-Signature")) snprintf(g_net.last_sig, sizeof g_net.last_sig, "%s", h[i].value);
        if (!strcmp(h[i].name, "X-Session-Id")) snprintf(g_net.hdr_session, sizeof g_net.hdr_session, "%s", h[i].value);
        if (!strcmp(h[i].name, "X-Provider")) snprintf(g_net.hdr_provider, sizeof g_net.hdr_provider, "%s", h[i].value);
        if (!strcmp(h[i].name, "X-Protocol")) snprintf(g_net.hdr_proto, sizeof g_net.hdr_proto, "%s", h[i].value);
        if (!strcmp(h[i].name, "CF-Access-Client-Id")) snprintf(g_net.hdr_cf, sizeof g_net.hdr_cf, "%s", h[i].value);
    }
    bool lan = strstr(url, "lan.test") != NULL;
    if (lan && g_net.fail_lan_unsent) { if (phase) phase(u, AI_PHASE_CONNECTING); return -1; }
    if (strstr(url, "/requests/cancel")) {
        g_net.cancel_calls++;
        size_t c = len < sizeof g_net.last_body - 1 ? len : sizeof g_net.last_body - 1;
        memcpy(g_net.last_body, body, c); g_net.last_body[c] = 0;
        *resp = strdup("{\"status\":\"cancelado no servidor\"}"); *rl = strlen(*resp); *st = 200; return 0;
    }
    if (!strcmp(method, "GET") && strstr(url, "page=")) {
        int p = atoi(strstr(url, "page=") + 5);
        g_net.page_calls++;
        *resp = strdup(p >= 1 && p <= 4 && g_net.pages[p - 1] ? g_net.pages[p - 1] : "{}"); *rl = strlen(*resp); *st = 200; return 0;
    }
    if (!strcmp(method, "GET")) {
        g_net.polls++;
        if (abort && abort(u)) return -2;
        if (g_net.polls <= g_net.pending_polls) { *resp = strdup("{\"status\":\"processing\"}"); *rl = strlen(*resp); *st = 202; return 0; }
        *resp = strdup(g_net.reply ? g_net.reply : "{}"); *rl = strlen(*resp); *st = g_net.status ? g_net.status : 200; return 0;
    }
    size_t c = len < sizeof g_net.last_body - 1 ? len : sizeof g_net.last_body - 1;
    memcpy(g_net.last_body, body, c); g_net.last_body[c] = 0;
    if (phase) { phase(u, AI_PHASE_SENDING); phase(u, AI_PHASE_SENT); phase(u, AI_PHASE_WAITING); }
    if (abort && abort(u)) return -2;
    if (g_net.fail || (lan && g_net.fail_lan_sent)) return -1;
    if (g_net.pending_polls) { *resp = strdup("{\"status\":\"processing\"}"); *rl = strlen(*resp); *st = 202; return 0; }
    *resp = strdup(g_net.reply ? g_net.reply : "{}");
    *rl = strlen(*resp);
    *st = g_net.status ? g_net.status : 200;
    return 0;
}
static ai_transport_t g_transport = {fake_post, NULL};

/* ---- camera ---- */
typedef struct { cam_state_t st; int fail_start, fail_capture; } fake_cam_t;
static fake_cam_t g_cam;
static void cam_start(camera_hal_t *h, cam_res_t r, uint8_t q) { (void)h; (void)r; (void)q; g_cam.st = g_cam.fail_start ? CAM_ERROR : CAM_READY; }
static void cam_capture(camera_hal_t *h) { (void)h; g_cam.st = g_cam.fail_capture ? CAM_ERROR : CAM_CAPTURED; }
static bool cam_take(camera_hal_t *h, cam_image_t *o) {
    (void)h; if (g_cam.st != CAM_CAPTURED) return false;
    o->len = 2000; o->data = calloc(1, o->len); o->data[0] = 0xFF; o->data[1] = 0xD8; o->width = 800; o->height = 600;
    g_cam.st = CAM_READY; return true;
}
static void cam_stop(camera_hal_t *h) { (void)h; g_cam.st = CAM_OFF; }
static cam_state_t cam_state(camera_hal_t *h) { (void)h; return g_cam.st; }
static const char *cam_err(camera_hal_t *h) { (void)h; return "sensor nao detectado"; }
static const char *cam_diag(camera_hal_t *h) { (void)h; return "fake"; }
__attribute__((unused)) static camera_hal_t g_camhal = {cam_start, cam_capture, cam_take, cam_stop, cam_state, cam_err, cam_diag, NULL};

/* ---- wifi ---- */
static wifi_state_t g_wifi_state = WIFI_ST_CONNECTED;
static wifi_saved_t g_saved;
static wifi_state_t w_state(wifi_hal_t *w) { (void)w; return g_wifi_state; }
static const char *w_ssid(wifi_hal_t *w) { (void)w; return "Hotspot"; }
static int8_t w_rssi(wifi_hal_t *w) { (void)w; return -50; }
static const char *w_err(wifi_hal_t *w) { (void)w; return ""; }
static int w_saved(wifi_hal_t *w, char s[][33], int max) { (void)w; int n = 0; for (; n < g_saved.n && n < max; n++) strcpy(s[n], g_saved.net[n].ssid); return n; }
static int w_add(wifi_hal_t *w, const char *s, const char *p) { (void)w; return wifi_saved_add(&g_saved, s, p); }
static int w_remove(wifi_hal_t *w, const char *s) { (void)w; return wifi_saved_remove(&g_saved, s); }
static void w_connect(wifi_hal_t *w) { (void)w; g_wifi_state = WIFI_ST_CONNECTED; }
static void w_off(wifi_hal_t *w) { (void)w; g_wifi_state = WIFI_ST_OFF; }
__attribute__((unused)) static wifi_hal_t g_wifihal = {w_state, w_ssid, w_rssi, w_err, w_saved, w_add, w_remove, w_connect, w_off, NULL};
