/**
 * Cryptographic helpers built only on node:crypto (no custom algorithms):
 *  - SecretBox: AES-256-GCM with a master key (file data/master.key, 0600, or MT_MASTER_KEY)
 *  - scrypt password hashing
 *  - TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 digits) for the admin second factor
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class SecretBox {
  private key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('chave mestra deve ter 32 bytes');
    this.key = key;
  }
  static load(dataDir: string, envKey?: string): SecretBox {
    if (envKey) return new SecretBox(Buffer.from(envKey, 'base64'));
    const file = join(dataDir, 'master.key');
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    try { chmodSync(file, 0o600); } catch { /* windows */ }
    return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
  }
  seal(plain: string | Buffer, aad = 'mt'): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }
  openBuf(sealed: string, aad = 'mt'): Buffer {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('formato selado invalido');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
  }
  open(sealed: string, aad = 'mt'): string { return this.openBuf(sealed, aad).toString('utf8'); }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, salt.toString('base64'), h.toString('base64')].join('$');
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = scryptSync(pw, Buffer.from(salt, 'base64'), 32, { ...SCRYPT, N: Number(n) });
  const ref = Buffer.from(hash, 'base64');
  return ref.length === h.length && timingSafeEqual(ref, h);
}

export function passwordStrongEnough(pw: string): boolean {
  return pw.length >= 12 && /[a-z]/.test(pw) && /[A-Z0-9]/.test(pw);
}

export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function ctEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ------------------------------ TOTP ------------------------------ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 invalido');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secretB32: string, time = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  const code = ((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secretB32: string, code: string, time = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const d of [-1, 0, 1]) if (ctEqualStr(totp(secretB32, time + d * 30_000), code)) return true;
  return false;
}
