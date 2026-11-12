/*
 * Text entry building blocks (C counterpart of simulator/js/core/textInput.js):
 *   textbuf_t  editable UTF-8-free cell buffer with cursor and secure wipe
 *   multitap_t method B: phone keypad cycling with timeout
 *   vkbd_t     method A: QWERTY grid navigated with the D-pad
 * Both methods edit the same textbuf_t, so switching never loses text.
 * The buffer stores *cell strings* (see mt_font.h), one byte per character.
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TEXTBUF_MAX 512

typedef struct {
    char data[TEXTBUF_MAX + 1];
    uint16_t len, cursor, max;
} textbuf_t;

void textbuf_init(textbuf_t *b, uint16_t max);
bool textbuf_insert(textbuf_t *b, char c);
bool textbuf_insert_str(textbuf_t *b, const char *s);
void textbuf_replace_before_cursor(textbuf_t *b, char c);
bool textbuf_backspace(textbuf_t *b);
void textbuf_left(textbuf_t *b);
void textbuf_right(textbuf_t *b);
void textbuf_wipe(textbuf_t *b);

typedef enum { MT_CASE_LOWER = 0, MT_CASE_FIRST, MT_CASE_UPPER, MT_CASE_NUM } mt_case_t;

typedef struct {
    textbuf_t *buf;
    uint32_t timeout_ms;
    mt_case_t mode;
    bool pending;
    char key;
    uint8_t idx;
    uint32_t at;
} multitap_t;

void multitap_init(multitap_t *m, textbuf_t *buf, uint32_t timeout_ms);
/** digit = '0'..'9'; now = ms timestamp */
bool multitap_press(multitap_t *m, char digit, uint32_t now);
void multitap_commit(multitap_t *m);
void multitap_tick(multitap_t *m, uint32_t now);
void multitap_cycle_case(multitap_t *m);
const char *multitap_case_name(const multitap_t *m);

typedef enum { VK_INSERT, VK_SHIFT, VK_PAGE, VK_LEFT, VK_RIGHT, VK_DEL, VK_OK } vk_action_t;

typedef struct {
    uint8_t page, row, col;
    bool shift;
} vkbd_t;

typedef struct { const char *label; char value; uint8_t width; vk_action_t action; } vk_key_t;

#define VK_ROWS 4
#define VK_GRID_COLS 10

void vkbd_init(vkbd_t *k);
void vkbd_move(vkbd_t *k, char dir); /* 'u','d','l','r' */
/** Activate the focused key; for VK_INSERT *ch receives the character (cell byte). */
vk_action_t vkbd_activate(vkbd_t *k, char *ch);
const vk_key_t *vkbd_row(const vkbd_t *k, uint8_t row, uint8_t *count);
const char *vkbd_page_name(const vkbd_t *k);

#ifdef __cplusplus
}
#endif
