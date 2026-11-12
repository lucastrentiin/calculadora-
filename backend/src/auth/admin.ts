/**
 * Owner (admin) authentication for the dashboard.
 *  - password (scrypt) + TOTP second factor (mandatory in production profile)
 *  - optional Cloudflare Access JWT on top (ADMIN_AUTH_MODE=password+access)
 *  - session cookie: random 256-bit id, stored hashed, HttpOnly, Secure, SameSite=Strict
 *  - CSRF token per session (header X-CSRF-Token) for every state-changing call
 *  - lockout after repeated failures; everything logged without secrets
 */
import type { Db } from '../storage/db.ts';
import { base32Encode, hashPassword, passwordStrongEnough, sha256, token, verifyPassword, verifyTotp, type SecretBox } from '../security/crypto.ts';
import { randomBytes } from 'node:crypto';

export interface AdminSession { username: string; csrf: string; expires_at: number }

export class AdminAuth {
  private db: Db;
  private box: SecretBox;
  private sessionMinutes: number;
  private requireTotp: boolean;
  private now: () => number;
  constructor(db: Db, box: SecretBox, opts: { sessionMinutes: number; requireTotp: boolean; now?: () => number }) {
    this.db = db; this.box = box; this.sessionMinutes = opts.sessionMinutes; this.requireTotp = opts.requireTotp; this.now = opts.now ?? (() => Date.now());
  }

  hasAdmin(): boolean { return !!this.db.get('SELECT username FROM admins LIMIT 1'); }

  /** Creates the owner account; returns the TOTP secret (base32) to enroll in an authenticator app. */
  createAdmin(username: string, password: string): { totpSecret: string } {
    if (!/^[a-z0-9_.-]{3,32}$/i.test(username)) throw new Error('usuario invalido');
    if (!passwordStrongEnough(password)) throw new Error('senha fraca: minimo 12 caracteres, misture letras e numeros');
    const secret = base32Encode(randomBytes(20));
    this.db.run('INSERT INTO admins (username, pass_hash, totp_enc, created_at) VALUES (?, ?, ?, ?)', username, hashPassword(password), this.box.seal(secret, 'totp'), this.now());
    this.db.securityLog('admin_created', username);
    return { totpSecret: secret };
  }

  changePassword(username: string, oldPw: string, newPw: string): void {
    const a = this.db.get<{ pass_hash: string }>('SELECT pass_hash FROM admins WHERE username = ?', username);
    if (!a || !verifyPassword(oldPw, a.pass_hash)) throw new Error('senha atual incorreta');
    if (!passwordStrongEnough(newPw)) throw new Error('senha fraca');
    this.db.run('UPDATE admins SET pass_hash = ? WHERE username = ?', hashPassword(newPw), username);
    this.db.run('DELETE FROM admin_sessions WHERE username = ?', username);
    this.db.securityLog('admin_password_changed', username);
  }

  login(username: string, password: string, code: string | undefined, ip?: string, ua?: string): { sid: string; csrf: string } {
    const a = this.db.get<{ username: string; pass_hash: string; totp_enc: string | null; failed: number; locked_until: number }>('SELECT * FROM admins WHERE username = ?', username);
    const fail = (why: string) => {
      if (a) {
        const failed = a.failed + 1;
        const lock = failed >= 5 ? this.now() + Math.min(3600_000, 60_000 * 2 ** (failed - 5)) : 0;
        this.db.run('UPDATE admins SET failed = ?, locked_until = ? WHERE username = ?', failed, lock, username);
      }
      this.db.securityLog('admin_login_failed', username.slice(0, 32), why + (ip ? ' ip=' + ip : ''));
      return new Error('credenciais invalidas');
    };
    if (!a) { verifyPassword(password, hashPassword('x-dummy-password-1')); throw fail('usuario'); } // equalise timing
    if (a.locked_until > this.now()) { this.db.securityLog('admin_login_locked', username); throw new Error('conta temporariamente bloqueada'); }
    if (!verifyPassword(password, a.pass_hash)) throw fail('senha');
    if (this.requireTotp || code) {
      const secret = a.totp_enc ? this.box.open(a.totp_enc, 'totp') : '';
      if (!secret || !code || !verifyTotp(secret, code, this.now())) throw fail('totp');
    }
    this.db.run('UPDATE admins SET failed = 0, locked_until = 0 WHERE username = ?', username);
    const sid = token(32), csrf = token(24);
    this.db.run('INSERT INTO admin_sessions (id_hash, username, csrf, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(sid), username, csrf, this.now(), this.now() + this.sessionMinutes * 60_000, ip ?? null, (ua ?? '').slice(0, 120));
    this.db.securityLog('admin_login', username, ip);
    return { sid, csrf };
  }

  session(sid: string | undefined): AdminSession | null {
    if (!sid) return null;
    const s = this.db.get<AdminSession & { id_hash: string }>('SELECT * FROM admin_sessions WHERE id_hash = ?', sha256(sid));
    if (!s) return null;
    if (s.expires_at < this.now()) { this.db.run('DELETE FROM admin_sessions WHERE id_hash = ?', s.id_hash); return null; }
    // sliding expiration
    this.db.run('UPDATE admin_sessions SET expires_at = ? WHERE id_hash = ?', this.now() + this.sessionMinutes * 60_000, s.id_hash);
    return { username: s.username, csrf: s.csrf, expires_at: s.expires_at };
  }

  logout(sid: string | undefined): void { if (sid) this.db.run('DELETE FROM admin_sessions WHERE id_hash = ?', sha256(sid)); }
  sessions(): { username: string; created_at: number; expires_at: number; ip: string | null; ua: string | null; id: string }[] {
    return this.db.all<{ username: string; created_at: number; expires_at: number; ip: string | null; ua: string | null; id_hash: string }>('SELECT * FROM admin_sessions')
      .map(s => ({ username: s.username, created_at: s.created_at, expires_at: s.expires_at, ip: s.ip, ua: s.ua, id: s.id_hash.slice(0, 12) }));
  }
  revokeSession(idPrefix: string): void { this.db.run('DELETE FROM admin_sessions WHERE substr(id_hash, 1, 12) = ?', idPrefix); this.db.securityLog('admin_session_revoked', undefined, idPrefix); }
  setSessionMinutes(m: number): void { this.sessionMinutes = m; }
}
