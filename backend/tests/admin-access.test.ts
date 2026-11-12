import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as csign, randomBytes } from 'node:crypto';
import { AccessVerifier } from '../src/security/accessJwt.ts';
import { totp } from '../src/security/crypto.ts';
import { startApp, signed } from './helpers.ts';

async function login(t: Awaited<ReturnType<typeof startApp>>, totpSecret?: string, base = t.base) {
  const r = await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dono', password: 'SenhaMuitoForte123', code: totpSecret ? totp(totpSecret) : undefined }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: r.status, cookie, csrf: r.ok ? (await r.json()).csrf as string : '' };
}

test('dashboard requires authentication; owner account only from the console', async () => {
  const t = await startApp();
  const st = await (await fetch(t.base + '/admin/api/state')).json();
  assert.equal(st.hasAdmin, false);
  for (const p of ['/admin/api/dashboard', '/admin/api/providers', '/admin/api/devices', '/admin/api/history', '/admin/api/security', '/admin/api/remote']) {
    assert.equal((await fetch(t.base + p)).status, 401, p);
  }
  assert.equal((await fetch(t.base + '/admin/api/login', { method: 'POST', body: '{"username":"x","password":"y"}' })).status, 401);
  const page = await fetch(t.base + '/admin/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  await t.close();
});

test('login with password + TOTP, CSRF enforcement, lockout, secrets never echoed', async () => {
  const t = await startApp({ ADMIN_REQUIRE_TOTP: '1' });
  const { totpSecret } = t.app.admin.createAdmin('dono', 'SenhaMuitoForte123');
  assert.equal((await login(t)).status, 401, 'sem TOTP');
  const s = await login(t, totpSecret);
  assert.equal(s.status, 200);
  assert.match(s.cookie, /^mt_admin=/);
  const h = { Cookie: s.cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(t.base + '/admin/api/dashboard', { headers: h })).status, 200);
  const noCsrf = await fetch(t.base + '/admin/api/secrets', { method: 'POST', headers: h, body: JSON.stringify({ name: 'anthropic_api_key', value: 'sk-ant-segredo' }) });
  assert.equal(noCsrf.status, 403);
  const withCsrf = await fetch(t.base + '/admin/api/secrets', { method: 'POST', headers: { ...h, 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ name: 'anthropic_api_key', value: 'sk-ant-segredo' }) });
  assert.equal(withCsrf.status, 200);
  const prov = await (await fetch(t.base + '/admin/api/providers', { headers: h })).text();
  assert.ok(!prov.includes('sk-ant-segredo'), 'segredo exposto');
  assert.ok(prov.includes('"set":true'));
  const raw = JSON.stringify(t.app.db.all('SELECT * FROM secrets'));
  assert.ok(!raw.includes('sk-ant-segredo'), 'segredo em texto puro no banco');
  const sec = await (await fetch(t.base + '/admin/api/security', { headers: h })).text();
  assert.ok(!sec.includes('SenhaMuitoForte123') && !sec.includes('sk-ant'));
  for (let i = 0; i < 5; i++) await fetch(t.base + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dono', password: 'errada-errada-1' }) });
  assert.equal((await login(t, totpSecret)).status, 401, 'bloqueio apos falhas');
  await t.close();
});

test('admin is not reachable on the LAN listener unless ADMIN_ON_LAN', async () => {
  const t = await startApp();
  assert.equal((await fetch(t.lanBase + '/admin/api/state')).status, 404);
  await t.close();
});

test('history toggle off deletes stored history; export requires login', async () => {
  const t = await startApp();
  t.app.admin.createAdmin('dono', 'SenhaMuitoForte123');
  const s = await login(t);
  t.app.db.run('INSERT INTO history (device_id, at, question_enc) VALUES (?, ?, ?)', 'd', Date.now(), t.app.box.seal('q', 'history'));
  assert.equal((await fetch(t.base + '/admin/api/history/export')).status, 401);
  const exp = await (await fetch(t.base + '/admin/api/history/export', { headers: { Cookie: s.cookie } })).json();
  assert.equal(exp.history[0].question, 'q');
  await fetch(t.base + '/admin/api/settings', { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ privacy: { historyQuestions: false, historyResponses: false } }) });
  assert.equal(t.app.db.all('SELECT * FROM history').length, 0);
  await t.close();
});

function accessKit() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const team = 'equipe.cloudflareaccess.com';
  const mk = (aud: string, expDelta = 300) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ aud: [aud], iss: `https://${team}`, exp: Math.floor(Date.now() / 1000) + expDelta, common_name: 'svc' })).toString('base64url');
    return `${h}.${p}.${csign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url')}`;
  };
  return { verifier: new AccessVerifier(team, async () => ({ keys: [jwk] })), mk, team };
}

test('Cloudflare Access JWT verification (signature, audience, expiry)', async () => {
  const k = accessKit();
  assert.ok(await k.verifier.verify(k.mk('aud-dev'), 'aud-dev'));
  await assert.rejects(k.verifier.verify(k.mk('outro'), 'aud-dev'), /audiencia/);
  await assert.rejects(k.verifier.verify(k.mk('aud-dev', -600), 'aud-dev'), /expirado/);
  await assert.rejects(k.verifier.verify(undefined, 'aud-dev'), /ausente/);
  const forged = k.mk('aud-dev').split('.'); forged[2] = randomBytes(256).toString('base64url');
  await assert.rejects(k.verifier.verify(forged.join('.'), 'aud-dev'), /assinatura/);
});

test('hmac+access mode: tunnel requests need a valid Access token; LAN uses HMAC only', async () => {
  const k = accessKit();
  const t = await startApp({ DEVICE_AUTH_MODE: 'hmac+access', CLOUDFLARE_ACCESS_ENABLED: '1', CLOUDFLARE_TEAM_DOMAIN: k.team, CLOUDFLARE_ACCESS_AUD_DEVICE: 'aud-dev' }, { access: k.verifier });
  const key = t.app.devices.create('dev-x', 'x');
  const dev = { id: 'dev-x', key };
  const p = '/api/v1/device/status';
  assert.equal((await fetch(t.base + p, signed('GET', p, new Uint8Array(0), dev))).status, 401, 'sem token do Access');
  assert.equal((await fetch(t.base + p, signed('GET', p, new Uint8Array(0), dev, { 'Cf-Access-Jwt-Assertion': k.mk('aud-dev') }))).status, 200);
  assert.equal((await fetch(t.lanBase + p, signed('GET', p, new Uint8Array(0), dev))).status, 200, 'LAN: somente HMAC');
  await t.close();
});
