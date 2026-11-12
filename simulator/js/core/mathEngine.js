/*
 * Deterministic offline math engine.
 *
 * - Own tokenizer + recursive-descent parser (no eval / Function()).
 * - Precedence: ( )  >  postfix (! % ²)  >  ^ (right assoc)  >  unary -  >  * / implicit  >  + -
 *   so -2^2 = -4 and 2^3^2 = 2^9.
 * - Degrees/radians, domain checks, division by zero, overflow.
 * - Step-by-step reduction of the expression tree (used by "resolução completa").
 *
 * Mirrored in C by firmware/components/math_engine (same grammar and error codes).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MT = root.MT || {}; root.MT.MathEngine = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_LEN = 256;
  const MAX_DEPTH = 64;
  const MAX_STEPS = 200;

  const ERR = {
    SYNTAX: 'SYNTAX', DOMAIN: 'DOMAIN', DIV_ZERO: 'DIV_ZERO', OVERFLOW: 'OVERFLOW',
    UNKNOWN: 'UNKNOWN', ARGS: 'ARGS', TOO_LONG: 'TOO_LONG', DEPTH: 'DEPTH'
  };
  const ERR_TEXT = {
    SYNTAX: 'Erro de sintaxe', DOMAIN: 'Erro de dominio', DIV_ZERO: 'Divisao por zero',
    OVERFLOW: 'Estouro numerico', UNKNOWN: 'Nome desconhecido', ARGS: 'Argumentos invalidos',
    TOO_LONG: 'Expressao longa demais', DEPTH: 'Aninhamento excessivo'
  };

  class MathError extends Error {
    constructor(code, detail, pos) {
      super(ERR_TEXT[code] + (detail ? ': ' + detail : ''));
      this.code = code; this.detail = detail || ''; this.pos = pos == null ? -1 : pos;
    }
  }

  const CONSTANTS = { pi: Math.PI, e: Math.E };

  // name -> [minArgs, maxArgs]
  const FUNCTIONS = {
    sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1],
    sinh: [1, 1], cosh: [1, 1], tanh: [1, 1], asinh: [1, 1], acosh: [1, 1], atanh: [1, 1],
    sqrt: [1, 1], cbrt: [1, 1], root: [2, 2], ln: [1, 1], log: [1, 2], log2: [1, 1], exp: [1, 1],
    abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 1], nCr: [2, 2], nPr: [2, 2]
  };

  const FN_RULE = {
    sin: 'Seno', cos: 'Cosseno', tan: 'Tangente', asin: 'Arco-seno', acos: 'Arco-cosseno', atan: 'Arco-tangente',
    sinh: 'Seno hiperbolico', cosh: 'Cosseno hiperbolico', tanh: 'Tangente hiperbolica',
    asinh: 'Arco-seno hiperb.', acosh: 'Arco-cosseno hiperb.', atanh: 'Arco-tangente hiperb.',
    sqrt: 'Raiz quadrada', cbrt: 'Raiz cubica', root: 'Raiz n-esima', ln: 'Logaritmo natural',
    log: 'Logaritmo', log2: 'Logaritmo base 2', exp: 'Exponencial', abs: 'Valor absoluto',
    floor: 'Piso', ceil: 'Teto', round: 'Arredondamento', nCr: 'Combinacao', nPr: 'Arranjo'
  };

  /* ------------------------------------------------------------------ */
  /* Tokenizer                                                           */
  /* ------------------------------------------------------------------ */

  function normalizeInput(src) {
    return String(src)
      .replace(/×/g, '*').replace(/·/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
      .replace(/π/g, 'pi').replace(/√/g, 'sqrt').replace(/²/g, '^2').replace(/³/g, '^3')
      .replace(/⁻¹/g, '^(-1)');
  }

  function tokenize(src) {
    const s = normalizeInput(src);
    if (s.length > MAX_LEN) throw new MathError(ERR.TOO_LONG);
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') { i++; continue; }
      if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        const start = i;
        while (i < s.length && /[0-9]/.test(s[i])) i++;
        if (s[i] === '.') { i++; while (i < s.length && /[0-9]/.test(s[i])) i++; }
        if (s[i] === '.') throw new MathError(ERR.SYNTAX, 'ponto duplicado', i);
        // scientific notation: E or e followed by optional sign and digits (E is the EXP key)
        if ((s[i] === 'E') && /[-+0-9]/.test(s[i + 1] || '')) {
          let j = i + 1;
          if (s[j] === '+' || s[j] === '-') j++;
          if (!/[0-9]/.test(s[j] || '')) throw new MathError(ERR.SYNTAX, 'expoente', i);
          while (j < s.length && /[0-9]/.test(s[j])) j++;
          i = j;
        }
        const text = s.slice(start, i);
        toks.push({ t: 'num', v: parseFloat(text), text, pos: start });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const start = i;
        while (i < s.length && /[A-Za-z_0-9]/.test(s[i])) i++;
        toks.push({ t: 'id', v: s.slice(start, i), pos: start });
        continue;
      }
      if ('+-*/^!%'.includes(c)) { toks.push({ t: 'op', v: c, pos: i }); i++; continue; }
      if (c === '(') { toks.push({ t: 'lp', pos: i }); i++; continue; }
      if (c === ')') { toks.push({ t: 'rp', pos: i }); i++; continue; }
      if (c === ',' || c === ';') { toks.push({ t: 'comma', pos: i }); i++; continue; }
      throw new MathError(ERR.SYNTAX, 'caractere "' + c + '"', i);
    }
    toks.push({ t: 'end', pos: s.length });
    return toks;
  }

  /* ------------------------------------------------------------------ */
  /* Parser                                                              */
  /* ------------------------------------------------------------------ */

  function parse(src, opts = {}) {
    const toks = tokenize(src);
    let p = 0;
    let depth = 0;
    const isVar = opts.isVariable || (() => true);
    const peek = () => toks[p];
    const next = () => toks[p++];
    const enter = () => { if (++depth > MAX_DEPTH) throw new MathError(ERR.DEPTH); };
    const leave = () => { depth--; };

    function startsPrimary(tk) {
      return tk.t === 'num' || tk.t === 'id' || tk.t === 'lp';
    }

    function parseExpr() {
      enter();
      let left = parseTerm();
      while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = next().v;
        const right = parseTerm();
        left = { t: 'bin', op, a: left, b: right };
      }
      leave();
      return left;
    }

    function parseTerm() {
      let left = parseUnary();
      for (;;) {
        const tk = peek();
        if (tk.t === 'op' && (tk.v === '*' || tk.v === '/')) {
          next();
          left = { t: 'bin', op: tk.v, a: left, b: parseUnary() };
        } else if (startsPrimary(tk)) {
          // implicit multiplication: 2pi, 3(4), (1)(2), 2sqrt(4)
          left = { t: 'bin', op: '*', a: left, b: parseUnary(), implicit: true };
        } else break;
      }
      return left;
    }

    function parseUnary() {
      const tk = peek();
      if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
        next();
        enter();
        const a = parseUnary();
        leave();
        return tk.v === '-' ? { t: 'neg', a } : a;
      }
      return parsePower();
    }

    function parsePower() {
      const base = parsePostfix();
      if (peek().t === 'op' && peek().v === '^') {
        next();
        enter();
        const exp = parseUnary(); // right associative, allows 2^-1
        leave();
        return { t: 'bin', op: '^', a: base, b: exp };
      }
      return base;
    }

    function parsePostfix() {
      let a = parsePrimary();
      while (peek().t === 'op' && (peek().v === '!' || peek().v === '%')) {
        const op = next().v;
        a = op === '!' ? { t: 'fact', a } : { t: 'pct', a };
      }
      return a;
    }

    function parsePrimary() {
      const tk = next();
      if (tk.t === 'num') {
        if (!isFinite(tk.v)) throw new MathError(ERR.OVERFLOW);
        return { t: 'num', v: tk.v };
      }
      if (tk.t === 'lp') {
        const e = parseExpr();
        if (peek().t === 'rp') next();
        else if (peek().t !== 'end') throw new MathError(ERR.SYNTAX, 'falta ")"', peek().pos);
        // missing closing parenthesis at the end of input is tolerated (calculator behaviour)
        return { t: 'paren', a: e };
      }
      if (tk.t === 'id') {
        const name = tk.v;
        if (FUNCTIONS[name] && peek().t === 'lp') {
          next();
          const args = [];
          enter();
          if (peek().t !== 'rp') {
            args.push(parseExpr());
            while (peek().t === 'comma') { next(); args.push(parseExpr()); }
          }
          leave();
          if (peek().t === 'rp') next();
          else if (peek().t !== 'end') throw new MathError(ERR.SYNTAX, 'falta ")"', peek().pos);
          const [mn, mx] = FUNCTIONS[name];
          if (args.length < mn || args.length > mx) throw new MathError(ERR.ARGS, name);
          return { t: 'fn', name, args };
        }
        if (FUNCTIONS[name]) throw new MathError(ERR.SYNTAX, name + ' requer "("', tk.pos);
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return { t: 'const', name };
        if (!isVar(name)) throw new MathError(ERR.UNKNOWN, name, tk.pos);
        return { t: 'var', name };
      }
      if (tk.t === 'end') throw new MathError(ERR.SYNTAX, 'expressao incompleta', tk.pos);
      throw new MathError(ERR.SYNTAX, 'token inesperado', tk.pos);
    }

    const ast = parseExpr();
    if (peek().t === 'rp') throw new MathError(ERR.SYNTAX, '")" sem par', peek().pos);
    if (peek().t !== 'end') throw new MathError(ERR.SYNTAX, 'token inesperado', peek().pos);
    return ast;
  }

  /* ------------------------------------------------------------------ */
  /* Evaluation                                                          */
  /* ------------------------------------------------------------------ */

  const SNAP = 1e-12;
  function snap(v) { return Math.abs(v) < SNAP ? 0 : v; }

  function check(v) {
    if (Number.isNaN(v)) throw new MathError(ERR.DOMAIN);
    if (!isFinite(v)) throw new MathError(ERR.OVERFLOW);
    return v === 0 ? 0 : v; // normalise -0
  }

  function isInt(v) { return Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9; }

  function toRad(x, ctx) {
    if (ctx.angle === 'deg') return (x % 360) * Math.PI / 180;
    return x;
  }
  function fromRad(x, ctx) { return ctx.angle === 'deg' ? x * 180 / Math.PI : x; }

  function factorial(n) {
    if (!isInt(n) || n < 0) throw new MathError(ERR.DOMAIN, 'fatorial');
    n = Math.round(n);
    if (n > 170) throw new MathError(ERR.OVERFLOW);
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }

  function power(a, b) {
    if (a === 0 && b === 0) throw new MathError(ERR.DOMAIN, '0^0');
    if (a === 0 && b < 0) throw new MathError(ERR.DIV_ZERO);
    if (a < 0 && !isInt(b)) {
      // real odd root of a negative number: (-8)^(1/3) = -2
      const f = toFraction(b, 99);
      if (f && f.d % 2 === 1) {
        const mag = Math.pow(-a, Math.abs(f.n) / f.d);
        const signed = (f.n % 2 === 0) ? mag : -mag;
        return f.n < 0 ? 1 / signed : signed;
      }
      throw new MathError(ERR.DOMAIN, 'base negativa');
    }
    return Math.pow(a, b);
  }

  function applyFn(name, args, ctx) {
    const x = args[0];
    switch (name) {
      case 'sin': return snap(Math.sin(toRad(x, ctx)));
      case 'cos': return snap(Math.cos(toRad(x, ctx)));
      case 'tan': {
        const r = toRad(x, ctx);
        if (Math.abs(Math.cos(r)) < SNAP) throw new MathError(ERR.DOMAIN, 'tan');
        return snap(Math.tan(r));
      }
      case 'asin': if (x < -1 || x > 1) throw new MathError(ERR.DOMAIN, 'asin'); return fromRad(Math.asin(x), ctx);
      case 'acos': if (x < -1 || x > 1) throw new MathError(ERR.DOMAIN, 'acos'); return fromRad(Math.acos(x), ctx);
      case 'atan': return fromRad(Math.atan(x), ctx);
      case 'sinh': return Math.sinh(x);
      case 'cosh': return Math.cosh(x);
      case 'tanh': return Math.tanh(x);
      case 'asinh': return Math.asinh(x);
      case 'acosh': if (x < 1) throw new MathError(ERR.DOMAIN, 'acosh'); return Math.acosh(x);
      case 'atanh': if (x <= -1 || x >= 1) throw new MathError(ERR.DOMAIN, 'atanh'); return Math.atanh(x);
      case 'sqrt': if (x < 0) throw new MathError(ERR.DOMAIN, 'raiz de negativo'); return Math.sqrt(x);
      case 'cbrt': return Math.cbrt(x);
      case 'root': {
        const n = args[0], v = args[1];
        if (n === 0) throw new MathError(ERR.DOMAIN, 'indice 0');
        if (v < 0) {
          if (isInt(n) && Math.round(n) % 2 !== 0) return -Math.pow(-v, 1 / n);
          throw new MathError(ERR.DOMAIN, 'raiz par de negativo');
        }
        return Math.pow(v, 1 / n);
      }
      case 'ln': if (x <= 0) throw new MathError(ERR.DOMAIN, 'ln'); return Math.log(x);
      case 'log': {
        if (args.length === 2) {
          const b = args[0], v = args[1];
          if (b <= 0 || b === 1 || v <= 0) throw new MathError(ERR.DOMAIN, 'log');
          return Math.log(v) / Math.log(b);
        }
        if (x <= 0) throw new MathError(ERR.DOMAIN, 'log');
        return Math.log10(x);
      }
      case 'log2': if (x <= 0) throw new MathError(ERR.DOMAIN, 'log2'); return Math.log2(x);
      case 'exp': return Math.exp(x);
      case 'abs': return Math.abs(x);
      case 'floor': return Math.floor(x);
      case 'ceil': return Math.ceil(x);
      case 'round': return Math.round(x);
      case 'nCr': case 'nPr': {
        const n = args[0], r = args[1];
        if (!isInt(n) || !isInt(r) || n < 0 || r < 0 || r > n) throw new MathError(ERR.DOMAIN, name);
        if (name === 'nPr') return factorial(n) / factorial(n - r);
        let k = Math.min(r, n - r), res = 1;
        for (let i = 1; i <= k; i++) res = res * (n - k + i) / i;
        return Math.round(res);
      }
      default: throw new MathError(ERR.UNKNOWN, name);
    }
  }

  function lookupVar(name, ctx) {
    const vars = ctx.vars || {};
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      if (typeof v !== 'number' || !isFinite(v)) throw new MathError(ERR.UNKNOWN, name);
      return v;
    }
    throw new MathError(ERR.UNKNOWN, name);
  }

  function evalNode(n, ctx) {
    switch (n.t) {
      case 'num': return n.v;
      case 'paren': return evalNode(n.a, ctx);
      case 'const': return CONSTANTS[n.name];
      case 'var': return lookupVar(n.name, ctx);
      case 'neg': return check(-evalNode(n.a, ctx));
      case 'fact': return check(factorial(evalNode(n.a, ctx)));
      case 'pct': return check(evalNode(n.a, ctx) / 100);
      case 'fn': return check(applyFn(n.name, n.args.map(a => evalNode(a, ctx)), ctx));
      case 'bin': {
        const a = evalNode(n.a, ctx);
        // calculator percentage: 200 + 10% = 220
        if ((n.op === '+' || n.op === '-') && n.b.t === 'pct') {
          const p = evalNode(n.b.a, ctx);
          return check(n.op === '+' ? a + a * p / 100 : a - a * p / 100);
        }
        const b = evalNode(n.b, ctx);
        return check(binop(n.op, a, b));
      }
      default: throw new MathError(ERR.SYNTAX);
    }
  }

  function binop(op, a, b) {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': if (b === 0) throw new MathError(ERR.DIV_ZERO); return a / b;
      case '^': return power(a, b);
      default: throw new MathError(ERR.SYNTAX);
    }
  }

  function evaluate(src, ctx = {}) {
    const ast = typeof src === 'string' ? parse(src) : src;
    return evalNode(ast, Object.assign({ angle: 'rad', vars: {} }, ctx));
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  function trimZeros(s) {
    if (s.indexOf('.') < 0) return s;
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }

  function formatNumber(v, sig = 10) {
    if (Number.isNaN(v)) return 'NaN';
    if (!isFinite(v)) return v > 0 ? '∞' : '-∞';
    if (v === 0) return '0';
    const abs = Math.abs(v);
    // round to significant digits first to find the real exponent
    const rounded = Number(v.toPrecision(sig));
    const exp = Math.floor(Math.log10(Math.abs(rounded)));
    if (exp >= sig || exp < -9) {
      const [m, e] = rounded.toExponential(sig - 1).split('e');
      return trimZeros(m) + 'E' + String(parseInt(e, 10));
    }
    const decimals = Math.max(0, Math.min(20, sig - 1 - exp));
    let s = rounded.toFixed(decimals);
    s = trimZeros(s);
    if (s === '-0') s = '0';
    void abs;
    return s;
  }

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }

  /** Best rational approximation p/q with q <= maxDen, accepted only if (almost) exact. */
  function toFraction(x, maxDen = 9999) {
    if (!isFinite(x)) return null;
    if (isInt(x)) return { n: Math.round(x), d: 1 };
    const sign = x < 0 ? -1 : 1;
    let v = Math.abs(x);
    let h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = v;
    for (let i = 0; i < 40; i++) {
      const a = Math.floor(b);
      const h2 = a * h1 + h0, k2 = a * k1 + k0;
      if (k2 > maxDen) break;
      h0 = h1; h1 = h2; k0 = k1; k1 = k2;
      if (Math.abs(v - h1 / k1) < 1e-10 * Math.max(1, v)) {
        const g = gcd(h1, k1);
        return { n: sign * h1 / g, d: k1 / g };
      }
      const frac = b - a;
      if (frac < 1e-15) break;
      b = 1 / frac;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Printing (AST -> text) and pretty display                           */
  /* ------------------------------------------------------------------ */

  function prec(n) {
    switch (n.t) {
      case 'bin': return n.op === '+' || n.op === '-' ? 1 : n.op === '^' ? 4 : 2;
      case 'neg': return 3;
      case 'fact': case 'pct': return 5;
      case 'num': return n.v < 0 ? 3 : 6;
      default: return 6;
    }
  }

  function printAst(n, fmt = formatNumber) {
    function wrap(child, cond) { const s = pr(child); return cond ? '(' + s + ')' : s; }
    function pr(n) {
      switch (n.t) {
        case 'num': return fmt(n.v);
        case 'paren': return '(' + pr(n.a) + ')';
        case 'const': return n.name;
        case 'var': return n.name;
        case 'neg': return '-' + wrap(n.a, prec(n.a) < 3 || (n.a.t === 'num' && n.a.v < 0) || n.a.t === 'neg');
        case 'fact': return wrap(n.a, prec(n.a) < 6) + '!';
        case 'pct': return wrap(n.a, prec(n.a) < 6) + '%';
        case 'fn': return n.name + '(' + n.args.map(pr).join(',') + ')';
        case 'bin': {
          const p = prec(n);
          let left, right;
          if (n.op === '^') {
            left = wrap(n.a, prec(n.a) <= 4);
            right = wrap(n.b, prec(n.b) < 3);
          } else {
            left = wrap(n.a, prec(n.a) < p);
            const rightNeedsParens = prec(n.b) < p || (prec(n.b) === p && (n.op === '-' || n.op === '/')) ||
              (n.b.t === 'num' && n.b.v < 0) || n.b.t === 'neg';
            right = wrap(n.b, rightNeedsParens);
          }
          return left + n.op + right;
        }
        default: return '?';
      }
    }
    return pr(n);
  }

  /** Display form for the LCD (uses the extra glyphs of the bitmap font). */
  function pretty(s) {
    return String(s).replace(/sqrt\(/g, '√(').replace(/\bpi\b/g, 'π').replace(/\*/g, '×').replace(/\//g, '÷');
  }

  /* ------------------------------------------------------------------ */
  /* Step-by-step resolution                                             */
  /* ------------------------------------------------------------------ */

  function clone(n) { return JSON.parse(JSON.stringify(n)); }

  function isNum(n) { return n.t === 'num'; }

  const OP_RULE = { '+': 'Soma', '-': 'Subtracao', '*': 'Multiplicacao', '/': 'Divisao', '^': 'Potencia' };

  /**
   * Reduce the tree one operation at a time (leftmost innermost first, which
   * respects precedence because it is encoded in the tree).
   */
  function solveSteps(src, ctx = {}) {
    const c = Object.assign({ angle: 'rad', vars: {} }, ctx);
    const ast = typeof src === 'string' ? parse(src) : src;
    const steps = [];
    let tree = clone(ast);
    steps.push({ rule: 'Expressao original', expr: printAst(tree) });

    // 1) substitute constants and variables in a single step
    let substituted = [];
    (function sub(n, parent, key) {
      if (n.t === 'const' || n.t === 'var') {
        const v = n.t === 'const' ? CONSTANTS[n.name] : lookupVar(n.name, c);
        substituted.push(n.name + '=' + formatNumber(v));
        const repl = { t: 'num', v };
        if (parent) parent[key] = repl; else tree = repl;
        return;
      }
      if (n.a) sub(n.a, n, 'a');
      if (n.b) sub(n.b, n, 'b');
      if (n.args) n.args.forEach((x, i) => sub(x, n.args, i));
    })(tree, null, null);
    if (substituted.length) steps.push({ rule: 'Substituicao: ' + Array.from(new Set(substituted)).join(', '), expr: printAst(tree) });

    function reduceOnce(n, parent, key) {
      // returns rule name if a reduction happened
      if (n.t === 'num') return null;
      if (n.t === 'paren') {
        if (isNum(n.a)) { const repl = n.a; if (parent) parent[key] = repl; else tree = repl; return 'Remocao de parenteses'; }
        return reduceOnce(n.a, n, 'a');
      }
      const kids = [];
      if (n.a) kids.push([n, 'a', n.a]);
      if (n.b && !(n.t === 'bin' && (n.op === '+' || n.op === '-') && n.b.t === 'pct' && isNum(n.b.a))) kids.push([n, 'b', n.b]);
      if (n.args) n.args.forEach((x, i) => kids.push([n.args, i, x]));
      for (const [par, k, child] of kids) {
        const r = reduceOnce(child, par, k);
        if (r) return r;
      }
      const v = evalNode(n, c);
      let rule;
      if (n.t === 'bin') {
        rule = (n.b.t === 'pct') ? 'Porcentagem' : OP_RULE[n.op];
      } else if (n.t === 'fn') rule = FN_RULE[n.name] || n.name;
      else if (n.t === 'neg') rule = 'Sinal';
      else if (n.t === 'fact') rule = 'Fatorial';
      else if (n.t === 'pct') rule = 'Porcentagem';
      else rule = 'Calculo';
      const before = printAst(n);
      const repl = { t: 'num', v };
      if (parent) parent[key] = repl; else tree = repl;
      return rule + ': ' + before + ' = ' + formatNumber(v);
    }

    // parentheses around a single number are removed silently (not a step)
    function stripNumParens(n, parent, key) {
      if (n.t === 'paren' && isNum(n.a)) { if (parent) parent[key] = n.a; else tree = n.a; return; }
      if (n.a) stripNumParens(n.a, n, 'a');
      if (n.b) stripNumParens(n.b, n, 'b');
      if (n.args) n.args.forEach((x, i) => stripNumParens(x, n.args, i));
    }

    let guard = 0;
    while (tree.t !== 'num' && guard++ < MAX_STEPS) {
      const rule = reduceOnce(tree, null, null);
      if (!rule) break;
      stripNumParens(tree, null, null);
      steps.push({ rule, expr: printAst(tree) });
    }
    const value = tree.t === 'num' ? tree.v : evalNode(ast, c);
    return { steps, value, truncated: guard >= MAX_STEPS };
  }

  /** Convenience wrapper used by the calculator UI. Never throws. */
  function calculate(src, ctx = {}) {
    try {
      const value = evaluate(src, ctx);
      return { ok: true, value, text: formatNumber(value), fraction: toFraction(value) };
    } catch (e) {
      if (e instanceof MathError) return { ok: false, error: e.code, message: e.message, pos: e.pos };
      return { ok: false, error: ERR.SYNTAX, message: ERR_TEXT.SYNTAX, pos: -1 };
    }
  }

  return {
    ERR, ERR_TEXT, MathError, CONSTANTS, FUNCTIONS, MAX_LEN,
    tokenize, parse, evaluate, calculate, formatNumber, toFraction, printAst, pretty, solveSteps, gcd
  };
});
