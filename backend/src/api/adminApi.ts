/**
 * Owner dashboard API (/admin/api/*) + static dashboard (/admin/).
 * Every call requires a valid session cookie; state-changing calls also need
 * the CSRF header. On the tunnel listener, Cloudflare Access is verified too
 * when ADMIN_AUTH_MODE=password+access. The owner account is created only
 * from the server console (npm run admin:create), never through the web.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Config } from '../config/index.ts';
import type { Db } from '../storage/db.ts';
import type { AdminAuth } from '../auth/admin.ts';
import type { Devices } from '../devices/devices.ts';
import type { AccessVerifier } from '../security/accessJwt.ts';
import type { Registry, SelectionPolicy } from '../providers/registry.ts';
import type { ProviderContext } from '../providers/context.ts';
import type { TaskManager, Privacy } from '../requests/taskManager.ts';
import type { Ota } from '../ota/ota.ts';
import type { RateLimiter } from '../middleware/limits.ts';
import type { SecretBox } from '../security/crypto.ts';
import { CodexCLIProvider } from '../providers/openai/codexCli.ts';
import { HttpError, Router, SEC_HEADERS, parseCookies, readBody, sendJson, type Ctx } from '../middleware/http.ts';
import { remoteAccessStatus, serverDiagnostics } from '../diagnostics/diag.ts';
import { MODES } from '../requests/schema.ts';

export interface AdminDeps { cfg: Config; db: Db; admin: AdminAuth; devices: Devices; access?: AccessVerifier; reg: Registry; pctx: ProviderContext; tasks: TaskManager; ota: Ota; loginLimiter: RateLimiter; box: SecretBox; dashboardDir: string }

const SECRET_NAMES = new Set(['openai_api_key', 'anthropic_api_key']);

export function adminRouter(d: AdminDeps): Router {
  const r = new Router();
  const cookieName = 'mt_admin';
  const secure = () => d.cfg.profile === 'production' || !d.cfg.allowInsecureHttp;

  async function access(c: Ctx) {
    if (c.via === 'lan' && !d.cfg.adminOnLan) throw new HttpError(404, 'not_found');
    if (c.via === 'tunnel' && d.cfg.adminAuthMode === 'password+access') {
      try { await d.access!.verify(c.req.headers['cf-access-jwt-assertion'] as string | undefined, d.cfg.cloudflareAccessAudAdmin); }
      catch (e) { d.db.securityLog('access_jwt_rejected', 'admin', (e as Error).message); throw new HttpError(401, 'access_denied', 'Cloudflare Access recusou'); }
    }
  }
  async function session(c: Ctx, mutating: boolean) {
    await access(c);
    const sid = parseCookies(c.req.headers.cookie)[cookieName];
    const s = d.admin.session(sid);
    if (!s) throw new HttpError(401, 'login_required', 'faca login');
    if (mutating && c.req.headers['x-csrf-token'] !== s.csrf) { d.db.securityLog('csrf_rejected', s.username); throw new HttpError(403, 'csrf', 'token CSRF invalido'); }
    return s;
  }
  async function json<T>(c: Ctx, max = 16 * 1024): Promise<T> {
    const b = await readBody(c.req, max);
    try { return JSON.parse(Buffer.from(b).toString('utf8') || '{}') as T; } catch { throw new HttpError(400, 'bad_json'); }
  }
  const ok = (c: Ctx, body: unknown = { ok: true }) => sendJson(c.res, 200, body);

  /* ---------------- static dashboard ---------------- */
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  r.add('GET', '/admin/?(:file)?', async (c) => {
    await access(c);
    const name = c.path === '/admin' || c.path === '/admin/' ? 'index.html' : c.path.slice('/admin/'.length);
    const file = normalize(join(d.dashboardDir, name));
    if (!file.startsWith(d.dashboardDir) || !existsSync(file)) throw new HttpError(404, 'not_found');
    const ext = file.slice(file.lastIndexOf('.'));
    c.res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', ...SEC_HEADERS,
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
    c.res.end(readFileSync(file));
  });

  /* ---------------- auth ---------------- */
  r.add('GET', '/admin/api/state', async (c) => { await access(c); ok(c, { hasAdmin: d.admin.hasAdmin(), totp: d.cfg.adminRequireTotp, profile: d.cfg.profile }); });
  r.add('POST', '/admin/api/login', async (c) => {
    await access(c);
    const lim = d.loginLimiter.take('login:' + c.ip);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', 'muitas tentativas', lim.retryAfter);
    const b = await json<{ username?: string; password?: string; code?: string }>(c, 2048);
    try {
      const { sid, csrf } = d.admin.login(String(b.username ?? ''), String(b.password ?? ''), b.code ? String(b.code) : undefined, c.ip, String(c.req.headers['user-agent'] ?? ''));
      sendJson(c.res, 200, { ok: true, csrf }, { 'Set-Cookie': `${cookieName}=${sid}; Path=/admin; HttpOnly; SameSite=Strict${secure() ? '; Secure' : ''}; Max-Age=${d.cfg.adminSessionMinutes * 60}` });
    } catch (e) { throw new HttpError(401, 'login_failed', (e as Error).message); }
  });
  r.add('POST', '/admin/api/logout', async (c) => {
    await session(c, true);
    d.admin.logout(parseCookies(c.req.headers.cookie)[cookieName]);
    sendJson(c.res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0` });
  });
  r.add('GET', '/admin/api/me', async (c) => { const s = await session(c, false); ok(c, { username: s.username, csrf: s.csrf }); });

  /* ---------------- dashboard ---------------- */
  r.add('GET', '/admin/api/dashboard', async (c) => {
    await session(c, false);
    const now = Date.now();
    const devs = d.devices.list();
    ok(c, {
      server: serverDiagnostics(d.cfg), tasks: d.tasks.stats(), policy: d.reg.policy(),
      devices: { total: devs.length, online: devs.filter(x => x.last_seen && now - x.last_seen < 10 * 60_000).length },
      providers: d.reg.infos().map(p => ({ id: p.id, name: p.name, status: p.status, detail: p.statusDetail })),
      failures: d.db.all("SELECT at, provider, kind, error FROM request_log WHERE error IS NOT NULL ORDER BY at DESC LIMIT 10"),
      requests24h: d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM request_log WHERE at > ?', now - 86400_000)?.n ?? 0,
    });
  });

  /* ---------------- providers ---------------- */
  r.add('GET', '/admin/api/providers', async (c) => { await session(c, false); ok(c, { providers: d.reg.infos(), policy: d.reg.policy(), secrets: [...SECRET_NAMES].map(n => ({ name: n, set: d.pctx.hasSecret(n) })) }); });
  r.add('POST', '/admin/api/providers/refresh', async (c) => { await session(c, true); await d.reg.refreshAll(); ok(c, { providers: d.reg.infos() }); });
  r.add('POST', '/admin/api/providers/:id/test', async (c) => {
    const s = await session(c, true);
    const p = d.reg.get(c.params.id);
    if (!p) throw new HttpError(404, 'not_found');
    const res = await p.healthCheck();
    d.db.securityLog('provider_tested', s.username, p.id + ':' + (res.ok ? 'ok' : 'falha'));
    ok(c, { result: res, info: p.info() });
  });
  r.add('POST', '/admin/api/providers/:id/settings', async (c) => {
    const s = await session(c, true);
    const p = d.reg.get(c.params.id);
    if (!p) throw new HttpError(404, 'not_found');
    const b = await json<{ enabled?: boolean; model?: string; acknowledged?: boolean; authMode?: 'subscription' | 'api_key' }>(c);
    const patch: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (typeof b.model === 'string' && /^[A-Za-z0-9._:-]{0,80}$/.test(b.model)) patch.model = b.model;
    if (typeof b.acknowledged === 'boolean') patch.acknowledged = b.acknowledged;
    if (b.authMode === 'subscription' || b.authMode === 'api_key') patch.authMode = b.authMode;
    d.pctx.saveSettings(p.id, patch, s.username);
    await p.refresh();
    ok(c, { info: p.info() });
  });
  r.add('POST', '/admin/api/providers/codex_cli/logout', async (c) => {
    await session(c, true);
    const p = d.reg.get('codex_cli');
    ok(c, { output: p instanceof CodexCLIProvider ? await p.logout() : '' });
  });
  r.add('POST', '/admin/api/secrets', async (c) => {
    const s = await session(c, true);
    const b = await json<{ name?: string; value?: string | null }>(c);
    if (!b.name || !SECRET_NAMES.has(b.name)) throw new HttpError(400, 'bad_request', 'segredo desconhecido');
    if (b.value != null && (typeof b.value !== 'string' || b.value.length > 300)) throw new HttpError(400, 'bad_request');
    d.pctx.setSecret(b.name, b.value ?? null, s.username);
    await d.reg.refreshAll();
    ok(c); // never echo secrets back
  });
  r.add('POST', '/admin/api/selection', async (c) => {
    await session(c, true);
    const b = await json<Partial<SelectionPolicy>>(c);
    const ids = new Set(d.reg.infos().map(i => i.id));
    const patch: Partial<SelectionPolicy> = {};
    if (b.preferred && ids.has(b.preferred)) patch.preferred = b.preferred;
    if (Array.isArray(b.autoOrder)) patch.autoOrder = b.autoOrder.filter(x => ids.has(x));
    if (Array.isArray(b.deviceVisible)) patch.deviceVisible = b.deviceVisible.filter(x => ids.has(x));
    if (typeof b.allowFailover === 'boolean') patch.allowFailover = b.allowFailover;
    d.reg.setPolicy(patch);
    ok(c, { policy: d.reg.policy() });
  });

  /* ---------------- devices ---------------- */
  r.add('GET', '/admin/api/devices', async (c) => { await session(c, false); ok(c, { devices: d.devices.list() }); });
  r.add('POST', '/admin/api/devices/enroll', async (c) => {
    await session(c, true);
    const b = await json<{ name?: string }>(c);
    ok(c, { code: d.devices.createEnrollment(String(b.name ?? 'dispositivo').slice(0, 64)), expiresInMin: 15 });
  });
  r.add('POST', '/admin/api/devices/:id/:action', async (c) => {
    await session(c, true);
    const { id, action } = c.params;
    if (!d.devices.get(id)) throw new HttpError(404, 'not_found');
    const b = await json<{ name?: string }>(c);
    switch (action) {
      case 'rename': d.devices.rename(id, String(b.name ?? id)); return ok(c);
      case 'revoke': d.devices.setEnabled(id, false); return ok(c);
      case 'authorize': d.devices.setEnabled(id, true); return ok(c);
      case 'rotate': return ok(c, { device_key: d.devices.rotate(id), note: 'grave a nova chave no dispositivo; a anterior vale por 24 h' });
      case 'delete': d.devices.remove(id); return ok(c);
      default: throw new HttpError(404, 'not_found');
    }
  });
  r.add('GET', '/admin/api/devices/:id/diag', async (c) => {
    await session(c, false);
    ok(c, { reports: d.db.all<{ at: number; report: string }>('SELECT at, report FROM device_diag WHERE device_id = ? ORDER BY at DESC LIMIT 10', c.params.id).map(x => ({ at: x.at, report: JSON.parse(x.report) })) });
  });

  /* ---------------- settings & privacy ---------------- */
  r.add('GET', '/admin/api/settings', async (c) => {
    await session(c, false);
    ok(c, { defaultMode: d.db.getSetting('defaultMode', 'short'), privacy: d.tasks.privacy(), sessionMinutes: d.db.getSetting('sessionMinutes', d.cfg.adminSessionMinutes),
      limits: { ratePerMinute: d.cfg.ratePerMinute, dailyQuota: d.cfg.dailyQuota, maxImageBytes: d.cfg.maxImageBytes, maxConcurrent: d.cfg.maxConcurrentTasks },
      network: { publicHostname: d.cfg.publicHostname ?? null, lanEnabled: d.cfg.lanEnabled, lanPort: d.cfg.lanPort, tunnelPort: d.cfg.tunnelPort } });
  });
  r.add('POST', '/admin/api/settings', async (c) => {
    const s = await session(c, true);
    const b = await json<{ defaultMode?: string; privacy?: Partial<Privacy>; sessionMinutes?: number }>(c);
    if (b.defaultMode && (MODES as readonly string[]).includes(b.defaultMode)) d.db.setSetting('defaultMode', b.defaultMode);
    if (b.privacy) {
      const cur = d.tasks.privacy();
      const n: Privacy = {
        historyQuestions: typeof b.privacy.historyQuestions === 'boolean' ? b.privacy.historyQuestions : cur.historyQuestions,
        historyResponses: typeof b.privacy.historyResponses === 'boolean' ? b.privacy.historyResponses : cur.historyResponses,
        storeImages: typeof b.privacy.storeImages === 'boolean' ? b.privacy.storeImages : cur.storeImages,
        diagLogs: typeof b.privacy.diagLogs === 'boolean' ? b.privacy.diagLogs : cur.diagLogs,
        retentionDays: Number.isInteger(b.privacy.retentionDays) && b.privacy.retentionDays! >= 1 && b.privacy.retentionDays! <= 3650 ? b.privacy.retentionDays! : cur.retentionDays,
      };
      d.db.setSetting('privacy', n);
      if (!n.historyQuestions && !n.historyResponses) d.db.run('DELETE FROM history');
      d.tasks.purge();
    }
    if (Number.isInteger(b.sessionMinutes) && b.sessionMinutes! >= 5 && b.sessionMinutes! <= 720) { d.db.setSetting('sessionMinutes', b.sessionMinutes); d.admin.setSessionMinutes(b.sessionMinutes!); }
    d.db.securityLog('settings_changed', s.username);
    ok(c);
  });

  /* ---------------- history & favorites ---------------- */
  const decode = (enc: string | null) => { if (!enc) return null; try { return d.box.open(enc, 'history'); } catch { return '[ilegivel]'; } };
  r.add('GET', '/admin/api/history', async (c) => {
    await session(c, false);
    const q = (c.url.searchParams.get('q') ?? '').toLowerCase();
    const rows = d.db.all<{ id: number; device_id: string; at: number; provider: string; mode: string; kind: string; question_enc: string | null; response_enc: string | null }>('SELECT * FROM history ORDER BY at DESC LIMIT 500');
    const items = rows.map(x => ({ id: x.id, device: x.device_id, at: x.at, provider: x.provider, mode: x.mode, kind: x.kind, question: decode(x.question_enc), response: decode(x.response_enc) }))
      .filter(x => !q || (x.question ?? '').toLowerCase().includes(q) || (x.response ?? '').toLowerCase().includes(q)).slice(0, 200);
    ok(c, { items });
  });
  r.add('GET', '/admin/api/history/export', async (c) => {
    const s = await session(c, false);
    const rows = d.db.all<{ id: number; device_id: string; at: number; provider: string; mode: string; question_enc: string | null; response_enc: string | null }>('SELECT * FROM history ORDER BY at');
    const favs = d.db.all<{ id: number; at: number; kind: string; title: string; content_enc: string }>('SELECT * FROM favorites ORDER BY at');
    d.db.securityLog('data_exported', s.username);
    sendJson(c.res, 200, { exported_at: new Date().toISOString(),
      history: rows.map(x => ({ ...x, question_enc: undefined, response_enc: undefined, question: decode(x.question_enc), response: decode(x.response_enc) })),
      favorites: favs.map(f => ({ id: f.id, at: f.at, kind: f.kind, title: f.title, content: decode(f.content_enc) })) },
      { 'Content-Disposition': 'attachment; filename="terminal-matematico-export.json"' });
  });
  r.add('POST', '/admin/api/history/delete', async (c) => {
    const s = await session(c, true);
    const b = await json<{ id?: number; all?: boolean }>(c);
    if (b.all) d.db.run('DELETE FROM history'); else if (Number.isInteger(b.id)) d.db.run('DELETE FROM history WHERE id = ?', b.id!);
    d.db.securityLog('history_deleted', s.username, b.all ? 'tudo' : String(b.id));
    ok(c);
  });
  r.add('GET', '/admin/api/favorites', async (c) => {
    await session(c, false);
    ok(c, { items: d.db.all<{ id: number; at: number; kind: string; title: string; content_enc: string }>('SELECT * FROM favorites ORDER BY at DESC').map(f => ({ id: f.id, at: f.at, kind: f.kind, title: f.title, content: decode(f.content_enc) })) });
  });
  r.add('POST', '/admin/api/favorites', async (c) => {
    await session(c, true);
    const b = await json<{ kind?: string; title?: string; content?: string; deleteId?: number }>(c, 64 * 1024);
    if (Number.isInteger(b.deleteId)) { d.db.run('DELETE FROM favorites WHERE id = ?', b.deleteId!); return ok(c); }
    if (!['formula', 'resolution', 'question', 'result'].includes(String(b.kind)) || !b.title || !b.content) throw new HttpError(400, 'bad_request');
    d.db.run('INSERT INTO favorites (device_id, at, kind, title, content_enc) VALUES (NULL, ?, ?, ?, ?)', Date.now(), String(b.kind), String(b.title).slice(0, 120), d.box.seal(String(b.content).slice(0, 20000), 'history'));
    ok(c);
  });

  /* ---------------- manual integration ---------------- */
  r.add('GET', '/admin/api/manual', async (c) => { await session(c, false); ok(c, { pending: d.tasks.pendingManual() }); });
  r.add('GET', '/admin/api/manual/:device/:id/image', async (c) => {
    await session(c, false);
    const img = d.tasks.manualImage(c.params.device, c.params.id);
    if (!img) throw new HttpError(404, 'not_found');
    c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': img.length, ...SEC_HEADERS });
    c.res.end(img);
  });
  r.add('POST', '/admin/api/manual/:device/:id', async (c) => {
    await session(c, true);
    const b = await json<{ answer?: string }>(c, 64 * 1024);
    if (!b.answer || !b.answer.trim()) throw new HttpError(400, 'bad_request');
    if (!d.tasks.completeManual(c.params.device, c.params.id, b.answer)) throw new HttpError(404, 'not_found');
    ok(c);
  });

  /* ---------------- security ---------------- */
  r.add('GET', '/admin/api/security', async (c) => {
    await session(c, false);
    ok(c, { sessions: d.admin.sessions(), log: d.db.all('SELECT at, event, actor, detail FROM security_log ORDER BY at DESC LIMIT 200'), version: serverDiagnostics(d.cfg).version, profile: d.cfg.profile,
      totpRequired: d.cfg.adminRequireTotp, accessMode: d.cfg.adminAuthMode });
  });
  r.add('POST', '/admin/api/security/sessions/:id/revoke', async (c) => { await session(c, true); d.admin.revokeSession(c.params.id); ok(c); });
  r.add('POST', '/admin/api/security/password', async (c) => {
    const s = await session(c, true);
    const b = await json<{ old?: string; new?: string }>(c, 2048);
    try { d.admin.changePassword(s.username, String(b.old ?? ''), String(b.new ?? '')); } catch (e) { throw new HttpError(400, 'bad_request', (e as Error).message); }
    ok(c);
  });

  /* ---------------- remote access & updates ---------------- */
  r.add('GET', '/admin/api/remote', async (c) => { await session(c, false); ok(c, await remoteAccessStatus(d.cfg, d.db)); });
  r.add('GET', '/admin/api/updates', async (c) => { await session(c, false); ok(c, { firmware: d.ota.list(), manifest: d.ota.manifest() }); });
  r.add('POST', '/admin/api/updates/:version', async (c) => {
    await session(c, true);
    const b = await json<{ approved?: boolean }>(c);
    d.ota.approve(c.params.version, !!b.approved);
    ok(c);
  });

  return r;
}
