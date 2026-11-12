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

  // [code, label, shiftLabel]
  const LAYOUT = [
    [['SHIFT', 'SHIFT', ''], ['ALPHA', 'ALPHA', 'a/A'], ['MODE', 'MODE', ''], ['MENU', 'MENU', ''], ['ON', 'ON', '']],
    [['FRAC', 'S⇔D', ''], ['SQRT', '√', '∛'], ['SQR', 'x²', ''], ['POW', 'xʸ', 'ʸ√x'], ['LOG', 'log', '10ˣ'], ['LN', 'ln', 'eˣ']],
    [['NEG', '(−)', ''], ['LPAREN', '(', ''], ['RPAREN', ')', 'x!'], ['SIN', 'sin', 'sin⁻¹'], ['COS', 'cos', 'cos⁻¹'], ['TAN', 'tan', 'tan⁻¹']],
    [['STO', 'M+', 'M−'], ['RCL', 'MR', 'MC'], ['PI', 'π', ''], ['PERCENT', '%', ''], ['INV', 'x⁻¹', ''], ['VARX', 'x', '']],
    [['7', '7', ''], ['8', '8', ''], ['9', '9', ''], ['DEL', 'DEL', ''], ['AC', 'AC', '']],
    [['4', '4', ''], ['5', '5', ''], ['6', '6', ''], ['MUL', '×', 'nCr'], ['DIV', '÷', 'nPr']],
    [['1', '1', ''], ['2', '2', 'abc'], ['3', '3', 'def'], ['ADD', '+', ''], ['SUB', '−', '']],
    [['0', '0', ''], ['DOT', '.', ','], ['EXP', '×10ˣ', ''], ['ANS', 'Ans', ''], ['EQ', '=', 'passos']]
  ];
  const DPAD = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

  const ALL = new Set(LAYOUT.flat().map(k => k[0]).concat(DPAD).concat(['CHAR', 'COMMA']));

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
      a: 'ANS', m: 'MODE', n: 'NEG', i: 'INV', f: 'FRAC', '!': 'RPAREN'
    };
    if (map[k]) return { key: map[k], shift: k === '!' ? true : undefined };
    return null;
  }

  return { LAYOUT, DPAD, ALL, fromKeyboard };
});
