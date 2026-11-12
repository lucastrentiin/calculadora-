/*
 * Generic UI views for the monochrome LCD. Each view has:
 *   state      : AppState it belongs to (drives the state machine)
 *   protected  : true when it shows protected content (privacy lock target)
 *   onKey(ev, app) -> boolean handled
 *   render(fb, app)
 *   dispose()  : wipe sensitive data (called on pop and on privacy lock)
 * Navigation rules (consistent everywhere):
 *   menus/keyboards : arrows move focus, = / RIGHT selects, AC / LEFT goes back
 *   reading pages   : UP/DOWN scroll lines (SHIFT = page), LEFT/RIGHT scroll the
 *                     focused math line horizontally, AC goes back
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./font.js'), require('./framebuffer.js'), require('./textLayout.js'), require('./textInput.js'), require('./mathEngine.js'));
  } else { root.MT = root.MT || {}; root.MT.Views = factory(root.MT.Font, root.MT.Framebuffer, root.MT.TextLayout, root.MT.TextInput, root.MT.MathEngine); }
})(typeof self !== 'undefined' ? self : this, function (Font, Framebuffer, TL, TI, M) {
  'use strict';

  const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

  /* ------------------------------ drawing helpers ------------------- */

  function scrollbar(fb, total, top, visible, y0, h) {
    if (total <= visible) return;
    const x = fb.width - 2;
    fb.vline(x + 1, y0, h, 1);
    const bh = Math.max(2, Math.round(h * visible / total));
    const by = y0 + Math.round((h - bh) * top / Math.max(1, total - visible));
    fb.fillRect(x, by, 1, bh, 1);
  }
  function arrowRight(fb, x, y) { fb.vline(x, y, 5); fb.vline(x + 1, y + 1, 3); fb.setPixel(x + 2, y + 2); }
  function arrowLeft(fb, x, y) { fb.setPixel(x, y + 2); fb.vline(x + 1, y + 1, 3); fb.vline(x + 2, y, 5); }
  function arrowUp(fb, x, y) { fb.setPixel(x + 2, y); fb.hline(x + 1, y + 1, 3); fb.hline(x, y + 2, 5); }
  function arrowDown(fb, x, y) { fb.hline(x, y, 5); fb.hline(x + 1, y + 1, 3); fb.setPixel(x + 2, y + 2); }

  /** Title in tiny font (only when the layout has room for it). */
  function drawTitle(fb, L, title) {
    if (!L.titleRow) return 0;
    const t = Font.normalize(title).toUpperCase().slice(0, Math.floor((fb.width - 6) / 4));
    fb.drawTiny(1, 0, t);
    return 7;
  }

  function fieldText(text, cols, cursorAtEnd = true) {
    if (text.length <= cols) return text;
    return cursorAtEnd ? '…' + text.slice(text.length - cols + 1) : text.slice(0, cols - 1) + '…';
  }

  /* ------------------------------ MenuView -------------------------- */

  class MenuView {
    constructor(state, title, items, opts = {}) {
      this.state = state; this.title = title; this.itemsSrc = items;
      this.sel = 0; this.top = 0; this.protected = !!opts.protected; this.opts = opts;
    }
    items(app) { return typeof this.itemsSrc === 'function' ? this.itemsSrc(app) : this.itemsSrc; }
    back(app) { if (this.opts.onBack) this.opts.onBack(app); else app.pop(); }
    onKey(ev, app) {
      const items = this.items(app);
      const n = items.length;
      const it = items[this.sel];
      switch (ev.key) {
        case 'UP': if (n) this.sel = (this.sel - 1 + n) % n; return true;
        case 'DOWN': if (n) this.sel = (this.sel + 1) % n; return true;
        case 'LEFT':
          if (it && it.cycle) { it.cycle(app, -1); return true; }
          this.back(app); return true;
        case 'RIGHT':
          if (it && it.cycle) { it.cycle(app, 1); return true; }
          if (it && it.select) it.select(app); return true;
        case 'EQ':
          if (it && it.cycle && !it.select) { it.cycle(app, 1); return true; }
          if (it && it.select) it.select(app); return true;
        case 'DEL':
          if (it && it.del) { it.del(app); this.sel = Math.min(this.sel, Math.max(0, this.items(app).length - 1)); }
          return true;
        case 'STO':
          if (it && it.fav) it.fav(app); return true;
        case 'AC': this.back(app); return true;
        default:
          if (DIGITS.includes(ev.key) && ev.key !== '0') {
            const i = Number(ev.key) - 1;
            if (i < n) { this.sel = i; const t = items[i]; if (t.select) t.select(app); else if (t.cycle) t.cycle(app, 1); }
            return true;
          }
      }
      return false;
    }
    render(fb, app) {
      const L = app.layout();
      const items = this.items(app);
      const y0 = drawTitle(fb, L, this.title);
      const rows = Math.floor((fb.height - y0) / L.ch);
      if (this.sel < this.top) this.top = this.sel;
      if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
      if (!items.length) { fb.drawText(L.x0, y0, '(vazio)', { scale: L.scale }); return; }
      for (let r = 0; r < rows; r++) {
        const i = this.top + r;
        if (i >= items.length) break;
        const it = items[i];
        const y = y0 + r * L.ch;
        const label = typeof it.label === 'function' ? it.label(app) : it.label;
        const value = it.value && !L.simple ? String(it.value(app)) : '';
        const cols = L.cols;
        let line = Font.normalize(label);
        if (value) {
          const v = Font.normalize(value);
          const room = cols - v.length - 1;
          line = (line.length > room ? line.slice(0, Math.max(1, room - 1)) + '…' : line.padEnd(room, ' ')) + ' ' + v;
        }
        line = line.slice(0, cols);
        fb.drawText(L.x0, y, line, { scale: L.scale });
        if (i === this.sel) fb.invertRect(0, y, L.x0 + cols * L.cw + 1, L.ch);
      }
      scrollbar(fb, items.length, this.top, rows, y0, fb.height - y0);
    }
  }

  /* ------------------------------ ReaderView ------------------------ */

  class ReaderView {
    constructor(state, title, blocks, opts = {}) {
      this.state = state; this.title = title; this.blocks = blocks; this.opts = opts;
      this.protected = !!opts.protected; this.model = null; this.layoutKey = '';
    }
    ensureModel(app) {
      const L = app.layout();
      const key = L.cols + 'x' + L.rows;
      if (!this.model) this.model = new TL.ReaderModel(this.blocks, L.cols, L.rows);
      else if (key !== this.layoutKey) this.model.relayout(L.cols, L.rows);
      this.layoutKey = key;
      return this.model;
    }
    onKey(ev, app) {
      const m = this.ensureModel(app);
      const step = app.settings.scrollStep || 1;
      switch (ev.key) {
        case 'UP': ev.shift ? m.page(-1) : m.move(-step); return true;
        case 'DOWN': ev.shift ? m.page(1) : m.move(step); return true;
        case 'LEFT': m.scrollH(-1); return true;
        case 'RIGHT': m.scrollH(1); return true;
        case 'AC': app.pop(); return true;
        case 'STO': if (this.opts.onFavorite) this.opts.onFavorite(app, this); return true;
        case 'EQ': if (this.opts.onEnter) { this.opts.onEnter(app, this); return true; } return true;
        case 'DEL': if (this.opts.onDelete) { this.opts.onDelete(app, this); return true; } return false;
        default: return false;
      }
    }
    render(fb, app) {
      const L = app.layout();
      const m = this.ensureModel(app);
      const vis = m.visible();
      vis.forEach((l, r) => {
        const y = r * L.ch;
        fb.drawText(L.x0, y, l.text, { scale: L.scale });
        if (l.kind === 'title') fb.hline(L.x0, y + L.ch - 1, Math.max(L.cw, Font.normalize(l.text).length * L.cw), 1);
        if (l.kind === 'rule') { for (let x = L.x0; x < L.x0 + l.text.length * L.cw; x += 2) fb.setPixel(x, y + L.ch - 1); }
        if (l.focused) {
          if (l.leftMore) arrowLeft(fb, 0, y + 1); else fb.vline(0, y, L.ch - 1, 1);
        }
        if (l.rightMore) arrowRight(fb, fb.width - 5, y + 1);
      });
      scrollbar(fb, m.lines.length, m.top, L.rows, 0, fb.height);
    }
    dispose() { if (this.protected) { this.blocks = []; this.model = null; } }
  }

  /* ------------------------------ FormView -------------------------- */
  // field: {key, label, type:'num'|'expr'|'list'|'choice'|'pin', options:[{label,value}], text, idx}

  class FormView {
    constructor(state, title, fields, onSubmit, opts = {}) {
      this.state = state; this.title = title; this.onSubmit = onSubmit; this.opts = opts;
      this.protected = !!opts.protected;
      this.fields = fields.map(f => Object.assign({ text: f.text != null ? String(f.text) : '', idx: f.idx || 0 }, f));
      this.sel = 0; this.top = 0; this.error = '';
    }
    values() {
      const out = {};
      for (const f of this.fields) {
        if (f.type === 'choice') out[f.key] = f.options[f.idx].value;
        else if (f.type === 'num') {
          if (f.text.trim() === '') throw new M.MathError(M.ERR.ARGS, 'falta ' + f.label);
          out[f.key] = M.evaluate(f.text, { angle: 'rad' }); // accepts 1/3, 2pi, sqrt(2)
        } else if (f.type === 'list') {
          const parts = f.text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
          out[f.key] = parts.map(p => M.evaluate(p));
        } else out[f.key] = f.text;
      }
      return out;
    }
    insert(f, s) { if (f.text.length < 200) f.text += s; }
    onKey(ev, app) {
      const f = this.fields[this.sel];
      this.error = '';
      const k = ev.key;
      if (k === 'UP') { this.sel = (this.sel - 1 + this.fields.length) % this.fields.length; return true; }
      if (k === 'DOWN') { this.sel = (this.sel + 1) % this.fields.length; return true; }
      if (k === 'AC') { if (f.type !== 'choice' && f.text) f.text = ''; else app.pop(); return true; }
      if (f.type === 'choice') {
        if (k === 'LEFT' || k === 'RIGHT') { f.idx = (f.idx + (k === 'LEFT' ? -1 : 1) + f.options.length) % f.options.length; if (f.onChange) f.onChange(this, f); return true; }
      } else {
        if (k === 'DEL' || k === 'LEFT') { f.text = f.text.slice(0, -1); return true; }
        if (k === 'CHAR' && ev.ch && (f.type === 'expr' || /[0-9.,\-+*/^()Ee]/.test(ev.ch))) { this.insert(f, ev.ch); return true; }
        const ins = keyText(ev, f.type);
        if (ins != null) { if (f.type === 'pin' && !/^[0-9]$/.test(ins)) return true; this.insert(f, ins); return true; }
      }
      if (k === 'EQ' || (k === 'RIGHT' && f.type !== 'choice')) {
        if (k === 'EQ' && this.sel < this.fields.length - 1 && !ev.shift && this.opts.stepThrough !== false) { this.sel++; return true; }
        try { this.onSubmit(this.values(), app, this); }
        catch (e) { this.error = e && e.message ? e.message : 'Erro'; }
        return true;
      }
      return false;
    }
    render(fb, app) {
      const L = app.layout();
      const y0 = drawTitle(fb, L, this.error ? this.error : this.title);
      const rows = Math.floor((fb.height - y0) / L.ch);
      if (this.sel < this.top) this.top = this.sel;
      if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
      for (let r = 0; r < rows; r++) {
        const i = this.top + r;
        if (i >= this.fields.length) break;
        const f = this.fields[i];
        const y = y0 + r * L.ch;
        const lab = Font.normalize(f.label) + ':';
        let val;
        if (f.type === 'choice') val = (i === this.sel ? '<' : '') + f.options[f.idx].label + (i === this.sel ? '>' : '');
        else if (f.type === 'pin') val = '*'.repeat(f.text.length);
        else val = M.pretty(f.text);
        if (i === this.sel && f.type !== 'choice') val += '_';
        const room = Math.max(1, L.cols - lab.length);
        fb.drawText(L.x0, y, lab + fieldText(Font.normalize(val), room), { scale: L.scale });
        if (i === this.sel) fb.vline(0, y, L.ch - 1, 1);
      }
      scrollbar(fb, this.fields.length, this.top, rows, y0, fb.height - y0);
    }
    dispose() { if (this.protected) this.fields.forEach(f => { f.text = ''; }); }
  }

  /** Text inserted by a calculator key in numeric/expression contexts. */
  function keyText(ev, type) {
    const k = ev.key;
    if (DIGITS.includes(k)) return k;
    const num = { DOT: '.', NEG: '-', SUB: '-', EXP: 'E' };
    if (num[k]) return num[k];
    if (type === 'list' && (k === 'COMMA' || (k === 'DOT' && ev.shift))) return ',';
    if (type !== 'expr' && type !== 'num' && type !== 'list') return null;
    const sh = ev.shift;
    const map = {
      ADD: '+', MUL: '*', DIV: '/', POW: sh ? 'root(' : '^', SQR: '^2', SQRT: sh ? 'cbrt(' : 'sqrt(', LPAREN: '(', RPAREN: sh ? '!' : ')',
      SIN: sh ? 'asin(' : 'sin(', COS: sh ? 'acos(' : 'cos(', TAN: sh ? 'atan(' : 'tan(', LOG: sh ? '10^(' : 'log(', LN: sh ? 'e^(' : 'ln(',
      PI: 'pi', PERCENT: '%', INV: '^(-1)', VARX: 'x', COMMA: ',', ANS: 'Ans'
    };
    return map[k] != null ? map[k] : null;
  }

  /* ------------------------------ EditorView (TEXT_ENTRY) ----------- */

  class EditorView {
    constructor(state, title, onSubmit, opts = {}) {
      this.state = state; this.title = title; this.onSubmit = onSubmit; this.opts = opts;
      this.protected = opts.protected !== false;
      this.buf = new TI.TextBuffer(opts.maxLen || 500);
      if (opts.initial) this.buf.text = opts.initial;
      this.method = opts.method || 'A';
      this.vk = new TI.VirtualKeyboard();
      this.mt = new TI.MultiTap(this.buf, { timeoutMs: opts.multitapMs || 900 });
      this.hoff = 0;
    }
    get text() { return this.buf.text; }
    submit(app) { this.mt.commit(); this.onSubmit(this.buf.text, app, this); }
    onKey(ev, app) {
      const k = ev.key;
      const now = app.now();
      if (k === 'MODE') { this.mt.commit(); this.method = this.method === 'A' ? 'B' : 'A'; return true; }
      if (k === 'AC') { this.mt.commit(); if (this.opts.onCancel) this.opts.onCancel(app, this); app.pop(); return true; }
      if (k === 'DEL') { this.mt.commit(); this.buf.backspace(); return true; }
      if (k === 'CHAR' && ev.ch) { this.mt.commit(); this.buf.insert(ev.ch); return true; }
      if (k === 'EQ' && (ev.shift || this.method === 'B')) { this.submit(app); return true; }
      if (this.method === 'A') {
        if (ev.shift && (k === 'LEFT' || k === 'RIGHT')) { k === 'LEFT' ? this.buf.left() : this.buf.right(); return true; }
        if (['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(k)) { this.vk.move(k.toLowerCase()); return true; }
        if (k === 'ALPHA') { this.vk.shift = !this.vk.shift; return true; }
        if (k === 'EQ') {
          const r = this.vk.activate();
          if (r.insert) this.buf.insert(r.insert);
          else if (r.action === 'left') this.buf.left();
          else if (r.action === 'right') this.buf.right();
          else if (r.action === 'del') this.buf.backspace();
          else if (r.action === 'ok') this.submit(app);
          return true;
        }
        if (DIGITS.includes(k)) { this.buf.insert(k); return true; }
        if (k === 'DOT') { this.buf.insert('.'); return true; }
        const t = keyText(ev, 'expr');
        if (t != null) { this.buf.insert(t); return true; }
        return false;
      }
      // method B (multi-tap)
      if (DIGITS.includes(k)) { this.mt.press(k, now); return true; }
      if (k === 'ALPHA') { this.mt.cycleCase(); return true; }
      if (k === 'LEFT') { this.mt.commit(); this.buf.left(); return true; }
      if (k === 'RIGHT') { this.mt.commit(); this.buf.right(); return true; }
      const cols = app.layout1().cols;
      if (k === 'UP') { this.mt.commit(); for (let i = 0; i < cols; i++) this.buf.left(); return true; }
      if (k === 'DOWN') { this.mt.commit(); for (let i = 0; i < cols; i++) this.buf.right(); return true; }
      if (k === 'DOT') { this.mt.commit(); this.buf.insert('.'); return true; }
      const t = keyText(ev, 'expr');
      if (t != null) { this.mt.commit(); this.buf.insert(t); return true; }
      return false;
    }
    tick(app) { this.mt.tick(app.now()); }
    shown() { return this.opts.masked ? '*'.repeat(this.buf.chars.length) : this.buf.text; }
    renderTextLine(fb, y, cols, x0) {
      const t = Font.normalize(this.shown());
      const cur = this.buf.cursor;
      if (cur < this.hoff) this.hoff = cur;
      if (cur > this.hoff + cols - 1) this.hoff = cur - cols + 1;
      const slice = t.slice(this.hoff, this.hoff + cols);
      fb.drawText(x0, y, slice);
      const cx = x0 + (cur - this.hoff) * 6;
      fb.vline(Math.max(0, cx - 1), y, 8, 1); // insertion cursor
      if (this.hoff > 0) arrowLeft(fb, 0, y + 1);
      if (t.length - this.hoff > cols) arrowRight(fb, fb.width - 3, y + 1);
    }
    render(fb, app) {
      const L1 = app.layout1();
      if (this.method === 'A') {
        this.renderTextLine(fb, 0, L1.cols, L1.x0);
        // keyboard: 3 visible rows of 4
        const rows = this.vk.rows;
        const vis = Math.min(3, Math.floor((fb.height - 8) / 8));
        let first = Math.min(Math.max(0, this.vk.row - vis + 1), rows.length - vis);
        if (this.vk.row < first) first = this.vk.row;
        const cellW = Math.floor((fb.width - 6) / TI.GRID_COLS);
        for (let r = 0; r < vis; r++) {
          const ri = first + r;
          const y = 8 + r * 8;
          let cell = 0;
          rows[ri].forEach((key, i) => {
            const x = 2 + cell * cellW;
            const w = key.w * cellW;
            const label = this.vk.label(key);
            fb.drawText(x + Math.floor((w - 5) / 2), y, label);
            if (ri === this.vk.row && i === this.vk.col) fb.invertRect(x, y, w, 8);
            cell += key.w;
          });
        }
        // page/scroll indicators
        if (first > 0) arrowUp(fb, fb.width - 5, 8);
        if (first + vis < rows.length) arrowDown(fb, fb.width - 5, fb.height - 3);
        fb.drawTiny(fb.width - 4, 14, this.vk.pageName[0].toUpperCase());
        return;
      }
      // method B: wrapped text (3 rows) + status row
      const cols = L1.cols;
      const t = Font.normalize(this.shown());
      const cur = this.buf.cursor;
      const lineOf = Math.floor(cur / cols);
      const rows = 3;
      if (this.topLine == null) this.topLine = 0;
      if (lineOf < this.topLine) this.topLine = lineOf;
      if (lineOf >= this.topLine + rows) this.topLine = lineOf - rows + 1;
      for (let r = 0; r < rows; r++) {
        const li = this.topLine + r;
        fb.drawText(L1.x0, r * 8, t.slice(li * cols, li * cols + cols));
      }
      const cy = (lineOf - this.topLine) * 8;
      const cx = L1.x0 + (cur % cols) * 6;
      if (this.mt.pending && cur > 0) {
        const pl = Math.floor((cur - 1) / cols) - this.topLine;
        fb.invertRect(L1.x0 + ((cur - 1) % cols) * 6 - 1, pl * 8, 7, 8);
      } else fb.vline(Math.max(0, cx - 1), cy, 8, 1);
      const total = Math.ceil((t.length + 1) / cols);
      scrollbar(fb, total, this.topLine, rows, 0, 24);
      fb.drawTiny(1, 26, 'B ' + this.mt.caseMode.toUpperCase() + ' ' + t.length);
      if (this.mt.caseMode === 'Abc') fb.drawTiny(1, 26, 'B A');
    }
    dispose() { this.buf.wipe(); this.mt.pending = null; }
  }

  /* ------------------------------ BusyView -------------------------- */

  class BusyView {
    constructor(state, lines, opts = {}) { this.state = state; this.lines = lines; this.opts = opts; this.protected = opts.protected !== false; }
    onKey(ev, app) {
      if (ev.key === 'AC') { if (this.opts.onCancel) this.opts.onCancel(app); return true; }
      return true; // swallow other keys while busy
    }
    render(fb, app) {
      const lines = typeof this.lines === 'function' ? this.lines(app) : this.lines;
      lines.slice(0, 3).forEach((l, i) => fb.drawText(2, i * 8, l));
      const t = Math.floor(app.now() / 150) % 8;
      const cx = fb.width - 10, cy = 26;
      const pts = [[0, -4], [3, -3], [4, 0], [3, 3], [0, 4], [-3, 3], [-4, 0], [-3, -3]];
      pts.forEach((p, i) => { if (i === t || i === (t + 7) % 8) fb.fillRect(cx + p[0], cy + p[1] - 1, 2, 2); else fb.setPixel(cx + p[0], cy + p[1]); });
      fb.drawTiny(2, 26, 'AC CANCELA');
    }
  }

  return { MenuView, ReaderView, FormView, EditorView, BusyView, keyText, scrollbar, drawTitle, arrowLeft, arrowRight, arrowUp, arrowDown };
});
