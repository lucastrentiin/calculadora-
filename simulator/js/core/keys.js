/*
 * Logical key codes. The physical keypad driver (matrix scan on hardware,
 * buttons/PC keyboard in the simulator) only has to produce these codes.
 * The matrix position of each key is NOT defined here (hardware undecided):
 * see hardware/KEYPAD.md and firmware/components/keypad.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MT = root.MT || {}; root.MT.Keys = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [code, label, shiftLabel, alphaLabel] — fx-82MS-class arrangement used by the DEXIN KK-82MS-B
  // reference (docs/DEXIN_COMPAT.md). MENU is an extension key (offline tools), not on the original.
  const LAYOUT = [
    [['SHIFT', 'SHIFT', ''], ['ALPHA', 'ALPHA', ''], ['MODE', 'MODE', 'CLR'], ['MENU', 'MENU', ''], ['ON', 'ON', '']],
    [['INV', 'x⁻¹', 'x!'], ['NCR', 'nCr', 'nPr'], ['POL', 'Pol(', 'Rec('], ['CUBE', 'x³', '∛']],
    [['FRAC', 'ab/c', 'd/c'], ['SQRT', '√', ''], ['SQR', 'x²', ''], ['POW', '^', 'ˣ√'], ['LOG', 'log', '10ˣ'], ['LN', 'ln', 'eˣ']],
    [['NEG', '(−)', '', 'A'], ['DMS', "°'\"", '←', 'B'], ['HYP', 'hyp', '', 'C'], ['SIN', 'sin', 'sin⁻¹', 'D'], ['COS', 'cos', 'cos⁻¹', 'E'], ['TAN', 'tan', 'tan⁻¹', 'F']],
    [['RCL', 'RCL', 'STO'], ['ENG', 'ENG', '←'], ['LPAREN', '(', ''], ['RPAREN', ')', '', 'X'], ['COMMA', ',', ';', 'Y'], ['STO', 'M+', 'M−', 'M']],
    [['7', '7', ''], ['8', '8', ''], ['9', '9', ''], ['DEL', 'DEL', 'INS'], ['AC', 'AC', 'OFF']],
    [['4', '4', ''], ['5', '5', ''], ['6', '6', ''], ['MUL', '×', ''], ['DIV', '÷', '']],
    [['1', '1', 'S-SUM'], ['2', '2', 'S-VAR'], ['3', '3', ''], ['ADD', '+', ''], ['SUB', '−', '']],
    [['0', '0', 'Rnd'], ['DOT', '.', 'Ran#'], ['EXP', 'EXP', 'π'], ['ANS', 'Ans', 'DRG►'], ['EQ', '=', '%']]
  ];
  const DPAD = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

  const ALL = new Set(LAYOUT.flat().map(k => k[0]).concat(DPAD).concat(['CHAR', 'COMMA', 'PERCENT', 'PI', 'VARX']));

  /** PC keyboard -> key event (simulator only). textMode: printable chars become CHAR. */
  function fromKeyboard(e, textMode) {
    const k = e.key;
    const named = {
      ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'EQ', '=': 'EQ',
      Backspace: 'DEL', Delete: 'DEL', Escape: 'AC', F1: 'ON', F2: 'SHIFT', F3: 'ALPHA', F4: 'MODE', F6: 'MENU', Insert: 'STO'
    };
    if (named[k]) return { key: named[k] };
    if (textMode && k.length === 1) return { key: 'CHAR', ch: k };
    const map = {
      '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
      '.': 'DOT', ',': 'COMMA', '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '^': 'POW', '(': 'LPAREN', ')': 'RPAREN',
      '%': 'PERCENT', s: 'SIN', c: 'COS', t: 'TAN', g: 'LOG', l: 'LN', p: 'PI', r: 'SQRT', q: 'SQR', e: 'EXP', x: 'VARX',
      a: 'ANS', m: 'MODE', n: 'NEG', i: 'INV', f: 'FRAC', '!': 'RPAREN', h: 'HYP', d: 'DMS', k: 'ENG', o: 'POL', u: 'CUBE', v: 'RCL', C: 'NCR'
    };
    if (map[k]) return { key: map[k], shift: k === '!' ? true : undefined };
    return null;
  }

  return { LAYOUT, DPAD, ALL, fromKeyboard };
});
