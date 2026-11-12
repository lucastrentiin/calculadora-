/* Private declarations shared by app_state.c, app_views.c and app_screens.c */
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "app_state.h"
#include "math_renderer.h"
#include "mt_font.h"
#include "text_input.h"

#define APP_LOG(a, e) do { if ((a)->p.log) (a)->p.log(e); } while (0)

/* layout */
typedef struct { uint8_t scale; int cw, ch, x0, cols, rows; bool title_row, simple; } layout_t;
layout_t app_layout(const app_t *a);
layout_t app_layout1(const app_t *a);
uint32_t app_now(const app_t *a);
void app_flash(app_t *a, const char *msg);
void app_save_settings(app_t *a);
void calc_cfg_from_settings(app_t *a);
void calc_cfg_to_settings(app_t *a);

/* ------------------------------ menu ------------------------------ */
typedef struct menu_view menu_view_t;
struct menu_view {
    view_t base;
    const char *title;
    int sel, top;
    intptr_t arg;
    int (*count)(app_t *a, menu_view_t *m);
    void (*label)(app_t *a, menu_view_t *m, int i, char *buf, size_t len);
    void (*value)(app_t *a, menu_view_t *m, int i, char *buf, size_t len);  /* optional */
    bool (*cycle)(app_t *a, menu_view_t *m, int i, int dir);                 /* optional: true if item cycles */
    void (*select)(app_t *a, menu_view_t *m, int i);
    void (*del)(app_t *a, menu_view_t *m, int i);                            /* optional */
    void (*fav)(app_t *a, menu_view_t *m, int i);                            /* optional */
    void (*back)(app_t *a, menu_view_t *m);                                  /* optional (default pop) */
};
menu_view_t *menu_new(app_state_id_t st, bool prot, const char *title);

/* ------------------------------ reader ---------------------------- */
typedef struct reader_view reader_view_t;
struct reader_view {
    view_t base;
    doc_t doc;
    reader_t rd;
    int lcols, lrows;
    intptr_t arg;
    char extra[64];
    void (*on_enter)(app_t *a, reader_view_t *r);
    void (*on_fav)(app_t *a, reader_view_t *r);
};
reader_view_t *reader_new(app_state_id_t st, bool prot);
/** Serialise the document as plain text (for favorites). Caller frees. */
char *reader_plain_text(const reader_view_t *r);

/* ------------------------------ form ------------------------------ */
enum { FLD_NUM = 0, FLD_EXPR, FLD_CHOICE, FLD_PIN, FLD_LIST };
typedef struct {
    const char *label;
    uint8_t type;
    char text[96];
    uint8_t idx, nopts;
    const char *const *opts;
} field_t;
typedef struct form_view form_view_t;
struct form_view {
    view_t base;
    const char *title;
    field_t f[10];
    int n, sel, top;
    char error[40];
    bool step_through;
    intptr_t arg;
    void (*submit)(app_t *a, form_view_t *f);
};
form_view_t *form_new(app_state_id_t st, bool prot, const char *title, void (*submit)(app_t *, form_view_t *));
field_t *form_add(form_view_t *f, const char *label, uint8_t type);
/** Evaluate a numeric field; returns false and sets f->error on failure. */
bool form_num(form_view_t *f, int i, double *out);

/* ------------------------------ editor ---------------------------- */
typedef struct editor_view editor_view_t;
struct editor_view {
    view_t base;
    const char *title;
    textbuf_t buf;
    multitap_t mt;
    vkbd_t vk;
    char method;
    bool masked;
    uint16_t hoff, top_line;
    char ctx[40];          /* e.g. SSID while typing the password */
    void (*submit)(app_t *a, editor_view_t *e, const char *utf8);
};
editor_view_t *editor_new(app_state_id_t st, bool prot, const char *title, void (*submit)(app_t *, editor_view_t *, const char *));

/* ------------------------------ busy ------------------------------ */
typedef struct busy_view busy_view_t;
struct busy_view {
    view_t base;
    int kind; /* 0 AI, 1 OTA */
    uint32_t gen;
};
busy_view_t *busy_new(int kind, uint32_t gen);

/* drawing helpers */
void ui_scrollbar(fb_t *fb, int total, int top, int visible, int y0, int h);
int ui_title(fb_t *fb, const layout_t *L, const char *title);

/* screens (app_screens.c) */
view_t *screens_protected_menu(app_t *a);
void screens_open_question(app_t *a);
void screens_open_camera(app_t *a);
void screens_open_settings(app_t *a);
void screens_open_history(app_t *a);
void screens_open_favorites(app_t *a);
void screens_open_pin_setup(app_t *a);
void screens_open_steps(app_t *a, const char *expr, bool prot);
void screens_ai_result(app_t *a, busy_view_t *b);
void screens_message(app_t *a, app_state_id_t st, const char *title, const char *text);
