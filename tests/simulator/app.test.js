'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('../../simulator/js/core/app.js');
const P = require('../../simulator/js/sim/platform.js');

const PIN = ['1', '2', '3', '4', '5', '6'];
const COMBO = ['SHIFT', 'SHIFT', 'ALPHA', 'ALPHA'];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function setup(opts = {}) {
  let t = 1_000_000;
  const logs = [];
  const platform = P.createPlatform({ storage: opts.storage, clock: () => t, aiOpts: { latencyMs: opts.latency ?? 40 }, log: (e, d) => logs.push(JSON.stringify([e, d])) });
  if (opts.ai) platform.ai = opts.ai;
  const mk = () => new App(platform, { authPolicy: { iterations: 1000 } });
  const app = mk();
  app.settings.aiNoticeAck = true; // privacy notice covered by its own test
  const k = (...keys) => keys.flat().forEach(x => app.handleKey(typeof x === 'string' ? { key: x } : x));
  const ctx = { app, k, platform, logs, advance: (ms) => { t += ms; }, mk, get t() { return t; } };
  if (opts.pin !== false) {
    k(COMBO, PIN, 'DOWN', PIN, 'EQ');
    await app.pinSetupPromise;
    k('ON');
  }
  return ctx;
}
async function login(c, pin = PIN) { c.k(COMBO, pin, 'EQ'); await c.app.pendingAuth; }
const pixelsDiff = (a, b, w) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push([i % w, Math.floor(i / w)]); return out; };

test('starts in NORMAL and works offline as a calculator', async () => {
  const c = await setup({ pin: false });
  c.platform.wifi.disconnect();
  assert.equal(c.app.state, 'NORMAL');
  c.k('1', '2', 'DIV', '4', 'EQ');
  assert.equal(c.app.calc.resultText(), '3');
  c.k('ADD', '1', 'EQ'); // continues from Ans
  assert.equal(c.app.calc.resultText(), '4');
  c.k('MODE', 'MODE', '2'); assert.equal(c.app.settings.angle, 'rad'); // MODE screens like the original
  c.k('ON'); assert.equal(c.app.calc.expr, ''); // ON keeps its conventional meaning
  c.k('UP'); assert.equal(c.app.calc.resultText(), '4'); // REPLAY
  c.k('AC', '3', 'EQ', 'STO');                        // M+
  c.k('AC', 'RCL', 'STO');                           // RCL M
  assert.equal(c.app.calc.resultText(), '3');
  c.k('1', 'FRAC', '3', 'EQ'); assert.equal(c.app.calc.resultText(), '1┘3');
  c.k('FRAC'); assert.equal(c.app.calc.resultText(), '0.3333333333');
});

test('first use requires creating a PIN (no fixed PIN); verifier never stores the PIN', async () => {
  const c = await setup({ pin: false });
  assert.equal(c.app.auth.hasPin(), false);
  c.k(COMBO);
  assert.equal(c.app.state, 'SETTINGS');
  c.k(PIN, 'DOWN', '6', '5', '4', '3', '2', '1', 'EQ');
  assert.match(c.app.top.error, /diferentes/);
  c.k('AC', 'UP', 'AC');
  c.k('1', '2', '3', 'DOWN', '1', '2', '3', 'EQ');
  assert.match(c.app.top.error, /6 a 8/);
  const dump = () => [...c.platform.storage.m.values()].join('\n') + c.logs.join('\n');
  c.k('AC', 'UP', 'AC', PIN, 'DOWN', PIN, 'EQ');
  await c.app.pinSetupPromise;
  assert.equal(c.app.state, 'AUTHENTICATED');
  assert.ok(!dump().includes('123456'), 'PIN em texto puro no armazenamento ou log');
  const ver = JSON.parse(c.platform.storage.get('auth.verifier'));
  assert.equal(ver.alg, 'PBKDF2-SHA256'); assert.ok(ver.salt && ver.check);
});

test('discreet authentication: only a corner indicator changes, digits are not shown', async () => {
  const c = await setup();
  c.k('7', 'MUL', '6', 'EQ');
  const before = Uint8Array.from(c.app.render().pixels);
  c.k(COMBO);
  assert.equal(c.app.state, 'AUTH_PENDING');
  const pending = Uint8Array.from(c.app.render().pixels);
  const diff = pixelsDiff(before, pending, 128);
  assert.ok(diff.length > 0 && diff.every(([x, y]) => x >= 125 && y <= 2), 'mudanca fora do canto superior direito');
  c.k('1', '2', '3');
  assert.deepEqual(Array.from(c.app.render().pixels), Array.from(pending), 'digitos do PIN apareceram no visor');
  assert.equal(c.app.calc.resultText(), '42'); // math content kept
  c.k('4', '5', '6', 'EQ');
  await c.app.pendingAuth;
  assert.equal(c.app.state, 'AUTHENTICATED');
});

test('authentication timeout and non-digit keys silently return to the calculator', async () => {
  const c = await setup();
  c.k(COMBO, '1'); c.advance(31000); c.app.tick();
  assert.equal(c.app.state, 'NORMAL');
  c.k(COMBO, '1', 'ADD');
  assert.equal(c.app.state, 'NORMAL');
  assert.equal(c.app.calc.expr, '+'); // the key behaved as a calculator key
});

test('wrong PIN attempts lead to temporary lockout (persisted across reboot)', async () => {
  const c = await setup();
  for (let i = 0; i < 5; i++) { await login(c, ['9', '9', '9', '9', '9', '9']); assert.equal(c.app.state, 'NORMAL'); c.advance(4000); }
  assert.ok(c.app.auth.isLocked());
  await login(c);                              // correct PIN ignored during lockout
  assert.equal(c.app.state, 'NORMAL');
  const rebooted = c.mk();                     // new App instance, same storage
  assert.ok(rebooted.auth.isLocked());
  c.advance(31000);
  await login(c);
  assert.equal(c.app.state, 'AUTHENTICATED');
  c.k('ON');
  for (let i = 0; i < 5; i++) { await login(c, ['0', '0', '0', '0', '0', '0']); c.advance(1000); }
  c.advance(31000);
  await login(c, ['0', '0', '0', '0', '0', '0']);
  assert.ok(c.app.auth.lockRemainingMs() > 30000, 'backoff exponencial');
});

test('protected menu navigation: wrap-around, shortcuts and back', async () => {
  const c = await setup();
  await login(c);
  const menu = c.app.top;
  c.k('UP'); assert.equal(menu.sel, menu.items(c.app).length - 1);
  c.k('DOWN'); assert.equal(menu.sel, 0);
  c.k('DOWN', 'DOWN', 'EQ'); assert.equal(c.app.state, 'MATH_TOOLS');
  c.k('AC'); assert.equal(c.app.state, 'AUTHENTICATED');
  c.k('8'); assert.equal(c.app.state, 'SETTINGS');
  c.k('LEFT'); // LEFT on a cycle item changes the value instead of leaving
  assert.equal(c.app.settings.responseMode, 'fast');
  c.k('AC'); c.k('6'); assert.equal(c.app.settings.responseMode, 'short');
});

test('PRIVACY_LOCK from every protected state returns to NORMAL in < 100 ms and wipes data', async () => {
  const c = await setup({ latency: 2000 });
  c.k('2', 'ADD', '2', 'EQ');
  const states = {
    AUTHENTICATED: () => {},
    TEXT_ENTRY: () => { c.k('1'); c.app.handleKey({ key: 'CHAR', ch: 'segredo' }); },
    AI_REQUEST: () => { c.k('1'); c.app.handleKey({ key: 'CHAR', ch: '2+2' }); c.app.handleKey({ key: 'EQ', shift: true }); },
    AI_RESPONSE: async () => { c.platform.ai.latencyMs = 5; c.k('1'); c.app.handleKey({ key: 'CHAR', ch: '3*3' }); c.app.handleKey({ key: 'EQ', shift: true }); await c.app.ai.promise; c.platform.ai.latencyMs = 2000; },
    CAMERA: async () => { c.k('2'); await wait(200); },
    MATH_TOOLS: () => c.k('3'),
    SETTINGS: () => c.k('8')
  };
  for (const [st, go] of Object.entries(states)) {
    await login(c);
    await go();
    assert.equal(c.app.state, st);
    const views = c.app.views.slice();
    c.k('ON');
    assert.equal(c.app.state, 'NORMAL', st);
    assert.equal(c.app.isProtected, false);
    assert.equal(c.app.views.length, 0);
    assert.equal(c.app.vault.isOpen, false);
    assert.equal(c.app.lastLock.from, st);
    assert.ok(c.app.lastLock.ms < 100, st + ' levou ' + c.app.lastLock.ms + ' ms');
    assert.equal(c.app.calc.resultText(), '4', 'conteudo matematico normal restaurado');
    for (const v of views) if (v.buf) assert.equal(v.buf.text, '', 'buffer de texto nao foi limpo');
    if (st === 'CAMERA') assert.equal(c.platform.camera.isActive(), false);
    // re-entering protected content requires a new authentication
    c.k('MENU'); assert.equal(c.app.isProtected, false); c.k('ON');
  }
});

test('AUTH_PENDING + ON just cancels; late PIN verification after ON is ignored', async () => {
  const c = await setup();
  c.k(COMBO, PIN, 'EQ');
  c.k('ON');
  await c.app.pendingAuth;
  assert.equal(c.app.state, 'NORMAL');
  assert.equal(c.app.session.authenticated, false);
});

test('async AI request: cancel before sending vs. after reaching the server', async () => {
  const c = await setup({ latency: 400 });
  await login(c);
  c.k('1'); c.app.handleKey({ key: 'CHAR', ch: '1+1' }); c.app.handleKey({ key: 'EQ', shift: true });
  assert.equal(c.app.state, 'AI_REQUEST');
  c.k('ON'); // immediately: not sent yet
  assert.equal(c.app.remoteCancels.length, 0);

  await login(c);
  c.k('1'); c.app.handleKey({ key: 'CHAR', ch: '2+2' }); c.app.handleKey({ key: 'EQ', shift: true });
  const req = c.app.ai;
  while (!req.sent) await wait(5);
  c.k('ON');
  assert.equal(c.app.state, 'NORMAL');
  assert.equal(c.app.remoteCancels.length, 1);
  assert.equal(c.app.remoteCancels[0].status, 'cancelamento solicitado');
  await wait(150);
  assert.equal(c.app.remoteCancels[0].status, 'cancelado no servidor');
  await wait(400);
  assert.equal(c.app.state, 'NORMAL', 'resposta tardia nao pode aparecer');
});

test('late response after cancel is discarded and recorded', async () => {
  let resolve;
  const ai = { ask: (p, o) => { o.onPhase('enviado'); return new Promise(r => { resolve = r; }); }, cancelRemote: async () => ({ status: 'ja concluido no servidor' }) };
  const c = await setup({ ai });
  await login(c);
  c.k('1'); c.app.handleKey({ key: 'CHAR', ch: 'oi' }); c.app.handleKey({ key: 'EQ', shift: true });
  c.k('ON');
  resolve({ version: 1, status: 'ok', answer: 'segredo' });
  await wait(10);
  assert.equal(c.app.state, 'NORMAL');
  assert.equal(c.app.remoteCancels[0].lateResponseDiscarded, true);
  assert.equal(c.app.remoteCancels[0].status, 'ja concluido no servidor');
});

test('text entry: methods A and B, switching keeps text, submit goes to AI and shows response', async () => {
  const c = await setup({ latency: 5 });
  await login(c);
  c.k('1');
  const ed = c.app.top;
  assert.equal(ed.method, 'A');
  c.k('RIGHT', 'RIGHT', 'EQ');            // 'e' from the virtual keyboard
  c.k('MODE');                            // switch to B
  c.k('4', '4', '4');                     // 'i'
  c.k('MODE');                            // back to A
  assert.equal(ed.text, 'ei');
  c.k('DEL'); assert.equal(ed.text, 'e');
  c.k('2', 'ADD', '2');
  c.app.handleKey({ key: 'EQ', shift: true });
  assert.equal(c.app.state, 'AI_REQUEST');
  await c.app.ai.promise;
  assert.equal(c.app.state, 'AI_RESPONSE');
  const reader = c.app.top;
  const txt = reader.model ? reader.model.lines.map(l => l.text).join('\n') : reader.blocks.map(b => b.text).join('\n');
  assert.match(txt, /\[IA\]/); assert.match(txt, /\[LOCAL\]/);
  c.k('DOWN', 'DOWN', 'DOWN'); assert.ok(reader.model.cursor >= 3);
  c.k('EQ'); c.k('3'); // mode switch: Completo, re-rendered without new request
  assert.equal(c.app.state, 'AI_RESPONSE');
});

test('history and favorites are encrypted at rest and survive re-authentication', async () => {
  const c = await setup({ latency: 5 });
  await login(c);
  await c.app.vaultReady;
  c.k('1'); c.app.handleKey({ key: 'CHAR', ch: 'pergunta-secreta 6*7' }); c.app.handleKey({ key: 'EQ', shift: true });
  await c.app.ai.promise;
  c.k('STO'); // favorite
  await wait(20);
  const blob = c.platform.storage.get('vault');
  assert.ok(blob && !blob.includes('pergunta-secreta'), 'dados privados em texto puro');
  c.k('ON');
  await login(c);
  await c.app.vaultReady;
  assert.equal(c.app.vault.data.history.length, 1);
  assert.equal(c.app.vault.data.favorites.length, 1);
  c.k('5'); // history menu
  assert.equal(c.app.top.items(c.app).length, 2); // item + "apagar tudo"
  c.k('DEL'); await wait(10);
  assert.equal(c.app.vault.data.history.length, 0);
  c.k('AC', '8');
  const menu = c.app.top;
  // AC on the protected root menu ends the session (tested below)
  const idx = menu.items(c.app).findIndex(i => i.label === 'Historico IA');
  menu.sel = idx; c.k('EQ');
  assert.equal(c.app.settings.aiHistory, false);
  c.k('AC', '1'); c.app.handleKey({ key: 'CHAR', ch: '1+1' }); c.app.handleKey({ key: 'EQ', shift: true });
  await c.app.ai.promise;
  assert.equal(c.app.vault.data.history.length, 0, 'historico desativado nao grava');
});

test('wrong data key cannot read the vault', async () => {
  const c = await setup({ latency: 5 });
  await login(c);
  await c.app.vaultReady;
  c.app.vault.data.history.push({ title: 'x' });
  await c.app.vault.save();
  const { Vault } = require('../../simulator/js/core/auth.js');
  const v = new Vault({ crypto: c.platform.crypto, storage: c.platform.storage });
  await v.open(new Uint8Array(32));
  assert.equal(v.corrupt, true);
  assert.equal(v.data.history.length, 0);
});

test('automatic lock after inactivity and on critical battery', async () => {
  const c = await setup();
  await login(c);
  c.advance(c.app.settings.autoLockSec * 1000 + 1);
  c.app.tick();
  assert.equal(c.app.state, 'NORMAL'); assert.equal(c.app.lastLock.reason, 'inactivity');
  await login(c);
  c.platform.battery.percent = 2;
  c.app.tick();
  assert.equal(c.app.lastLock.reason, 'battery');
  c.platform.battery.supported = false;
  c.k('1', 'EQ'); // calculator still works, no battery icon drawn
  const fb = c.app.render();
  let px = 0; for (let x = 110; x < 125; x++) for (let y = 0; y < 6; y++) px += fb.getPixel(x, y);
  assert.equal(px, 0);
});

test('sleep after inactivity; first key only wakes the display', async () => {
  const c = await setup();
  c.advance(c.app.settings.sleepSec * 1000 + 1); c.app.tick();
  assert.equal(c.app.asleep, true);
  assert.ok(c.app.render().pixels.every(p => p === 0));
  c.k('5'); assert.equal(c.app.asleep, false); assert.equal(c.app.calc.expr, '');
});

test('camera: init failure, capture failure, capture and send', async () => {
  const c = await setup({ latency: 5 });
  await login(c);
  c.platform.camera.failInit = true;
  c.k('2'); await wait(200);
  assert.equal(c.app.top.phase, 'error');
  c.platform.camera.failInit = false;
  c.k('EQ'); await wait(200);
  assert.equal(c.app.top.phase, 'ready');
  c.k('RIGHT'); assert.equal(c.app.settings.resolution, 'XGA');
  c.platform.camera.failCapture = true;
  c.k('EQ'); await wait(200);
  assert.equal(c.app.top.phase, 'error');
  c.platform.camera.failCapture = false;
  c.k('EQ'); await wait(200); c.k('EQ'); await wait(200);
  assert.equal(c.app.top.phase, 'captured');
  c.k('EQ');
  assert.equal(c.platform.camera.isActive(), false, 'camera desligada apos uso');
  assert.equal(c.app.state, 'AI_REQUEST');
  await c.app.ai.promise;
  assert.equal(c.app.state, 'AI_RESPONSE');
});

test('Wi-Fi errors: AI unavailable but offline tools keep working', async () => {
  const c = await setup();
  await login(c);
  c.platform.wifi.disconnect();
  c.k('1'); c.app.handleKey({ key: 'CHAR', ch: 'x' }); c.app.handleKey({ key: 'EQ', shift: true });
  assert.equal(c.app.state, 'AI_RESPONSE');
  assert.match(c.app.top.blocks.map(b => b.text).join(' '), /Wi-Fi desconectado/);
  c.k('AC', '3', '3'); // tools -> quadratic
  c.k('1', 'DOWN', 'SUB', '3', 'DOWN', '2', 'EQ');
  assert.match(c.app.top.blocks.map(b => b.text).join('\n'), /x2 = .* = 2/);
});

test('AI failures: timeout, invalid and huge responses are handled', async () => {
  const c = await setup({ latency: 5 });
  await login(c);
  for (const [mode, re] of [['timeout', /Tempo esgotado/], ['invalid', /invalida/], ['garbage', /invalida/], ['huge', /invalida|excede/], ['refused', /Recusado/]]) {
    c.platform.ai.failMode = mode;
    c.k('1'); c.app.handleKey({ key: 'CHAR', ch: '1+1' }); c.app.handleKey({ key: 'EQ', shift: true });
    await c.app.ai.promise;
    assert.equal(c.app.state, 'AI_RESPONSE', mode);
    assert.match(c.app.top.blocks.map(b => b.text).join(' '), re, mode);
    c.k('AC');
  }
});

test('unprotected tools from NORMAL (MENU): formulas, conversions and steps; ON returns', async () => {
  const c = await setup();
  c.k('MENU'); assert.equal(c.app.state, 'MATH_TOOLS'); assert.equal(c.app.isProtected, false);
  const menu = c.app.top;
  menu.sel = menu.items(c.app).findIndex(i => i.label === 'Conversoes'); c.k('EQ');
  c.k('EQ'); // Comprimento
  c.k('1', '0', '0', 'DOWN', 'DOWN', 'RIGHT', 'EQ'); // 100 mm -> m
  const lines = c.app.top.blocks.map(b => b.text).join('\n');
  assert.match(lines, /100 mm = 0.1 m/);
  c.k('ON'); assert.equal(c.app.state, 'NORMAL');
  c.k('2', 'ADD', '3', 'MUL', '4');
  c.k('MENU', 'EQ', 'EQ');                           // tools -> step by step of the current expression
  assert.equal(c.app.state, 'MATH_TOOLS');
  assert.match(c.app.top.blocks.map(b => b.text).join('\n'), /14/);
});

test('formula favorites and application with variables', async () => {
  const c = await setup();
  c.app.openFormulas(false);
  c.app.openFormula(require('../../simulator/js/core/formulas.js').get('pyth'), false);
  c.k('STO'); assert.deepEqual(c.app.formulaFavs, ['pyth']);
  c.k('EQ', '3', 'DOWN', '4', 'EQ');
  assert.match(c.app.top.blocks.map(b => b.text).join('\n'), /c = 5/);
});

test('storage failures (power loss / full flash) do not break the calculator', async () => {
  const c = await setup({ pin: false });
  c.platform.storage.set = () => { throw new Error('flash cheia'); };
  c.k('2', 'ADD', '2', 'EQ', 'MODE');
  assert.equal(c.app.calc.resultText(), '4');
  assert.ok(c.logs.some(l => l.includes('storage_error')));
});

test('rendering adapts to other resolutions and large font', async () => {
  let t = 0;
  const platform = P.createPlatform({ clock: () => t });
  const app = new App(platform, { width: 192, height: 64 });
  assert.equal(app.layout().cols, 30); assert.equal(app.layout().rows, 8);
  app.settings.largeFont = true;
  assert.equal(app.layout().cols, 15); assert.equal(app.layout().rows, 4);
  app.openTools(false);
  app.render();
  app.openSteps('1+2+3+4+5+6+7+8+9+10+11+12+13+14+15+16+17+18+19+20+21+22', false);
  app.render();
  app.handleKey({ key: 'RIGHT' });
  app.render();
});

test('logs never contain PINs or questions', async () => {
  const c = await setup({ latency: 5 });
  await login(c);
  c.k('1'); c.app.handleKey({ key: 'CHAR', ch: 'minha duvida 9*9' }); c.app.handleKey({ key: 'EQ', shift: true });
  await c.app.ai.promise;
  const all = c.logs.join('\n');
  assert.ok(!all.includes('123456')); assert.ok(!all.includes('minha duvida'));
});

test('AC on the protected root menu ends the session like a lock', async () => {
  const c = await setup();
  await login(c);
  c.k('AC');
  assert.equal(c.app.state, 'NORMAL');
  assert.equal(c.app.isProtected, false);
});
