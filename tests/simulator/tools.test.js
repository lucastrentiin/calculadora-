'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../simulator/js/core/mathEngine.js');
const U = require('../../simulator/js/core/units.js');
const F = require('../../simulator/js/core/formulas.js');
const S = require('../../simulator/js/core/solvers.js');

const near = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('unit conversions use verifiable exact factors', () => {
  near(U.convert('length', 'in', 'cm', 1), 2.54);
  near(U.convert('length', 'mi', 'km', 1), 1.609344);
  near(U.convert('length', 'ft', 'm', 10), 3.048);
  near(U.convert('area', 'ha', 'm2', 1), 10000);
  near(U.convert('area', 'acre', 'm2', 1), 4046.8564224);
  near(U.convert('volume', 'L', 'mL', 1), 1000);
  near(U.convert('volume', 'galUS', 'L', 1), 3.785411784);
  near(U.convert('mass', 'lb', 'kg', 1), 0.45359237);
  near(U.convert('mass', 'oz', 'g', 16), 453.59237);
  near(U.convert('temperature', 'C', 'F', 100), 212);
  near(U.convert('temperature', 'F', 'C', 32), 0);
  near(U.convert('temperature', 'C', 'K', 0), 273.15);
  near(U.convert('temperature', 'K', 'R', 100), 180);
  assert.throws(() => U.convert('temperature', 'K', 'C', -1), /zero absoluto/);
  near(U.convert('speed', 'km/h', 'm/s', 36), 10);
  near(U.convert('speed', 'kn', 'km/h', 1), 1.852);
  near(U.convert('time', 'h', 's', 1), 3600);
  near(U.convert('time', 'd', 'min', 1), 1440);
  near(U.convert('pressure', 'atm', 'Pa', 1), 101325);
  near(U.convert('pressure', 'atm', 'mmHg', 1), 760, 1e-6);
  near(U.convert('pressure', 'bar', 'kPa', 1), 100);
  near(U.convert('energy', 'kcal', 'kJ', 1), 4.184);
  near(U.convert('energy', 'kWh', 'J', 1), 3.6e6);
  near(U.convert('angle', 'deg', 'rad', 180), Math.PI);
  near(U.convert('angle', 'rev', 'deg', 1), 360);
  assert.throws(() => U.convert('length', 'm', 'kg', 1));
  for (const c of U.CATEGORIES) for (const [sym] of c.units) near(U.convert(c.id, sym, sym, 12.5), 12.5);
  assert.equal(U.CATEGORIES.length, 10);
  const ex = U.explain('length', 'km', 'm', 2);
  assert.equal(ex.result, 2000);
  assert.ok(ex.steps.length >= 3);
});

test('formula library: every example is reproduced by the engine', () => {
  assert.ok(F.LIST.length >= 40);
  const cats = new Set(F.LIST.map(f => f.cat));
  for (const [id] of F.CATEGORIES) assert.ok(cats.has(id), 'categoria sem formulas: ' + id);
  for (const f of F.LIST) {
    for (const k of ['id', 'name', 'formula', 'out', 'expr', 'vars', 'units', 'example', 'cat']) assert.ok(f[k] != null, f.id + ' sem ' + k);
    const r = F.apply(f.id, f.example.in);
    near(r.value, f.example.out, 1e-9);
    assert.ok(r.lines.length > 3);
  }
  assert.ok(F.search('pitagoras').some(f => f.id === 'pyth'));
  assert.ok(F.search('ÁREA').length > 3);
  assert.throws(() => F.apply('rect', { b: 1 }), /falta h/);
});

test('linear and quadratic equations with steps', () => {
  assert.equal(S.linear(2, -4).x, 2);
  assert.equal(S.linear(0, 0).kind, 'infinite');
  assert.equal(S.linear(0, 1).kind, 'none');
  const q = S.quadratic(1, -5, 6);
  assert.deepEqual(q.roots, [2, 3]);
  assert.equal(q.d, 1);
  assert.ok(q.lines.some(l => /D = 1$/.test(l.text)));
  assert.equal(S.quadratic(1, 2, 1).kind, 'double');
  const c = S.quadratic(1, 0, 1);
  assert.equal(c.kind, 'complex'); assert.equal(c.im, 1);
  assert.equal(S.quadratic(0, 2, -4).x, 2);
  const big = S.quadratic(1, -1e8, 1); // cancellation-prone case
  near(big.roots[0], 1e-8, 1e-6);
});

test('linear systems', () => {
  const r = S.linearSystem([[2, 1], [1, -1]], [5, 1]);
  near(r.x[0], 2); near(r.x[1], 1);
  const r3 = S.linearSystem([[1, 1, 1], [0, 2, 5], [2, 5, -1]], [6, -4, 27]);
  near(r3.x[0], 5); near(r3.x[1], 3); near(r3.x[2], -2);
  assert.equal(S.linearSystem([[1, 1], [2, 2]], [1, 3]).kind, 'none');
  assert.equal(S.linearSystem([[1, 1], [2, 2]], [1, 2]).kind, 'infinite');
});

test('matrices', () => {
  assert.equal(S.det([[1, 2], [3, 4]]), -2);
  assert.equal(S.det([[2, 0, 0], [0, 3, 0], [0, 0, 4]]), 24);
  assert.deepEqual(S.inverse([[4, 7], [2, 6]]).map(r => r.map(v => Number(v.toFixed(10)))), [[0.6, -0.7], [-0.2, 0.4]]);
  assert.throws(() => S.inverse([[1, 2], [2, 4]]), /singular/);
  assert.deepEqual(S.multiply([[1, 2], [3, 4]], [[5], [6]]), [[17], [39]]);
  assert.deepEqual(S.transpose([[1, 2, 3]]), [[1], [2], [3]]);
});

test('descriptive statistics', () => {
  const s = S.stats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.mean, 5); assert.equal(s.median, 4.5); assert.equal(s.sdP, 2);
  near(s.varS, 32 / 7); assert.deepEqual(s.mode, [4]); assert.equal(s.range, 7);
  assert.throws(() => S.stats([]));
});

test('value table', () => {
  const t = S.valueTable('x^2', 0, 3, 1);
  assert.deepEqual(t.rows.map(r => r.y), [0, 1, 4, 9]);
  const d = S.valueTable('1/x', -1, 1, 1);
  assert.equal(d.rows[1].y, null);
  assert.throws(() => S.valueTable('x', 0, 1000, 1), /200/);
  assert.equal(M.formatNumber(S.valueTable('sin(x)', 0, 90, 90, { angle: 'deg' }).rows[1].y), '1');
});
