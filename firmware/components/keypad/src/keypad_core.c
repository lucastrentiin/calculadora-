#include <string.h>

#include "keypad.h"

#define KEY_STR(n) #n,
static const char *const NAMES[] = {KEY_LIST(KEY_STR)};
#undef KEY_STR

const char *key_name(keycode_t k)
{
    if (k >= KEY_COUNT) return "?";
    const char *n = NAMES[k];
    return (n[0] == 'K' && n[1] >= '0' && n[1] <= '9') ? n + 1 : n; /* K7 -> "7" */
}

keycode_t key_from_name(const char *name)
{
    for (int i = 0; i < KEY_COUNT; i++) if (strcmp(key_name((keycode_t)i), name) == 0) return (keycode_t)i;
    return KEY_NONE;
}

bool key_repeatable(keycode_t k) { return k == KEY_UP || k == KEY_DOWN || k == KEY_LEFT || k == KEY_RIGHT || k == KEY_DEL; }

void keypad_init(keypad_t *k, const keycode_t *keymap, uint8_t npos, const keypad_cfg_t *cfg)
{
    memset(k, 0, sizeof(*k));
    k->keymap = keymap;
    k->npos = npos > KEYPAD_MAX_KEYS ? KEYPAD_MAX_KEYS : npos;
    if (cfg) k->cfg = *cfg;
    else { k->cfg.debounce_ms = 20; k->cfg.repeat_delay_ms = 450; k->cfg.repeat_rate_ms = 140; }
}

void keypad_set_repeat(keypad_t *k, uint16_t d, uint16_t r) { k->cfg.repeat_delay_ms = d; k->cfg.repeat_rate_ms = r; }

static bool push(keypad_t *k, keycode_t key, bool rep, uint32_t now)
{
    uint8_t next = (uint8_t)((k->head + 1) % KEYPAD_QUEUE);
    if (next == k->tail) {
        /* queue full: the privacy key must never be lost, drop the oldest event instead */
        if (key != KEY_ON) { k->dropped++; return false; }
        k->tail = (uint8_t)((k->tail + 1) % KEYPAD_QUEUE);
        k->dropped++;
    }
    k->q[k->head] = (key_event_t){key, rep, now};
    k->head = next;
    return true;
}

bool keypad_push(keypad_t *k, keycode_t key, uint32_t now) { return push(k, key, false, now); }

bool keypad_pop(keypad_t *k, key_event_t *ev)
{
    if (k->tail == k->head) return false;
    *ev = k->q[k->tail];
    k->tail = (uint8_t)((k->tail + 1) % KEYPAD_QUEUE);
    return true;
}

void keypad_scan_update(keypad_t *k, const uint8_t *pressed, uint32_t now)
{
    for (uint8_t i = 0; i < k->npos; i++) {
        uint8_t p = pressed[i] ? 1 : 0;
        if (p != k->raw[i]) { k->raw[i] = p; k->changed_at[i] = now; }
        keycode_t code = k->keymap ? k->keymap[i] : KEY_NONE;
        if (k->raw[i] != k->stable[i] && now - k->changed_at[i] >= k->cfg.debounce_ms) {
            k->stable[i] = k->raw[i];
            if (k->stable[i] && code != KEY_NONE) {
                push(k, code, false, now);
                k->pressed_at[i] = now;
                k->last_repeat[i] = now;
            }
        } else if (k->stable[i] && code != KEY_NONE && key_repeatable(code) && k->cfg.repeat_delay_ms) {
            if (now - k->pressed_at[i] >= k->cfg.repeat_delay_ms && now - k->last_repeat[i] >= k->cfg.repeat_rate_ms) {
                push(k, code, true, now);
                k->last_repeat[i] = now;
            }
        }
    }
}

keycode_t keypad_console_map(int ch, bool *shift)
{
    *shift = false;
    switch (ch) {
    case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': return (keycode_t)(KEY_K0 + (ch - '0'));
    case '.': return KEY_DOT;
    case ',': return KEY_COMMA;
    case '+': return KEY_ADD;
    case '-': return KEY_SUB;
    case '*': return KEY_MUL;
    case '/': return KEY_DIV;
    case '^': return KEY_POW;
    case '(': return KEY_LPAREN;
    case ')': return KEY_RPAREN;
    case '%': return KEY_PERCENT;
    case '!': *shift = true; return KEY_RPAREN;
    case '=': case '\r': case '\n': return KEY_EQ;
    case 8: case 127: return KEY_DEL;
    case 27: return KEY_AC;
    case 's': return KEY_SIN;
    case 'c': return KEY_COS;
    case 't': return KEY_TAN;
    case 'g': return KEY_LOG;
    case 'l': return KEY_LN;
    case 'p': return KEY_PI;
    case 'r': return KEY_SQRT;
    case 'q': return KEY_SQR;
    case 'e': return KEY_EXP;
    case 'x': return KEY_VARX;
    case 'a': return KEY_ANS;
    case 'n': return KEY_NEG;
    case 'i': return KEY_INV;
    case 'f': return KEY_FRAC;
    case 'm': return KEY_MODE;
    case 'u': case 'k': return KEY_UP;
    case 'd': case 'j': return KEY_DOWN;
    case 'h': return KEY_LEFT;
    case 'o': return KEY_RIGHT;   /* vim-like h/j/k/o since 'l' is ln */
    case 'S': return KEY_SHIFT;
    case 'A': return KEY_ALPHA;
    case 'M': return KEY_MENU;
    case 'O': return KEY_ON;
    case 'P': return KEY_STO;
    case 'R': return KEY_RCL;
    }
    return KEY_NONE;
}
