/**
 * Device authentication with per-device HMAC-SHA256 keys.
 *
 * Signed string (UTF-8, "\n" separated):
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(SHA-256(body))
 * Headers: X-Device-Id, X-Timestamp (unix seconds), X-Nonce (16-64 hex), X-Signature (hex)
 *
 * - timestamps outside the allowed skew are rejected
 * - nonces are remembered for the skew window (replay protection)
 * - comparison is constant time
 * The device key is provisioned once (npm run provision) and stored in the
 * device's encrypted NVS; the Anthropic key is never sent to devices.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

export interface DeviceRecord { keyB64: string; enabled: boolean; name?: string; createdAt: string }
export type DeviceTable = Record<string, DeviceRecord>;

export interface DeviceStore { get(id: string): DeviceRecord | undefined }

export class FileDeviceStore implements DeviceStore {
  private table: DeviceTable = {};
  private file: string;
  constructor(file: string) {
    this.file = file;
    this.reload();
  }
  reload(): void {
    this.table = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as DeviceTable : {};
  }
  get(id: string): DeviceRecord | undefined { return Object.prototype.hasOwnProperty.call(this.table, id) ? this.table[id] : undefined; }
  put(id: string, rec: DeviceRecord): void {
    this.table[id] = rec;
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.table, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export class MemoryDeviceStore implements DeviceStore {
  table: DeviceTable;
  constructor(table: DeviceTable = {}) { this.table = table; }
  get(id: string): DeviceRecord | undefined { return Object.prototype.hasOwnProperty.call(this.table, id) ? this.table[id] : undefined; }
}

export function sha256Hex(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

export function signRequest(keyB64: string, method: string, path: string, ts: string, nonce: string, body: Uint8Array): string {
  const msg = [method, path, ts, nonce, sha256Hex(body)].join('\n');
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(msg).digest('hex');
}

export type AuthResult = { ok: true; deviceId: string } | { ok: false; status: number; error: string };

export class DeviceAuthenticator {
  private nonces = new Map<string, number>();
  private store: DeviceStore;
  private skewSec: number;
  private now: () => number;
  constructor(store: DeviceStore, skewSec: number, now: () => number = () => Date.now()) {
    this.store = store; this.skewSec = skewSec; this.now = now;
  }

  verify(method: string, path: string, headers: Record<string, string | string[] | undefined>, body: Uint8Array): AuthResult {
    const h = (n: string) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
    const id = h('x-device-id'), ts = h('x-timestamp'), nonce = h('x-nonce'), sig = h('x-signature');
    if (!id || !ts || !nonce || !sig) return { ok: false, status: 401, error: 'autenticacao ausente' };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
      return { ok: false, status: 401, error: 'cabecalhos invalidos' };
    }
    const dev = this.store.get(id);
    // same error for unknown and disabled devices (no enumeration)
    if (!dev || !dev.enabled) return { ok: false, status: 401, error: 'dispositivo nao autorizado' };
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - Number(ts)) > this.skewSec) return { ok: false, status: 401, error: 'relogio fora da janela' };
    const expected = Buffer.from(signRequest(dev.keyB64, method, path, ts, nonce, body), 'hex');
    const got = Buffer.from(sig, 'hex');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, status: 401, error: 'assinatura invalida' };
    this.gc(nowSec);
    const key = id + ':' + nonce;
    if (this.nonces.has(key)) return { ok: false, status: 401, error: 'requisicao repetida' };
    this.nonces.set(key, nowSec + this.skewSec);
    return { ok: true, deviceId: id };
  }

  private gc(nowSec: number): void {
    if (this.nonces.size < 1000) return;
    for (const [k, exp] of this.nonces) if (exp < nowSec) this.nonces.delete(k);
  }
}
