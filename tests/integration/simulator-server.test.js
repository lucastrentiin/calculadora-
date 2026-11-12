'use strict';
/*
 * End-to-end: the simulator's real HTTP client (simulator/js/sim/platform.js HttpAI,
 * protocol mt1 with HMAC) talks to the real home server process (backend/src/server.ts)
 * using the MockProvider. Covers acceptance criteria 1, 2, 5, 6, 9, 11 and 12.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const P = require('../../simulator/js/sim/platform.js');
const { App } = require('../../simulator/js/core/app.js');

const ROOT = join(__dirname, '..', '..');
const NODE = process.execPath;
const port = 18000 + Math.floor(Math.random() * 2000);

let server, env, dataDir;
test.before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mt-e2e-'));
  env = { ...process.env, MT_DATA_DIR: dataDir, SERVER_LOCAL_PORT: String(port), REQUEST_WAIT_MS: '3000' };
  server = spawn(NODE, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('servidor nao subiu')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('tunel')) { clearTimeout(t); res(); } });
  });
});
test.after(() => { if (server) server.kill('SIGTERM'); });

function provision(id) {
  const out = execFileSync(NODE, ['--disable-warning=ExperimentalWarning', 'src/cli/admin.ts', 'device-add', id, 'simulador'], { cwd: join(ROOT, 'backend'), env }).toString();
  return out.match(/device_key: (\S+)/)[1];
}

test('simulator <-> home server: config, question, structured answer, image, cancel', async () => {
  const key = provision('sim-e2e');
  const ai = new P.HttpAI({ baseUrl: 'http://127.0.0.1:' + (port + 1), remoteUrl: 'http://127.0.0.1:' + port, deviceId: 'sim-e2e', deviceKeyB64: key });
  const cfg = await ai.config();
  assert.ok(cfg.providers.some(p => p.id === 'mock'), 'servidor oferece o MockProvider sem nenhum app instalado');

  const r = await ai.ask({ kind: 'text', requestId: 'e2e-00000001', sessionId: 's-0001', question: 'resolva 2x^2-5x+3=0', mode: 'full', provider: 'mock' }, {});
  assert.equal(r.status, 'ok');
  assert.equal(r.provider, 'mock');
  assert.match(r.answer, /x1 = 1, x2 = 1.5/);
  assert.equal(r.verification.state, 'match');

  const jpeg = new Uint8Array(3000); jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); jpeg.set([0xff, 0xc0, 0, 17, 8, 1, 224, 2, 128, 3], 20); jpeg[2998] = 0xff; jpeg[2999] = 0xd9;
  const v = await ai.ask({ kind: 'image', requestId: 'e2e-00000002', sessionId: 's-0001', image: jpeg, prompt: 'resolva', mode: 'short', provider: 'mock' }, {});
  assert.equal(v.status, 'ok');
  assert.equal(v.kind, 'image');

  const c = await ai.cancelRemote('e2e-00000002');
  assert.equal(c.status, 'ja concluido no servidor');
  await assert.rejects(new P.HttpAI({ baseUrl: 'http://127.0.0.1:' + port, deviceId: 'sim-e2e', deviceKeyB64: Buffer.alloc(32).toString('base64') }).config(), /401/);
});

test('full simulator app over the server: LCD shows the whole resolution; ON returns to NORMAL', async () => {
  const key = provision('sim-app');
  let t = 1e7;
  const platform = P.createPlatform({ clock: () => t, ai: new P.HttpAI({ baseUrl: 'http://127.0.0.1:' + port, deviceId: 'sim-app', deviceKeyB64: key }) });
  const app = new App(platform, { authPolicy: { iterations: 1000 } });
  app.settings.aiNoticeAck = true;
  const k = (...ks) => ks.flat().forEach(x => app.handleKey(typeof x === 'string' ? { key: x } : x));
  const PIN = ['1', '2', '3', '4', '5', '6'];
  k('SHIFT', 'SHIFT', 'ALPHA', 'ALPHA', PIN, 'DOWN', PIN, 'EQ'); await app.pinSetupPromise;
  await new Promise(r => setTimeout(r, 300));
  app.settings.provider = 'mock';
  k('1'); app.handleKey({ key: 'CHAR', ch: '2+3*(4-1)^2/9' }); app.handleKey({ key: 'EQ', shift: true });
  await app.ai.promise;
  assert.equal(app.state, 'AI_RESPONSE');
  const reader = app.top;
  app.render();
  const blocks = reader.blocks.map(b => b.text).join('\n');
  assert.match(blocks, /\[IA\] Resultado/);
  assert.match(blocks, /\[SERVIDOR\] Verificacao/);
  assert.match(blocks, /\[LOCAL\] Verificacao/);
  let guard = 0; while (reader.model.cursor < reader.model.lines.length - 1 && guard++ < 500) k('DOWN');
  assert.equal(reader.model.cursor, reader.model.lines.length - 1, 'todo o conteudo e alcancavel');
  k('ON');
  assert.equal(app.state, 'NORMAL');
  server.kill('SIGSTOP');                  // home server frozen/unreachable
  k('2', 'ADD', '2', 'EQ');
  assert.equal(app.calc.resultText(), '4', 'calculadora offline independente do servidor');
  server.kill('SIGCONT');
});
