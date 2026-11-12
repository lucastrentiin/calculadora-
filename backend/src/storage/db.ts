/**
 * SQLite storage (node:sqlite, bundled with Node >= 22.13: no native build,
 * no external database). Schema is versioned; queries use only portable SQL
 * so a later move to PostgreSQL only needs a new driver (docs/SERVER.md).
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS: string[] = [
  `CREATE TABLE devices (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, key_enc TEXT NOT NULL, key_prev_enc TEXT, key_prev_until INTEGER,
     enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_seen INTEGER, firmware TEXT,
     last_ip TEXT, last_status TEXT, ota_state TEXT);
   CREATE TABLE enrollments (code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE admins (username TEXT PRIMARY KEY, pass_hash TEXT NOT NULL, totp_enc TEXT, created_at INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE admin_sessions (id_hash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE secrets (name TEXT PRIMARY KEY, value_enc TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, at INTEGER NOT NULL, provider TEXT, mode TEXT, kind TEXT,
     question_enc TEXT, response_enc TEXT);
   CREATE TABLE favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content_enc TEXT NOT NULL);
   CREATE TABLE security_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, actor TEXT, detail TEXT);
   CREATE TABLE request_log (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, at INTEGER NOT NULL, provider TEXT, kind TEXT, status TEXT, ms INTEGER, error TEXT);
   CREATE TABLE firmware (version TEXT PRIMARY KEY, file TEXT NOT NULL, sha256 TEXT NOT NULL, validation_hash TEXT, size INTEGER NOT NULL,
     approved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, notes TEXT);
   CREATE TABLE device_diag (device_id TEXT NOT NULL, at INTEGER NOT NULL, report TEXT NOT NULL);
   CREATE INDEX idx_history_at ON history(at); CREATE INDEX idx_reqlog_at ON request_log(at); CREATE INDEX idx_seclog_at ON security_log(at);`,
];

export class Db {
  readonly sql: DatabaseSync;
  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
    this.migrate();
  }
  static open(dataDir: string): Db {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, 'mt.sqlite');
    const db = new Db(file);
    try { chmodSync(file, 0o600); } catch { /* windows */ }
    return db;
  }
  static memory(): Db { return new Db(':memory:'); }

  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
    const row = this.sql.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
    let v = row?.v ?? 0;
    if (!row) this.sql.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
    while (v < MIGRATIONS.length) {
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(MIGRATIONS[v]);
        v++;
        this.sql.prepare('UPDATE schema_version SET v = ?').run(v);
        this.sql.exec('COMMIT');
      } catch (e) { this.sql.exec('ROLLBACK'); throw e; }
    }
  }

  get<T>(q: string, ...p: (string | number | null)[]): T | undefined { return this.sql.prepare(q).get(...p) as T | undefined; }
  all<T>(q: string, ...p: (string | number | null)[]): T[] { return this.sql.prepare(q).all(...p) as T[]; }
  run(q: string, ...p: (string | number | null)[]): { changes: number | bigint } { return this.sql.prepare(q).run(...p); }

  getSetting<T>(key: string, def: T): T {
    const r = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    if (!r) return def;
    try { return JSON.parse(r.value) as T; } catch { return def; }
  }
  setSetting(key: string, value: unknown): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }
  securityLog(event: string, actor?: string, detail?: string): void {
    this.run('INSERT INTO security_log (at, event, actor, detail) VALUES (?, ?, ?, ?)', Date.now(), event, actor ?? null, detail ?? null);
  }
  close(): void { this.sql.close(); }
}
