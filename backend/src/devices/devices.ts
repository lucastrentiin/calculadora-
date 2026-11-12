/**
 * Device registry + HMAC request authentication (protocol mt1).
 *
 * Signed string: METHOD \n PATH(+query) \n TIMESTAMP \n NONCE \n hex(SHA-256(body))
 * Headers: X-Device-Id, X-Timestamp, X-Nonce, X-Signature, X-Protocol: mt1
 *
 * Enrollment: the owner creates a one-time code in the dashboard (valid 15 min);
 * the device (or the provisioning tool) calls POST /api/v1/device/register with
 * that code and receives its own random 256-bit key once. Keys are stored
 * encrypted (SecretBox). Rotation keeps the previous key valid for a grace
 * period; revocation is immediate.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../storage/db.ts';
import { sha256, type SecretBox } from '../security/crypto.ts';

export interface DeviceRow {
  id: string; name: string; key_enc: string; key_prev_enc: string | null; key_prev_until: number | null; enabled: number;
  created_at: number; last_seen: number | null; firmware: string | null; last_ip: string | null; last_status: string | null; ota_state: string | null;
}

export function sha256Hex(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

export function signRequest(keyB64: string, method: string, path: string, ts: string, nonce: string, body: Uint8Array): string {
  const msg = [method, path, ts, nonce, sha256Hex(body)].join('\n');
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(msg).digest('hex');
}

export type AuthResult = { ok: true; device: DeviceRow } | { ok: false; status: number; error: string };

export class Devices {
  private nonces = new Map<string, number>();
  private db: Db;
  private box: SecretBox;
  private skewSec: number;
  private now: () => number;
  constructor(db: Db, box: SecretBox, skewSec: number, now: () => number = () => Date.now()) {
    this.db = db; this.box = box; this.skewSec = skewSec; this.now = now;
  }

  /* ------------------------------ admin side ---------------------- */
  createEnrollment(name: string, ttlMs = 15 * 60_000): string {
    const code = randomBytes(9).toString('base64url'); // 12 chars, ~72 bits
    this.db.run('INSERT INTO enrollments (code_hash, name, expires_at) VALUES (?, ?, ?)', sha256(code), name.slice(0, 64), this.now() + ttlMs);
    this.db.securityLog('enrollment_created', 'admin', name.slice(0, 64));
    return code;
  }
  /** Direct creation (CLI). Returns the key once. */
  create(id: string, name: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('id invalido');
    if (this.get(id)) throw new Error('dispositivo ja existe');
    const key = randomBytes(32).toString('base64');
    this.db.run('INSERT INTO devices (id, name, key_enc, created_at) VALUES (?, ?, ?, ?)', id, name.slice(0, 64), this.box.seal(key, 'device:' + id), this.now());
    this.db.securityLog('device_created', 'admin', id);
    return key;
  }
  /** Exchange a one-time code for a device identity. */
  register(code: string, requestedId?: string): { id: string; key: string } {
    const row = this.db.get<{ code_hash: string; name: string; expires_at: number; used: number }>('SELECT * FROM enrollments WHERE code_hash = ?', sha256(code));
    if (!row || row.used || row.expires_at < this.now()) { this.db.securityLog('enrollment_rejected', 'device'); throw new Error('codigo invalido ou expirado'); }
    this.db.run('UPDATE enrollments SET used = 1 WHERE code_hash = ?', row.code_hash);
    const id = requestedId && /^[A-Za-z0-9_-]{1,64}$/.test(requestedId) && !this.get(requestedId) ? requestedId : 'dev-' + randomBytes(5).toString('hex');
    const key = this.create(id, row.name);
    this.db.securityLog('device_enrolled', 'device', id);
    return { id, key };
  }
  rotate(id: string, graceMs = 24 * 3600_000): string {
    const d = this.get(id);
    if (!d) throw new Error('dispositivo inexistente');
    const key = randomBytes(32).toString('base64');
    this.db.run('UPDATE devices SET key_prev_enc = key_enc, key_prev_until = ?, key_enc = ? WHERE id = ?', this.now() + graceMs, this.box.seal(key, 'device:' + id), id);
    this.db.securityLog('device_key_rotated', 'admin', id);
    return key;
  }
  setEnabled(id: string, enabled: boolean): void {
    this.db.run('UPDATE devices SET enabled = ?, key_prev_enc = CASE WHEN ? = 0 THEN NULL ELSE key_prev_enc END WHERE id = ?', enabled ? 1 : 0, enabled ? 1 : 0, id);
    this.db.securityLog(enabled ? 'device_authorized' : 'device_revoked', 'admin', id);
  }
  rename(id: string, name: string): void { this.db.run('UPDATE devices SET name = ? WHERE id = ?', name.slice(0, 64), id); }
  remove(id: string): void { this.db.run('DELETE FROM devices WHERE id = ?', id); this.db.securityLog('device_deleted', 'admin', id); }
  get(id: string): DeviceRow | undefined { return this.db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', id); }
  list(): Omit<DeviceRow, 'key_enc' | 'key_prev_enc'>[] {
    return this.db.all<DeviceRow>('SELECT * FROM devices ORDER BY created_at').map(({ key_enc: _k, key_prev_enc: _p, ...rest }) => rest);
  }
  touch(id: string, ip: string | undefined, firmware?: string): void {
    this.db.run('UPDATE devices SET last_seen = ?, last_ip = ?, firmware = COALESCE(?, firmware) WHERE id = ?', this.now(), ip ?? null, firmware ?? null, id);
  }

  /* ------------------------------ request auth -------------------- */
  verify(method: string, path: string, headers: Record<string, string | string[] | undefined>, body: Uint8Array): AuthResult {
    const h = (n: string) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
    const id = h('x-device-id'), ts = h('x-timestamp'), nonce = h('x-nonce'), sig = h('x-signature');
    if (h('x-protocol') && h('x-protocol') !== 'mt1') return { ok: false, status: 400, error: 'versao de protocolo nao suportada' };
    if (!id || !ts || !nonce || !sig) return { ok: false, status: 401, error: 'autenticacao ausente' };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
      return { ok: false, status: 401, error: 'cabecalhos invalidos' };
    }
    const dev = this.get(id);
    if (!dev || !dev.enabled) { this.db.securityLog('device_auth_failed', id, 'desconhecido ou revogado'); return { ok: false, status: 401, error: 'dispositivo nao autorizado' }; }
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - Number(ts)) > this.skewSec) return { ok: false, status: 401, error: 'relogio fora da janela' };
    const keys = [this.box.open(dev.key_enc, 'device:' + id)];
    if (dev.key_prev_enc && dev.key_prev_until && dev.key_prev_until > this.now()) keys.push(this.box.open(dev.key_prev_enc, 'device:' + id));
    const got = Buffer.from(sig, 'hex');
    const match = keys.some(k => { const e = Buffer.from(signRequest(k, method, path, ts, nonce, body), 'hex'); return e.length === got.length && timingSafeEqual(e, got); });
    if (!match) { this.db.securityLog('device_auth_failed', id, 'assinatura'); return { ok: false, status: 401, error: 'assinatura invalida' }; }
    this.gc(nowSec);
    const nk = id + ':' + nonce;
    if (this.nonces.has(nk)) { this.db.securityLog('replay_blocked', id); return { ok: false, status: 401, error: 'requisicao repetida' }; }
    this.nonces.set(nk, nowSec + this.skewSec);
    return { ok: true, device: dev };
  }
  private gc(nowSec: number): void {
    if (this.nonces.size < 2000) return;
    for (const [k, exp] of this.nonces) if (exp < nowSec) this.nonces.delete(k);
  }
}
