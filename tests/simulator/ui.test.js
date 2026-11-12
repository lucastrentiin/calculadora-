'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FB = require('../../simulator/js/core/framebuffer.js');
const Font = require('../../simulator/js/core/font.js');
const TL = require('../../simulator/js/core/textLayout.js');
const TI = require('../../simulator/js/core/textInput.js');
const AR = require('../../simulator/js/core/aiResponse.js');

test('framebuffer draws glyphs, clips, tracks dirty area and exports pages', () => {
  const fb = new FB(128, 32);
  fb.resetDirty();
  fb.drawText(0, 0, '1');
  assert.ok(fb.dirty && fb.dirty.x2 <= 6);
  // glyph '1' column 2 is fully set (0x7F)
  for (let y = 0; y < 7; y++) assert.equal(fb.getPixel(2, y), 1);
  fb.setPixel(500, 500); // out of bounds is ignored
  const pages = fb.toPages();
  assert.equal(pages.length, 128 * 4);
  assert.equal(pages[2], 0x7F);
  fb.clear(); fb.drawText(0, 0, 'x', { scale: 2 });
  assert.equal(FB.textWidth('abc', 2), 36);
});

test('font covers printable ASCII and math symbols; normalizes accents', () => {
  for (let c = 0x20; c <= 0x7E; c++) assert.equal(Font.glyph5x7(String.fromCharCode(c)).length, 5);
  for (const ch of 'π√²°×÷←→↑↓θΣ') assert.ok(Font.EXTRA[ch], ch);
  assert.equal(Font.normalize('Equação ÁREA ç'), 'Equacao AREA c');
  assert.equal(Font.normalize('漢'), '?');
});

test('word wrap never loses content', () => {
  const txt = 'Uma explicacao bem longa que precisa quebrar em varias linhas sem perder nenhuma palavra supercalifragilisticexpialidocious final.';
  const lines = TL.wrapText(txt, 20);
  assert.ok(lines.every(l => l.length <= 20));
  assert.equal(lines.join(' ').replace(/- /g, '').replace(/-(?=\S)/g, '').replace(/\s+/g, ''), txt.replace(/\s+/g, ''));
});

test('math lines are not wrapped and break points never split tokens', () => {
  const expr = 'x=(-12.5E-3+sqrt(144))/(2*3.14159)+sin(45)*cos(30)';
  const bps = TL.mathBreakpoints(expr);
  for (const b of bps) {
    const prev = expr[b - 1] || '', cur = expr[b];
    assert.ok(!(/[A-Za-z0-9_.]/.test(prev) && /[A-Za-z0-9_.]/.test(cur)), 'quebra dentro de token em ' + b);
  }
  assert.ok(!bps.includes(expr.indexOf('E-3') + 1), 'nao pode quebrar notacao cientifica');
  const doc = TL.layoutDoc([{ kind: 'math', text: expr }], 20);
  assert.equal(doc.length, 1);
  assert.equal(doc[0].text, expr); // original expression preserved
});

test('reader: vertical and horizontal scrolling over the whole content', () => {
  const blocks = [{ kind: 'title', text: 'T' }];
  for (let i = 0; i < 30; i++) blocks.push({ kind: 'text', text: 'Linha numero ' + i + ' com texto.' });
  const expr = '1+2+3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18+19+20';
  blocks.push({ kind: 'math', text: expr });
  const r = new TL.ReaderModel(blocks, 20, 4);
  assert.equal(r.visible().length, 4);
  r.move(-5); assert.equal(r.cursor, 0);
  r.end(); assert.equal(r.cursor, r.lines.length - 1);
  assert.equal(r.top, r.lines.length - 4);
  assert.ok(r.current().math);
  assert.ok(r.canScrollRight());
  let seen = r.visible()[3].text;
  let guard = 0;
  while (r.scrollH(1) && guard++ < 50) seen += '|' + r.visible()[3].text;
  assert.ok(!r.canScrollRight());
  // every character of the expression appeared on screen
  const visibleChars = new Set();
  r.hoff = 0;
  do { const off = r.hoff; for (let i = 0; i < 20 && off + i < expr.length; i++) visibleChars.add(off + i); } while (r.scrollH(1));
  assert.equal(visibleChars.size, expr.length);
  while (r.scrollH(-1));
  assert.equal(r.hoff, 0);
  r.page(-1); assert.ok(r.cursor < r.lines.length - 1);
  r.home(); assert.equal(r.top, 0);
});

test('reader relayout keeps position when the font size changes', () => {
  const blocks = Array.from({ length: 20 }, (_, i) => ({ kind: 'text', text: 'Bloco ' + i + ' texto texto texto' }));
  const r = new TL.ReaderModel(blocks, 20, 4);
  r.move(10);
  const block = r.current().block;
  r.relayout(10, 2);
  assert.equal(r.current().block, block);
});

test('memory guard truncates huge documents explicitly', () => {
  const blocks = Array.from({ length: 200 }, () => ({ kind: 'text', text: 'y'.repeat(1000) }));
  const lines = TL.layoutDoc(blocks, 20);
  assert.ok(lines.length <= TL.MAX_LINES + 1);
  assert.match(lines[lines.length - 1].text, /truncado/);
});

test('multi-tap (method B): cycling, timeout, case, numbers, punctuation', () => {
  const b = new TI.TextBuffer();
  const mt = new TI.MultiTap(b, { timeoutMs: 800 });
  mt.press('4', 0); mt.press('4', 100); assert.equal(b.text, 'h');
  mt.press('3', 200); assert.equal(b.text, 'hd');           // different key commits
  mt.press('3', 1500); assert.equal(b.text, 'hdd');         // timeout commits
  mt.press('7', 2000); mt.press('7', 2100); mt.press('7', 2200); mt.press('7', 2300); mt.press('7', 2400); assert.equal(b.text, 'hdd7');
  mt.press('7', 2500); assert.equal(b.text, 'hddp');        // wraps around
  mt.press('0', 4000); assert.equal(b.text, 'hddp ');
  mt.cycleCase(); assert.equal(mt.caseMode, 'Abc');
  mt.press('2', 5000); mt.commit(); assert.equal(b.text, 'hddp A'); assert.equal(mt.caseMode, 'abc');
  mt.caseMode = 'ABC'; mt.press('2', 7000); mt.press('2', 7100); assert.equal(b.text, 'hddp AB');
  mt.caseMode = '123'; mt.press('5', 9000); assert.equal(b.text, 'hddp AB5');
  mt.caseMode = 'abc'; mt.press('1', 10000); mt.press('1', 10100); assert.equal(b.text, 'hddp AB5,');
  b.left(); b.left(); b.backspace(); assert.equal(b.text, 'hddp A5,');   // edit earlier text
  mt.tick(20000); assert.equal(mt.pending, null);
});

test('virtual keyboard (method A): navigation, pages, shift, actions', () => {
  const vk = new TI.VirtualKeyboard();
  assert.equal(vk.focused().l, 'q');
  vk.move('right'); vk.move('right'); assert.equal(vk.activate().insert, 'e');
  vk.move('left'); vk.move('left'); vk.move('left'); assert.equal(vk.focused().l, '-'.length === 1 ? 'p' : 'p');
  vk.move('down'); vk.move('down'); vk.move('down'); // bottom row
  assert.ok(vk.focused().v.startsWith('@') || vk.focused().v === ' ');
  vk.row = 0; vk.col = 0; vk.shift = true; assert.equal(vk.activate().insert, 'Q'); assert.equal(vk.shift, false);
  vk.row = 3; vk.col = 1; assert.equal(vk.activate().action, 'page'); assert.equal(vk.pageName, '123');
  vk.row = 0; vk.col = 0; assert.equal(vk.activate().insert, '1');
  vk.row = 3; vk.col = 1; vk.activate(); assert.equal(vk.pageName, 'mat');
  vk.row = 0; vk.col = 0; assert.equal(vk.activate().insert, 'π');
  vk.row = 3; vk.col = 6; assert.equal(vk.activate().action, 'ok');
  // vertical navigation onto the wide space key and back keeps a sensible column
  vk.row = 2; vk.col = 3; vk.move('down'); assert.equal(vk.focused().v, ' '); vk.move('up'); assert.equal(vk.row, 2);
});

test('AI response validation: incomplete, oversized and hostile payloads', () => {
  assert.equal(AR.validate(null).ok, false);
  assert.equal(AR.validate('texto').ok, false);
  assert.equal(AR.validate({ version: 1, status: 'ok' }).ok, false); // missing answer
  assert.equal(AR.validate({ version: 2, status: 'ok', answer: 'x' }).ok, false);
  const ok = AR.validate({ version: 1, status: 'ok', mode: 'full', answer: '42', steps: [{ title: 't', math: '6*7', text: '' }], check: { expression: '6*7', expected: 42 } });
  assert.equal(ok.ok, true);
  assert.equal(AR.verify(ok.value).state, 'match');
  const bad = AR.validate({ version: 1, status: 'ok', answer: '43', check: { expression: '6*7', expected: 43 } });
  assert.equal(AR.verify(bad.value).state, 'mismatch');
  const many = AR.validate({ version: 1, status: 'ok', answer: 'a', steps: Array.from({ length: 300 }, () => ({ title: 'x', math: 'y', text: 'z' })) });
  assert.equal(many.ok, true); assert.equal(many.partial, true); assert.equal(many.value.steps.length, AR.LIMITS.steps); assert.equal(many.value.truncated, true);
  const huge = AR.validate({ version: 1, status: 'ok', answer: 'a', steps: Array.from({ length: 80 }, () => ({ title: 'x', math: 'y'.repeat(5000), text: 'z'.repeat(5000) })) });
  assert.equal(huge.ok, false);
  const types = AR.validate({ version: 1, status: 'ok', answer: { evil: true } });
  assert.equal(types.ok, false);
  const evilCheck = AR.validate({ version: 1, status: 'ok', answer: '1', check: { expression: 'process.exit()', expected: 1 } });
  assert.equal(AR.verify(evilCheck.value).state, 'error');
});

test('AI document separates IA content from local verification and honours modes', () => {
  const resp = AR.validate({ version: 1, status: 'ok', mode: 'full', answer: 'x = 2', given: [{ name: 'a', value: '1' }], formulas: ['f'],
    steps: Array.from({ length: 8 }, (_, i) => ({ title: 'Passo ' + i, math: i + '+1', text: 'explica' })), check: { expression: '1+1', expected: 2 } }).value;
  const v = AR.verify(resp);
  const fast = AR.toDoc(resp, 'fast', v);
  const short = AR.toDoc(resp, 'short', v);
  const full = AR.toDoc(resp, 'full', v);
  assert.ok(fast.length < short.length && short.length < full.length);
  assert.ok(full.some(b => /^\[IA\]/.test(b.text)) && full.some(b => /^\[LOCAL\]/.test(b.text)));
  assert.equal(full.filter(b => /^\d+\. Passo/.test(b.text)).length, 8);   // every step kept in full mode
  assert.ok(short.some(b => /etapas a mais/.test(b.text)));
});
