/**
 * Firmware distribution. Only images registered by the owner (CLI or
 * dashboard) and explicitly approved are served; nothing is installable from
 * arbitrary uploads by devices. The image header and embedded app version are
 * checked, and the manifest carries the image's appended SHA-256 (the value the
 * device compares with esp_partition_get_sha256, see docs/OTA.md).
 * Authenticity on the device comes from Secure Boot v2 signature verification.
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '../storage/db.ts';

export interface EspImageInfo { version: string; projectName: string; appendedSha256: string | null; fileSha256: string; size: number }

/** Parse an ESP32 app image (esp_image_header_t + esp_app_desc_t in the first segment). */
export function inspectEspImage(buf: Buffer): EspImageInfo {
  if (buf.length < 24 + 8 + 256 || buf[0] !== 0xe9) throw new Error('nao e uma imagem de app ESP (magic 0xE9)');
  const hashAppended = buf[23] === 1;
  const descOff = 24 + 8; // image header (24) + first segment header (8)
  if (buf.readUInt32LE(descOff) !== 0xabcd5432) throw new Error('esp_app_desc_t ausente');
  const cstr = (o: number, n: number) => { const s = buf.subarray(o, o + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('latin1'); };
  const version = cstr(descOff + 16, 32);
  const projectName = cstr(descOff + 48, 32);
  return {
    version, projectName, size: buf.length,
    appendedSha256: hashAppended ? buf.subarray(buf.length - 32).toString('hex') : null,
    fileSha256: createHash('sha256').update(buf).digest('hex'),
  };
}

export class Ota {
  private db: Db;
  private dir: string;
  constructor(db: Db, dataDir: string) { this.db = db; this.dir = join(dataDir, 'firmware'); mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }

  publish(file: string, notes = ''): EspImageInfo {
    const buf = readFileSync(file);
    const info = inspectEspImage(buf);
    if (!/^[0-9A-Za-z.+-]{1,31}$/.test(info.version)) throw new Error('versao invalida na imagem');
    if (this.db.get('SELECT version FROM firmware WHERE version = ?', info.version)) throw new Error('versao ja publicada');
    const dest = join(this.dir, info.version.replace(/[^0-9A-Za-z.+-]/g, '_') + '.bin');
    copyFileSync(file, dest);
    try { chmodSync(dest, 0o600); } catch { /* windows */ }
    this.db.run('INSERT INTO firmware (version, file, sha256, validation_hash, size, approved, created_at, notes) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      info.version, dest, info.fileSha256, info.appendedSha256, info.size, Date.now(), notes.slice(0, 200));
    this.db.securityLog('firmware_published', 'admin', info.version);
    return info;
  }
  approve(version: string, approved: boolean): void {
    this.db.run('UPDATE firmware SET approved = ? WHERE version = ?', approved ? 1 : 0, version);
    this.db.securityLog(approved ? 'firmware_approved' : 'firmware_withdrawn', 'admin', version);
  }
  list() { return this.db.all<{ version: string; sha256: string; validation_hash: string | null; size: number; approved: number; created_at: number; notes: string }>('SELECT version, sha256, validation_hash, size, approved, created_at, notes FROM firmware ORDER BY created_at DESC'); }
  latestApproved() { return this.db.get<{ version: string; file: string; sha256: string; validation_hash: string | null; size: number }>('SELECT * FROM firmware WHERE approved = 1 ORDER BY created_at DESC LIMIT 1'); }
  manifest(): { version: string; url: string; sha256: string; size: number } | null {
    const f = this.latestApproved();
    if (!f || !f.validation_hash) return null;
    return { version: f.version, url: '/api/v1/updates/firmware?version=' + encodeURIComponent(f.version), sha256: f.validation_hash, size: f.size };
  }
  stream(version: string) {
    const f = this.db.get<{ file: string; size: number; approved: number }>('SELECT file, size, approved FROM firmware WHERE version = ?', version);
    if (!f || !f.approved || !existsSync(f.file)) return null;
    return { size: statSync(f.file).size, stream: createReadStream(f.file) };
  }
}
