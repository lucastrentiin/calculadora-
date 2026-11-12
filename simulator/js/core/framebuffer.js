/*
 * 1-bit framebuffer independent of the physical display.
 * The display driver (canvas in the simulator, LCD controller on hardware)
 * only needs to copy pixels/pages from this buffer. A dirty rectangle is kept
 * so drivers that support partial updates can transfer only what changed.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./font.js'));
  else { root.MT = root.MT || {}; root.MT.Framebuffer = factory(root.MT.Font); }
})(typeof self !== 'undefined' ? self : this, function (Font) {
  'use strict';

  class Framebuffer {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.pixels = new Uint8Array(width * height);
      this.invertAll = false; // high-contrast/inversion handled at blit time
      this.resetDirty();
      this.markDirty(0, 0, width, height);
    }

    resetDirty() { this.dirty = null; }

    markDirty(x, y, w, h) {
      const x1 = Math.max(0, x), y1 = Math.max(0, y);
      const x2 = Math.min(this.width, x + w), y2 = Math.min(this.height, y + h);
      if (x2 <= x1 || y2 <= y1) return;
      if (!this.dirty) { this.dirty = { x1, y1, x2, y2 }; return; }
      this.dirty.x1 = Math.min(this.dirty.x1, x1);
      this.dirty.y1 = Math.min(this.dirty.y1, y1);
      this.dirty.x2 = Math.max(this.dirty.x2, x2);
      this.dirty.y2 = Math.max(this.dirty.y2, y2);
    }

    clear() { this.pixels.fill(0); this.markDirty(0, 0, this.width, this.height); }

    setPixel(x, y, on = 1) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      const i = y * this.width + x;
      const v = on ? 1 : 0;
      if (this.pixels[i] !== v) { this.pixels[i] = v; this.markDirty(x, y, 1, 1); }
    }

    getPixel(x, y) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
      return this.pixels[y * this.width + x];
    }

    fillRect(x, y, w, h, on = 1) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.setPixel(i, j, on);
    }

    invertRect(x, y, w, h) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
        if (i < 0 || j < 0 || i >= this.width || j >= this.height) continue;
        this.setPixel(i, j, !this.pixels[j * this.width + i]);
      }
    }

    hline(x, y, w, on = 1) { this.fillRect(x, y, w, 1, on); }
    vline(x, y, h, on = 1) { this.fillRect(x, y, 1, h, on); }
    drawRect(x, y, w, h, on = 1) {
      this.hline(x, y, w, on); this.hline(x, y + h - 1, w, on);
      this.vline(x, y, h, on); this.vline(x + w - 1, y, h, on);
    }

    /** Draw one 5x7 glyph. scale >= 1. Returns advance in pixels. */
    drawChar(x, y, ch, opts = {}) {
      const scale = opts.scale || 1;
      const cols = Font.glyph5x7(ch);
      const on = opts.invert ? 0 : 1;
      if (opts.invert) this.fillRect(x, y, Font.CELL_W * scale, Font.CELL_H * scale, 1);
      for (let cx = 0; cx < 5; cx++) {
        const bits = cols[cx];
        for (let cy = 0; cy < 7; cy++) {
          if (bits & (1 << cy)) this.fillRect(x + cx * scale, y + cy * scale, scale, scale, on);
        }
      }
      return Font.CELL_W * scale;
    }

    drawText(x, y, text, opts = {}) {
      const s = Font.normalize(text);
      let cx = x;
      for (const ch of s) {
        if (cx >= this.width) break;
        cx += this.drawChar(cx, y, ch, opts);
      }
      return cx - x;
    }

    drawTiny(x, y, text, on = 1) {
      let cx = x;
      for (const ch of String(text)) {
        const cols = Font.tinyGlyph(ch);
        if (cols) for (let i = 0; i < 3; i++) for (let j = 0; j < 5; j++) if (cols[i] & (1 << j)) this.setPixel(cx + i, y + j, on);
        cx += Font.TINY_CELL_W;
      }
      return cx - x;
    }

    static textWidth(text, scale = 1) { return Font.normalize(text).length * Font.CELL_W * scale; }

    /** Debug/test view: '#' on, '.' off. */
    toAscii() {
      const rows = [];
      for (let y = 0; y < this.height; y++) {
        let r = '';
        for (let x = 0; x < this.width; x++) r += this.pixels[y * this.width + x] ? '#' : '.';
        rows.push(r);
      }
      return rows.join('\n');
    }

    /** Page format (8 vertical pixels per byte, LSB top) used by many LCD controllers. */
    toPages() {
      const pages = Math.ceil(this.height / 8);
      const out = new Uint8Array(pages * this.width);
      for (let p = 0; p < pages; p++) for (let x = 0; x < this.width; x++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) if (this.getPixel(x, p * 8 + bit)) b |= (1 << bit);
        out[p * this.width + x] = b;
      }
      return out;
    }
  }

  return Framebuffer;
});
