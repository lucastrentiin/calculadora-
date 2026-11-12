/*
 * Text layout for small displays:
 *  - word wrap for prose (never drops content; long words are hard-split)
 *  - math lines are NOT wrapped: they are scrolled horizontally, and the
 *    horizontal offset only snaps to token boundaries so a number, function
 *    name or operator is never cut in an ambiguous way
 *  - ReaderModel: 2-D viewport (vertical lines + horizontal math offset)
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./font.js'));
  else { root.MT = root.MT || {}; root.MT.TextLayout = factory(root.MT.Font); }
})(typeof self !== 'undefined' ? self : this, function (Font) {
  'use strict';

  const MAX_LINES = 4000;      // memory guard for the laid out document
  const MAX_DOC_CHARS = 64000; // memory guard for stored content

  function wrapText(text, cols) {
    if (cols < 1) cols = 1;
    const out = [];
    const paragraphs = String(text).split('\n');
    for (const para of paragraphs) {
      const words = para.split(/ +/).filter(w => w.length);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (let w of words) {
        while (w.length > cols) { // hard split very long tokens
          if (line) { out.push(line); line = ''; }
          out.push(w.slice(0, cols - 1) + '-');
          w = w.slice(cols - 1);
        }
        if (!line) line = w;
        else if (line.length + 1 + w.length <= cols) line += ' ' + w;
        else { out.push(line); line = w; }
      }
      if (line) out.push(line);
    }
    return out;
  }

  /** Indices where a math line may start being displayed (token starts). */
  function mathBreakpoints(text) {
    const s = Font.normalize(text);
    const bps = [0];
    const isWord = (c) => /[A-Za-z0-9_.]/.test(c);
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      // don't break inside numbers/identifiers, nor inside scientific notation like 1E-5
      if (isWord(a) && isWord(b)) continue;
      if (b === '-' && /E/.test(a) && /[0-9]/.test(s[i - 2] || '')) continue;
      if ((a === '-' || a === '+') && /E/.test(s[i - 2] || '') && /[0-9]/.test(s[i - 3] || '')) continue;
      bps.push(i);
    }
    return bps;
  }

  /**
   * Lay a document out. Blocks: {kind:'title'|'text'|'math'|'label'|'sep', text, tag}
   * Returns lines: {text, kind, math:boolean, block:index}
   */
  function layoutDoc(blocks, cols) {
    const lines = [];
    let total = 0, truncated = false;
    blocks.forEach((b, bi) => {
      if (truncated) return;
      const text = Font.normalize(b.text == null ? '' : b.text);
      total += text.length;
      if (total > MAX_DOC_CHARS) { truncated = true; return; }
      if (b.kind === 'sep') { lines.push({ text: '', kind: 'sep', math: false, block: bi }); return; }
      if (b.kind === 'math') {
        if (b.rule) wrapText(b.rule, cols).forEach(t => lines.push({ text: t, kind: 'rule', math: false, block: bi }));
        lines.push({ text, kind: 'math', math: true, block: bi, bps: mathBreakpoints(text) });
        return;
      }
      wrapText(text, cols).forEach(t => lines.push({ text: t, kind: b.kind || 'text', math: false, block: bi }));
    });
    if (lines.length > MAX_LINES) { lines.length = MAX_LINES; truncated = true; }
    if (truncated) lines.push({ text: '[conteudo truncado: limite de memoria]', kind: 'text', math: false, block: -1 });
    return lines;
  }

  class ReaderModel {
    constructor(blocks, cols, rows) {
      this.blocks = blocks;
      this.cols = cols;
      this.rows = rows;
      this.lines = layoutDoc(blocks, cols);
      this.cursor = 0;  // focused line
      this.top = 0;     // first visible line
      this.hoff = 0;    // horizontal char offset of the focused math line
    }
    relayout(cols, rows) {
      const block = this.lines[this.cursor] ? this.lines[this.cursor].block : 0;
      this.cols = cols; this.rows = rows;
      this.lines = layoutDoc(this.blocks, cols);
      const idx = this.lines.findIndex(l => l.block === block);
      this.cursor = Math.max(0, idx);
      this.hoff = 0;
      this.ensureVisible();
    }
    ensureVisible() {
      if (this.cursor < this.top) this.top = this.cursor;
      if (this.cursor >= this.top + this.rows) this.top = this.cursor - this.rows + 1;
      const maxTop = Math.max(0, this.lines.length - this.rows);
      this.top = Math.min(Math.max(0, this.top), maxTop);
    }
    move(delta) {
      const n = this.lines.length;
      const c = Math.min(Math.max(0, this.cursor + delta), Math.max(0, n - 1));
      if (c !== this.cursor) { this.cursor = c; this.hoff = 0; }
      this.ensureVisible();
      return c;
    }
    page(dir) { return this.move(dir * Math.max(1, this.rows - 1)); }
    home() { this.cursor = 0; this.top = 0; this.hoff = 0; }
    end() { this.move(this.lines.length); }
    current() { return this.lines[this.cursor]; }
    canScrollRight() {
      const l = this.current();
      return !!(l && l.math && l.text.length - this.hoff > this.cols);
    }
    canScrollLeft() { return this.hoff > 0; }
    scrollH(dir) {
      const l = this.current();
      if (!l || !l.math) return false;
      if (dir > 0) {
        if (!this.canScrollRight()) return false;
        const limit = this.hoff + Math.max(1, this.cols - 4);
        let next = this.hoff;
        for (const b of l.bps) if (b > this.hoff && b <= limit) next = b;
        if (next === this.hoff) next = l.bps.find(b => b > this.hoff) || this.hoff + 1; // token wider than window
        this.hoff = next;
        return true;
      }
      if (this.hoff === 0) return false;
      const limit = this.hoff - Math.max(1, this.cols - 4);
      let prev = 0;
      for (const b of l.bps) if (b < this.hoff && b >= limit) { prev = b; break; }
      this.hoff = prev;
      return true;
    }
    /** Visible slice: [{text, kind, focused, leftMore, rightMore}] */
    visible() {
      const out = [];
      for (let i = this.top; i < Math.min(this.lines.length, this.top + this.rows); i++) {
        const l = this.lines[i];
        const off = (i === this.cursor && l.math) ? this.hoff : 0;
        const text = l.text.slice(off, off + this.cols);
        out.push({ text, kind: l.kind, focused: i === this.cursor, leftMore: off > 0, rightMore: l.math && l.text.length - off > this.cols, index: i });
      }
      return out;
    }
    position() { return { line: this.cursor + 1, total: this.lines.length, top: this.top }; }
  }

  return { wrapText, mathBreakpoints, layoutDoc, ReaderModel, MAX_LINES, MAX_DOC_CHARS };
});
