/*
 * Parametrised offline math tools with step-by-step explanations:
 * linear/quadratic equations, small linear systems (Gaussian elimination),
 * basic matrices, descriptive statistics and value tables.
 * Every function returns { ok, lines:[...], ... } where lines are display
 * lines; "math" lines are flagged so the reader can scroll them horizontally.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mathEngine.js'));
  else { root.MT = root.MT || {}; root.MT.Solvers = factory(root.MT.MathEngine); }
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  const f = (v) => M.formatNumber(v);
  const EPS = 1e-12;
  const T = (text) => ({ kind: 'text', text });
  const X = (text) => ({ kind: 'math', text });
  const H = (text) => ({ kind: 'title', text });

  function num(v, name) {
    if (typeof v !== 'number' || !isFinite(v)) throw new M.MathError(M.ERR.ARGS, name || 'valor');
    return v;
  }

  function linear(a, b) {
    num(a, 'a'); num(b, 'b');
    const lines = [H('Equacao do 1o grau'), X(`${f(a)}x + ${f(b)} = 0`)];
    if (Math.abs(a) < EPS) {
      if (Math.abs(b) < EPS) { lines.push(T('a = 0 e b = 0: infinitas solucoes.')); return { ok: true, kind: 'infinite', lines }; }
      lines.push(T('a = 0 e b != 0: sem solucao.'));
      return { ok: true, kind: 'none', lines };
    }
    const x = -b / a;
    lines.push(T('Isolando x:'), X(`x = -b/a = -(${f(b)})/${f(a)}`), X(`x = ${f(x)}`));
    return { ok: true, kind: 'unique', x, lines };
  }

  function quadratic(a, b, c) {
    num(a, 'a'); num(b, 'b'); num(c, 'c');
    if (Math.abs(a) < EPS) {
      const r = linear(b, c);
      r.lines.unshift(T('a = 0: a equacao e do 1o grau.'));
      return r;
    }
    const lines = [H('Equacao do 2o grau'), X(`${f(a)}x^2 + ${f(b)}x + ${f(c)} = 0`),
      T('Dados:'), X(`a = ${f(a)}, b = ${f(b)}, c = ${f(c)}`),
      T('Formula do discriminante:'), X('D = b^2 - 4ac')];
    const d = b * b - 4 * a * c;
    lines.push(T('Substituindo:'), X(`D = (${f(b)})^2 - 4*(${f(a)})*(${f(c)})`), X(`D = ${f(b * b)} - (${f(4 * a * c)})`), X(`D = ${f(d)}`));
    lines.push(T('Formula de Bhaskara:'), X('x = (-b +- sqrt(D)) / (2a)'));
    const xv = -b / (2 * a), yv = -d / (4 * a);
    let result;
    if (Math.abs(d) < EPS * Math.max(1, b * b)) {
      const x = -b / (2 * a);
      lines.push(T('D = 0: uma raiz real dupla.'), X(`x = -(${f(b)}) / (2*${f(a)})`), X(`x = ${f(x)}`));
      result = { kind: 'double', roots: [x] };
    } else if (d > 0) {
      const sq = Math.sqrt(d);
      // numerically stable form
      const q = -0.5 * (b + Math.sign(b || 1) * sq);
      let x1 = q / a, x2 = c / q;
      if (x1 > x2) [x1, x2] = [x2, x1];
      lines.push(T('D > 0: duas raizes reais.'), X(`sqrt(D) = ${f(sq)}`),
        X(`x1 = (-(${f(b)}) - ${f(sq)}) / ${f(2 * a)} = ${f(x1)}`),
        X(`x2 = (-(${f(b)}) + ${f(sq)}) / ${f(2 * a)} = ${f(x2)}`));
      result = { kind: 'real', roots: [x1, x2] };
    } else {
      const re = -b / (2 * a), im = Math.sqrt(-d) / Math.abs(2 * a);
      lines.push(T('D < 0: sem raizes reais; raizes complexas:'), X(`x = ${f(re)} +- ${f(im)}i`));
      result = { kind: 'complex', re, im, roots: [] };
    }
    lines.push(T('Verificacao:'));
    for (const r of result.roots) lines.push(X(`${f(a)}*(${f(r)})^2 + ${f(b)}*(${f(r)}) + ${f(c)} = ${f(a * r * r + b * r + c)}`));
    lines.push(T('Vertice:'), X(`xv = ${f(xv)}, yv = ${f(yv)}`));
    return Object.assign({ ok: true, d, vertex: [xv, yv], lines }, result);
  }

  /** Solve A x = b with Gaussian elimination and partial pivoting. n <= 4. */
  function linearSystem(A, b) {
    const n = A.length;
    if (n < 2 || n > 4 || b.length !== n || A.some(r => r.length !== n)) throw new M.MathError(M.ERR.ARGS, 'sistema');
    A.forEach(r => r.forEach(v => num(v))); b.forEach(v => num(v));
    const m = A.map((r, i) => r.concat([b[i]]));
    const names = ['x', 'y', 'z', 'w'];
    const lines = [H(`Sistema ${n}x${n}`)];
    const rowText = (r) => r.slice(0, n).map((v, j) => `${f(v)}${names[j]}`).join(' + ') + ` = ${f(r[n])}`;
    m.forEach(r => lines.push(X(rowText(r))));
    lines.push(T('Eliminacao de Gauss:'));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
      if (Math.abs(m[piv][col]) < EPS) {
        // singular: distinguish none / infinite by checking consistency later
        continue;
      }
      if (piv !== col) { [m[piv], m[col]] = [m[col], m[piv]]; lines.push(T(`Troca L${col + 1} <-> L${piv + 1}`)); }
      for (let r = col + 1; r < n; r++) {
        const k = m[r][col] / m[col][col];
        if (Math.abs(k) < EPS) continue;
        for (let c = col; c <= n; c++) m[r][c] -= k * m[col][c];
        m[r][col] = 0;
        lines.push(X(`L${r + 1} = L${r + 1} - (${f(k)})L${col + 1}`));
      }
    }
    m.forEach(r => lines.push(X(rowText(r))));
    for (let i = 0; i < n; i++) {
      if (Math.abs(m[i][i]) < EPS) {
        const rowZero = m[i].slice(0, n).every(v => Math.abs(v) < 1e-9);
        if (rowZero && Math.abs(m[i][n]) > 1e-9) { lines.push(T('Linha inconsistente: sistema impossivel.')); return { ok: true, kind: 'none', lines }; }
        lines.push(T('Sistema possivel e indeterminado.'));
        return { ok: true, kind: 'infinite', lines };
      }
    }
    const x = new Array(n).fill(0);
    lines.push(T('Substituicao regressiva:'));
    for (let i = n - 1; i >= 0; i--) {
      let s = m[i][n];
      for (let j = i + 1; j < n; j++) s -= m[i][j] * x[j];
      x[i] = s / m[i][i];
      if (Math.abs(x[i]) < 1e-12) x[i] = 0;
      lines.push(X(`${names[i]} = ${f(x[i])}`));
    }
    lines.push(T('Verificacao:'));
    A.forEach((r, i) => lines.push(X(r.map((v, j) => `${f(v)}*${f(x[j])}`).join(' + ') + ` = ${f(r.reduce((s, v, j) => s + v * x[j], 0))} (esperado ${f(b[i])})`)));
    return { ok: true, kind: 'unique', x, lines };
  }

  /* ----------------------------- matrices -------------------------- */
  function dims(A) { return [A.length, A[0] ? A[0].length : 0]; }
  function checkMatrix(A) {
    if (!Array.isArray(A) || !A.length || A.some(r => !Array.isArray(r) || r.length !== A[0].length)) throw new M.MathError(M.ERR.ARGS, 'matriz');
    A.forEach(r => r.forEach(v => num(v)));
  }
  function det(A) {
    checkMatrix(A);
    const [r, c] = dims(A);
    if (r !== c) throw new M.MathError(M.ERR.ARGS, 'matriz nao quadrada');
    const m = A.map(row => row.slice());
    let d = 1;
    for (let i = 0; i < r; i++) {
      let p = i;
      for (let k = i + 1; k < r; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
      if (Math.abs(m[p][i]) < EPS) return 0;
      if (p !== i) { [m[p], m[i]] = [m[i], m[p]]; d = -d; }
      d *= m[i][i];
      for (let k = i + 1; k < r; k++) {
        const t = m[k][i] / m[i][i];
        for (let j = i; j < r; j++) m[k][j] -= t * m[i][j];
      }
    }
    return Math.abs(d) < 1e-12 ? 0 : d;
  }
  function transpose(A) { checkMatrix(A); return A[0].map((_, j) => A.map(r => r[j])); }
  function multiply(A, B) {
    checkMatrix(A); checkMatrix(B);
    if (dims(A)[1] !== dims(B)[0]) throw new M.MathError(M.ERR.ARGS, 'dimensoes');
    return A.map(r => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  }
  function add(A, B, sign = 1) {
    checkMatrix(A); checkMatrix(B);
    if (dims(A)[0] !== dims(B)[0] || dims(A)[1] !== dims(B)[1]) throw new M.MathError(M.ERR.ARGS, 'dimensoes');
    return A.map((r, i) => r.map((v, j) => v + sign * B[i][j]));
  }
  function inverse(A) {
    checkMatrix(A);
    const n = A.length;
    if (dims(A)[1] !== n) throw new M.MathError(M.ERR.ARGS, 'matriz nao quadrada');
    const m = A.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < EPS) throw new M.MathError(M.ERR.DOMAIN, 'matriz singular');
      [m[p], m[c]] = [m[c], m[p]];
      const pv = m[c][c];
      for (let j = 0; j < 2 * n; j++) m[c][j] /= pv;
      for (let r = 0; r < n; r++) if (r !== c) {
        const k = m[r][c];
        for (let j = 0; j < 2 * n; j++) m[r][j] -= k * m[c][j];
      }
    }
    return m.map(r => r.slice(n).map(v => (Math.abs(v) < 1e-12 ? 0 : v)));
  }
  function matrixLines(name, A) { return A.map((r, i) => X(`${i === 0 ? name + ' = ' : ' '.repeat(name.length + 3)}[ ${r.map(f).join('  ')} ]`)); }

  /* ----------------------------- statistics ------------------------ */
  function stats(data) {
    if (!Array.isArray(data) || data.length === 0) throw new M.MathError(M.ERR.ARGS, 'dados vazios');
    data.forEach(v => num(v));
    const n = data.length;
    const s = data.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const median = (arr) => { const k = arr.length; return k % 2 ? arr[(k - 1) / 2] : (arr[k / 2 - 1] + arr[k / 2]) / 2; };
    const med = median(s);
    const lower = s.slice(0, Math.floor(n / 2)), upper = s.slice(Math.ceil(n / 2));
    const q1 = n > 1 ? median(lower) : s[0], q3 = n > 1 ? median(upper) : s[0];
    const ss = s.reduce((a, v) => a + (v - mean) * (v - mean), 0);
    const varP = ss / n, varS = n > 1 ? ss / (n - 1) : NaN;
    const counts = new Map();
    s.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
    const maxc = Math.max(...counts.values());
    const mode = maxc > 1 ? [...counts.entries()].filter(([, c]) => c === maxc).map(([v]) => v) : [];
    const r = { ok: true, n, sum, mean, median: med, q1, q3, min: s[0], max: s[n - 1], range: s[n - 1] - s[0], varP, varS, sdP: Math.sqrt(varP), sdS: Math.sqrt(varS), mode };
    r.lines = [H('Estatistica descritiva'), X('dados: ' + data.map(f).join(', ')), X('ordenados: ' + s.map(f).join(', ')),
      X(`n = ${n}`), X(`soma = ${f(sum)}`), T('Media = soma / n'), X(`media = ${f(sum)} / ${n} = ${f(mean)}`),
      X(`mediana = ${f(med)}`), X(`Q1 = ${f(q1)}  Q3 = ${f(q3)}`), X(`min = ${f(r.min)}  max = ${f(r.max)}`),
      X(`amplitude = ${f(r.range)}`), T('Variancia populacional = soma((x-media)^2)/n'), X(`var = ${f(ss)} / ${n} = ${f(varP)}`),
      X(`desvio padrao pop. = ${f(r.sdP)}`)];
    if (n > 1) r.lines.push(X(`var amostral = ${f(ss)} / ${n - 1} = ${f(varS)}`), X(`desvio padrao amostral = ${f(r.sdS)}`));
    r.lines.push(X('moda = ' + (mode.length ? mode.map(f).join(', ') : 'amodal')));
    return r;
  }

  /* ----------------------------- value table ----------------------- */
  function valueTable(expr, start, end, step, ctx = {}) {
    num(start); num(end); num(step);
    if (step === 0 || (end - start) / step < 0) throw new M.MathError(M.ERR.ARGS, 'passo');
    const count = Math.floor((end - start) / step + 1e-9) + 1;
    if (count > 200) throw new M.MathError(M.ERR.ARGS, 'maximo 200 linhas');
    const ast = M.parse(expr);
    const rows = [];
    const lines = [H('Tabela de valores'), X(`f(x) = ${expr}`)];
    for (let i = 0; i < count; i++) {
      const x = Number((start + i * step).toPrecision(12));
      let y, txt;
      try { y = M.evaluate(ast, Object.assign({}, ctx, { vars: Object.assign({}, ctx.vars, { x }) })); txt = f(y); }
      catch (e) { y = null; txt = e.code === M.ERR.DIV_ZERO ? 'div/0' : 'indef.'; }
      rows.push({ x, y });
      lines.push(X(`x=${f(x)}  f=${txt}`));
    }
    return { ok: true, rows, lines };
  }

  return { linear, quadratic, linearSystem, det, transpose, multiply, add, inverse, matrixLines, stats, valueTable };
});
