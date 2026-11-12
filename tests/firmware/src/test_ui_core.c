#include "mt_test.h"
#include "conversions.h"
#include "formulas.h"
#include "framebuffer.h"
#include "keypad.h"
#include "math_renderer.h"
#include "mt_font.h"
#include "text_input.h"

TEST(framebuffer_and_font) {
    uint8_t mem[128 * 4];
    fb_t fb;
    CHECK(fb_init(&fb, 128, 32, mem, sizeof mem));
    fb_reset_dirty(&fb);
    fb_text(&fb, 0, 0, "1", NULL);
    CHECK(fb_is_dirty(&fb) && fb.dx2 <= 6);
    for (int y = 0; y < 7; y++) CHECK(fb_get(&fb, 2, y));
    CHECK_INT(mem[2], 0x7F); /* page layout */
    fb_set(&fb, 500, 500, true); /* clipped */
    char cells[16];
    CHECK_INT(mt_to_cells("\xCF\x80r\xC2\xB2", cells, sizeof cells), 3); /* πr² */
    CHECK_INT((uint8_t)cells[0], 0x80);
    CHECK_INT(mt_to_cells("A\xC3\xA7\xC3\xA3o", cells, sizeof cells), 4); /* Ação -> Acao */
    CHECK_STR(cells, "Acao");
    char back[16];
    mt_cells_to_utf8("\x80" "x", 2, back, sizeof back);
    CHECK_STR(back, "\xCF\x80x");
    uint8_t big[96 * 8]; fb_t f2; CHECK(fb_init(&f2, 96, 64, big, sizeof big)); /* other resolution */
}

typedef struct { int n; } cnt_t;
static void count_emit(const char *s, uint16_t len, void *u) { cnt_t *c = u; (void)s; CHECK(len <= 20); c->n++; }
TEST(wrap_and_breakpoints) {
    const char *t = "Uma explicacao bem longa que precisa quebrar em varias linhas supercalifragilisticexpialidocious fim";
    cnt_t c = {0};
    mr_wrap(t, strlen(t), 20, count_emit, &c);
    CHECK(c.n >= 5);
    const char *e = "x=(-12.5E-3+sqrt(144))/(2*3.14159)";
    size_t n = strlen(e);
    for (size_t i = 1; i < n; i++) if (mr_is_breakpoint(e, n, i)) {
        bool w1 = (e[i-1] >= '0' && e[i-1] <= '9') || e[i-1] == '.' || (e[i-1] >= 'a' && e[i-1] <= 'z') || (e[i-1] >= 'A' && e[i-1] <= 'Z');
        bool w2 = (e[i] >= '0' && e[i] <= '9') || e[i] == '.' || (e[i] >= 'a' && e[i] <= 'z') || (e[i] >= 'A' && e[i] <= 'Z');
        CHECK(!(w1 && w2));
    }
    CHECK(!mr_is_breakpoint(e, n, (size_t)(strstr(e, "E-3") - e) + 1));
}

TEST(reader_scrolling) {
    doc_t d; doc_init(&d, true);
    doc_add(&d, DOC_TITLE, "Titulo", NULL);
    char line[64];
    for (int i = 0; i < 30; i++) { snprintf(line, sizeof line, "Linha numero %d com texto.", i); doc_add(&d, DOC_TEXT, line, NULL); }
    const char *expr = "1+2+3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18+19+20";
    doc_add(&d, DOC_MATH, expr, "Regra");
    reader_t r;
    CHECK(reader_init(&r, &d, 20, 4));
    reader_move(&r, -5); CHECK_INT(r.cursor, 0);
    reader_end(&r); CHECK_INT(r.cursor, r.nlines - 1); CHECK_INT(r.top, r.nlines - 4);
    CHECK(reader_can_scroll_right(&r));
    char seen[128] = {0};
    int guard = 0;
    do { for (size_t i = 0; i < 20 && r.hoff + i < strlen(expr); i++) seen[r.hoff + i] = 1; } while (reader_scroll_h(&r, 1) && guard++ < 50);
    int all = 1; for (size_t i = 0; i < strlen(expr); i++) all &= seen[i];
    CHECK(all); /* every char of the expression reachable */
    CHECK(!reader_can_scroll_right(&r));
    while (reader_scroll_h(&r, -1)) {}
    CHECK_INT(r.hoff, 0);
    reader_row_t row; CHECK(reader_row(&r, 3, &row) && row.focused && row.right_more);
    size_t blk = r.lines[r.cursor].block;
    reader_relayout(&r, 10, 2); CHECK_INT(r.lines[r.cursor].block, blk);
    uint8_t mem[512]; fb_t fb; fb_init(&fb, 128, 32, mem, sizeof mem); reader_render(&r, &fb, 1, 3);
    reader_free(&r); doc_free(&d);
}

TEST(memory_limit) {
    doc_t d; doc_init(&d, false);
    static char big[1001]; memset(big, 'y', 1000);
    int added = 0; while (doc_add(&d, DOC_TEXT, big, NULL)) added++;
    CHECK(d.truncated); CHECK(added * 1000 <= MR_MAX_DOC_BYTES);
    reader_t r; reader_init(&r, &d, 20, 4);
    CHECK(r.nlines <= MR_MAX_LINES);
    CHECK(strncmp(r.lines[r.nlines - 1].text, "[conteudo truncado", 18) == 0);
    reader_free(&r); doc_free(&d);
}

TEST(multitap) {
    textbuf_t b; textbuf_init(&b, 100);
    multitap_t m; multitap_init(&m, &b, 800);
    multitap_press(&m, '4', 0); multitap_press(&m, '4', 100); CHECK_STR(b.data, "h");
    multitap_press(&m, '3', 200); CHECK_STR(b.data, "hd");
    multitap_press(&m, '3', 1500); CHECK_STR(b.data, "hdd");
    for (int i = 0; i < 5; i++) multitap_press(&m, '7', (uint32_t)(2000 + i * 100));
    CHECK_STR(b.data, "hdd7");
    multitap_press(&m, '7', 2500); CHECK_STR(b.data, "hddp");
    multitap_press(&m, '0', 4000); CHECK_STR(b.data, "hddp ");
    multitap_cycle_case(&m); multitap_press(&m, '2', 5000); multitap_commit(&m); CHECK_STR(b.data, "hddp A"); CHECK_INT(m.mode, MT_CASE_LOWER);
    m.mode = MT_CASE_NUM; multitap_press(&m, '5', 6000); CHECK_STR(b.data, "hddp A5");
    textbuf_left(&b); textbuf_left(&b); textbuf_backspace(&b); CHECK_STR(b.data, "hddpA5");
    textbuf_wipe(&b); CHECK_INT(b.len, 0);
}

TEST(virtual_keyboard) {
    vkbd_t k; vkbd_init(&k);
    char ch = 0;
    vkbd_move(&k, 'r'); vkbd_move(&k, 'r'); CHECK_INT(vkbd_activate(&k, &ch), VK_INSERT); CHECK_INT(ch, 'e');
    k.shift = true; CHECK_INT(vkbd_activate(&k, &ch), VK_INSERT); CHECK_INT(ch, 'E'); CHECK(!k.shift);
    k.row = 3; k.col = 1; CHECK_INT(vkbd_activate(&k, &ch), VK_PAGE); CHECK_STR(vkbd_page_name(&k), "123");
    k.row = 0; k.col = 0; vkbd_activate(&k, &ch); CHECK_INT(ch, '1');
    k.row = 3; k.col = 1; vkbd_activate(&k, &ch); k.row = 0; k.col = 0; vkbd_activate(&k, &ch); CHECK_INT((uint8_t)ch, 0x80); /* pi */
    k.row = 3; k.col = 6; CHECK_INT(vkbd_activate(&k, &ch), VK_OK);
    k.page = 0; k.row = 2; k.col = 3; vkbd_move(&k, 'd'); CHECK_INT(vkbd_activate(&k, &ch), VK_INSERT); CHECK_INT(ch, ' ');
}

TEST(keypad_core) {
    static const keycode_t map[3] = {KEY_K1, KEY_UP, KEY_ON};
    keypad_t k; keypad_cfg_t cfg = {20, 400, 100};
    keypad_init(&k, map, 3, &cfg);
    uint8_t p[3] = {1, 0, 0};
    keypad_scan_update(&k, p, 0); keypad_scan_update(&k, p, 10);
    key_event_t ev; CHECK(!keypad_pop(&k, &ev));       /* still bouncing */
    keypad_scan_update(&k, p, 25); CHECK(keypad_pop(&k, &ev) && ev.key == KEY_K1);
    keypad_scan_update(&k, p, 1000); CHECK(!keypad_pop(&k, &ev)); /* digits do not repeat */
    uint8_t up[3] = {0, 1, 0};
    for (uint32_t t = 1100; t <= 1700; t += 10) keypad_scan_update(&k, up, t);
    int n = 0; while (keypad_pop(&k, &ev)) { CHECK_INT(ev.key, KEY_UP); n++; }
    CHECK(n >= 3);
    for (int i = 0; i < 40; i++) keypad_push(&k, KEY_K2, 0); /* overflow */
    CHECK(keypad_push(&k, KEY_ON, 0)); /* privacy key never dropped */
    keycode_t last = KEY_NONE; while (keypad_pop(&k, &ev)) last = ev.key;
    CHECK_INT(last, KEY_ON);
    CHECK_STR(key_name(KEY_K7), "7"); CHECK_INT(key_from_name("SHIFT"), KEY_SHIFT);
    bool sh; CHECK_INT(keypad_console_map('!', &sh), KEY_RPAREN); CHECK(sh);
}

TEST(conversions_and_formulas) {
    double v;
    CHECK_INT(conv_convert("length", "in", "cm", 1, &v), CONV_OK); CHECK_NEAR(v, 2.54, 1e-12);
    CHECK_INT(conv_convert("temperature", "C", "F", 100, &v), CONV_OK); CHECK_NEAR(v, 212, 1e-12);
    CHECK_INT(conv_convert("temperature", "K", "C", -1, &v), CONV_ERR_ABS_ZERO);
    CHECK_INT(conv_convert("pressure", "atm", "Pa", 1, &v), CONV_OK); CHECK_NEAR(v, 101325, 1e-12);
    CHECK_INT(conv_convert("length", "m", "kg", 1, &v), CONV_ERR_UNIT);
    CHECK_INT(conv_category_count, 10);
    CHECK(formula_count >= 40);
    for (size_t i = 0; i < formula_count; i++) {
        const formula_t *f = &formula_list[i];
        double vals[8], r = NAN;
        for (size_t k = 0; k < f->nvars; k++) vals[k] = f->vars[k].example;
        CHECK_INT(formula_apply(f, vals, &r), ME_OK);
        CHECK_NEAR(r, f->example_out, 1e-9);
    }
    const formula_t *res[64];
    CHECK(formula_search("PITAGORAS", res, 64) >= 1);
    CHECK(formula_search("\xC3\xA1rea", res, 64) >= 3); /* "área" */
}

TEST_MAIN(RUN(framebuffer_and_font); RUN(wrap_and_breakpoints); RUN(reader_scrolling); RUN(memory_limit); RUN(multitap);
          RUN(virtual_keyboard); RUN(keypad_core); RUN(conversions_and_formulas))
