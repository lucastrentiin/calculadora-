/*
 * In-browser self test (button "Executar autoteste"). The full suite lives in
 * tests/simulator and runs with `npm test`; this subset proves the core works
 * in the user's browser without hardware or Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/app.js'), require('./platform.js'), require('../core/mathEngine.js'), require('../core/units.js'), require('../core/textInput.js'));
  } else { root.MT = root.MT || {}; root.MT.SelfTest = factory(root.MT.AppModule, root.MT.SimPlatform, root.MT.MathEngine, root.MT.Units, root.MT.TextInput); }
})(typeof self !== 'undefined' ? self : this, function (AppMod, P, M, U, TI) {
  'use strict';

  function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' esperado ' + JSON.stringify(b) + ', obtido ' + JSON.stringify(a)); }
  function near(a, b, msg) { if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b))) throw new Error((msg || '') + ' esperado ' + b + ', obtido ' + a); }

  async function makeApp() {
    let t = 1e6;
    const platform = P.createPlatform({ clock: () => t, aiOpts: { latencyMs: 5 } });
    const app = new AppMod.App(platform, { authPolicy: { iterations: 1000 } });
    app.settings.aiNoticeAck = true;
    const k = (...ks) => ks.forEach(x => app.handleKey(typeof x === 'string' ? { key: x } : x));
    k('SHIFT', 'SHIFT', 'ALPHA', 'ALPHA', '1', '2', '3', '4', '5', '6', 'DOWN', '1', '2', '3', '4', '5', '6', 'EQ');
    await app.pinSetupPromise;
    k('ON');
    return { app, k, platform, advance: (ms) => { t += ms; } };
  }
  async function login(ctx) {
    ctx.k('SHIFT', 'SHIFT', 'ALPHA', 'ALPHA', '1', '2', '3', '4', '5', '6', 'EQ');
    await ctx.app.pendingAuth;
  }

  const cases = [
    ['precedencia', () => { eq(M.calculate('2+3*4^2').text, '50'); eq(M.calculate('-2^2').text, '-4'); eq(M.calculate('2^3^2').text, '512'); }],
    ['trigonometria em graus', () => { eq(M.calculate('sin(30)', { angle: 'deg' }).text, '0.5'); eq(M.calculate('tan(90)', { angle: 'deg' }).error, 'DOMAIN'); }],
    ['erros', () => { eq(M.calculate('1/0').error, 'DIV_ZERO'); eq(M.calculate('2+*3').error, 'SYNTAX'); eq(M.calculate('ln(-1)').error, 'DOMAIN'); }],
    ['conversoes', () => { near(U.convert('length', 'in', 'cm', 1), 2.54); near(U.convert('temperature', 'C', 'F', 100), 212); }],
    ['multi-tap', () => {
      const b = new TI.TextBuffer(); const mt = new TI.MultiTap(b, { timeoutMs: 500 });
      mt.press('4', 0); mt.press('4', 100); mt.press('4', 1000); mt.press('6', 1100); eq(b.text, 'hgm');
    }],
    ['autenticacao e bloqueio ON', async () => {
      const c = await makeApp();
      await login(c);
      eq(c.app.state, 'AUTHENTICATED');
      c.k('ON');
      eq(c.app.state, 'NORMAL'); eq(c.app.session.authenticated, false);
    }],
    ['ON em todos os estados protegidos', async () => {
      const c = await makeApp();
      const reach = {
        AUTHENTICATED: async () => {},
        TEXT_ENTRY: async () => c.k('1'),
        AI_REQUEST: async () => { c.k('1'); c.app.handleKey({ key: 'CHAR', ch: '2+2' }); c.app.handleKey({ key: 'EQ', shift: true }); },
        CAMERA: async () => { c.k('2'); },
        MATH_TOOLS: async () => c.k('3'),
        SETTINGS: async () => c.k('8')
      };
      for (const [st, go] of Object.entries(reach)) {
        await login(c); await go();
        eq(c.app.state, st, 'alcancar ' + st);
        c.k('ON');
        eq(c.app.state, 'NORMAL', 'ON em ' + st);
        eq(c.app.isProtected, false);
      }
    }],
    ['PIN errado e bloqueio temporario', async () => {
      const c = await makeApp();
      for (let i = 0; i < 5; i++) { c.k('SHIFT', 'SHIFT', 'ALPHA', 'ALPHA', '9', '9', '9', '9', '9', '9', 'EQ'); await c.app.pendingAuth; c.advance(4000); }
      eq(c.app.auth.isLocked(), true);
      await login(c);
      eq(c.app.state, 'NORMAL', 'combinacao ignorada durante bloqueio');
    }]
  ];

  async function run() {
    const out = [];
    for (const [name, fn] of cases) {
      try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, err: e.message }); }
    }
    return out;
  }
  return { run, cases };
});
