import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { inspectEspImage } from '../src/ota/ota.ts';
import { SecretBox, hashPassword, verifyPassword, totp, verifyTotp, base32Encode } from '../src/security/crypto.ts';
import { startApp, signed, tempDir } from './helpers.ts';
import { Db } from '../src/storage/db.ts';

export function fakeEspImage(version: string, size = 4096): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xe9; b[1] = 1; b[23] = 1; // magic, 1 segment, hash appended
  b.writeUInt32LE(0xabcd5432, 32);
  b.write(version, 32 + 16, 'latin1');
  b.write('terminal_matematico', 32 + 48, 'latin1');
  createHash('sha256').update(b.subarray(0, size - 32)).digest().copy(b, size - 32);
  return b;
}

test('ESP image inspection accepts only real app images', () => {
  const img = fakeEspImage('0.3.1');
  const info = inspectEspImage(img);
  assert.equal(info.version, '0.3.1');
  assert.equal(info.projectName, 'terminal_matematico');
  assert.equal(info.appendedSha256, img.subarray(img.length - 32).toString('hex'));
  assert.throws(() => inspectEspImage(Buffer.alloc(4096)), /0xE9/);
  const noDesc = Buffer.from(img); noDesc.writeUInt32LE(0, 32);
  assert.throws(() => inspectEspImage(noDesc), /esp_app_desc/);
});

test('OTA: only approved firmware is served, to authenticated devices', async () => {
  const t = await startApp();
  const key = t.app.devices.create('dev-o', 'o');
  const dev = { id: 'dev-o', key };
  const f = join(tempDir(), 'fw.bin');
  writeFileSync(f, fakeEspImage('0.3.0'));
  t.app.ota.publish(f);
  assert.throws(() => t.app.ota.publish(f), /ja publicada/);
  const m0 = await (await fetch(t.base + '/api/v1/updates/manifest', signed('GET', '/api/v1/updates/manifest', new Uint8Array(0), dev))).json();
  assert.equal(m0.version, null, 'nao aprovado ainda');
  const fwPath = '/api/v1/updates/firmware?version=0.3.0';
  assert.equal((await fetch(t.base + fwPath, signed('GET', fwPath, new Uint8Array(0), dev))).status, 404);
  t.app.ota.approve('0.3.0', true);
  const m = await (await fetch(t.base + '/api/v1/updates/manifest', signed('GET', '/api/v1/updates/manifest', new Uint8Array(0), dev))).json();
  assert.equal(m.version, '0.3.0');
  assert.equal(m.sha256.length, 64);
  const bin = await fetch(t.base + fwPath, signed('GET', fwPath, new Uint8Array(0), dev));
  assert.equal(bin.status, 200);
  assert.equal((await bin.arrayBuffer()).byteLength, 4096);
  assert.equal((await fetch(t.base + fwPath)).status, 401, 'sem autenticacao');
  await t.close();
});

test('crypto primitives: SecretBox, scrypt, TOTP RFC 6238 vector', () => {
  const box = new SecretBox(randomBytes(32));
  const s = box.seal('dado secreto', 'aad1');
  assert.equal(box.open(s, 'aad1'), 'dado secreto');
  assert.throws(() => box.open(s, 'outro-aad'));
  assert.throws(() => new SecretBox(randomBytes(32)).open(s, 'aad1'));
  const h = hashPassword('SenhaMuitoForte123');
  assert.ok(verifyPassword('SenhaMuitoForte123', h) && !verifyPassword('errada', h));
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 59_000), '287082'); // RFC 6238 SHA1 vector (last 6 digits of 94287082)
  assert.ok(verifyTotp(secret, totp(secret, 1_000_000), 1_000_000 + 20_000));
  assert.ok(!verifyTotp(secret, '000000', 59_000));
});

test('SQLite storage: migrations idempotent, data survives reopen (server restart)', () => {
  const dir = tempDir();
  const a = Db.open(dir);
  a.setSetting('x', { y: 1 });
  a.close();
  const b = Db.open(dir);
  assert.deepEqual(b.getSetting('x', null), { y: 1 });
  b.close();
});
