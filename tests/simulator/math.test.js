'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../simulator/js/core/mathEngine.js');

const calc = (s, ctx) => M.calculate(s, ctx);
const val = (s, ctx) => { const r = calc(s, ctx); assert.ok(r.ok, s + ' -> ' + r.message); return r.value; };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('basic operations', () => {
  assert.equal(val('1+2'), 3);
  assert.equal(val('7-10'), -3);
  assert.equal(val('6*7'), 42);
  assert.equal(val('7/2'), 3.5);
  assert.equal(val('.5+.25'), 0.75);
});

test('precedence and associativity', () => {
  assert.equal(val('2+3*4'), 14);
  assert.equal(val('(2+3)*4'), 20);
  assert.equal(val('2^3^2'), 512);
  assert.equal(val('-2^2'), -4);
  assert.equal(val('(-2)^2'), 4);
  assert.equal(val('2^-1'), 0.5);
  assert.equal(val('10-4-3'), 3);
  assert.equal(val('100/10/5'), 2);
  assert.equal(val('2*-3'), -6);
  assert.equal(val('--3'), 3);
});

test('implicit multiplication', () => {
  near(val('2pi'), 2 * Math.PI);
  assert.equal(val('3(4+1)'), 15);
  assert.equal(val('(1+1)(2+2)'), 8);
  assert.equal(val('2sqrt(9)'), 6);
});

test('powers, roots, fractions', () => {
  assert.equal(val('sqrt(16)'), 4);
  assert.equal(val('cbrt(-27)'), -3);
  assert.equal(val('root(4,81)'), 3);
  assert.equal(val('(-8)^(1/3)'), -2);
  assert.equal(calc('(-8)^(1/2)').error, 'DOMAIN');
  assert.equal(val('√(25)+3²'), 14);
  assert.deepEqual(M.toFraction(0.75), { n: 3, d: 4 });
  assert.deepEqual(M.toFraction(-2 / 3), { n: -2, d: 3 });
  assert.equal(M.toFraction(Math.PI), null);
  assert.equal(calc('1/3+1/6').fraction.d, 2);
});

test('trigonometry in degrees and radians', () => {
  const deg = { angle: 'deg' };
  assert.equal(calc('sin(30)', deg).text, '0.5');
  assert.equal(calc('cos(60)', deg).text, '0.5');
  assert.equal(calc('sin(180)', deg).text, '0');
  assert.equal(calc('cos(90)', deg).text, '0');
  assert.equal(calc('tan(45)', deg).text, '1');
  assert.equal(calc('tan(90)', deg).error, 'DOMAIN');
  assert.equal(calc('asin(0.5)', deg).text, '30');
  assert.equal(calc('atan(1)', deg).text, '45');
  near(val('sin(pi/2)', { angle: 'rad' }), 1);
  assert.equal(calc('sin(pi)', { angle: 'rad' }).text, '0');
  assert.equal(calc('asin(2)').error, 'DOMAIN');
  near(val('sinh(0)+cosh(0)'), 1);
});

test('logarithms and exponentials', () => {
  assert.equal(val('log(1000)'), 3);
  assert.equal(val('ln(e)'), 1);
  assert.equal(val('log2(8)'), 3);
  near(val('log(2,8)'), 3);
  near(val('exp(1)'), Math.E);
  assert.equal(val('10^(2)'), 100);
  assert.equal(calc('log(0)').error, 'DOMAIN');
  assert.equal(calc('ln(-1)').error, 'DOMAIN');
});

test('scientific notation, constants, percentages, factorial, combinatorics', () => {
  assert.equal(val('1.5E3'), 1500);
  assert.equal(val('2E-3'), 0.002);
  assert.equal(val('200+10%'), 220);
  assert.equal(val('200-10%'), 180);
  assert.equal(val('50%'), 0.5);
  assert.equal(val('5!'), 120);
  assert.equal(val('nCr(5,2)'), 10);
  assert.equal(val('nPr(5,2)'), 20);
  assert.equal(calc('3.5!').error, 'DOMAIN');
  assert.equal(calc('171!').error, 'OVERFLOW');
});

test('variables (Ans, memory)', () => {
  assert.equal(val('Ans*2', { vars: { Ans: 21 } }), 42);
  assert.equal(val('M+1', { vars: { M: 4 } }), 5);
  assert.equal(calc('foo+1').error, 'UNKNOWN');
});

test('errors: syntax, division by zero, overflow, limits', () => {
  assert.equal(calc('1/0').error, 'DIV_ZERO');
  assert.equal(calc('0^-1').error, 'DIV_ZERO');
  assert.equal(calc('2+*3').error, 'SYNTAX');
  assert.equal(calc('').error, 'SYNTAX');
  assert.equal(calc('1..2').error, 'SYNTAX');
  assert.equal(calc('(1+2))').error, 'SYNTAX');
  assert.equal(calc('sin 30').error, 'SYNTAX');
  assert.equal(calc('10^400').error, 'OVERFLOW');
  assert.equal(calc('1+'.repeat(200) + '1').error, 'TOO_LONG');
  assert.equal(calc('('.repeat(100) + '1').error, 'DEPTH');
  assert.equal(calc('0^0').error, 'DOMAIN');
  assert.equal(val('(1+2'), 3); // closing parenthesis at the end may be omitted
});

test('number formatting', () => {
  assert.equal(M.formatNumber(0.1 + 0.2), '0.3');
  assert.equal(M.formatNumber(1 / 3), '0.3333333333');
  assert.equal(M.formatNumber(123456789012), '1.23456789E11');
  assert.equal(M.formatNumber(-0), '0');
  assert.equal(M.formatNumber(1e-12), '1E-12');
  assert.equal(M.formatNumber(0.000000001234), '0.000000001234');
  assert.equal(M.formatNumber(9999999999), '9999999999');
  assert.equal(M.formatNumber(2.5e-7), '0.00000025');
});

test('no arbitrary code evaluation', () => {
  for (const evil of ['alert(1)', 'constructor', 'process.exit()', 'this', '__proto__']) {
    assert.equal(calc(evil).ok, false, evil);
  }
});

test('step by step resolution keeps order and final value', () => {
  const r = M.solveSteps('2+3*(4-1)^2/9');
  assert.equal(r.value, 5);
  const exprs = r.steps.map(s => s.expr);
  assert.deepEqual(exprs, ['2+3*(4-1)^2/9', '2+3*3^2/9', '2+3*9/9', '2+27/9', '2+3', '5']);
  assert.match(r.steps[2].rule, /Potencia/);
  const s2 = M.solveSteps('2*pi*r', { vars: { r: 2 } });
  assert.match(s2.steps[1].rule, /Substituicao/);
  assert.ok(Math.abs(s2.value - 4 * Math.PI) < 1e-12);
});

test('printAst round trip preserves value', () => {
  for (const e of ['2-(3-4)', '2/(3/4)', '(-2)^2', '-(2^2)', '2^(1/2)', '(1+2)!', 'sin(30)+cos(60)*2']) {
    const printed = M.printAst(M.parse(e));
    assert.equal(M.evaluate(printed, { angle: 'deg' }), M.evaluate(e, { angle: 'deg' }), e + ' vs ' + printed);
  }
});
