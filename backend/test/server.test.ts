import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { DeviceAuthenticator, MemoryDeviceStore, signRequest } from '../src/deviceAuth.ts';
import { RateLimiter, inspectJpeg } from '../src/limits.ts';
import { MockProvider } from '../src/ai/mock.ts';
import { loadConfig } from '../src/config.ts';
import { DeviceResponse, toDeviceResponse, sanitizeCheck } from '../src/schema.ts';

const KEY = randomBytes(32).toString('base64');

function jpeg(w = 640, h = 480, size = 2000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03], 20);
  b.set([0xff, 0xda, 0x00, 0x02], 40);
  b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}

async function start(opts: { rate?: number; delay?: number; devices?: Record<string, { keyB64: string; enabled: boolean; createdAt: string }> } = {}) {
  const config = { ...loadConfig({ AI_PROVIDER: 'mock' } as NodeJS.ProcessEnv), ratePerMinute: opts.rate ?? 100, aiTimeoutMs: 2000 };
  const provider = new MockProvider(opts.delay ?? 0);
  const store = new MemoryDeviceStore(opts.devices ?? { 'dev-1': { keyB64: KEY, enabled: true, createdAt: '' }, 'dev-off': { keyB64: KEY, enabled: false, createdAt: '' } });
  const logs: Record<string, unknown>[] = [];
  const handler = createHandler({ config, auth: new DeviceAuthenticator(store, 300), limiter: new RateLimiter(config.ratePerMinute, 1000), provider, log: (e) => logs.push(e) });
  const server: Server = createServer((q, r) => { void handler(q, r); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, provider, logs, close: () => new Promise<void>(r => server.close(() => r())) };
}

function signed(path: string, body: Uint8Array, o: { device?: string; key?: string; ts?: number; nonce?: string; ctype?: string; extra?: Record<string, string> } = {}): RequestInit {
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomBytes(12).toString('hex');
  const sig = signRequest(o.key ?? KEY, 'POST', path, ts, nonce, body);
  return {
    method: 'POST',
    headers: { 'X-Device-Id': o.device ?? 'dev-1', 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig, 'Content-Type': o.ctype ?? 'application/json', ...(o.extra ?? {}) },
    body: body as unknown as BodyInit,
  };
}
const askBody = (id = 'req-00000001', question = '2+2?', mode = 'full') => new TextEncoder().encode(JSON.stringify({ request_id: id, question, mode }));

test('health is public and leaks nothing sensitive', async () => {
  const s = await start();
  const r = await fetch(s.base + '/v1/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { ok: true, provider: 'mock' });
  await s.close();
});

test('ask: valid signed request returns a contract-valid response', async () => {
  const s = await start();
  const r = await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody()));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(DeviceResponse.safeParse(j).success);
  assert.equal(j.request_id, 'req-00000001');
  assert.equal(j.mode, 'full');
  assert.equal(s.provider.calls[0].question, '2+2?');
  assert.ok(!JSON.stringify(s.logs).includes('2+2?'), 'corpo nao pode ir para o log');
  await s.close();
});

test('device authentication failures', async () => {
  const s = await start();
  const body = askBody();
  const cases: [string, RequestInit][] = [
    ['sem cabecalhos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }],
    ['chave errada', signed('/v1/ask', body, { key: randomBytes(32).toString('base64') })],
    ['dispositivo desconhecido', signed('/v1/ask', body, { device: 'nope' })],
    ['dispositivo desativado', signed('/v1/ask', body, { device: 'dev-off' })],
    ['timestamp antigo', signed('/v1/ask', body, { ts: Math.floor(Date.now() / 1000) - 3600 })],
  ];
  for (const [name, init] of cases) {
    const r = await fetch(s.base + '/v1/ask', init);
    assert.equal(r.status, 401, name);
  }
  // body tampering
  const init = signed('/v1/ask', body);
  init.body = askBody('req-00000001', 'outra pergunta') as unknown as BodyInit;
  assert.equal((await fetch(s.base + '/v1/ask', init)).status, 401);
  // replay
  const once = signed('/v1/ask', askBody('req-00000002'));
  assert.equal((await fetch(s.base + '/v1/ask', once)).status, 200);
  assert.equal((await fetch(s.base + '/v1/ask', once)).status, 401);
  await s.close();
});

test('validation: size, content type, JSON and fields', async () => {
  const s = await start();
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', new Uint8Array(20000)))).status, 413);
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody(), { ctype: 'text/plain' }))).status, 415);
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', new TextEncoder().encode('{nope')))).status, 400);
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('x', 'q')))).status, 400);
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-00000003', 'q', 'turbo')))).status, 400);
  const extra = new TextEncoder().encode(JSON.stringify({ request_id: 'req-00000004', question: 'q', mode: 'fast', admin: true }));
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', extra))).status, 400);
  assert.equal((await fetch(s.base + '/v2/whatever', signed('/v2/whatever', askBody()))).status, 404);
  await s.close();
});

test('image endpoint: JPEG validation and success', async () => {
  const s = await start();
  const hdr = { 'X-Request-Id': 'img-00000001', 'X-Mode': 'short', 'X-Prompt': Buffer.from('resolva').toString('base64') };
  const ok = await fetch(s.base + '/v1/image', signed('/v1/image', jpeg(), { ctype: 'image/jpeg', extra: hdr }));
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).answer, /2000 bytes/);
  assert.equal(s.provider.calls[0].prompt, 'resolva');
  const png = new Uint8Array(2000); png.set([0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await fetch(s.base + '/v1/image', signed('/v1/image', png, { ctype: 'image/jpeg', extra: { ...hdr, 'X-Request-Id': 'img-00000002' } }))).status, 415);
  const cut = jpeg().slice(0, 1500);
  assert.equal((await fetch(s.base + '/v1/image', signed('/v1/image', cut, { ctype: 'image/jpeg', extra: { ...hdr, 'X-Request-Id': 'img-00000003' } }))).status, 415);
  assert.equal((await fetch(s.base + '/v1/image', signed('/v1/image', jpeg(8000, 8000), { ctype: 'image/jpeg', extra: { ...hdr, 'X-Request-Id': 'img-00000004' } }))).status, 413);
  assert.equal((await fetch(s.base + '/v1/image', signed('/v1/image', jpeg(), { ctype: 'image/jpeg', extra: { ...hdr, 'X-Mode': 'x' } }))).status, 400);
  await s.close();
});

test('rate limiting returns 429 with Retry-After', async () => {
  const s = await start({ rate: 2 });
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-1000000' + i)))).status);
  assert.deepEqual(codes, [200, 200, 429]);
  const r = await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-20000000')));
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  await s.close();
});

test('explicit cancellation: in-flight, completed and unknown requests', async () => {
  const s = await start({ delay: 300 });
  const pending = fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-30000001')));
  await new Promise(r => setTimeout(r, 50));
  const cpath = '/v1/requests/req-30000001/cancel';
  const c1 = await (await fetch(s.base + cpath, signed(cpath, new Uint8Array(0)))).json();
  assert.equal(c1.status, 'cancelado no servidor');
  assert.equal((await pending).status, 409);
  // completed
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-30000002')))).status, 200);
  const p2 = '/v1/requests/req-30000002/cancel';
  assert.equal((await (await fetch(s.base + p2, signed(p2, new Uint8Array(0)))).json()).status, 'ja concluido no servidor');
  const p3 = '/v1/requests/req-39999999/cancel';
  assert.equal((await (await fetch(s.base + p3, signed(p3, new Uint8Array(0)))).json()).status, 'desconhecido no servidor');
  // another device cannot cancel or observe this device's requests
  const other = await start({ devices: { 'dev-2': { keyB64: KEY, enabled: true, createdAt: '' } } });
  assert.equal((await (await fetch(other.base + p2, signed(p2, new Uint8Array(0), { device: 'dev-2' }))).json()).status, 'desconhecido no servidor');
  await other.close();
  // request id reuse is rejected
  assert.equal((await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-30000002')))).status, 409);
  await s.close();
});

test('device disconnect aborts the upstream AI call', async () => {
  const s = await start({ delay: 500 });
  const ac = new AbortController();
  const p = fetch(s.base + '/v1/ask', { ...signed('/v1/ask', askBody('req-40000001')), signal: ac.signal }).catch(() => null);
  await new Promise(r => setTimeout(r, 50));
  ac.abort();
  await p;
  await new Promise(r => setTimeout(r, 50));
  const cp = '/v1/requests/req-40000001/cancel';
  assert.equal((await (await fetch(s.base + cp, signed(cp, new Uint8Array(0)))).json()).status, 'cancelado no servidor');
  await s.close();
});

test('provider errors are mapped without leaking details', async () => {
  const s = await start();
  s.provider.next = () => ({ kind: 'error', status: 504, error: 'Tempo esgotado no servico de IA', retryable: true });
  const r = await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-50000001')));
  assert.equal(r.status, 504);
  assert.deepEqual(await r.json(), { error: 'Tempo esgotado no servico de IA', retryable: true });
  s.provider.next = () => ({ kind: 'refused', reason: 'recusado' });
  const r2 = await (await fetch(s.base + '/v1/ask', signed('/v1/ask', askBody('req-50000002')))).json();
  assert.equal(r2.status, 'refused');
  await s.close();
});

test('response limits: oversized model output is truncated and flagged', () => {
  const sol = {
    answer: 'a'.repeat(5000), given: Array.from({ length: 50 }, () => ({ name: 'n', value: 'v' })), formulas: [],
    steps: Array.from({ length: 200 }, () => ({ title: 't', math: 'm'.repeat(3000), text: 'x' })),
    check: { expression: 'process.exit()', expected: 1, angle: 'rad' as const }, notes: '',
  };
  const out = toDeviceResponse('req-60000001', 'full', sol);
  assert.equal(out.truncated, true);
  assert.equal(out.steps.length, 80);
  assert.equal(out.given.length, 30);
  assert.ok(out.answer.length <= 1000);
  assert.equal(out.check, null, 'expressao de verificacao perigosa removida');
  assert.deepEqual(sanitizeCheck({ expression: 'sqrt(16)+2^3', expected: 12, angle: 'rad' }), { expression: 'sqrt(16)+2^3', expected: 12, angle: 'rad' });
});

test('jpeg inspector', () => {
  assert.deepEqual(inspectJpeg(jpeg(1600, 1200)), { ok: true, width: 1600, height: 1200 });
  assert.equal(inspectJpeg(new Uint8Array(10)).ok, false);
});
