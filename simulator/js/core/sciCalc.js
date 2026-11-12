/*
 * NORMAL mode: scientific calculator compatible with the fx-82MS-class layout
 * used by the reference DEXIN KK-82MS-B (inventory and verification status in
 * docs/DEXIN_COMPAT.md – every behaviour must still be confirmed against the
 * physical unit; nothing here is declared 100% compatible).
 *
 * Modes (MODE): COMP / SD / REG(Lin Log Exp Pwr Inv Quad); Deg/Rad/Gra;
 * Fix/Sci/Norm1-2; Disp ab/c|d/c and Dot|Comma. CLR (SHIFT MODE): Mcl|Scl / Mode / All.
 * SHIFT and ALPHA functions per key, STO/RCL variables A-F X Y M, M+/M-, Ans,
 * REPLAY, INS/overwrite, ENG/ENG<-, DMS (°'" and <-), DRG►, fractions a┘b┘c,
 * Pol/Rec (results in E/F), Rnd, Ran#, % (SHIFT =), hyp, nCr/nPr infix,
 * error messages Math/Syntax/Stack/Arg ERROR with cursor-to-error editing.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mathEngine.js'), require('./font.js'), require('./framebuffer.js'));
  else { root.MT = root.MT || {}; root.MT.SciCalc = factory(root.MT.MathEngine, root.MT.Font, root.MT.Framebuffer); }
})(typeof self !== 'undefined' ? self : this, function (M, Font, Framebuffer) {
  'use strict';

  const VARS = ['A', 'B', 'C', 'D', 'E', 'F', 'X', 'Y', 'M'];
  const ERR_NAME = { DOMAIN: 'Math ERROR', DIV_ZERO: 'Math ERROR', OVERFLOW: 'Math ERROR', SYNTAX: 'Syntax ERROR', UNKNOWN: 'Syntax ERROR', ARGS: 'Arg ERROR', DEPTH: 'Stack ERROR', TOO_LONG: 'Stack ERROR' };
  const REG_TYPES = ['Lin', 'Log', 'Exp', 'Pwr', 'Inv', 'Quad'];

  // display form of internal tokens
  const PRETTY = {
    '*': '×', '/': '÷', pi: 'π', 'sqrt(': '√(', 'cbrt(': '∛(', '^2': '²', '^3': '³', '^(-1)': '⁻¹', 'Ran#': 'Ran#', ' nCr ': 'C', ' nPr ': 'P',
    sumx2: 'Σx²', sumx: 'Σx', n: 'n', xbar: '\uE000', xsn: 'xσn', xsn1: 'xσn-1', sumy2: 'Σy²', sumy: 'Σy', sumxy: 'Σxy', sumx3: 'Σx³', sumx2y: 'Σx²y', sumx4: 'Σx⁴',
    ybar: 'ȳ', ysn: 'yσn', ysn1: 'yσn-1', regA: 'A', regB: 'B', regC: 'C', regr: 'r', xhat: '\uE001', xhat1: '\uE0011', xhat2: '\uE0012', yhat: 'ŷ', '-': '−', NEG: '(−)'
  };

  // key -> [primary, shift, alpha]; strings are tokens; functions are actions
  const KEYMAP = {
    '0': ['0', 'Rnd('], '1': ['1', '@SSUM'], '2': ['2', '@SVAR'], '3': ['3'], '4': ['4'], '5': ['5'], '6': ['6'], '7': ['7'], '8': ['8'], '9': ['9'],
    DOT: ['.', 'Ran#'], EXP: ['E', 'pi'], ANS: ['Ans', '@DRG'], ADD: ['+'], SUB: ['-'], MUL: ['*'], DIV: ['/'],
    NEG: ['-', null, 'A'], DMS: ['°', '@DMSBACK', 'B'], HYP: ['@HYP', null, 'C'], SIN: ['sin(', 'asin(', 'D'], COS: ['cos(', 'acos(', 'E'], TAN: ['tan(', 'atan(', 'F'],
    LPAREN: ['('], RPAREN: [')', null, 'X'], COMMA: [',', ';', 'Y'], STO: ['@MPLUS', '@MMINUS', 'M'], RCL: ['@RCL', '@STO'], ENG: ['@ENG', '@ENGBACK'],
    INV: ['^(-1)', '!'], NCR: [' nCr ', ' nPr '], POL: ['Pol(', 'Rec('], CUBE: ['^3', 'cbrt('], FRAC: ['@ABC', '@DC'], SQRT: ['sqrt('], SQR: ['^2'],
    POW: ['^', 'root('], LOG: ['log(', '10^('], LN: ['ln(', 'e^('], PERCENT: ['%'], PI: ['pi'], VARX: ['X'],
    EQ: ['@EQ', '@PCT'], DEL: ['@DEL', '@INS'], AC: ['@AC', '@OFF'], MODE: ['@MODE', '@CLR'],
  };

  class SciCalc {
    constructor(app) {
      this.app = app;
      this.tokens = []; this.cursor = 0; this.result = null; this.evaluated = false; this.hoff = 0; this.histIdx = -1;
      this.history = [];
      this.vars = Object.fromEntries(VARS.map(v => [v, 0]));
      this.ans = 0;
      this.insert = false;            // fx-82MS default: overwrite
      this.hyp = false; this.pending = null; this.menu = null; this.errPos = -1;
      this.view = 'dec';              // dec | frac | dms | eng
      this.engShift = 0;
      this.data = [];                 // SD: {x,f}; REG: {x,y,f}
      this.dataIdx = -1;
      this.multi = null;
    }
    get mem() { return this.vars.M; }
    set mem(v) { this.vars.M = v; }
    get expr() { return this.tokens.join(''); }
    get s() { return this.app.settings; }

    /* ------------------------------ persistence ------------------------ */
    load(saved) {
      if (!saved) return;
      if (saved.vars) for (const v of VARS) if (typeof saved.vars[v] === 'number') this.vars[v] = saved.vars[v];
      if (typeof saved.ans === 'number') this.ans = saved.ans;
      if (Array.isArray(saved.data)) this.data = saved.data.filter(d => d && typeof d.x === 'number').slice(0, 80);
    }
    snapshot() { return { vars: this.vars, ans: this.ans, data: this.data }; }
    persist() { if (this.app.saveJSON) this.app.saveJSON('calc.state', this.snapshot()); }

    clear() { this.tokens = []; this.cursor = 0; this.result = null; this.evaluated = false; this.hoff = 0; this.histIdx = -1; this.errPos = -1; this.view = 'dec'; this.engShift = 0; this.pending = null; this.menu = null; this.hyp = false; this.dataIdx = -1; }

    /* ------------------------------ context ---------------------------- */
    stats() {
      const reg = this.s.calcMode === 'REG';
      const t = this.s.regType || 'Lin';
      let n = 0, sx = 0, sx2 = 0, sy = 0, sy2 = 0, sxy = 0, sx3 = 0, sx2y = 0, sx4 = 0, sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0;
      for (const d of this.data) {
        const f = d.f || 1, x = d.x, y = d.y || 0;
        n += f; sx += f * x; sx2 += f * x * x;
        if (reg) {
          sy += f * y; sy2 += f * y * y; sxy += f * x * y; sx3 += f * x ** 3; sx2y += f * x * x * y; sx4 += f * x ** 4;
          const X = t === 'Log' || t === 'Pwr' ? Math.log(x) : t === 'Inv' ? 1 / x : x;
          const Y = t === 'Exp' || t === 'Pwr' ? Math.log(y) : y;
          sX += f * X; sY += f * Y; sXX += f * X * X; sYY += f * Y * Y; sXY += f * X * Y;
        }
      }
      const o = { n, sumx: sx, sumx2: sx2, sumy: sy, sumy2: sy2, sumxy: sxy, sumx3: sx3, sumx2y: sx2y, sumx4: sx4 };
      const need = (k) => { if (!n || (k > 1 && n < k)) throw new M.MathError(M.ERR.DOMAIN, 'dados insuficientes'); };
      const lazy = {
        xbar: () => { need(1); return sx / n; }, xsn: () => { need(1); return Math.sqrt(Math.max(0, sx2 / n - (sx / n) ** 2)); },
        xsn1: () => { need(2); return Math.sqrt(Math.max(0, (sx2 - sx * sx / n) / (n - 1))); },
        ybar: () => { need(1); return sy / n; }, ysn: () => { need(1); return Math.sqrt(Math.max(0, sy2 / n - (sy / n) ** 2)); },
        ysn1: () => { need(2); return Math.sqrt(Math.max(0, (sy2 - sy * sy / n) / (n - 1))); },
      };
      if (reg) {
        let A, B, C = 0, r = NaN;
        if (t === 'Quad') {
          // least squares y = A + Bx + Cx^2
          const Sxx = sx2 - sx * sx / n, Sxy = sxy - sx * sy / n, Sxx2 = sx3 - sx * sx2 / n, Sx2x2 = sx4 - sx2 * sx2 / n, Sx2y = sx2y - sx2 * sy / n;
          const den = Sxx * Sx2x2 - Sxx2 * Sxx2;
          lazy.regB = () => { need(3); if (Math.abs(den) < 1e-300) throw new M.MathError(M.ERR.DOMAIN); return (Sxy * Sx2x2 - Sx2y * Sxx2) / den; };
          lazy.regC = () => { need(3); return (Sx2y * Sxx - Sxy * Sxx2) / den; };
          lazy.regA = () => (sy - lazy.regB() * sx - lazy.regC() * sx2) / n;
          lazy.regr = () => { throw new M.MathError(M.ERR.SYNTAX, 'r indisponivel em Quad'); };
        } else {
          const SXX = sXX - sX * sX / n, SYY = sYY - sY * sY / n, SXY = sXY - sX * sY / n;
          lazy.regB = () => { need(2); if (SXX === 0) throw new M.MathError(M.ERR.DOMAIN); return SXY / SXX; };
          lazy.regA = () => { const a = (sY - lazy.regB() * sX) / n; return t === 'Exp' || t === 'Pwr' ? Math.exp(a) : a; };
          lazy.regr = () => { need(2); if (SXX * SYY <= 0) throw new M.MathError(M.ERR.DOMAIN); return SXY / Math.sqrt(SXX * SYY); };
        }
        void A; void B; void C; void r;
      }
      return { o, lazy, t };
    }

    ctx() {
      const vars = Object.assign({ Ans: this.ans }, this.vars);
      let st = null;
      const getStats = () => (st = st || this.stats());
      const statNames = ['n', 'sumx', 'sumx2', 'sumy', 'sumy2', 'sumxy', 'sumx3', 'sumx2y', 'sumx4', 'xbar', 'xsn', 'xsn1', 'ybar', 'ysn', 'ysn1', 'regA', 'regB', 'regC', 'regr'];
      if (this.s.calcMode !== 'COMP') {
        for (const k of statNames) Object.defineProperty(vars, k, { enumerable: true, get: () => { const s = getStats(); return k in s.o ? s.o[k] : s.lazy[k](); } });
      }
      return {
        angle: this.s.angle, vars,
        setVar: (k, v) => { this.vars[k] = v; },
        random: () => (this.app.p && this.app.p.random ? this.app.p.random() : Math.floor(Math.random() * 1000) / 1000),
        round: (x) => Number(this.format(x, true)),
        estimate: (name, v) => this.estimate(name, v, getStats()),
      };
    }

    estimate(name, v, st) {
      if (this.s.calcMode !== 'REG') throw new M.MathError(M.ERR.SYNTAX);
      const A = st.lazy.regA(), B = st.lazy.regB(), t = st.t;
      if (name === 'yhat') {
        switch (t) { case 'Lin': return A + B * v; case 'Log': return A + B * Math.log(v); case 'Exp': return A * Math.exp(B * v); case 'Pwr': return A * Math.pow(v, B); case 'Inv': return A + B / v; case 'Quad': return A + B * v + st.lazy.regC() * v * v; }
      }
      if (t === 'Quad') {
        const C = st.lazy.regC(), D = B * B - 4 * C * (A - v);
        if (D < 0 || C === 0) throw new M.MathError(M.ERR.DOMAIN);
        return name === 'xhat2' ? (-B - Math.sqrt(D)) / (2 * C) : (-B + Math.sqrt(D)) / (2 * C);
      }
      switch (t) { case 'Lin': return (v - A) / B; case 'Log': return Math.exp((v - A) / B); case 'Exp': return Math.log(v / A) / B; case 'Pwr': return Math.pow(v / A, 1 / B); case 'Inv': return B / (v - A); }
      throw new M.MathError(M.ERR.SYNTAX);
    }

    /* ------------------------------ formatting ------------------------- */
    format(v, forRnd = false) {
      const s = this.s, d = s.dispDigits == null ? 0 : s.dispDigits;
      const abs = Math.abs(v);
      const sci = (sig) => { const [m, e] = v.toExponential(Math.max(0, sig - 1)).split('e'); return (forRnd ? m : m.replace(/\.?0+$/, '')) + 'E' + (Number(e) < 0 ? '-' : '') + String(Math.abs(Number(e))).padStart(2, '0'); };
      if (v === 0) return forRnd ? '0' : '0';
      if (s.disp === 'fix') {
        if (abs >= 1e10) return forRnd ? String(Number(v.toPrecision(10))) : sci(10);
        const r = v.toFixed(d);
        return forRnd ? r : r;
      }
      if (s.disp === 'sci') {
        const sig = d === 0 ? 10 : d;
        if (forRnd) return String(Number(v.toPrecision(sig)));
        const [m, e] = v.toExponential(sig - 1).split('e');
        return m + 'E' + (Number(e) < 0 ? '-' : '') + String(Math.abs(Number(e))).padStart(2, '0');
      }
      const lowLimit = s.disp === 'norm2' ? 1e-9 : 1e-2;
      if (forRnd) return String(Number(v.toPrecision(10)));
      if (abs >= 1e10 || abs < lowLimit) return sci(10);
      return M.formatNumber(v);
    }
    engFormat(v) {
      if (v === 0) return '0';
      let e = Math.floor(Math.log10(Math.abs(v)) / 3) * 3 + this.engShift * 3;
      const m = v / Math.pow(10, e);
      return Number(m.toPrecision(10)) + 'E' + (e < 0 ? '-' : '') + String(Math.abs(e)).padStart(2, '0');
    }
    dmsFormat(v) {
      const sign = v < 0 ? '-' : '', a = Math.abs(v);
      let d = Math.floor(a), mm = Math.floor((a - d) * 60), ss = Number((((a - d) * 60 - mm) * 60).toFixed(2));
      if (ss >= 60) { ss = 0; mm++; } if (mm >= 60) { mm = 0; d++; }
      return sign + d + '°' + mm + '°' + ss;
    }
    fracFormat(v, improper) {
      const f = M.toFraction(v, 99999);
      if (!f || f.d === 1) return null;
      const n = Math.abs(f.n), sign = f.n < 0 ? '-' : '';
      let text = sign + n + '┘' + f.d;
      if (!improper && n > f.d) text = sign + Math.floor(n / f.d) + '┘' + (n % f.d) + '┘' + f.d;
      return text.replace(/-/g, '').length <= 10 ? text : null; // fx-style digit limit
    }
    resultText() {
      const r = this.result;
      if (!r) return '';
      if (!r.ok) return r.message;
      if (r.label) return r.label;
      let t;
      if (this.view === 'frac') t = this.fracFormat(r.value, this.s.fracFmt === 'dc') || this.format(r.value);
      else if (this.view === 'dms') t = this.dmsFormat(r.value);
      else if (this.view === 'eng') t = this.engFormat(r.value);
      else t = this.format(r.value);
      return this.s.decSep === 'comma' ? t.replace(/\./g, ',') : t;
    }

    /* ------------------------------ editing ---------------------------- */
    put(t, fresh) {
      if (this.evaluated) {
        const cont = !fresh && /^[+\-*/^%!]|^\^|^ n[CP]r $|^(xhat|xhat1|xhat2|yhat)$/.test(t) || t === '^2' || t === '^3' || t === '^(-1)';
        this.tokens = cont ? ['Ans'] : [];
        this.cursor = this.tokens.length; this.evaluated = false; this.result = null; this.view = 'dec'; this.engShift = 0;
      }
      if (this.expr.length + t.length > 99 * 3) return; // input buffer like the original (79-99 steps)
      if (!this.insert && this.cursor < this.tokens.length) this.tokens[this.cursor] = t;
      else this.tokens.splice(this.cursor, 0, t);
      this.cursor++; this.histIdx = -1;
    }

    evaluate(extraPercent) {
      if (!this.tokens.length) return;
      let src = this.expr;
      if (extraPercent) src += '%';
      const r = M.calculate(src, this.ctx());
      this.evaluated = true; this.view = 'dec'; this.engShift = 0;
      if (!r.ok) {
        this.result = { ok: false, message: ERR_NAME[r.error] || 'Math ERROR', code: r.error };
        this.errPos = r.pos;
        return;
      }
      this.result = r;
      this.ans = r.value;
      if (src.includes('┘') && M.toFraction(r.value, 99999) && !Number.isInteger(r.value)) this.view = 'frac'; // fraction in -> fraction out
      this.history.unshift({ tokens: this.tokens.slice().concat(extraPercent ? ['%'] : []), text: this.format(r.value), value: r.value });
      if (this.history.length > 50) this.history.pop();
      if (this.app.saveCalcHistory) this.app.saveCalcHistory();
      this.persist();
    }

    gotoError() {
      // place the cursor on the token containing the error position
      this.evaluated = false; this.result = null;
      let pos = 0, idx = this.tokens.length;
      if (this.errPos >= 0) for (let i = 0; i < this.tokens.length; i++) { pos += M.tokenize ? this.tokens[i].length : 1; if (pos > this.errPos) { idx = i; break; } }
      this.cursor = idx;
    }

    browse(dir) {
      if (!this.history.length) return;
      this.histIdx = Math.min(this.history.length - 1, Math.max(0, this.histIdx + (dir < 0 ? 1 : -1)));
      const h = this.history[this.histIdx];
      this.tokens = h.tokens.slice(); this.cursor = this.tokens.length; this.evaluated = true; this.view = 'dec';
      // REPLAY shows the calculation as it was done (stored result), like the original
      const v = typeof h.value === 'number' ? h.value : Number(h.text);
      this.result = { ok: true, value: v, text: this.format(v) };
    }

    /* ------------------------------ statistics data -------------------- */
    addData() {
      const src = this.expr;
      if (!src) return;
      const [main, freqS] = src.split(';');
      const parts = main.split(',');
      const ev = (e) => { const r = M.calculate(e, this.ctx()); if (!r.ok) throw r; return r.value; };
      try {
        const f = freqS != null ? ev(freqS) : 1;
        if (this.s.calcMode === 'REG') { if (parts.length !== 2) throw { error: 'SYNTAX' }; this.data.push({ x: ev(parts[0]), y: ev(parts[1]), f }); }
        else { if (parts.length !== 1) throw { error: 'SYNTAX' }; this.data.push({ x: ev(parts[0]), f }); }
        if (this.data.length > 80) { this.data.pop(); this.result = { ok: false, message: 'Data Full' }; this.evaluated = true; return; }
        this.persist();
        this.tokens = []; this.cursor = 0; this.evaluated = true; this.dataIdx = -1;
        this.result = { ok: true, value: this.data.length, label: 'n=' + this.data.length };
      } catch (e) {
        this.result = { ok: false, message: ERR_NAME[e.error] || 'Syntax ERROR' }; this.evaluated = true;
      }
    }
    dataView() {
      const d = this.data[this.dataIdx];
      if (!d) return 'sem dados';
      const i = this.dataIdx + 1;
      return this.s.calcMode === 'REG' ? `x${i}=${this.format(d.x)} y${i}=${this.format(d.y)}` : `x${i}=${this.format(d.x)} F=${d.f}`;
    }

    /* ------------------------------ menus ------------------------------ */
    menus() {
      const s = this.s;
      const self = this;
      return {
        mode: { lines: ['COMP SD  REG', ' 1    2   3'], pick: (n) => { if (n === 1) { s.calcMode = 'COMP'; } else if (n === 2) { s.calcMode = 'SD'; self.data = []; } else if (n === 3) { self.menu = 'reg1'; return 'stay'; } else return 'stay'; } , next: 'angle' },
        reg1: { lines: ['Lin  Log  Exp', ' 1    2    3  >'], pick: (n) => { if (n >= 1 && n <= 3) { s.calcMode = 'REG'; s.regType = REG_TYPES[n - 1]; self.data = []; } else return 'stay'; }, right: 'reg2' },
        reg2: { lines: ['Pwr  Inv  Quad', '<1    2    3'], pick: (n) => { if (n >= 1 && n <= 3) { s.calcMode = 'REG'; s.regType = REG_TYPES[n + 2]; self.data = []; } else return 'stay'; }, left: 'reg1' },
        angle: { lines: ['Deg  Rad  Gra', ' 1    2    3'], pick: (n) => { const a = ['deg', 'rad', 'grad'][n - 1]; if (!a) return 'stay'; s.angle = a; }, next: 'fmt' },
        fmt: { lines: ['Fix  Sci  Norm', ' 1    2    3'], pick: (n) => { if (n === 1) { self.menu = 'fix'; return 'stay'; } if (n === 2) { self.menu = 'sci'; return 'stay'; } if (n === 3) { self.menu = 'norm'; return 'stay'; } return 'stay'; }, next: 'disp' },
        fix: { lines: ['Fix 0~9?', ''], digit: (n) => { s.disp = 'fix'; s.dispDigits = n; } },
        sci: { lines: ['Sci 0~9?', ''], digit: (n) => { s.disp = 'sci'; s.dispDigits = n; } },
        norm: { lines: ['Norm 1~2?', ''], digit: (n) => { if (n === 1 || n === 2) { s.disp = 'norm' + n; } else return 'stay'; } },
        disp: { lines: ['Disp', ' 1'], pick: (n) => { if (n === 1) { self.menu = 'disp1'; return 'stay'; } return 'stay'; }, next: 'mode' },
        disp1: { lines: ['ab/c  d/c', ' 1     2   >'], pick: (n) => { if (n === 1) s.fracFmt = 'abc'; else if (n === 2) s.fracFmt = 'dc'; else return 'stay'; }, right: 'disp2' },
        disp2: { lines: ['Dot   Comma', '<1     2'], pick: (n) => { if (n === 1) s.decSep = 'dot'; else if (n === 2) s.decSep = 'comma'; else return 'stay'; }, left: 'disp1' },
        clr: { lines: [(s.calcMode === 'COMP' ? 'Mcl' : 'Scl') + '  Mode  All', ' 1     2    3'], pick: (n) => {
          if (n === 1) { if (s.calcMode === 'COMP') { VARS.forEach(v => { self.vars[v] = 0; }); } else self.data = []; self.persist(); self.flash(s.calcMode === 'COMP' ? 'Mcl' : 'Scl'); }
          else if (n === 2) { self.resetMode(); self.flash('Mode Clear'); }
          else if (n === 3) { self.resetMode(); VARS.forEach(v => { self.vars[v] = 0; }); self.data = []; self.ans = 0; self.history = []; self.persist(); self.flash('All Clear'); }
          else return 'stay';
        } },
        drg: { lines: ['D    R    G', '1    2    3'], pick: (n) => { const u = ['ᵒ', 'ʳ', 'ᵍ'][n - 1]; if (!u) return 'stay'; self.menu = null; self.put(u); return 'done'; } },
        ssum: { lines: () => s.calcMode === 'REG' ? ['Σx²  Σx   n', ' 1    2   3  >'] : ['Σx²  Σx   n', ' 1    2   3'], pick: (n) => self.pickVar(['sumx2', 'sumx', 'n'], n), right: () => s.calcMode === 'REG' ? 'ssum2' : null },
        ssum2: { lines: ['Σy²  Σy  Σxy', '<1    2   3  >'], pick: (n) => self.pickVar(['sumy2', 'sumy', 'sumxy'], n), left: 'ssum', right: () => s.regType === 'Quad' ? 'ssum3' : null },
        ssum3: { lines: ['Σx³ Σx²y Σx⁴', '<1    2   3'], pick: (n) => self.pickVar(['sumx3', 'sumx2y', 'sumx4'], n), left: 'ssum2' },
        svar: { lines: () => ['\uE000   xσn  xσn-1', s.calcMode === 'REG' ? ' 1    2   3  >' : ' 1    2   3'], pick: (n) => self.pickVar(['xbar', 'xsn', 'xsn1'], n), right: () => s.calcMode === 'REG' ? 'svar2' : null },
        svar2: { lines: ['ȳ   yσn  yσn-1', '<1    2   3  >'], pick: (n) => self.pickVar(['ybar', 'ysn', 'ysn1'], n), left: 'svar', right: 'svar3' },
        svar3: { lines: () => s.regType === 'Quad' ? ['A    B    C', '<1    2   3  >'] : ['A    B    r', '<1    2   3  >'], pick: (n) => self.pickVar(s.regType === 'Quad' ? ['regA', 'regB', 'regC'] : ['regA', 'regB', 'regr'], n), left: 'svar2', right: 'svar4' },
        svar4: { lines: () => s.regType === 'Quad' ? ['\uE0011  \uE0012   ŷ', '<1    2   3'] : ['\uE001    ŷ', '<1    2'], pick: (n) => self.pickVar(s.regType === 'Quad' ? ['xhat1', 'xhat2', 'yhat'] : ['xhat', 'yhat'], n), left: 'svar3' },
      };
    }
    pickVar(list, n) { const t = list[n - 1]; if (!t) return 'stay'; this.menu = null; this.put(t); return 'done'; }
    resetMode() { const s = this.s; s.calcMode = 'COMP'; s.angle = 'deg'; s.disp = 'norm1'; s.dispDigits = 0; s.fracFmt = 'abc'; s.decSep = 'dot'; s.regType = 'Lin'; this.data = []; }
    flash(t) { this.evaluated = true; this.result = { ok: true, value: 0, label: t }; this.tokens = []; this.cursor = 0; }

    menuKey(k) {
      const all = this.menus();
      const m = all[this.menu];
      const resolve = (x) => (typeof x === 'function' ? x() : x);
      if (k === 'AC') { this.menu = null; return; }
      if (k === 'MODE' && m.next) { this.menu = m.next; return; }
      if (k === 'RIGHT' && resolve(m.right)) { this.menu = resolve(m.right); return; }
      if (k === 'LEFT' && resolve(m.left)) { this.menu = resolve(m.left); return; }
      if (/^[0-9]$/.test(k)) {
        const n = Number(k);
        if (m.digit) { if (m.digit(n) !== 'stay') { this.menu = null; this.save(); } return; }
        if (m.pick) { const r = m.pick(n); if (r !== 'stay' && r !== 'done' && this.menu === this.menu) this.menu = null; if (r !== 'stay') this.save(); }
      }
    }
    save() { if (this.app.saveSettings) this.app.saveSettings(); }

    /* ------------------------------ keys ------------------------------- */
    /** e = {key, shift, alpha} with modifiers already resolved by the app */
    key(e) {
      const k = e.key;
      if (this.menu) { this.menuKey(k); return; }
      if (this.pending === 'STO' || this.pending === 'RCL') {
        const map = KEYMAP[k];
        const v = map && map[2];
        const mode = this.pending; this.pending = null;
        if (!v || !VARS.includes(v)) return;
        if (mode === 'STO') {
          const val = this.currentValue();
          if (val == null) return;
          this.vars[v] = val; this.ans = val; this.persist();
          this.evaluated = true; this.result = { ok: true, value: val, text: this.format(val) };
          this.stoFlash = v;
        } else {
          const val = this.vars[v];
          this.tokens = [v]; this.cursor = 1; this.evaluated = true; this.result = { ok: true, value: val }; this.ans = val;
        }
        return;
      }
      if ((k === 'UP' || k === 'DOWN') && this.s.calcMode !== 'COMP' && this.data.length && (!this.tokens.length || this.dataIdx >= 0)) {
        this.dataIdx = Math.max(0, Math.min(this.data.length - 1, this.dataIdx < 0 ? (k === 'UP' ? this.data.length - 1 : 0) : this.dataIdx + (k === 'UP' ? -1 : 1)));
        this.tokens = []; this.cursor = 0; this.evaluated = true; this.result = { ok: true, value: 0, label: this.dataView() };
        return;
      }
      if (this.result && !this.result.ok && (k === 'LEFT' || k === 'RIGHT')) { this.gotoError(); return; }
      switch (k) {
        case 'LEFT': if (this.evaluated) { this.evaluated = false; this.result = null; this.cursor = this.tokens.length; } else if (this.cursor > 0) this.cursor--; return;
        case 'RIGHT': if (this.evaluated) { this.evaluated = false; this.result = null; this.cursor = 0; } else if (this.cursor < this.tokens.length) this.cursor++; return;
        case 'UP': this.browse(-1); return;
        case 'DOWN': this.browse(1); return;
        default: break;
      }
      const map = KEYMAP[k];
      if (!map) return;
      let action = e.alpha && map[2] ? map[2] : e.shift && map[1] !== undefined ? map[1] : map[0];
      if (action == null) return;
      if (this.hyp && /^(a?)(sin|cos|tan)\($/.test(action)) { action = action.replace('(', 'h('); this.hyp = false; }
      if (e.alpha && map[2]) { this.put(action); return; }  // variable name
      if (k === 'NEG') { this.put('-', true); return; }       // (−) never continues from Ans
      if (action[0] !== '@') { this.put(action); return; }
      this.action(action.slice(1));
    }

    currentValue() {
      if (this.evaluated && this.result && this.result.ok && !this.result.label) return this.result.value;
      if (!this.tokens.length) return this.ans;
      const r = M.calculate(this.expr, this.ctx());
      if (!r.ok) { this.result = { ok: false, message: ERR_NAME[r.error] || 'Math ERROR' }; this.evaluated = true; return null; }
      this.ans = r.value;
      return r.value;
    }

    action(a) {
      const s = this.s;
      switch (a) {
        case 'EQ': if (this.dataIdx >= 0 && this.tokens.length) { return this.editData(); } return this.evaluate(false);
        case 'PCT': return this.evaluate(true);
        case 'DEL':
          if (this.evaluated) { this.evaluated = false; this.result = null; this.cursor = this.tokens.length; return; }
          if (!this.insert && this.cursor < this.tokens.length) this.tokens.splice(this.cursor, 1);
          else if (this.cursor > 0) { this.tokens.splice(this.cursor - 1, 1); this.cursor--; }
          return;
        case 'INS': this.insert = !this.insert; return;
        case 'AC': this.clear(); return;
        case 'OFF': if (this.app.powerOff) this.app.powerOff(); return;
        case 'MODE': this.menu = 'mode'; return;
        case 'CLR': this.menu = 'clr'; return;
        case 'DRG': this.menu = 'drg'; return;
        case 'SSUM': if (s.calcMode !== 'COMP') this.menu = 'ssum'; return;
        case 'SVAR': if (s.calcMode !== 'COMP') this.menu = 'svar'; return;
        case 'HYP': this.hyp = !this.hyp; return;
        case 'STO': this.pending = 'STO'; return;
        case 'RCL': this.pending = 'RCL'; return;
        case 'MPLUS':
          if (s.calcMode !== 'COMP') return this.addData(); // DT
          { const v = this.currentValue(); if (v == null) return; this.vars.M += v; this.persist(); this.evaluated = true; this.result = { ok: true, value: v }; }
          return;
        case 'MMINUS':
          if (s.calcMode !== 'COMP') { // CL: delete the displayed (or last) data item
            const i = this.dataIdx >= 0 ? this.dataIdx : this.data.length - 1;
            if (i >= 0) this.data.splice(i, 1);
            this.dataIdx = -1; this.persist(); this.flash('n=' + this.data.length);
            return;
          }
          { const v = this.currentValue(); if (v == null) return; this.vars.M -= v; this.persist(); this.evaluated = true; this.result = { ok: true, value: v }; }
          return;
        case 'ENG': if (this.evaluated && this.result && this.result.ok) { if (this.view === 'eng') this.engShift--; this.view = 'eng'; } return;
        case 'ENGBACK': if (this.evaluated && this.result && this.result.ok) { if (this.view === 'eng') this.engShift++; this.view = 'eng'; } return;
        case 'ABC': if (this.evaluated && this.result && this.result.ok) { this.view = this.view === 'frac' ? 'dec' : (this.fracFormat(this.result.value, s.fracFmt === 'dc') ? 'frac' : 'dec'); } else this.put('┘'); return;
        case 'DC': if (this.evaluated && this.result && this.result.ok && this.view === 'frac') { s.fracFmt = s.fracFmt === 'dc' ? 'abc' : 'dc'; } return;
        case 'DMSBACK': if (this.evaluated && this.result && this.result.ok) this.view = this.view === 'dms' ? 'dec' : 'dms'; return;
        default: return;
      }
    }

    editData() {
      const r = M.calculate(this.expr, this.ctx());
      if (r.ok && this.data[this.dataIdx]) { this.data[this.dataIdx].x = r.value; this.persist(); }
      this.tokens = []; this.cursor = 0; this.evaluated = true; this.result = { ok: true, value: 0, label: this.dataView() };
    }

    /* ------------------------------ rendering -------------------------- */
    indicators() {
      const s = this.s, out = [];
      if (this.app.shift) out.push('S');
      if (this.app.alpha) out.push('A');
      if (this.vars.M !== 0) out.push('M');
      if (this.pending === 'STO') out.push('STO');
      if (this.pending === 'RCL') out.push('RCL');
      if (s.calcMode === 'SD') out.push('SD');
      if (s.calcMode === 'REG') out.push('REG');
      out.push({ deg: 'D', rad: 'R', grad: 'G' }[s.angle] || 'D');
      if (s.disp === 'fix') out.push('FIX');
      if (s.disp === 'sci') out.push('SCI');
      if (this.hyp) out.push('HYP');
      if (this.insert) out.push('INS');
      if (this.history.length && this.evaluated) out.push('^');
      return out;
    }

    render(fb, opts = {}) {
      fb.drawTiny(1, 0, this.indicators().join(' '));
      if (this.menu) {
        const m = this.menus()[this.menu];
        const lines = typeof m.lines === 'function' ? m.lines() : m.lines;
        fb.drawText(2, 10, lines[0]);
        fb.drawText(2, 20, lines[1] || '');
        return;
      }
      const cols = Math.floor((fb.width - 4) / 6);
      const parts = this.tokens.map(t => Font.normalize(PRETTY[t] != null ? PRETTY[t] : M.pretty(t)));
      const text = parts.join('');
      const curChar = parts.slice(0, this.cursor).join('').length;
      if (curChar < this.hoff) this.hoff = curChar;
      if (curChar > this.hoff + cols - 1) this.hoff = curChar - cols + 1;
      if (this.evaluated) this.hoff = Math.max(0, text.length - cols);
      fb.drawText(2, 7, text.slice(this.hoff, this.hoff + cols));
      if (this.hoff > 0) fb.setPixel(0, 10);
      if (text.length - this.hoff > cols) fb.setPixel(fb.width - 1, 10);
      if (!this.evaluated && opts.cursorOn) {
        const x = 1 + (curChar - this.hoff) * 6;
        if (this.insert) fb.vline(x, 7, 8); else fb.hline(x + 1, 14, 5);
      }
      const r = this.resultText();
      if (!r) return;
      if (this.result && !this.result.ok) { fb.drawText(2, 20, r); return; }
      const big = Framebuffer.textWidth(r, 2) <= fb.width - 2 && opts.scale !== 1;
      const w = Framebuffer.textWidth(r, big ? 2 : 1);
      fb.drawText(Math.max(0, fb.width - w - 1), big ? 16 : 22, r, { scale: big ? 2 : 1 });
    }
  }

  return { SciCalc, KEYMAP, VARS, ERR_NAME, PRETTY };
});
