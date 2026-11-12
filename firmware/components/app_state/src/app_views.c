/* Generic views. Navigation rules (identical to the simulator):
 *   menus/keyboards: arrows move focus, = / RIGHT selects, AC / LEFT goes back
 *   reading pages:   UP/DOWN scroll (SHIFT = page), LEFT/RIGHT scroll the focused math line, AC back */
#include <stdlib.h>

#include "app_internal.h"
#include "security.h"

void ui_scrollbar(fb_t *fb, int total, int top, int visible, int y0, int h)
{
    if (total <= visible) return;
    int x = fb->width - 2;
    fb_vline(fb, x + 1, y0, h);
    int bh = h * visible / total;
    if (bh < 2) bh = 2;
    int by = y0 + (h - bh) * top / (total - visible > 0 ? total - visible : 1);
    fb_fill_rect(fb, x, by, 1, bh, true);
}

int ui_title(fb_t *fb, const layout_t *L, const char *title)
{
    if (!L->title_row) return 0;
    char t[40];
    size_t n = 0;
    for (const char *s = title; *s && n < sizeof(t) - 1 && n < (size_t)((fb->width - 6) / 4); s++) {
        unsigned char c = (unsigned char)*s;
        if (c >= 0x80) continue;
        t[n++] = (char)((c >= 'a' && c <= 'z') ? c - 32 : c);
    }
    t[n] = 0;
    fb_tiny(fb, 1, 0, t);
    return 7;
}

/* ------------------------------ menu ------------------------------ */

static void menu_back(app_t *a, menu_view_t *m) { if (m->back) m->back(a, m); else app_pop(a); }

static bool menu_key(view_t *v, app_t *a, keycode_t k, bool shift)
{
    (void)shift;
    menu_view_t *m = (menu_view_t *)v;
    int n = m->count(a, m);
    switch (k) {
    case KEY_UP: if (n) m->sel = (m->sel - 1 + n) % n; return true;
    case KEY_DOWN: if (n) m->sel = (m->sel + 1) % n; return true;
    case KEY_LEFT: if (n && m->cycle && m->cycle(a, m, m->sel, -1)) return true; menu_back(a, m); return true;
    case KEY_RIGHT: if (n && m->cycle && m->cycle(a, m, m->sel, 1)) return true; if (n && m->select) m->select(a, m, m->sel); return true;
    case KEY_EQ: if (n && m->cycle && m->cycle(a, m, m->sel, 1)) return true; if (n && m->select) m->select(a, m, m->sel); return true;
    case KEY_DEL: if (n && m->del) { m->del(a, m, m->sel); n = m->count(a, m); if (m->sel >= n) m->sel = n ? n - 1 : 0; } return true;
    case KEY_STO: if (n && m->fav) m->fav(a, m, m->sel); return true;
    case KEY_AC: menu_back(a, m); return true;
    default:
        if (k >= KEY_K1 && k <= KEY_K9) {
            int i = k - KEY_K1;
            if (i < n) { m->sel = i; if (!(m->cycle && m->cycle(a, m, i, 1)) && m->select) m->select(a, m, i); }
            return true;
        }
        return false;
    }
}

static void menu_render(view_t *v, app_t *a, fb_t *fb)
{
    menu_view_t *m = (menu_view_t *)v;
    layout_t L = app_layout(a);
    int y0 = ui_title(fb, &L, m->title);
    int rows = (fb->height - y0) / L.ch;
    int n = m->count(a, m);
    if (m->sel < m->top) m->top = m->sel;
    if (m->sel >= m->top + rows) m->top = m->sel - rows + 1;
    if (!n) { fb_text(fb, L.x0, y0, "(vazio)", NULL); return; }
    for (int r = 0; r < rows && m->top + r < n; r++) {
        int i = m->top + r, y = y0 + r * L.ch;
        char lab[96], val[32] = "", cells[128];
        m->label(a, m, i, lab, sizeof(lab));
        if (m->value && !L.simple) m->value(a, m, i, val, sizeof(val));
        size_t nl = mt_to_cells(lab, cells, sizeof(cells));
        if (val[0]) {
            char vc[32];
            size_t nv = mt_to_cells(val, vc, sizeof(vc));
            int room = L.cols - (int)nv - 1;
            if (room < 1) room = 1;
            if ((int)nl > room) nl = (size_t)room;
            while ((int)nl < room) cells[nl++] = ' ';
            cells[nl++] = ' ';
            for (size_t k = 0; k < nv && nl < sizeof(cells) - 1; k++) cells[nl++] = vc[k];
            cells[nl] = 0;
        }
        fb_cells(fb, L.x0, y, cells, (size_t)L.cols, L.scale, false);
        if (i == m->sel) fb_invert_rect(fb, 0, y, L.x0 + L.cols * L.cw + 1, L.ch);
    }
    ui_scrollbar(fb, n, m->top, rows, y0, fb->height - y0);
}

static void free_view(view_t *v) { free(v); }

menu_view_t *menu_new(app_state_id_t st, bool prot, const char *title)
{
    menu_view_t *m = calloc(1, sizeof(*m));
    if (!m) return NULL;
    m->base = (view_t){st, prot, menu_key, menu_render, NULL, free_view};
    m->title = title;
    return m;
}

/* ------------------------------ reader ---------------------------- */

static void reader_sync_layout(reader_view_t *r, app_t *a)
{
    layout_t L = app_layout(a);
    if (r->lcols == L.cols && r->lrows == L.rows) return;
    if (!r->lcols) reader_init(&r->rd, &r->doc, (uint16_t)L.cols, (uint16_t)L.rows);
    else reader_relayout(&r->rd, (uint16_t)L.cols, (uint16_t)L.rows);
    r->lcols = L.cols;
    r->lrows = L.rows;
}

static bool reader_key(view_t *v, app_t *a, keycode_t k, bool shift)
{
    reader_view_t *r = (reader_view_t *)v;
    reader_sync_layout(r, a);
    int step = a->set.scroll_step ? a->set.scroll_step : 1;
    switch (k) {
    case KEY_UP: if (shift) reader_page(&r->rd, -1); else reader_move(&r->rd, -step); return true;
    case KEY_DOWN: if (shift) reader_page(&r->rd, 1); else reader_move(&r->rd, step); return true;
    case KEY_LEFT: reader_scroll_h(&r->rd, -1); return true;
    case KEY_RIGHT: reader_scroll_h(&r->rd, 1); return true;
    case KEY_AC: app_pop(a); return true;
    case KEY_STO: if (r->on_fav) r->on_fav(a, r); return true;
    case KEY_EQ: if (r->on_enter) r->on_enter(a, r); return true;
    default: return false;
    }
}

static void reader_draw(view_t *v, app_t *a, fb_t *fb)
{
    reader_view_t *r = (reader_view_t *)v;
    reader_sync_layout(r, a);
    layout_t L = app_layout(a);
    reader_render(&r->rd, fb, L.scale, L.x0);
}

static void reader_dispose(view_t *v)
{
    reader_view_t *r = (reader_view_t *)v;
    reader_free(&r->rd);
    doc_free(&r->doc);
    sec_wipe(r->extra, sizeof(r->extra));
    free(r);
}

reader_view_t *reader_new(app_state_id_t st, bool prot)
{
    reader_view_t *r = calloc(1, sizeof(*r));
    if (!r) return NULL;
    r->base = (view_t){st, prot, reader_key, reader_draw, NULL, reader_dispose};
    doc_init(&r->doc, prot);
    return r;
}

char *reader_plain_text(const reader_view_t *r)
{
    size_t total = 1;
    for (size_t i = 0; i < r->doc.nblocks; i++) total += strlen(r->doc.blocks[i].cells) * 3 + 1;
    char *out = malloc(total), *p = out;
    if (!out) return NULL;
    for (size_t i = 0; i < r->doc.nblocks; i++) {
        size_t n = mt_cells_to_utf8(r->doc.blocks[i].cells, strlen(r->doc.blocks[i].cells), p, total - (size_t)(p - out));
        p += n;
        *p++ = '\n';
    }
    *p = 0;
    return out;
}

/* ------------------------------ form ------------------------------ */

static const char *field_key_text(keycode_t k, bool shift, uint8_t type)
{
    static const char *const D[] = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"};
    if (key_is_digit(k)) return D[k - KEY_K0];
    if (type == FLD_PIN) return NULL;
    switch (k) {
    case KEY_DOT: return (shift && type == FLD_LIST) ? "," : ".";
    case KEY_NEG: case KEY_SUB: return "-";
    case KEY_EXP: return "E";
    case KEY_COMMA: return ",";
    default: break;
    }
    switch (k) {
    case KEY_ADD: return "+";
    case KEY_MUL: return "*";
    case KEY_DIV: return "/";
    case KEY_POW: return "^";
    case KEY_SQR: return "^2";
    case KEY_SQRT: return "sqrt(";
    case KEY_LPAREN: return "(";
    case KEY_RPAREN: return ")";
    case KEY_SIN: return shift ? "asin(" : "sin(";
    case KEY_COS: return shift ? "acos(" : "cos(";
    case KEY_TAN: return shift ? "atan(" : "tan(";
    case KEY_LOG: return "log(";
    case KEY_LN: return "ln(";
    case KEY_PI: return "pi";
    case KEY_PERCENT: return "%";
    case KEY_VARX: return "x";
    default: return NULL;
    }
}

bool form_num(form_view_t *f, int i, double *out)
{
    me_ctx_t ctx = {ME_ANGLE_RAD, NULL, 0};
    if (!f->f[i].text[0]) { snprintf(f->error, sizeof(f->error), "falta %s", f->f[i].label); return false; }
    me_err_t e = me_eval(f->f[i].text, &ctx, out);
    if (e != ME_OK) { snprintf(f->error, sizeof(f->error), "%s: %s", f->f[i].label, me_err_text(e)); return false; }
    return true;
}

static bool form_key(view_t *v, app_t *a, keycode_t k, bool shift)
{
    form_view_t *f = (form_view_t *)v;
    field_t *fl = &f->f[f->sel];
    f->error[0] = 0;
    if (k == KEY_UP) { f->sel = (f->sel - 1 + f->n) % f->n; return true; }
    if (k == KEY_DOWN) { f->sel = (f->sel + 1) % f->n; return true; }
    if (k == KEY_AC) { if (fl->type != FLD_CHOICE && fl->text[0]) { sec_wipe(fl->text, sizeof(fl->text)); } else app_pop(a); return true; }
    if (fl->type == FLD_CHOICE) {
        if (k == KEY_LEFT || k == KEY_RIGHT) { fl->idx = (uint8_t)((fl->idx + (k == KEY_LEFT ? fl->nopts - 1 : 1)) % fl->nopts); return true; }
    } else {
        if (k == KEY_DEL || k == KEY_LEFT) { size_t l = strlen(fl->text); if (l) fl->text[l - 1] = 0; return true; }
        const char *t = field_key_text(k, shift, fl->type);
        if (t) { if (strlen(fl->text) + strlen(t) < sizeof(fl->text)) strcat(fl->text, t); return true; }
    }
    if (k == KEY_EQ || (k == KEY_RIGHT && fl->type != FLD_CHOICE)) {
        if (k == KEY_EQ && f->step_through && f->sel < f->n - 1 && !shift) { f->sel++; return true; }
        if (f->submit) f->submit(a, f);
        return true;
    }
    return false;
}

static void form_render(view_t *v, app_t *a, fb_t *fb)
{
    form_view_t *f = (form_view_t *)v;
    layout_t L = app_layout(a);
    int y0 = ui_title(fb, &L, f->error[0] ? f->error : f->title);
    int rows = (fb->height - y0) / L.ch;
    if (f->sel < f->top) f->top = f->sel;
    if (f->sel >= f->top + rows) f->top = f->sel - rows + 1;
    for (int r = 0; r < rows && f->top + r < f->n; r++) {
        int i = f->top + r, y = y0 + r * L.ch;
        field_t *fl = &f->f[i];
        char line[160], val[100];
        if (fl->type == FLD_CHOICE) snprintf(val, sizeof(val), i == f->sel ? "<%s>" : "%s", fl->opts[fl->idx]);
        else if (fl->type == FLD_PIN) { size_t n = strlen(fl->text); memset(val, '*', n); val[n] = 0; }
        else snprintf(val, sizeof(val), "%s", fl->text);
        if (i == f->sel && fl->type != FLD_CHOICE) strncat(val, "_", sizeof(val) - strlen(val) - 1);
        int lab = (int)strlen(fl->label) + 1, room = L.cols - lab;
        if (room < 1) room = 1;
        const char *shown = val;
        if ((int)strlen(val) > room) shown = val + strlen(val) - room; /* keep the tail (cursor) visible */
        snprintf(line, sizeof(line), "%s:%s", fl->label, shown);
        fb_text(fb, L.x0, y, line, &(fb_text_opts_t){false, L.scale});
        if (i == f->sel) fb_vline(fb, 0, y, L.ch - 1);
    }
    ui_scrollbar(fb, f->n, f->top, rows, y0, fb->height - y0);
}

static void form_dispose(view_t *v)
{
    form_view_t *f = (form_view_t *)v;
    sec_wipe(f->f, sizeof(f->f));
    free(f);
}

form_view_t *form_new(app_state_id_t st, bool prot, const char *title, void (*submit)(app_t *, form_view_t *))
{
    form_view_t *f = calloc(1, sizeof(*f));
    if (!f) return NULL;
    f->base = (view_t){st, prot, form_key, form_render, NULL, form_dispose};
    f->title = title;
    f->submit = submit;
    f->step_through = true;
    return f;
}

field_t *form_add(form_view_t *f, const char *label, uint8_t type)
{
    if (f->n >= 10) return NULL;
    field_t *fl = &f->f[f->n++];
    memset(fl, 0, sizeof(*fl));
    fl->label = label;
    fl->type = type;
    return fl;
}

/* ------------------------------ editor ---------------------------- */

static void editor_submit(app_t *a, editor_view_t *e)
{
    multitap_commit(&e->mt);
    char utf8[TEXTBUF_MAX * 3 + 1];
    mt_cells_to_utf8(e->buf.data, e->buf.len, utf8, sizeof(utf8));
    e->submit(a, e, utf8); /* may pop/dispose e */
    sec_wipe(utf8, sizeof(utf8));
}

static bool editor_key(view_t *v, app_t *a, keycode_t k, bool shift)
{
    editor_view_t *e = (editor_view_t *)v;
    uint32_t now = app_now(a);
    if (k == KEY_MODE) { multitap_commit(&e->mt); e->method = e->method == 'A' ? 'B' : 'A'; return true; }
    if (k == KEY_AC) { app_pop(a); return true; }
    if (k == KEY_DEL) { multitap_commit(&e->mt); textbuf_backspace(&e->buf); return true; }
    if (k == KEY_EQ && (shift || e->method == 'B')) { editor_submit(a, e); return true; }
    if (e->method == 'A') {
        if (shift && (k == KEY_LEFT || k == KEY_RIGHT)) { if (k == KEY_LEFT) textbuf_left(&e->buf); else textbuf_right(&e->buf); return true; }
        if (k == KEY_UP) { vkbd_move(&e->vk, 'u'); return true; }
        if (k == KEY_DOWN) { vkbd_move(&e->vk, 'd'); return true; }
        if (k == KEY_LEFT) { vkbd_move(&e->vk, 'l'); return true; }
        if (k == KEY_RIGHT) { vkbd_move(&e->vk, 'r'); return true; }
        if (k == KEY_ALPHA) { e->vk.shift = !e->vk.shift; return true; }
        if (k == KEY_EQ) {
            char ch = 0;
            switch (vkbd_activate(&e->vk, &ch)) {
            case VK_INSERT: textbuf_insert(&e->buf, ch); break;
            case VK_LEFT: textbuf_left(&e->buf); break;
            case VK_RIGHT: textbuf_right(&e->buf); break;
            case VK_DEL: textbuf_backspace(&e->buf); break;
            case VK_OK: editor_submit(a, e); break;
            default: break;
            }
            return true;
        }
        if (key_is_digit(k)) { textbuf_insert(&e->buf, key_digit(k)); return true; }
    } else {
        if (key_is_digit(k)) { multitap_press(&e->mt, key_digit(k), now); return true; }
        if (k == KEY_ALPHA) { multitap_cycle_case(&e->mt); return true; }
        layout_t L1 = app_layout1(a);
        if (k == KEY_LEFT) { multitap_commit(&e->mt); textbuf_left(&e->buf); return true; }
        if (k == KEY_RIGHT) { multitap_commit(&e->mt); textbuf_right(&e->buf); return true; }
        if (k == KEY_UP) { multitap_commit(&e->mt); for (int i = 0; i < L1.cols; i++) textbuf_left(&e->buf); return true; }
        if (k == KEY_DOWN) { multitap_commit(&e->mt); for (int i = 0; i < L1.cols; i++) textbuf_right(&e->buf); return true; }
    }
    const char *t = field_key_text(k, shift, FLD_EXPR);
    if (t) { multitap_commit(&e->mt); textbuf_insert_str(&e->buf, t); return true; }
    return false;
}

static void editor_tick(view_t *v, app_t *a) { editor_view_t *e = (editor_view_t *)v; multitap_tick(&e->mt, app_now(a)); }

static void editor_render(view_t *v, app_t *a, fb_t *fb)
{
    editor_view_t *e = (editor_view_t *)v;
    layout_t L1 = app_layout1(a);
    char shown[TEXTBUF_MAX + 1];
    if (e->masked) { memset(shown, '*', e->buf.len); shown[e->buf.len] = 0; }
    else memcpy(shown, e->buf.data, (size_t)e->buf.len + 1);
    int cols = L1.cols;
    uint16_t cur = e->buf.cursor;
    if (e->method == 'A') {
        if (cur < e->hoff) e->hoff = cur;
        if (cur > e->hoff + cols - 1) e->hoff = (uint16_t)(cur - cols + 1);
        fb_cells(fb, L1.x0, 0, shown + e->hoff, (size_t)cols, 1, false);
        fb_vline(fb, L1.x0 + (cur - e->hoff) * 6 - 1, 0, 8);
        int vis = 3, first = e->vk.row - vis + 1;
        if (first < 0) first = 0;
        if (first > VK_ROWS - vis) first = VK_ROWS - vis;
        int cellw = (fb->width - 6) / VK_GRID_COLS;
        for (int r = 0; r < vis; r++) {
            uint8_t n;
            int ri = first + r, y = 8 + r * 8, cell = 0;
            const vk_key_t *row = vkbd_row(&e->vk, (uint8_t)ri, &n);
            for (int i = 0; i < n; i++) {
                int x = 2 + cell * cellw, w = row[i].width * cellw;
                char lab[3] = {row[i].label[0], row[i].label[1], 0};
                if (e->vk.shift && lab[0] >= 'a' && lab[0] <= 'z' && !lab[1]) lab[0] = (char)(lab[0] - 32);
                size_t ln = strlen(lab);
                fb_cells(fb, x + (w - (int)ln * 6 + 1) / 2, y, lab, ln, 1, false);
                if (ri == e->vk.row && i == e->vk.col) fb_invert_rect(fb, x, y, w, 8);
                cell += row[i].width;
            }
        }
        fb_tiny(fb, fb->width - 4, 14, (const char[]){(char)(vkbd_page_name(&e->vk)[0] - 32), 0});
        return;
    }
    int rows = 3, line = cur / cols;
    if (line < e->top_line) e->top_line = (uint16_t)line;
    if (line >= e->top_line + rows) e->top_line = (uint16_t)(line - rows + 1);
    for (int r = 0; r < rows; r++) {
        int li = e->top_line + r;
        if (li * cols <= e->buf.len) fb_cells(fb, L1.x0, r * 8, shown + li * cols, (size_t)cols, 1, false);
    }
    if (e->mt.pending && cur > 0) {
        int pl = (cur - 1) / cols - e->top_line;
        fb_invert_rect(fb, L1.x0 + ((cur - 1) % cols) * 6 - 1, pl * 8, 7, 8);
    } else fb_vline(fb, L1.x0 + (cur % cols) * 6 - 1, (line - e->top_line) * 8, 8);
    char st[24];
    snprintf(st, sizeof(st), "B %s %u", multitap_case_name(&e->mt), (unsigned)e->buf.len);
    fb_tiny(fb, 1, 26, st);
}

static void editor_dispose(view_t *v)
{
    editor_view_t *e = (editor_view_t *)v;
    textbuf_wipe(&e->buf);
    sec_wipe(e->ctx, sizeof(e->ctx));
    free(e);
}

editor_view_t *editor_new(app_state_id_t st, bool prot, const char *title, void (*submit)(app_t *, editor_view_t *, const char *))
{
    editor_view_t *e = calloc(1, sizeof(*e));
    if (!e) return NULL;
    e->base = (view_t){st, prot, editor_key, editor_render, editor_tick, editor_dispose};
    e->title = title;
    e->submit = submit;
    textbuf_init(&e->buf, 500);
    multitap_init(&e->mt, &e->buf, 900);
    vkbd_init(&e->vk);
    e->method = 'A';
    return e;
}

/* ------------------------------ busy ------------------------------ */

static bool busy_key(view_t *v, app_t *a, keycode_t k, bool shift)
{
    (void)shift;
    busy_view_t *b = (busy_view_t *)v;
    if (k == KEY_AC) {
        if (b->kind == 0 && a->p.ai) { ai_client_cancel(a->p.ai); if (a->p.wake_worker) a->p.wake_worker(); }
        app_pop(a);
    }
    return true; /* swallow everything else while busy */
}

static void busy_tick(view_t *v, app_t *a)
{
    busy_view_t *b = (busy_view_t *)v;
    if (b->kind == 0) screens_ai_result(a, b);
    else if (a->p.ota && a->p.ota->state(a->p.ota) == OTA_AVAILABLE) a->p.ota->apply(a->p.ota);
}

static const char *phase_name(ai_phase_t p)
{
    switch (p) {
    case AI_PHASE_QUEUED: return "na fila";
    case AI_PHASE_CONNECTING: return "conectando";
    case AI_PHASE_SENDING: return "enviando";
    case AI_PHASE_SENT: case AI_PHASE_WAITING: return "aguardando";
    case AI_PHASE_RECEIVING: return "recebendo";
    default: return "...";
    }
}

static void busy_render(view_t *v, app_t *a, fb_t *fb)
{
    busy_view_t *b = (busy_view_t *)v;
    if (b->kind == 0) {
        fb_text(fb, 2, 0, "Consultando", NULL);
        fb_text(fb, 2, 8, a->p.ai ? phase_name(ai_client_phase(a->p.ai)) : "-", NULL);
        char m[24];
        snprintf(m, sizeof(m), "Modo %s", settings_mode_name(a->ai_mode));
        fb_text(fb, 2, 16, m, NULL);
    } else if (a->p.ota) {
        fb_text(fb, 2, 0, a->p.ota->message(a->p.ota), NULL);
        char m[16];
        snprintf(m, sizeof(m), "%u%%", (unsigned)a->p.ota->progress(a->p.ota));
        fb_text(fb, 2, 8, m, NULL);
    }
    int t = (int)(app_now(a) / 150) % 8;
    static const int P[8][2] = {{0, -4}, {3, -3}, {4, 0}, {3, 3}, {0, 4}, {-3, 3}, {-4, 0}, {-3, -3}};
    for (int i = 0; i < 8; i++) {
        int x = fb->width - 10 + P[i][0], y = 26 + P[i][1];
        if (i == t) fb_fill_rect(fb, x, y - 1, 2, 2, true); else fb_set(fb, x, y, true);
    }
    fb_tiny(fb, 2, 26, "AC CANCELA");
}

busy_view_t *busy_new(int kind, uint32_t gen)
{
    busy_view_t *b = calloc(1, sizeof(*b));
    if (!b) return NULL;
    b->base = (view_t){kind == 0 ? ST_AI_REQUEST : ST_SETTINGS, true, busy_key, busy_render, busy_tick, free_view};
    b->kind = kind;
    b->gen = gen;
    return b;
}
