/*
 * Offline formula library. Each entry:
 *   id, cat, name, formula (display), out (result symbol), expr (evaluable by
 *   the math engine using the input variables), vars [[symbol, meaning, unit]],
 *   units (applicable units note), example { in: {...}, out: number }.
 * Examples are checked by tests/simulator/formulas.test.js.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mathEngine.js'));
  else { root.MT = root.MT || {}; root.MT.Formulas = factory(root.MT.MathEngine); }
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  const CATEGORIES = [
    ['basic', 'Matematica basica'], ['algebra', 'Algebra'], ['quadratic', 'Equacao 2o grau'],
    ['plane', 'Geometria plana'], ['solid', 'Geometria espacial'], ['trig', 'Trigonometria'],
    ['physics', 'Fisica basica'], ['stats', 'Estatistica'], ['conv', 'Conversoes']
  ];

  const L = [
    // basic
    { id: 'pct', cat: 'basic', name: 'Porcentagem', formula: 'P = v*p/100', out: 'P', expr: 'v*p/100',
      vars: [['v', 'valor total', '-'], ['p', 'percentual', '%']], units: 'mesma unidade de v', example: { in: { v: 250, p: 12 }, out: 30 } },
    { id: 'rule3', cat: 'basic', name: 'Regra de tres simples', formula: 'x = b*c/a', out: 'x', expr: 'b*c/a',
      vars: [['a', 'grandeza 1', '-'], ['b', 'grandeza 2', '-'], ['c', 'novo valor de a', '-']], units: '-', example: { in: { a: 4, b: 10, c: 6 }, out: 15 } },
    { id: 'simpleint', cat: 'basic', name: 'Juros simples', formula: 'J = C*i*t', out: 'J', expr: 'C*i*t',
      vars: [['C', 'capital', 'R$'], ['i', 'taxa por periodo (decimal)', '-'], ['t', 'periodos', '-']], units: 'R$', example: { in: { C: 1000, i: 0.02, t: 5 }, out: 100 } },
    { id: 'compint', cat: 'basic', name: 'Juros compostos', formula: 'M = C*(1+i)^t', out: 'M', expr: 'C*(1+i)^t',
      vars: [['C', 'capital', 'R$'], ['i', 'taxa por periodo (decimal)', '-'], ['t', 'periodos', '-']], units: 'R$', example: { in: { C: 1000, i: 0.1, t: 2 }, out: 1210 } },
    // algebra
    { id: 'pa', cat: 'algebra', name: 'Termo geral da PA', formula: 'an = a1+(n-1)*r', out: 'an', expr: 'a1+(n-1)*r',
      vars: [['a1', 'primeiro termo', '-'], ['n', 'posicao', '-'], ['r', 'razao', '-']], units: '-', example: { in: { a1: 2, n: 10, r: 3 }, out: 29 } },
    { id: 'pasum', cat: 'algebra', name: 'Soma da PA', formula: 'Sn = (a1+an)*n/2', out: 'Sn', expr: '(a1+an)*n/2',
      vars: [['a1', 'primeiro termo', '-'], ['an', 'ultimo termo', '-'], ['n', 'numero de termos', '-']], units: '-', example: { in: { a1: 1, an: 100, n: 100 }, out: 5050 } },
    { id: 'pg', cat: 'algebra', name: 'Termo geral da PG', formula: 'an = a1*q^(n-1)', out: 'an', expr: 'a1*q^(n-1)',
      vars: [['a1', 'primeiro termo', '-'], ['q', 'razao', '-'], ['n', 'posicao', '-']], units: '-', example: { in: { a1: 3, q: 2, n: 5 }, out: 48 } },
    { id: 'logchg', cat: 'algebra', name: 'Mudanca de base do log', formula: 'logb(x) = ln(x)/ln(b)', out: 'L', expr: 'ln(x)/ln(b)',
      vars: [['x', 'logaritmando', '-'], ['b', 'base', '-']], units: '-', example: { in: { x: 81, b: 3 }, out: 4 } },
    // quadratic
    { id: 'delta', cat: 'quadratic', name: 'Discriminante', formula: 'D = b^2-4*a*c', out: 'D', expr: 'b^2-4*a*c',
      vars: [['a', 'coef. de x^2', '-'], ['b', 'coef. de x', '-'], ['c', 'termo independente', '-']], units: '-', example: { in: { a: 1, b: -5, c: 6 }, out: 1 } },
    { id: 'bhaskara1', cat: 'quadratic', name: 'Bhaskara (raiz +)', formula: 'x1 = (-b+sqrt(D))/(2a)', out: 'x1', expr: '(-b+sqrt(b^2-4*a*c))/(2*a)',
      vars: [['a', 'coef. de x^2', '-'], ['b', 'coef. de x', '-'], ['c', 'termo independente', '-']], units: '-', example: { in: { a: 1, b: -5, c: 6 }, out: 3 } },
    { id: 'bhaskara2', cat: 'quadratic', name: 'Bhaskara (raiz -)', formula: 'x2 = (-b-sqrt(D))/(2a)', out: 'x2', expr: '(-b-sqrt(b^2-4*a*c))/(2*a)',
      vars: [['a', 'coef. de x^2', '-'], ['b', 'coef. de x', '-'], ['c', 'termo independente', '-']], units: '-', example: { in: { a: 1, b: -5, c: 6 }, out: 2 } },
    { id: 'vertexx', cat: 'quadratic', name: 'Vertice (x)', formula: 'xv = -b/(2a)', out: 'xv', expr: '-b/(2*a)',
      vars: [['a', 'coef. de x^2', '-'], ['b', 'coef. de x', '-']], units: '-', example: { in: { a: 2, b: -8 }, out: 2 } },
    // plane geometry
    { id: 'circarea', cat: 'plane', name: 'Area do circulo', formula: 'A = pi*r^2', out: 'A', expr: 'pi*r^2',
      vars: [['r', 'raio', 'm']], units: 'm2 se r em m', example: { in: { r: 2 }, out: 12.566370614359172 } },
    { id: 'circlen', cat: 'plane', name: 'Comprimento da circunferencia', formula: 'C = 2*pi*r', out: 'C', expr: '2*pi*r',
      vars: [['r', 'raio', 'm']], units: 'm', example: { in: { r: 1 }, out: 6.283185307179586 } },
    { id: 'rect', cat: 'plane', name: 'Area do retangulo', formula: 'A = b*h', out: 'A', expr: 'b*h',
      vars: [['b', 'base', 'm'], ['h', 'altura', 'm']], units: 'm2', example: { in: { b: 3, h: 4 }, out: 12 } },
    { id: 'tri', cat: 'plane', name: 'Area do triangulo', formula: 'A = b*h/2', out: 'A', expr: 'b*h/2',
      vars: [['b', 'base', 'm'], ['h', 'altura', 'm']], units: 'm2', example: { in: { b: 6, h: 4 }, out: 12 } },
    { id: 'trap', cat: 'plane', name: 'Area do trapezio', formula: 'A = (B+b)*h/2', out: 'A', expr: '(B+b)*h/2',
      vars: [['B', 'base maior', 'm'], ['b', 'base menor', 'm'], ['h', 'altura', 'm']], units: 'm2', example: { in: { B: 8, b: 4, h: 3 }, out: 18 } },
    { id: 'heron', cat: 'plane', name: 'Formula de Heron', formula: 'A = sqrt(s(s-a)(s-b)(s-c)), s=(a+b+c)/2', out: 'A',
      expr: 'sqrt(((a+b+c)/2)*((a+b+c)/2-a)*((a+b+c)/2-b)*((a+b+c)/2-c))',
      vars: [['a', 'lado a', 'm'], ['b', 'lado b', 'm'], ['c', 'lado c', 'm']], units: 'm2', example: { in: { a: 3, b: 4, c: 5 }, out: 6 } },
    { id: 'pyth', cat: 'plane', name: 'Teorema de Pitagoras', formula: 'c = sqrt(a^2+b^2)', out: 'c', expr: 'sqrt(a^2+b^2)',
      vars: [['a', 'cateto', 'm'], ['b', 'cateto', 'm']], units: 'm', example: { in: { a: 3, b: 4 }, out: 5 } },
    { id: 'dist', cat: 'plane', name: 'Distancia entre pontos', formula: 'd = sqrt((x2-x1)^2+(y2-y1)^2)', out: 'd', expr: 'sqrt((x2-x1)^2+(y2-y1)^2)',
      vars: [['x1', 'x do ponto 1', '-'], ['y1', 'y do ponto 1', '-'], ['x2', 'x do ponto 2', '-'], ['y2', 'y do ponto 2', '-']], units: '-', example: { in: { x1: 1, y1: 1, x2: 4, y2: 5 }, out: 5 } },
    // solid geometry
    { id: 'sphvol', cat: 'solid', name: 'Volume da esfera', formula: 'V = 4/3*pi*r^3', out: 'V', expr: '4/3*pi*r^3',
      vars: [['r', 'raio', 'm']], units: 'm3', example: { in: { r: 3 }, out: 113.09733552923255 } },
    { id: 'spharea', cat: 'solid', name: 'Area da esfera', formula: 'A = 4*pi*r^2', out: 'A', expr: '4*pi*r^2',
      vars: [['r', 'raio', 'm']], units: 'm2', example: { in: { r: 1 }, out: 12.566370614359172 } },
    { id: 'cylvol', cat: 'solid', name: 'Volume do cilindro', formula: 'V = pi*r^2*h', out: 'V', expr: 'pi*r^2*h',
      vars: [['r', 'raio', 'm'], ['h', 'altura', 'm']], units: 'm3', example: { in: { r: 1, h: 2 }, out: 6.283185307179586 } },
    { id: 'conevol', cat: 'solid', name: 'Volume do cone', formula: 'V = pi*r^2*h/3', out: 'V', expr: 'pi*r^2*h/3',
      vars: [['r', 'raio', 'm'], ['h', 'altura', 'm']], units: 'm3', example: { in: { r: 3, h: 1 }, out: 9.42477796076938 } },
    { id: 'boxvol', cat: 'solid', name: 'Volume do paralelepipedo', formula: 'V = a*b*c', out: 'V', expr: 'a*b*c',
      vars: [['a', 'comprimento', 'm'], ['b', 'largura', 'm'], ['c', 'altura', 'm']], units: 'm3', example: { in: { a: 2, b: 3, c: 4 }, out: 24 } },
    { id: 'pyrvol', cat: 'solid', name: 'Volume da piramide', formula: 'V = Ab*h/3', out: 'V', expr: 'Ab*h/3',
      vars: [['Ab', 'area da base', 'm2'], ['h', 'altura', 'm']], units: 'm3', example: { in: { Ab: 9, h: 4 }, out: 12 } },
    // trigonometry (angles in degrees in the examples; the engine uses the current angle mode)
    { id: 'lawcos', cat: 'trig', name: 'Lei dos cossenos', formula: 'a = sqrt(b^2+c^2-2bc*cos(A))', out: 'a', expr: 'sqrt(b^2+c^2-2*b*c*cos(A))',
      vars: [['b', 'lado b', 'm'], ['c', 'lado c', 'm'], ['A', 'angulo oposto a a', 'graus']], units: 'm', angle: 'deg', example: { in: { b: 3, c: 4, A: 90 }, out: 5 } },
    { id: 'lawsin', cat: 'trig', name: 'Lei dos senos', formula: 'b = a*sin(B)/sin(A)', out: 'b', expr: 'a*sin(B)/sin(A)',
      vars: [['a', 'lado a', 'm'], ['A', 'angulo A', 'graus'], ['B', 'angulo B', 'graus']], units: 'm', angle: 'deg', example: { in: { a: 10, A: 30, B: 90 }, out: 20 } },
    { id: 'deg2rad', cat: 'trig', name: 'Graus para radianos', formula: 'r = g*pi/180', out: 'r', expr: 'g*pi/180',
      vars: [['g', 'angulo', 'graus']], units: 'rad', example: { in: { g: 180 }, out: Math.PI } },
    { id: 'sintri', cat: 'trig', name: 'Area por dois lados e angulo', formula: 'A = a*b*sin(C)/2', out: 'A', expr: 'a*b*sin(C)/2',
      vars: [['a', 'lado a', 'm'], ['b', 'lado b', 'm'], ['C', 'angulo entre a e b', 'graus']], units: 'm2', angle: 'deg', example: { in: { a: 4, b: 5, C: 30 }, out: 5 } },
    // physics
    { id: 'vmed', cat: 'physics', name: 'Velocidade media', formula: 'v = d/t', out: 'v', expr: 'd/t',
      vars: [['d', 'distancia', 'm'], ['t', 'tempo', 's']], units: 'm/s', example: { in: { d: 100, t: 20 }, out: 5 } },
    { id: 'muv', cat: 'physics', name: 'Posicao no MUV', formula: 's = s0+v0*t+a*t^2/2', out: 's', expr: 's0+v0*t+a*t^2/2',
      vars: [['s0', 'posicao inicial', 'm'], ['v0', 'velocidade inicial', 'm/s'], ['a', 'aceleracao', 'm/s2'], ['t', 'tempo', 's']], units: 'm', example: { in: { s0: 0, v0: 10, a: 2, t: 5 }, out: 75 } },
    { id: 'torricelli', cat: 'physics', name: 'Torricelli', formula: 'v = sqrt(v0^2+2*a*d)', out: 'v', expr: 'sqrt(v0^2+2*a*d)',
      vars: [['v0', 'velocidade inicial', 'm/s'], ['a', 'aceleracao', 'm/s2'], ['d', 'deslocamento', 'm']], units: 'm/s', example: { in: { v0: 0, a: 2, d: 25 }, out: 10 } },
    { id: 'newton2', cat: 'physics', name: '2a lei de Newton', formula: 'F = m*a', out: 'F', expr: 'm*a',
      vars: [['m', 'massa', 'kg'], ['a', 'aceleracao', 'm/s2']], units: 'N', example: { in: { m: 10, a: 9.8 }, out: 98 } },
    { id: 'ek', cat: 'physics', name: 'Energia cinetica', formula: 'Ec = m*v^2/2', out: 'Ec', expr: 'm*v^2/2',
      vars: [['m', 'massa', 'kg'], ['v', 'velocidade', 'm/s']], units: 'J', example: { in: { m: 2, v: 3 }, out: 9 } },
    { id: 'ep', cat: 'physics', name: 'Energia potencial gravitacional', formula: 'Ep = m*g*h', out: 'Ep', expr: 'm*g*h',
      vars: [['m', 'massa', 'kg'], ['g', 'gravidade', 'm/s2'], ['h', 'altura', 'm']], units: 'J', example: { in: { m: 1, g: 9.81, h: 10 }, out: 98.1 } },
    { id: 'ohm', cat: 'physics', name: 'Lei de Ohm', formula: 'U = R*I', out: 'U', expr: 'R*I',
      vars: [['R', 'resistencia', 'ohm'], ['I', 'corrente', 'A']], units: 'V', example: { in: { R: 10, I: 2 }, out: 20 } },
    { id: 'power', cat: 'physics', name: 'Potencia eletrica', formula: 'P = U*I', out: 'P', expr: 'U*I',
      vars: [['U', 'tensao', 'V'], ['I', 'corrente', 'A']], units: 'W', example: { in: { U: 220, I: 5 }, out: 1100 } },
    { id: 'density', cat: 'physics', name: 'Densidade', formula: 'd = m/V', out: 'd', expr: 'm/V',
      vars: [['m', 'massa', 'kg'], ['V', 'volume', 'm3']], units: 'kg/m3', example: { in: { m: 500, V: 0.5 }, out: 1000 } },
    { id: 'pressure', cat: 'physics', name: 'Pressao', formula: 'p = F/A', out: 'p', expr: 'F/A',
      vars: [['F', 'forca', 'N'], ['A', 'area', 'm2']], units: 'Pa', example: { in: { F: 100, A: 0.5 }, out: 200 } },
    // statistics
    { id: 'mean2', cat: 'stats', name: 'Media ponderada (2 valores)', formula: 'm = (x1*p1+x2*p2)/(p1+p2)', out: 'm', expr: '(x1*p1+x2*p2)/(p1+p2)',
      vars: [['x1', 'valor 1', '-'], ['p1', 'peso 1', '-'], ['x2', 'valor 2', '-'], ['p2', 'peso 2', '-']], units: '-', example: { in: { x1: 6, p1: 2, x2: 9, p2: 1 }, out: 7 } },
    { id: 'zscore', cat: 'stats', name: 'Escore z', formula: 'z = (x-mu)/s', out: 'z', expr: '(x-mu)/s',
      vars: [['x', 'valor', '-'], ['mu', 'media', '-'], ['s', 'desvio padrao', '-']], units: '-', example: { in: { x: 85, mu: 70, s: 10 }, out: 1.5 } },
    { id: 'comb', cat: 'stats', name: 'Combinacao simples', formula: 'C = n!/(k!(n-k)!)', out: 'C', expr: 'nCr(n,k)',
      vars: [['n', 'total', '-'], ['k', 'escolhidos', '-']], units: '-', example: { in: { n: 10, k: 3 }, out: 120 } },
    { id: 'binom', cat: 'stats', name: 'Probabilidade binomial', formula: 'P = C(n,k)*p^k*(1-p)^(n-k)', out: 'P', expr: 'nCr(n,k)*p^k*(1-p)^(n-k)',
      vars: [['n', 'tentativas', '-'], ['k', 'sucessos', '-'], ['p', 'prob. de sucesso', '-']], units: '-', example: { in: { n: 4, k: 2, p: 0.5 }, out: 0.375 } },
    // conversions
    { id: 'c2f', cat: 'conv', name: 'Celsius para Fahrenheit', formula: 'F = C*9/5+32', out: 'F', expr: 'C*9/5+32',
      vars: [['C', 'temperatura', 'C']], units: 'F', example: { in: { C: 100 }, out: 212 } },
    { id: 'kmh2ms', cat: 'conv', name: 'km/h para m/s', formula: 'v = k/3.6', out: 'v', expr: 'k/3.6',
      vars: [['k', 'velocidade', 'km/h']], units: 'm/s', example: { in: { k: 72 }, out: 20 } }
  ];

  function byCategory(cat) { return L.filter(e => e.cat === cat); }
  function get(id) { return L.find(e => e.id === id) || null; }

  function strip(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function search(q) {
    const t = strip(q).trim();
    if (!t) return L.slice();
    return L.filter(e => strip(e.name).includes(t) || strip(e.formula).includes(t) || strip(e.cat).includes(t));
  }

  /** Apply a formula with given variable values; returns steps for display. */
  function apply(id, values, ctx = {}) {
    const e = get(id);
    if (!e) throw new Error('formula desconhecida');
    const vars = {};
    for (const [sym] of e.vars) {
      const v = values[sym];
      if (typeof v !== 'number' || !isFinite(v)) throw new M.MathError(M.ERR.ARGS, 'falta ' + sym);
      vars[sym] = v;
    }
    const c = Object.assign({ angle: e.angle || 'rad' }, ctx, { vars });
    const sol = M.solveSteps(e.expr, c);
    const lines = [
      { kind: 'title', text: e.name },
      { kind: 'math', text: e.formula },
      { kind: 'text', text: 'Dados:' },
      ...e.vars.map(([s, d, u]) => ({ kind: 'math', text: `${s} = ${M.formatNumber(vars[s])} ${u !== '-' ? u : ''} (${d})`.trim() })),
      { kind: 'text', text: 'Resolucao:' },
      ...sol.steps.map(st => ({ kind: 'math', text: st.expr, rule: st.rule })),
      { kind: 'math', text: `${e.out} = ${M.formatNumber(sol.value)} ${e.units}` }
    ];
    return { value: sol.value, lines };
  }

  return { CATEGORIES, LIST: L, byCategory, get, search, apply };
});
