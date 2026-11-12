/*
 * Text entry building blocks shared by both input methods:
 *  - TextBuffer: editable text with cursor (secure wipe)
 *  - MultiTap  : method B (phone keypad, timed key cycling)
 *  - VirtualKeyboard: method A (QWERTY grid navigated with the D-pad)
 * Both methods edit the same TextBuffer, so switching never loses text.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MT = root.MT || {}; root.MT.TextInput = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class TextBuffer {
    constructor(maxLen = 512) { this.chars = []; this.cursor = 0; this.maxLen = maxLen; }
    get text() { return this.chars.join(''); }
    set text(v) { this.chars = Array.from(String(v)).slice(0, this.maxLen); this.cursor = this.chars.length; }
    insert(s) {
      for (const ch of Array.from(s)) {
        if (this.chars.length >= this.maxLen) return false;
        this.chars.splice(this.cursor, 0, ch); this.cursor++;
      }
      return true;
    }
    replaceBeforeCursor(ch) { if (this.cursor > 0) this.chars[this.cursor - 1] = ch; }
    backspace() { if (this.cursor > 0) { this.chars.splice(this.cursor - 1, 1); this.cursor--; return true; } return false; }
    left() { if (this.cursor > 0) this.cursor--; }
    right() { if (this.cursor < this.chars.length) this.cursor++; }
    home() { this.cursor = 0; }
    end() { this.cursor = this.chars.length; }
    /** Overwrite then drop contents (best effort in JS; real zeroisation is done in C). */
    wipe() { for (let i = 0; i < this.chars.length; i++) this.chars[i] = '\0'; this.chars = []; this.cursor = 0; }
  }

  const MULTITAP_MAP = {
    '1': ['.', ',', '?', '!', "'", '-', '(', ')', ':', ';', '1'],
    '2': ['a', 'b', 'c', '2'], '3': ['d', 'e', 'f', '3'], '4': ['g', 'h', 'i', '4'],
    '5': ['j', 'k', 'l', '5'], '6': ['m', 'n', 'o', '6'], '7': ['p', 'q', 'r', 's', '7'],
    '8': ['t', 'u', 'v', '8'], '9': ['w', 'x', 'y', 'z', '9'], '0': [' ', '0']
  };
  const CASE_MODES = ['abc', 'Abc', 'ABC', '123'];

  class MultiTap {
    constructor(buffer, opts = {}) {
      this.buf = buffer;
      this.timeoutMs = opts.timeoutMs || 900;
      this.caseMode = 'abc';
      this.pending = null; // {key, idx, at}
    }
    setTimeout(ms) { this.timeoutMs = ms; }
    cycleCase() { this.commit(); this.caseMode = CASE_MODES[(CASE_MODES.indexOf(this.caseMode) + 1) % CASE_MODES.length]; }
    applyCase(ch) {
      if (this.caseMode === 'ABC' || this.caseMode === 'Abc') return ch.toUpperCase();
      return ch;
    }
    /** Called with digit keys '0'..'9'. now = ms timestamp. */
    press(digit, now) {
      const opts = MULTITAP_MAP[digit];
      if (!opts) return false;
      if (this.caseMode === '123') { this.commit(); this.buf.insert(digit); return true; }
      if (this.pending && this.pending.key === digit && now - this.pending.at < this.timeoutMs) {
        this.pending.idx = (this.pending.idx + 1) % opts.length;
        this.pending.at = now;
        this.buf.replaceBeforeCursor(this.applyCase(opts[this.pending.idx]));
        return true;
      }
      this.commit();
      if (!this.buf.insert(this.applyCase(opts[0]))) return false;
      this.pending = { key: digit, idx: 0, at: now };
      return true;
    }
    /** Finalise the pending character (timeout, cursor move, other key). */
    commit() {
      if (!this.pending) return;
      this.pending = null;
      if (this.caseMode === 'Abc') this.caseMode = 'abc'; // one-shot capital
    }
    tick(now) { if (this.pending && now - this.pending.at >= this.timeoutMs) this.commit(); }
    pendingChar() { return this.pending ? MULTITAP_MAP[this.pending.key][this.pending.idx] : null; }
  }

  // Virtual keyboard pages: rows of keys {l: label, v: value|action, w: width in cells}
  const K = (l, v = l, w = 1) => ({ l, v, w });
  const BOTTOM = [K('↑', '@shift'), K('#', '@page'), K('_', ' ', 3), K('←', '@left'), K('→', '@right'), K('<', '@del'), K('▸', '@ok')];
  const PAGES = [
    { name: 'abc', rows: [
      'qwertyuiop'.split('').map(c => K(c)),
      'asdfghjkl?'.split('').map(c => K(c)),
      'zxcvbnm,.-'.split('').map(c => K(c)),
      BOTTOM] },
    { name: '123', rows: [
      '1234567890'.split('').map(c => K(c)),
      '+-*/=()^%.'.split('').map(c => K(c)),
      '!?:;,\'"@&$'.split('').map(c => K(c)),
      BOTTOM] },
    { name: 'mat', rows: [
      ['π', '√', '²', '³', '°', '±', '≠', '≤', '≥', '∞'].map(c => K(c)),
      ['θ', 'α', 'λ', 'µ', 'Δ', 'Ω', 'Σ', '<', '>', '|'].map(c => K(c)),
      ['[', ']', '{', '}', '_', '~', '\\', 'x', 'y', 'z'].map(c => K(c)),
      BOTTOM] }
  ];
  const GRID_COLS = 10;

  class VirtualKeyboard {
    constructor() { this.page = 0; this.row = 0; this.col = 0; this.shift = false; }
    get rows() { return PAGES[this.page].rows; }
    get pageName() { return PAGES[this.page].name; }
    /** cell span [start, end) of key index i in row r */
    span(r, i) { let s = 0; for (let k = 0; k < i; k++) s += this.rows[r][k].w; return [s, s + this.rows[r][i].w]; }
    keyAtCell(r, cell) {
      let s = 0;
      for (let i = 0; i < this.rows[r].length; i++) { s += this.rows[r][i].w; if (cell < s) return i; }
      return this.rows[r].length - 1;
    }
    focused() { return this.rows[this.row][this.col]; }
    move(dir) {
      if (dir === 'left') this.col = (this.col - 1 + this.rows[this.row].length) % this.rows[this.row].length;
      else if (dir === 'right') this.col = (this.col + 1) % this.rows[this.row].length;
      else {
        const [s] = this.span(this.row, this.col);
        const n = this.rows.length;
        this.row = dir === 'up' ? (this.row - 1 + n) % n : (this.row + 1) % n;
        this.col = this.keyAtCell(this.row, s);
      }
    }
    /** Activate focused key; returns {insert} or {action}. */
    activate() {
      const k = this.focused();
      if (k.v.startsWith('@') && k.v.length > 1) {
        if (k.v === '@shift') { this.shift = !this.shift; return { action: 'shift' }; }
        if (k.v === '@page') { this.page = (this.page + 1) % PAGES.length; this.shift = false; this.col = Math.min(this.col, this.rows[this.row].length - 1); return { action: 'page' }; }
        return { action: k.v.slice(1) };
      }
      let ch = k.v;
      if (this.shift) { ch = ch.toUpperCase(); this.shift = false; }
      return { insert: ch };
    }
    label(k) { return this.shift && k.l.length === 1 && /[a-z]/.test(k.l) ? k.l.toUpperCase() : k.l; }
  }

  return { TextBuffer, MultiTap, VirtualKeyboard, MULTITAP_MAP, CASE_MODES, PAGES, GRID_COLS };
});
