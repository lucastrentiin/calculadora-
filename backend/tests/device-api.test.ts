import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DeviceResponse } from '../src/requests/schema.ts';
import { MockProvider } from '../src/providers/mock/mock.ts';
import { ManualProvider } from '../src/providers/manual/manual.ts';
import { BaseProvider } from '../src/providers/base.ts';
import type { TaskInput, TaskOutcome } from '../src/providers/types.ts';
import { startApp, signed, enc, jpeg } from './helpers.ts';

class FakeProvider extends BaseProvider {
  readonly id: string; readonly name: string; calls = 0; outcome: TaskOutcome; delay = 0; images: boolean;
  constructor(id: string, outcome: TaskOutcome, images = false) {
    super(); this.id = id; this.name = id; this.outcome = outcome; this.images = images;
    this.state.status = 'ready'; this.caps({ supportsText: true, supportsImages: images });
  }
  async refresh() { /* static */ }
  executeText(_i: TaskInput, s: AbortSignal): Promise<TaskOutcome> {
    this.calls++;
    return new Promise((res) => { const t = setTimeout(() => res(this.outcome), this.delay); s.addEventListener('abort', () => { clearTimeout(t); res({ kind: 'error', code: 'cancelled', message: 'x', retryable: false }); }); });
  }
  override executeImage(i: TaskInput, s: AbortSignal) { return this.executeText(i, s); }
}

async function enroll(t: Awaited<ReturnType<typeof startApp>>) {
  const code = t.app.devices.createEnrollment('teste');
  const r = await fetch(t.base + '/api/v1/device/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device_id: 'dev-01' }) });
  assert.equal(r.status, 201);
  const j = await r.json();
  return { id: j.device_id as string, key: j.device_key as string, code };
}

test('server starts without any AI app; mock provider answers with a valid contract', async () => {
  const t = await startApp();
  const dev = await enroll(t);
  const st = await fetch(t.base + '/api/v1/device/status', signed('GET', '/api/v1/device/status', new Uint8Array(0), dev));
  assert.equal(st.status, 200);
  const cfg = await (await fetch(t.base + '/api/v1/device/config', signed('GET', '/api/v1/device/config', new Uint8Array(0), dev))).json();
  assert.ok(cfg.providers.some((p: { id: string }) => p.id === 'mock'));
  assert.match(cfg.privacy_notice, /politicas/);
  const r = await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000001', question: 'quanto e 2+3*4', mode: 'full', provider: 'mock' }), dev));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(DeviceResponse.safeParse(j).success, JSON.stringify(DeviceResponse.safeParse(j).error?.issues));
  assert.equal(j.provider, 'mock');
  assert.match(j.answer, /14/);
  assert.equal(j.verification.state, 'match');
  assert.ok(!JSON.stringify(t.logs).includes('quanto e'), 'pergunta nao pode ir para o log');
  await t.close();
});

test('enrollment codes are single use and expire; unknown codes rejected', async () => {
  const t = await startApp();
  const dev = await enroll(t);
  const again = await fetch(t.base + '/api/v1/device/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: dev.code }) });
  assert.equal(again.status, 403);
  const bad = await fetch(t.base + '/api/v1/device/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'nao-existe-123' }) });
  assert.equal(bad.status, 403);
  await t.close();
});

test('device authentication: bad key, revoked, replay, rotation grace, protocol version', async () => {
  const t = await startApp();
  const dev = await enroll(t);
  const path = '/api/v1/device/status';
  assert.equal((await fetch(t.base + path, signed('GET', path, new Uint8Array(0), { id: dev.id, key: randomBytes(32).toString('base64') }))).status, 401);
  const once = signed('GET', path, new Uint8Array(0), dev);
  assert.equal((await fetch(t.base + path, once)).status, 200);
  assert.equal((await fetch(t.base + path, once)).status, 401, 'replay');
  assert.equal((await fetch(t.base + path, signed('GET', path, new Uint8Array(0), dev, { 'X-Protocol': 'mt9' }))).status, 400);
  const newKey = t.app.devices.rotate(dev.id);
  assert.equal((await fetch(t.base + path, signed('GET', path, new Uint8Array(0), dev))).status, 200, 'chave antiga vale no periodo de graca');
  assert.equal((await fetch(t.base + path, signed('GET', path, new Uint8Array(0), { id: dev.id, key: newKey }))).status, 200);
  t.app.devices.setEnabled(dev.id, false);
  assert.equal((await fetch(t.base + path, signed('GET', path, new Uint8Array(0), { id: dev.id, key: newKey }))).status, 401, 'credencial revogada');
  await t.close();
});

test('idempotency: same request_id never runs twice; queue limit per device', async () => {
  const fake = new FakeProvider('fake', { kind: 'ok', model: 'm', solution: MockProvider.solve('1+1') });
  const t = await startApp({}, { providers: () => [fake] });
  const dev = await enroll(t);
  const body = enc({ request_id: 'req-00000010', question: '1+1', mode: 'fast', provider: 'fake' });
  const a = await (await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', body, dev))).json();
  const b = await (await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', body, dev))).json();
  assert.equal(fake.calls, 1);
  assert.equal(a.response_id, b.response_id);
  fake.delay = 3000;
  const p1 = fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000011', question: 'a', mode: 'fast', provider: 'fake' }), dev));
  const p2 = fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000012', question: 'a', mode: 'fast', provider: 'fake' }), dev));
  await new Promise(r => setTimeout(r, 100));
  const p3 = await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000013', question: 'a', mode: 'fast', provider: 'fake' }), dev));
  assert.equal(p3.status, 429);
  for (const id of ['req-00000011', 'req-00000012']) await fetch(t.base + '/api/v1/requests/cancel', signed('POST', '/api/v1/requests/cancel', enc({ request_id: id }), dev));
  await Promise.all([p1, p2]);
  await t.close();
});

test('long tasks: 202 + polling; explicit cancellation reports what happened', async () => {
  const fake = new FakeProvider('fake', { kind: 'ok', model: 'm', solution: MockProvider.solve('2+2') });
  fake.delay = 2500;
  const t = await startApp({ REQUEST_WAIT_MS: '200' }, { providers: () => [fake] });
  const dev = await enroll(t);
  const r = await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000020', question: '2+2', mode: 'short', provider: 'fake' }), dev));
  assert.equal(r.status, 202);
  assert.equal((await r.json()).status, 'processing');
  const poll = '/api/v1/requests/req-00000020?wait=1000';
  assert.equal((await fetch(t.base + poll, signed('GET', poll, new Uint8Array(0), dev))).status, 202);
  const c = await (await fetch(t.base + '/api/v1/requests/cancel', signed('POST', '/api/v1/requests/cancel', enc({ request_id: 'req-00000020' }), dev))).json();
  assert.match(c.status, /cancelado no servidor/);
  const after = await (await fetch(t.base + '/api/v1/requests/req-00000020', signed('GET', '/api/v1/requests/req-00000020', new Uint8Array(0), dev))).json();
  assert.equal(after.status, 'cancelled');
  const unknown = await (await fetch(t.base + '/api/v1/requests/cancel', signed('POST', '/api/v1/requests/cancel', enc({ request_id: 'req-99999999' }), dev))).json();
  assert.equal(unknown.status, 'desconhecido no servidor');
  await t.close();
});

test('pagination keeps every step of a long COMPLETE answer', async () => {
  const sol = MockProvider.solve('x');
  sol.steps = Array.from({ length: 45 }, (_, i) => ({ title: 'Etapa ' + i, math: i + '+1', text: 't' }));
  const fake = new FakeProvider('fake', { kind: 'ok', model: 'm', solution: sol });
  const t = await startApp({ STEPS_PER_PAGE: '20' }, { providers: () => [fake] });
  const dev = await enroll(t);
  const first = await (await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000030', question: 'q', mode: 'full', provider: 'fake' }), dev))).json();
  assert.deepEqual(first.page, { index: 0, count: 3, steps_total: 45 });
  const titles = [...first.steps];
  for (let p = 1; p < 3; p++) {
    const path = `/api/v1/requests/req-00000030?page=${p}`;
    titles.push(...(await (await fetch(t.base + path, signed('GET', path, new Uint8Array(0), dev))).json()).steps);
  }
  assert.equal(titles.length, 45);
  assert.equal(titles[44].title, 'Etapa 44');
  await t.close();
});

test('provider errors: unavailable, no credits, revoked key, TLS failure, refusal', async () => {
  const cases: [TaskOutcome, string][] = [
    [{ kind: 'error', code: 'billing', message: 'Sem creditos', retryable: false }, 'billing'],
    [{ kind: 'error', code: 'auth', message: 'Chave revogada', retryable: false }, 'auth'],
    [{ kind: 'error', code: 'unavailable', message: 'TLS', retryable: true }, 'unavailable'],
    [{ kind: 'refused', reason: 'recusado' }, 'refused'],
  ];
  for (const [outcome, code] of cases) {
    const fake = new FakeProvider('fake', outcome);
    const t = await startApp({}, { providers: () => [fake] });
    const dev = await enroll(t);
    const j = await (await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000040', question: 'q', mode: 'fast', provider: 'fake' }), dev))).json();
    assert.equal(j.error.code, code);
    assert.notEqual(j.status, 'ok');
    await t.close();
  }
  const t = await startApp({}, { providers: () => [new MockProvider(0)] });
  const dev = await enroll(t);
  const r = await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000041', question: 'q', mode: 'fast', provider: 'codex_cli' }), dev));
  assert.equal(r.status, 503, 'provedor indisponivel');
  await t.close();
});

test('no automatic failover to another (billable) provider unless the owner allows it', async () => {
  const a = new FakeProvider('prov_a', { kind: 'error', code: 'unavailable', message: 'x', retryable: true });
  const b = new FakeProvider('prov_b', { kind: 'ok', model: 'm', solution: MockProvider.solve('1+1') });
  const t = await startApp({}, { providers: () => [a, b] });
  t.app.reg.setPolicy({ preferred: 'prov_a', autoOrder: ['prov_a', 'prov_b'] });
  const dev = await enroll(t);
  const j1 = await (await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000050', question: '1+1', mode: 'fast' }), dev))).json();
  assert.equal(j1.status, 'error');
  assert.equal(b.calls, 0);
  t.app.reg.setPolicy({ allowFailover: true });
  const j2 = await (await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000051', question: '1+1', mode: 'fast' }), dev))).json();
  assert.equal(j2.status, 'ok');
  assert.equal(j2.provider, 'prov_b');
  await t.close();
});

test('vision: JPEG validated, routed only to image-capable providers, temp image removed', async () => {
  const textOnly = new FakeProvider('texto', { kind: 'ok', model: 'm', solution: MockProvider.solve('1') }, false);
  const t = await startApp({}, { providers: () => [new MockProvider(0), textOnly] });
  const dev = await enroll(t);
  const hdr = { 'X-Request-Id': 'img-00000001', 'X-Mode': 'short', 'X-Provider': 'mock', 'X-Session-Id': 's-1234' };
  const ok = await fetch(t.base + '/api/v1/ai/vision', signed('POST', '/api/v1/ai/vision', jpeg(), dev, hdr, 'image/jpeg'));
  assert.equal(ok.status, 200);
  assert.match(JSON.stringify((await ok.json()).uncertainty), /2000 bytes/);
  const png = new Uint8Array(2000); png.set([0x89, 0x50]);
  assert.equal((await fetch(t.base + '/api/v1/ai/vision', signed('POST', '/api/v1/ai/vision', png, dev, { ...hdr, 'X-Request-Id': 'img-00000002' }, 'image/jpeg'))).status, 415);
  assert.equal((await fetch(t.base + '/api/v1/ai/vision', signed('POST', '/api/v1/ai/vision', jpeg(8000, 8000), dev, { ...hdr, 'X-Request-Id': 'img-00000003' }, 'image/jpeg'))).status, 413);
  assert.equal((await fetch(t.base + '/api/v1/ai/vision', signed('POST', '/api/v1/ai/vision', jpeg(), dev, { ...hdr, 'X-Request-Id': 'img-00000004', 'X-Provider': 'texto' }, 'image/jpeg'))).status, 503);
  const big = new Uint8Array(4 * 1024 * 1024);
  assert.equal((await fetch(t.base + '/api/v1/ai/vision', signed('POST', '/api/v1/ai/vision', big, dev, { ...hdr, 'X-Request-Id': 'img-00000005' }, 'image/jpeg'))).status, 413);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(t.cfg.dataDir + '/tmp'), [], 'imagens temporarias apagadas');
  await t.close();
});

test('manual integration: question waits for the owner answer from the dashboard', async () => {
  const t = await startApp({ REQUEST_WAIT_MS: '100' }, { providers: () => [new ManualProvider()] });
  const dev = await enroll(t);
  const r = await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000060', question: 'integral de x', mode: 'full', provider: 'manual' }), dev));
  assert.equal(r.status, 202);
  assert.equal((await r.json()).status, 'waiting_manual');
  assert.equal(t.app.tasks.pendingManual().length, 1);
  assert.ok(t.app.tasks.completeManual(dev.id, 'req-00000060', 'x^2/2 + C\nIntegral de x^n = x^(n+1)/(n+1)'));
  const j = await (await fetch(t.base + '/api/v1/requests/req-00000060', signed('GET', '/api/v1/requests/req-00000060', new Uint8Array(0), dev))).json();
  assert.equal(j.kind, 'manual');
  assert.equal(j.answer, 'x^2/2 + C');
  assert.match(j.uncertainty[0], /manualmente/);
  await t.close();
});

test('privacy: history only when enabled, encrypted at rest; images not kept', async () => {
  const t = await startApp({}, { providers: () => [new MockProvider(0)] });
  const dev = await enroll(t);
  await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000070', question: 'segredo 1+1', mode: 'fast', provider: 'mock' }), dev));
  assert.equal(t.app.db.all('SELECT * FROM history').length, 0, 'historico desligado por padrao');
  t.app.db.setSetting('privacy', { historyQuestions: true, historyResponses: true });
  await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-00000071', question: 'segredo 2+2', mode: 'fast', provider: 'mock' }), dev));
  const rows = t.app.db.all<{ question_enc: string }>('SELECT * FROM history');
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].question_enc.includes('segredo'));
  assert.equal(t.app.box.open(rows[0].question_enc, 'history'), 'segredo 2+2');
  await t.close();
});

test('rate limiting and size limits', async () => {
  const t = await startApp({ RATE_PER_MINUTE: '2' }, { providers: () => [new MockProvider(0)] });
  const dev = await enroll(t);
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', enc({ request_id: 'req-0000008' + i, question: '1', mode: 'fast', provider: 'mock' }), dev))).status);
  assert.deepEqual(codes, [200, 200, 429]);
  assert.equal((await fetch(t.base + '/api/v1/ai/ask', signed('POST', '/api/v1/ai/ask', new Uint8Array(20000), dev))).status, 413);
  await t.close();
});
