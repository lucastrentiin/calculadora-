'use strict';
// NORMAL mode compatibility tests (fx-82MS-class functions of the DEXIN KK-82MS-B reference).
// Each test name matches a row of docs/DEXIN_COMPAT.md. Expected values follow the
// documented behaviour of this calculator class; physical confirmation is still pending.
const test = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('../../simulator/js/core/app.js');
const P = require('../../simulator/js/sim/platform.js');

function calc() {
  const platform = P.createPlatform({ clock: () => 1e6 });
  platform.random = () => 0.427;
  const app = new App(platform);
  const k = (...keys) => keys.flat().forEach(x => app.handleKey(typeof x === 'string' ? { key: x } : x));
  const S = (x) => [{ key: 'SHIFT' }, { key: x }];
  const A = (x) => [{ key: 'ALPHA' }, { key: x }];
  const r = () => app.calc.resultText();
  return { app, k, S, A, r, c: app.calc };
}

test('aritmetica, precedencia, parenteses, notacao cientifica (EXP), Ans', () => {
  const { k, r } = calc();
  k('2', 'ADD', '3', 'MUL', '4', 'EQ'); assert.equal(r(), '14');
  k('LPAREN', '2', 'ADD', '3', 'RPAREN', 'MUL', '4', 'EQ'); assert.equal(r(), '20');
  k('1', 'DOT', '5', 'EXP', '3', 'EQ'); assert.equal(r(), '1500');
  k('MUL', '2', 'EQ'); assert.equal(r(), '3000');           // continues with Ans
  k('NEG', '2', 'POW', '2', 'EQ'); assert.equal(r(), '-4');  // (-) has lower priority than ^
});

test('fracoes a┘b┘c, conversao ab/c <-> decimal e d/c', () => {
  const { k, S, r } = calc();
  k('1', 'FRAC', '2', 'ADD', '1', 'FRAC', '3', 'EQ'); assert.equal(r(), '5┘6');
  k('FRAC'); assert.equal(r(), '0.8333333333');
  k('FRAC'); assert.equal(r(), '5┘6');
  k('2', 'FRAC', '1', 'FRAC', '4', 'EQ'); assert.equal(r(), '2┘1┘4');
  k(S('FRAC')); assert.equal(r(), '9┘4');                    // d/c: improper fraction
});

test('potencias e raizes: x², x³, ^, x⁻¹, √, ∛, ˣ√', () => {
  const { k, S, r } = calc();
  k('3', 'SQR', 'EQ'); assert.equal(r(), '9');
  k('2', 'CUBE', 'EQ'); assert.equal(r(), '8');
  k('2', 'POW', '1', '0', 'EQ'); assert.equal(r(), '1024');
  k('4', 'INV', 'EQ'); assert.equal(r(), '0.25');
  k('SQRT', '1', '6', 'RPAREN', 'EQ'); assert.equal(r(), '4');
  k(S('CUBE'), '2', '7', 'RPAREN', 'EQ'); assert.equal(r(), '3');
  k(S('POW'), '4', 'COMMA', '8', '1', 'RPAREN', 'EQ'); assert.equal(r(), '3');
});

test('trigonometria, inversas e hiperbolicas; DEG/RAD/GRA (MODE MODE)', () => {
  const { k, S, r, app } = calc();
  k('SIN', '3', '0', 'EQ'); assert.equal(r(), '0.5');
  k(S('COS'), '0', 'DOT', '5', 'EQ'); assert.equal(r(), '60');
  k('MODE', 'MODE', '2'); assert.equal(app.settings.angle, 'rad');
  k('COS', 'SHIFT', 'EXP', 'EQ'); assert.equal(r(), '-1');                 // π via SHIFT EXP
  k('MODE', 'MODE', '3'); assert.equal(app.settings.angle, 'grad');
  k('SIN', '1', '0', '0', 'EQ'); assert.equal(r(), '1');
  k('HYP', 'SIN', '0', 'EQ'); assert.equal(r(), '0');
  k('HYP', 'COS', '0', 'EQ'); assert.equal(r(), '1');
  k('HYP', 'SHIFT', 'TAN', '0', 'EQ'); assert.equal(r(), '0');           // tanh⁻¹
});

test('DRG► (SHIFT Ans) converte unidades angulares', () => {
  const { k, S, r } = calc();                                             // Deg
  k('MODE', 'MODE', '1');
  k('SHIFT', 'EXP', S('ANS'), '2', 'EQ'); assert.equal(r(), '180');       // πʳ -> 180°
  k('2', '0', '0', S('ANS'), '3', 'EQ'); assert.equal(r(), '180');        // 200ᵍ -> 180°
});

test("graus-minutos-segundos (°'\") e conversao ←", () => {
  const { k, S, r } = calc();
  k('1', '2', 'DMS', '3', '0', 'DMS', 'EQ'); assert.equal(r(), '12.5');
  k(S('DMS')); assert.equal(r(), '12°30°0');
  k(S('DMS')); assert.equal(r(), '12.5');
});

test('logaritmos e exponenciais', () => {
  const { k, S, r } = calc();
  k('LOG', '1', '0', '0', '0', 'EQ'); assert.equal(r(), '3');
  k('LN', 'S'.length ? 'SHIFT' : '', 'LN', '1', 'RPAREN', 'EQ'); assert.equal(r(), '1'); // ln(e^(1))
  k(S('LOG'), '3', 'EQ'); assert.equal(r(), '1000');
});

test('fatorial, nCr, nPr (infixos), Pol/Rec com E e F, Ran#, Rnd', () => {
  const { k, S, A, r, c } = calc();
  k('5', S('INV'), 'EQ'); assert.equal(r(), '120');
  k('5', 'NCR', '2', 'EQ'); assert.equal(r(), '10');
  k('5', S('NCR'), '2', 'EQ'); assert.equal(r(), '20');
  k('POL', '1', 'COMMA', '1', 'RPAREN', 'EQ'); assert.equal(r(), '1.414213562');
  assert.ok(Math.abs(c.vars.F - 45) < 1e-9, 'theta em F');
  k('RCL', 'TAN'); assert.equal(r(), '45');                               // RCL F
  k(S('POL'), '2', 'COMMA', '6', '0', 'RPAREN', 'EQ'); assert.equal(r(), '1');
  k(S('DOT'), 'EQ'); assert.equal(r(), '0.427');
  k('MODE', 'MODE', 'MODE', '1', '2');                                     // Fix 2
  k(S('0'), '1', 'DIV', '3', 'RPAREN', 'MUL', '3', 'EQ'); assert.equal(r(), '0.99');
  void A;
});

test('memorias e variaveis: STO/RCL A-F X Y M, M+, M−, ALPHA', () => {
  const { k, S, A, r, c } = calc();
  k('7', 'EQ', S('RCL'), 'NEG');                                          // STO A
  assert.equal(c.vars.A, 7);
  k('AC', A('NEG'), 'MUL', '2', 'EQ'); assert.equal(r(), '14');
  k('3', 'STO'); k('2', S('STO')); assert.equal(c.vars.M, 1);
  k('AC', 'RCL', 'STO'); assert.equal(r(), '1');
  k('5', 'EQ', S('RCL'), 'RPAREN'); assert.equal(c.vars.X, 5);
  k('AC', A('RPAREN'), 'ADD', A('COMMA'), 'EQ'); assert.equal(r(), '5');   // X + Y(0)
});

test('porcentagem com SHIFT = (%)', () => {
  const { k, S, r } = calc();
  k('1', '5', '0', '0', 'MUL', '1', '2', S('EQ')); assert.equal(r(), '180');
  k('6', '6', '0', 'DIV', '8', '8', '0', S('EQ')); assert.equal(r(), '75');
});

test('formatos de exibicao: Fix, Sci, Norm1/Norm2, ENG e ENG←, virgula decimal', () => {
  const { k, S, r, app } = calc();
  k('1', 'DIV', '3', 'EQ'); assert.equal(r(), '0.3333333333');
  k('MODE', 'MODE', 'MODE', '1', '3'); assert.equal(r(), '0.333');           // Fix 3
  k('MODE', 'MODE', 'MODE', '2', '4'); assert.equal(r(), '3.333E-01');       // Sci 4
  k('MODE', 'MODE', 'MODE', '3', '1');                                      // Norm 1
  k('1', 'DIV', '2', '0', '0', 'EQ'); assert.equal(r(), '5E-03');
  k('MODE', 'MODE', 'MODE', '3', '2'); assert.equal(r(), '0.005');          // Norm 2
  k('1', '2', '3', '4', '5', 'EQ', 'ENG'); assert.equal(r(), '12.345E03');
  k('ENG'); assert.equal(r(), '12345E00');
  k(S('ENG')); assert.equal(r(), '12.345E03');
  k('MODE', 'MODE', 'MODE', 'MODE', '1', 'RIGHT', '2'); assert.equal(app.settings.decSep, 'comma');
  k('1', 'DIV', '4', 'EQ'); assert.equal(r(), '0,25');
});

test('modo SD: DT, frequencia (;), S-SUM, S-VAR, CL e Scl', () => {
  const { k, S, r, app } = calc();
  k('MODE', '2'); assert.equal(app.settings.calcMode, 'SD');
  for (const v of ['2', '4', '4']) k(v, 'STO');                              // DT
  k('5', S('COMMA'), '2', 'STO');                                             // 5;2
  assert.equal(r(), 'n=4');
  k(S('1'), '3', 'EQ'); assert.equal(r(), '5');                               // n = 5 (with frequency)
  k(S('1'), '2', 'EQ'); assert.equal(r(), '20');                              // Σx
  k(S('2'), '1', 'EQ'); assert.equal(r(), '4');                               // x̄
  k(S('2'), '2', 'EQ'); assert.equal(r(), '1.095445115');                     // xσn
  k(S('2'), '3', 'EQ'); assert.equal(r(), '1.224744871');                     // xσn-1
  k('AC', S('STO')); assert.equal(app.calc.data.length, 3);                   // CL
  k(S('MODE'), '1'); assert.equal(app.calc.data.length, 0);                   // Scl
});

test('modo REG Lin/Quad: coeficientes A B r C e estimativas x̂ ŷ', () => {
  const { k, S, r, app } = calc();
  k('MODE', '3', '1'); assert.equal(app.settings.regType, 'Lin');
  for (const [x, y] of [['1', '3'], ['2', '5'], ['3', '7']]) k(x, 'COMMA', y, 'STO');
  k(S('2'), 'RIGHT', 'RIGHT', '1', 'EQ'); assert.equal(r(), '1');           // A
  k(S('2'), 'RIGHT', 'RIGHT', '2', 'EQ'); assert.equal(r(), '2');           // B
  k(S('2'), 'RIGHT', 'RIGHT', '3', 'EQ'); assert.equal(r(), '1');           // r
  k('1', '0', S('2'), 'RIGHT', 'RIGHT', 'RIGHT', '2', 'EQ'); assert.equal(r(), '21');  // 10ŷ
  k('2', '1', S('2'), 'RIGHT', 'RIGHT', 'RIGHT', '1', 'EQ'); assert.equal(r(), '10');  // 21x̂
  k('MODE', '3', 'RIGHT', '3'); assert.equal(app.settings.regType, 'Quad');
  for (const [x, y] of [['0', '1'], ['1', '2'], ['2', '5'], ['3', '10']]) k(x, 'COMMA', y, 'STO');
  k(S('2'), 'RIGHT', 'RIGHT', '3', 'EQ'); assert.equal(r(), '1');           // C (y = 1 + 0x + x²)
});

test('edicao: DEL, INS (sobrescrever por padrao), REPLAY, cursor no erro', () => {
  const { k, S, r, c } = calc();
  k('1', '2', '3', 'LEFT', 'LEFT', '9'); assert.equal(c.expr, '193');      // overwrite (default)
  k(S('DEL'), 'LEFT', '5'); assert.equal(c.expr, '1593');                   // INS mode
  k('AC', '1', 'MUL', 'DIV', '2', 'EQ'); assert.equal(r(), 'Syntax ERROR');
  k('LEFT'); assert.equal(c.evaluated, false);                              // back to editing
  k('AC', '1', 'DIV', '0', 'EQ'); assert.equal(r(), 'Math ERROR');
  k('AC', '2', 'EQ', '3', 'EQ', 'UP'); assert.equal(r(), '3');
  k('UP'); assert.equal(r(), '2');
});

test('CLR: Mcl, Mode, All', () => {
  const { k, S, c, app } = calc();
  k('5', 'STO'); assert.equal(c.vars.M, 5);
  k(S('MODE'), '1'); assert.equal(c.vars.M, 0);
  k('MODE', 'MODE', '2', S('MODE'), '2'); assert.equal(app.settings.angle, 'deg');
  k('7', 'EQ', S('MODE'), '3'); assert.equal(c.history.length, 0);
});

test('erros: Stack ERROR e Arg ERROR', () => {
  const { k, r } = calc();
  for (let i = 0; i < 70; i++) k('LPAREN');
  k('1', 'EQ'); assert.equal(r(), 'Stack ERROR');
  k('AC', 'POL', '1', 'RPAREN', 'EQ'); assert.equal(r(), 'Arg ERROR');
});

test('modo NORMAL nao mostra IA, camera ou servidor e nao exige rede', () => {
  const { app, k } = calc();
  app.p.wifi.disconnect();
  k('9', 'MUL', '9', 'EQ');
  assert.equal(app.calc.resultText(), '81');
  const ind = app.calc.indicators().join(' ');
  assert.ok(!/IA|CAM|WIFI|SRV/.test(ind));
});
