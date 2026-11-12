#!/usr/bin/env node
/*
 * Gerador da placa PRELIMINAR do teclado (formato 82MS) em Gerber RS-274X + Excellon.
 *   node tools/gen_keypad_pcb.js            -> hardware/pcb/out/ (gerbers, drill, preview.svg)
 *
 * O que esta placa e: a placa que fica sob o teclado de borracha da calculadora,
 * com contatos interdigitados (pente) em cada tecla, matriz 9x7 roteada em 2
 * camadas e uma fileira de ilhas para os fios do microcontrolador.
 * O que ela AINDA NAO e: o contorno e as posicoes das teclas sao estimativas
 * (a calculadora JS-82MS-A ainda nao foi medida); as areas do ESP32, do
 * MCP23017, do conector do display e da bateria estao apenas reservadas.
 * Serve para ORCAMENTO (tamanho, camadas, espessura, acabamento e furos reais).
 * Todas as medidas ficam em PARAM e sao trocadas quando a calculadora for medida.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Font = require('../simulator/js/core/font.js');

const PARAM = {
  W: 70, H: 100, corner: 4,           // contorno (mm) - ESTIMADO; so a area das teclas (a tela fica fora, ligada por cabo)
  edge: 0.3,                          // folga minima ate a borda
  trace: 0.25, comb: 0.2, combPitch: 0.5,
  via: { pad: 0.6, drill: 0.3 },
  th: { pad: 1.6, drill: 1.0, pitch: 2.54, x0: 13.4, y: 90 },
  busTop: 84,                         // fim da area das teclas
  version: 'v1 PRELIMINAR',
};
const OUT = path.join(__dirname, '..', 'hardware', 'pcb', 'out');

/* ------------------------------ geometria das teclas ------------------------------ */
const fx = (i) => 35 + (i - 2.5) * 10.5;   // grade de 6 colunas (teclas de funcao)
const dx = (i) => 35 + (i - 2) * 12.6;     // grade de 5 colunas (numeros)
const keys = [];
const K = (name, x, y, r, row, col) => keys.push({ name, x, y, r, row, col });
[['0', '.', 'EXP', 'Ans', '='], ['1', '2', '3', '+', '-'], ['4', '5', '6', 'x', '/'], ['7', '8', '9', 'DEL', 'AC']]
  .forEach((names, k) => names.forEach((n, i) => K(n, dx(i), 10 + k * 9, 3, 'R' + (8 - k), 'C' + i)));
[['RCL', 'ENG', '(', ')', ',', 'M+'], ['(-)', 'DMS', 'hyp', 'sin', 'cos', 'tan'], ['ab/c', 'sqrt', 'x2', '^', 'log', 'ln']]
  .forEach((names, k) => names.forEach((n, i) => K(n, fx(i), 46 + k * 7.5, 2.5, 'R' + (4 - k), 'C' + i)));
K('x-1', fx(0), 69, 2.5, 'R1', 'C0'); K('nCr', fx(1), 69, 2.5, 'R1', 'C1'); K('Pol', fx(4), 69, 2.5, 'R1', 'C4'); K('x3', fx(5), 69, 2.5, 'R1', 'C5');
K('LEFT', 27, 74, 2, 'R1', 'C2'); K('RIGHT', 43, 74, 2, 'R1', 'C3'); K('DOWN', 35, 68.5, 2, 'R1', 'C6');
K('SHIFT', fx(0), 77, 2.5, 'R0', 'C0'); K('ALPHA', fx(1), 77, 2.5, 'R0', 'C1'); K('MODE', fx(4), 77, 2.5, 'R0', 'C4');
K('UP', 35, 79.5, 2, 'R0', 'C6');
const ON = { name: 'ON', x: fx(5), y: 77, r: 2.5 };

/* linha horizontal de cada linha da matriz (camada de cima) e seu "riser" ate a area de fios */
const ROWLINE = { R8: 14.5, R7: 23.5, R6: 32.5, R5: 41.5, R4: 49.75, R3: 57.25, R2: 64.4, R1: 65.6, R0: 82.3 };
const RISER = { R8: 1.5, R7: 2.1, R6: 2.7, R5: 3.3, R4: 3.9, R3: 68.5, R2: 67.9, R1: 67.3, R0: 66.7 };
/* colunas (camada de baixo): x do barramento de funcao; numeros sobem e desviam em y=41.5 */
const COLX = { C0: fx(0) + 3.4, C1: fx(1) + 3.4, C2: fx(2) + 3.4, C3: fx(3) + 3.4, C4: fx(4) + 3.4, C5: fx(5) + 3.4, C6: 37.9 };
const JOG_Y = 41.5;

/* ------------------------------ primitivas ------------------------------ */
const L = { GTL: [], GBL: [], GTS: [], GBS: [], GTO: [], GBO: [], GKO: [] };
const drills = [];
const seg = (layer, x1, y1, x2, y2, w, net) => L[layer].push({ t: 'line', x1, y1, x2, y2, w, net });
const poly = (layer, pts, w, net) => { for (let i = 1; i < pts.length; i++) seg(layer, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], w, net); };
const flashC = (layer, x, y, d, net) => L[layer].push({ t: 'flash', x, y, shape: 'C', d, net });
const flashR = (layer, x, y, w, h, net) => L[layer].push({ t: 'flash', x, y, shape: 'R', w, h, net });
function via(x, y, net) { flashC('GTL', x, y, PARAM.via.pad, net); flashC('GBL', x, y, PARAM.via.pad, net); drills.push({ x, y, d: PARAM.via.drill }); }
function thPad(x, y, net) {
  for (const l of ['GTL', 'GBL']) flashC(l, x, y, PARAM.th.pad, net);
  for (const l of ['GTS', 'GBS']) flashC(l, x, y, PARAM.th.pad + 0.1);
  drills.push({ x, y, d: PARAM.th.drill });
}

/** Pente interdigitado: espinha A a esquerda, espinha B a direita. Retorna pontos de ligacao. */
function comb(k, netA, netB) {
  const { x, y, r } = k, hw = 0.75 * r, hh = 0.6 * r, w = PARAM.comb;
  const xa = x - hw, xb = x + hw;
  seg('GTL', xa, y - hh, xa, y + hh, w, netA);
  seg('GTL', xb, y - hh, xb, y + hh, w, netB);
  const n = Math.floor((2 * hh) / PARAM.combPitch) + 1, y0 = y - ((n - 1) * PARAM.combPitch) / 2;
  for (let i = 0; i < n; i++) {
    const yy = y0 + i * PARAM.combPitch;
    if (i % 2 === 0) seg('GTL', xa, yy, xb - 0.4, yy, w, netA);
    else seg('GTL', xb, yy, xa + 0.4, yy, w, netB);
  }
  flashC('GTS', x, y, 2 * r + 0.4); // abertura da mascara: contato exposto (ENIG)
  return { aTop: [xa, y + hh], aBot: [xa, y - hh], b: [xb, y], bBot: [xb, y - hh] };
}

/* ------------------------------ teclas da matriz ------------------------------ */
const T = PARAM.trace;
const colVias = {};
for (const k of keys) {
  const p = comb(k, k.row, k.col);
  const lineY = ROWLINE[k.row];
  const start = lineY > k.y ? p.aTop : p.aBot;           // linha acima ou abaixo da tecla
  seg('GTL', start[0], start[1], start[0], lineY, T, k.row);
  const vx = k.x + k.r + 0.9;                           // via a direita da tecla
  seg('GTL', p.b[0], p.b[1], vx, p.b[1], T, k.col);
  via(vx, k.y, k.col);
  (colVias[k.col] = colVias[k.col] || []).push({ x: vx, y: k.y, digit: k.r === 3 });
}

/* linhas da matriz (camada de cima) */
for (const row of Object.keys(ROWLINE)) {
  const ks = keys.filter((k) => k.row === row).map((k) => k.x - 0.75 * k.r);
  const rx = RISER[row], y = ROWLINE[row];
  const far = rx < 35 ? Math.max(...ks) : Math.min(...ks);
  seg('GTL', rx, y, far, y, T, row);
  seg('GTL', rx, y, rx, PARAM.busTop, T, row);
}

/* colunas (camada de baixo) */
const busEnd = {};
for (const col of Object.keys(COLX)) {
  const vs = colVias[col];
  const digits = vs.filter((v) => v.digit), funcs = vs.filter((v) => !v.digit);
  const cx = COLX[col];
  if (digits.length) {
    const ddx = digits[0].x, minY = Math.min(...digits.map((v) => v.y));
    seg('GBL', ddx, minY, ddx, JOG_Y, T, col);
    seg('GBL', ddx, JOG_Y, cx, JOG_Y, T, col);
    seg('GBL', cx, JOG_Y, cx, PARAM.busTop, T, col);
  } else {
    seg('GBL', cx, Math.min(...funcs.map((v) => v.y)), cx, PARAM.busTop, T, col);
  }
  for (const v of funcs) if (Math.abs(v.x - cx) > 1e-6) seg('GBL', v.x, v.y, cx, v.y, T, col); // LEFT/RIGHT
  busEnd[col] = cx;
}

/* tecla ON: fora da matriz (pino proprio para acordar o ESP32); outro lado no GND */
{
  const p = comb(ON, 'ON', 'GND');
  const ax = ON.x - ON.r - 0.9, by = ON.y - ON.r - 0.9;
  seg('GTL', p.aTop[0], ON.y, ax, ON.y, T, 'ON'); via(ax, ON.y, 'ON');
  seg('GBL', ax, ON.y, ax, PARAM.busTop, T, 'ON');
  seg('GTL', p.bBot[0], p.bBot[1], p.bBot[0], by, T, 'GND'); via(p.bBot[0], by, 'GND');
  seg('GBL', p.bBot[0], by, p.bBot[0], PARAM.busTop, T, 'GND');
  busEnd.ON = ax; busEnd.GND = p.bBot[0];
}

/* ------------------------------ ilhas para os fios (degraus sem cruzamento) ------------------------------ */
const ORDER = ['R8', 'R7', 'R6', 'R5', 'R4', 'C0', 'C1', 'C2', 'C6', 'C3', 'C4', 'ON', 'GND', 'C5', 'R0', 'R1', 'R2', 'R3'];
const LEVEL = { R8: 87.0, R7: 86.4, R6: 85.8, R5: 85.2, R4: 84.6, R3: 86.4, R2: 85.8, R1: 85.2, R0: 84.6,
  C0: 85.2, C1: 84.6, C2: 84.6, C6: 85.2, C3: 85.8, C4: 86.4, ON: 87.0, GND: 87.6, C5: 88.2 };
const padX = {};
ORDER.forEach((net, i) => {
  const xp = PARAM.th.x0 + i * PARAM.th.pitch; padX[net] = xp;
  const top = net[0] === 'R', layer = top ? 'GTL' : 'GBL';
  const xs = top ? RISER[net] : busEnd[net], lv = LEVEL[net];
  poly(layer, [[xs, PARAM.busTop], [xs, lv], [xp, lv], [xp, PARAM.th.y]], T, net);
  thPad(xp, PARAM.th.y, net);
});

/* ------------------------------ contorno ------------------------------ */
{
  const { W, H, corner: c } = PARAM, pts = [];
  const arc = (cx, cy, a0) => { for (let i = 0; i <= 8; i++) { const a = a0 + (i * Math.PI) / 16; pts.push([cx + c * Math.cos(a), cy + c * Math.sin(a)]); } };
  arc(W - c, c, -Math.PI / 2); arc(W - c, H - c, 0); arc(c, H - c, Math.PI / 2); arc(c, c, Math.PI);
  pts.push(pts[0]);
  poly('GKO', pts, 0.1);
}

/* ------------------------------ serigrafia ------------------------------ */
function text(layer, str, x, y, h, mirror) {
  const px = h / 7; let cx = 0;
  for (const ch of str) {
    const g = Font.glyph5x7(ch);
    for (let c = 0; c < 5; c++) for (let r = 0; r < 7; r++) {
      if (!((g[c] >> r) & 1)) continue;
      const gx = (cx + c + 0.5) * px, gy = (6 - r + 0.5) * px;
      flashR(layer, mirror ? x - gx : x + gx, y + gy, px, px);
    }
    cx += 6;
  }
}
const rect = (layer, x, y, w, h) => poly(layer, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], 0.15);
text('GTO', 'TERMINAL MATEMATICO ' + PARAM.version, 6, 96.6, 1.2);
ORDER.forEach((net, i) => { const lb = net === 'GND' ? 'G' : net, h = 1.05; text('GTO', lb, padX[net] - (lb.length * 6 * (h / 7)) / 2, i % 2 ? 93.6 : 91.9, h); });
// lado de baixo (texto espelhado para ler pelo verso)
const B = (s, x, y, h) => text('GBO', s, x, y, h, true);
// verso = lado dos componentes (como na placa da VovoCorp): areas reservadas, sem ilhas ainda
rect('GBO', 8, 8, 18, 25.5); B('ESP32-S3', 24, 22, 1.4); B('MODULO', 22.5, 18.5, 1.2);
rect('GBO', 29, 40, 12, 12); B('CAMERA', 39.5, 47, 1.2); B('(FPC)', 38, 43.5, 1.2);
rect('GBO', 44, 10, 18, 12); B('CARREGADOR', 61, 17, 1.1); B('REGULADOR', 60, 13.5, 1.1);
rect('GBO', 18, 95.4, 34, 3.6); B('SOLDA DO CABO DO DISPLAY', 50.5, 96.5, 1.0);
rect('GBO', 58.5, 91.5, 9, 7); B('BAT', 66, 94.5, 1.2);
B('PRELIMINAR - MEDIDAS A CONFIRMAR', 66, 2.2, 1.2);

/* ------------------------------ verificacao de folgas ------------------------------ */
function segDist(a, b) {
  const d = (p, s) => { const vx = s[2] - s[0], vy = s[3] - s[1], l = vx * vx + vy * vy; let t = l ? ((p[0] - s[0]) * vx + (p[1] - s[1]) * vy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - s[0] - t * vx, p[1] - s[1] - t * vy); };
  const inter = (() => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); const p1 = [a[0], a[1]], p2 = [a[2], a[3]], q1 = [b[0], b[1]], q2 = [b[2], b[3]]; return o(p1, p2, q1) * o(p1, p2, q2) < 0 && o(q1, q2, p1) * o(q1, q2, p2) < 0; })();
  if (inter) return 0;
  return Math.min(d([a[0], a[1]], b), d([a[2], a[3]], b), d([b[0], b[1]], a), d([b[2], b[3]], a));
}
function geom(p) { return p.t === 'line' ? { s: [p.x1, p.y1, p.x2, p.y2], hw: p.w / 2 } : { s: [p.x, p.y, p.x, p.y], hw: (p.d || Math.max(p.w, p.h)) / 2 }; }
function drc(minClear) {
  const errs = [];
  for (const layer of ['GTL', 'GBL']) {
    const items = L[layer].filter((p) => p.net).map((p) => ({ net: p.net, ...geom(p) }));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.net === b.net) continue;
      const c = segDist(a.s, b.s) - a.hw - b.hw;
      if (c < minClear) errs.push(`${layer}: ${a.net} x ${b.net} folga ${c.toFixed(3)} mm perto de (${a.s[0].toFixed(2)}, ${a.s[1].toFixed(2)})`);
    }
    for (const it of items) for (const v of [[it.s[0], it.s[1]], [it.s[2], it.s[3]]]) {
      const e = Math.min(v[0], v[1], PARAM.W - v[0], PARAM.H - v[1]) - it.hw;
      if (e < PARAM.edge) errs.push(`${layer}: ${it.net} a ${e.toFixed(3)} mm da borda`);
    }
  }
  return errs;
}

/* ------------------------------ escrita Gerber / Excellon ------------------------------ */
const n6 = (v) => Math.round(v * 1e6);
const FUNC = { GTL: 'Copper,L1,Top', GBL: 'Copper,L2,Bot', GTS: 'Soldermask,Top', GBS: 'Soldermask,Bot', GTO: 'Legend,Top', GBO: 'Legend,Bot', GKO: 'Profile,NP' };
function gerber(layer) {
  const ap = new Map(); let next = 10;
  const key = (p) => (p.t === 'line' ? `C${p.w.toFixed(3)}` : p.shape === 'C' ? `C${p.d.toFixed(3)}` : `R${p.w.toFixed(3)}X${p.h.toFixed(3)}`);
  for (const p of L[layer]) { const k = key(p); if (!ap.has(k)) ap.set(k, next++); }
  const out = [`G04 Terminal Matematico - teclado ${PARAM.version}*`, `%TF.FileFunction,${FUNC[layer]}*%`, '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%'];
  for (const [k, d] of ap) out.push(k[0] === 'C' ? `%ADD${d}C,${k.slice(1)}*%` : `%ADD${d}R,${k.slice(1)}*%`);
  let cur = -1;
  for (const p of L[layer]) {
    const d = ap.get(key(p)); if (d !== cur) { out.push(`D${d}*`); cur = d; }
    if (p.t === 'line') out.push(`X${n6(p.x1)}Y${n6(p.y1)}D02*`, `X${n6(p.x2)}Y${n6(p.y2)}D01*`);
    else out.push(`X${n6(p.x)}Y${n6(p.y)}D03*`);
  }
  out.push('M02*');
  return out.join('\n') + '\n';
}
function excellon() {
  const sizes = [...new Set(drills.map((d) => d.d))].sort();
  const out = ['M48', '; Terminal Matematico - teclado ' + PARAM.version, 'FMAT,2', 'METRIC,TZ'];
  sizes.forEach((s, i) => out.push(`T${i + 1}C${s.toFixed(3)}`));
  out.push('%');
  sizes.forEach((s, i) => { out.push(`T${i + 1}`); for (const d of drills.filter((d) => d.d === s)) out.push(`X${d.x.toFixed(3)}Y${d.y.toFixed(3)}`); });
  out.push('T0', 'M30');
  return out.join('\n') + '\n';
}

/* ------------------------------ previa SVG ------------------------------ */
function svg() {
  const { W, H } = PARAM, s = 6, pad = 10, gap = 30;
  const view = (layers, ox, mirror, title) => {
    const tx = (x) => ox + (mirror ? W - x : x) * s, ty = (y) => pad + 24 + (H - y) * s;
    let g = `<text x="${ox}" y="${pad + 14}" font-family="sans-serif" font-size="15" fill="#e8ede6">${title}</text>`;
    g += `<rect x="${ox}" y="${pad + 24}" width="${W * s}" height="${H * s}" rx="${PARAM.corner * s}" fill="#1f4d2b"/>`;
    for (const [layer, color] of layers) for (const p of L[layer]) {
      if (p.t === 'line') g += `<line x1="${tx(p.x1)}" y1="${ty(p.y1)}" x2="${tx(p.x2)}" y2="${ty(p.y2)}" stroke="${color}" stroke-width="${Math.max(p.w * s, 0.8)}" stroke-linecap="round"/>`;
      else if (p.shape === 'C') g += `<circle cx="${tx(p.x)}" cy="${ty(p.y)}" r="${(p.d * s) / 2}" fill="${color}"/>`;
      else g += `<rect x="${tx(p.x) - (p.w * s) / 2}" y="${ty(p.y) - (p.h * s) / 2}" width="${p.w * s}" height="${p.h * s}" fill="${color}"/>`;
    }
    for (const d of drills) g += `<circle cx="${tx(d.x)}" cy="${ty(d.y)}" r="${(d.d * s) / 2}" fill="#0b0f0c"/>`;
    return g;
  };
  const w = 2 * W * s + gap + 2 * pad, h = H * s + 2 * pad + 30;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#101411"/>` +
    view([['GBL', '#3b6fb5'], ['GTL', '#d9a441'], ['GTO', '#f2f2f2']], pad, false, 'Frente (lado das teclas)') +
    view([['GTL', '#6b5420'], ['GBL', '#5b9bea'], ['GBO', '#f2f2f2']], pad + W * s + gap, true, 'Verso (lado dos componentes)') + '</svg>';
}

/* continuidade: cada sinal precisa formar um unico conjunto ligado (cobre que se toca + furos entre camadas) */
function connectivity() {
  const items = [];
  for (const layer of ['GTL', 'GBL']) for (const p of L[layer]) if (p.net) items.push({ layer, net: p.net, ...geom(p) });
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.net !== b.net) continue;
    const sameLayer = a.layer === b.layer;
    const touch = segDist(a.s, b.s) <= a.hw + b.hw + 1e-6;
    if (sameLayer && touch) join(i, j);
    // furo: um flash na mesma posicao nas duas camadas
    if (!sameLayer && a.s[0] === a.s[2] && b.s[0] === b.s[2] && Math.hypot(a.s[0] - b.s[0], a.s[1] - b.s[1]) < 1e-6 &&
        drills.some((d) => Math.hypot(d.x - a.s[0], d.y - a.s[1]) < 1e-6)) join(i, j);
  }
  const errs = [];
  for (const net of new Set(items.map((x) => x.net))) {
    const roots = new Set(items.map((x, i) => (x.net === net ? find(i) : null)).filter((x) => x !== null));
    if (roots.size !== 1) errs.push(`sinal ${net} dividido em ${roots.size} partes`);
  }
  // cada tecla precisa estar na mesma ilha que a ilha de fio da sua linha e da sua coluna
  return errs;
}

/* ------------------------------ main ------------------------------ */
if (process.argv.includes('--selftest')) { seg('GTL', 30, 20, 40, 20, 0.25, 'R8'); seg('GTL', 35, 15, 35, 25, 0.25, 'R7'); seg('GBL', 20, 30, 21, 30, 0.25, 'C0'); }
const errs = drc(0.15).concat(connectivity());
if (errs.length) { console.error('ERROS de folga:\n' + errs.slice(0, 30).join('\n')); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const NAME = 'terminal-teclado';
for (const layer of Object.keys(L)) fs.writeFileSync(path.join(OUT, `${NAME}.${layer}`), gerber(layer));
fs.writeFileSync(path.join(OUT, `${NAME}.DRL`), excellon());
fs.writeFileSync(path.join(OUT, 'preview.svg'), svg());
const nets = new Set(Object.values(L).flat().map((p) => p.net).filter(Boolean));
console.log(`ok: ${keys.length + 1} teclas, ${nets.size} sinais, ${drills.length} furos, ${PARAM.W}x${PARAM.H} mm, verificacao de folga >= 0,15 mm sem erros`);
