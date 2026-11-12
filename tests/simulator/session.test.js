'use strict';
// Addendum requirements: session binding, ON key everywhere, providers, failures, recovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('../../simulator/js/core/app.js');
const P = require('../../simulator/js/sim/platform.js');

const PIN = ['1', '2', '3', '4', '5', '6'];
const COMBO = ['SHIFT', 'SHIFT', 'ALPHA', 'ALPHA'];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function setup(opts = {}) {
  let t = 5_000_000;
  const platform = P.createPlatform({ storage: opts.storage, clock: () => t, aiOpts: { latencyMs: opts.latency ?? 30 } });
  if (opts.ai) platform.ai = opts.ai;
  const mk = () => { const a = new App(platform, { authPolicy: { iterations: 1000 } }); return a; };
  const c = { platform, mk, app: mk(), advance: (ms) => { t += ms; } };
  c.k = (...keys) => keys.flat().forEach(x => c.app.handleKey(typeof x === 'string' ? { key: x } : x));
  c.ask = (q) => { c.k('1'); c.app.handleKey({ key: 'CHAR', ch: q }); c.app.handleKey({ key: 'EQ', shift: true }); };
  c.login = async () => { c.k(COMBO, PIN, 'EQ'); await c.app.pendingAuth; };
  if (opts.pin !== false) { c.k(COMBO, PIN, 'DOWN', PIN, 'EQ'); await c.app.pinSetupPromise; c.k('ON'); }
  if (opts.ack !== false) c.app.settings.aiNoticeAck = true;
  return c;
}
const text = (app) => (app.top && app.top.blocks ? app.top.blocks.map(b => b.text).join('\n') : '');

test('a response from a previous session never appears, even after a new authentication', async () => {
  let resolveOld;
  const ai = { config: async () => ({ providers: [{ id: 'auto', label: 'AUTOMATICO' }] }),
    ask: (p, o) => { o.onPhase('enviado'); return new Promise(r => { resolveOld = r; }); }, cancelRemote: async () => ({ status: 'ja concluido no servidor' }) };
  const c = await setup({ ai });
  await c.login();
  c.ask('segredo antigo');
  assert.equal(c.app.state, 'AI_REQUEST');
  c.k('ON');
  await c.login();                       // new session
  assert.equal(c.app.state, 'AUTHENTICATED');
  resolveOld({ version: 1, status: 'ok', answer: 'resposta antiga secreta' });
  await wait(10);
  assert.equal(c.app.state, 'AUTHENTICATED', 'resposta antiga reabriu a tela');
  assert.ok(!text(c.app).includes('antiga'));
});

test('ON during image transmission: back to NORMAL, image buffer wiped, remote cancel tracked', async () => {
  let image;
  const ai = { config: async () => ({ providers: [] }), ask: (p, o) => { image = p.image; o.onPhase('enviado'); return new Promise(() => {}); }, cancelRemote: async () => ({ status: 'cancelado no servidor' }) };
  const c = await setup({ ai });
  await c.login();
  c.k('2'); await wait(200);              // camera
  c.k('EQ'); await wait(200);             // capture
  assert.equal(c.app.top.phase, 'captured');
  c.k('EQ');                              // send
  assert.equal(c.app.state, 'AI_REQUEST');
  assert.ok(image && image.length > 0);
  c.k('ON');
  assert.equal(c.app.state, 'NORMAL');
  assert.ok(image.every(b => b === 0), 'buffer da imagem nao foi limpo');
  await wait(20);
  assert.equal(c.app.remoteCancels[0].status, 'cancelado no servidor');
});

test('assistant selection lists only configured providers and is sent with the request', async () => {
  const c = await setup();
  let sent;
  const orig = c.platform.ai.ask.bind(c.platform.ai);
  c.platform.ai.ask = (p, o) => { sent = p; return orig(p, o); };
  await c.login();
  await wait(50);
  const menu = c.app.top;
  menu.sel = menu.items(c.app).findIndex(i => i.label === 'Assistente');
  c.k('EQ');
  const labels = c.app.top.items(c.app).map(i => i.label.replace('*', ''));
  assert.deepEqual(labels, ['AUTOMATICO', 'DEMO', 'GPT', 'CLAUDE']);
  c.k('DOWN', 'DOWN', 'DOWN', 'EQ');      // CLAUDE
  assert.equal(c.app.settings.provider, 'claude_code');
  c.ask('1+1');
  await c.app.ai.promise;
  assert.equal(sent.provider, 'claude_code');
  assert.equal(typeof sent.sessionId, 'string');
});

test('provider unavailable, no credits, TLS failure and server down are reported clearly', async () => {
  const c = await setup();
  await c.login();
  c.app.settings.provider = 'claude_code';
  for (const [mode, re] of [['provider_down', /nao autenticado/], ['no_credits', /Sem creditos/], ['tls', /TLS/], ['offline', /inacessivel/]]) {
    c.platform.ai.failMode = mode;
    c.ask('2+2');
    await c.app.ai.promise;
    assert.equal(c.app.state, 'AI_RESPONSE', mode);
    assert.match(text(c.app), re, mode);
    c.k('AC');
  }
  c.k('ON');
  c.k('6', 'MUL', '7', 'EQ');             // calculator independent of the server
  assert.equal(c.app.calc.resultText(), '42');
});

test('reconnection after the network drops', async () => {
  const c = await setup();
  await c.login();
  c.platform.wifi.disconnect();
  c.ask('1+1');
  assert.match(text(c.app), /Wi-Fi desconectado/);
  c.k('AC');
  c.platform.wifi.connect();
  c.ask('1+1');
  await c.app.ai.promise;
  assert.match(text(c.app), /\[IA\] Resultado/);
});

test('restart after a crash starts in NORMAL with no protected data open', async () => {
  const storage = new P.MemoryStorage();
  const c = await setup({ storage });
  await c.login();
  c.ask('pergunta');
  const rebooted = c.mk();                 // same storage, new process
  assert.equal(rebooted.state, 'NORMAL');
  assert.equal(rebooted.isProtected, false);
  assert.equal(rebooted.vault.isOpen, false);
  assert.ok(!rebooted.render().pixels.every(p => p === 0));
});

test('simulated storage corruption falls back safely', async () => {
  const storage = new P.MemoryStorage();
  const c = await setup({ storage });
  storage.set('settings', '{corrompido');
  storage.set('calc.history', 'nao-json');
  storage.set('vault', '{"v":1,"iv":"AAAA","ct":"BBBB"}');
  const a = c.mk();
  assert.equal(a.settings.angle, 'deg', 'ajustes padrao');
  assert.deepEqual(a.calc.history, []);
  a.handleKey({ key: 'SHIFT' }); a.handleKey({ key: 'SHIFT' }); a.handleKey({ key: 'ALPHA' }); a.handleKey({ key: 'ALPHA' });
  PIN.forEach(k => a.handleKey({ key: k })); a.handleKey({ key: 'EQ' });
  await a.pendingAuth; await a.vaultReady;
  assert.equal(a.state, 'AUTHENTICATED');
  assert.equal(a.vault.corrupt, true);
  assert.deepEqual(a.vault.data.history, []);
});

test('privacy notice must be accepted before the first AI use', async () => {
  const c = await setup({ ack: false });
  await c.login();
  c.k('1');
  assert.match(text(c.app), /politicas/);
  c.k('EQ');
  assert.equal(c.app.state, 'TEXT_ENTRY');
  assert.equal(c.app.settings.aiNoticeAck, true);
});

test('self-diagnostics: storage, LCD patterns, camera JPEG, server status', async () => {
  const c = await setup();
  await c.login();
  c.k('8');
  const m = c.app.top;
  m.sel = m.items(c.app).findIndex(i => i.label === 'Autodiagnostico'); c.k('EQ');
  const items = () => c.app.top.items(c.app);
  c.app.top.sel = items().findIndex(i => i.label === 'Armazenamento'); c.k('EQ');
  assert.match(text(c.app), /OK  Escrita\/leitura/); c.k('AC');
  c.app.top.sel = items().findIndex(i => i.label === 'LCD (padroes)'); c.k('EQ');
  assert.ok(c.app.render().pixels.every(p => p === 1), 'todos os pixels acesos');
  c.k('RIGHT'); assert.ok(c.app.render().pixels.every(p => p === 0)); c.k('AC');
  c.app.top.sel = items().findIndex(i => i.label === 'Camera / JPEG'); c.k('EQ'); await wait(400);
  assert.match(text(c.app), /OK  Captura JPEG/); c.k('AC');
  c.app.top.sel = items().findIndex(i => i.label === 'Wi-Fi e servidor'); c.k('EQ'); await wait(100);
  assert.match(text(c.app), /dispositivo autorizado/);
  c.k('ON');
  assert.equal(c.app.state, 'NORMAL');
});
