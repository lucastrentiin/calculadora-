/**
 * Device API (protocol mt1), mounted at /api/v1 on both listeners.
 *
 *  POST /api/v1/device/register      one-time enrollment code -> device id + key (no HMAC yet)
 *  GET  /api/v1/device/status        auth check, server time, protocol
 *  GET  /api/v1/device/config        providers the device may offer, defaults, privacy notice
 *  POST /api/v1/device/diagnostics   self-test report from the device
 *  POST /api/v1/ai/ask               JSON question
 *  POST /api/v1/ai/vision            raw image/jpeg (X-Request-Id, X-Mode, X-Provider, X-Session-Id, X-Prompt)
 *  POST /api/v1/requests/cancel      {request_id}
 *  GET  /api/v1/requests/:id?page=n  result / polling / pagination
 *  GET  /api/v1/updates/manifest     approved firmware manifest
 *  GET  /api/v1/updates/firmware     approved firmware binary
 *  GET  /api/v1/health               public liveness (no data)
 */
import type { Config } from '../config/index.ts';
import type { Db } from '../storage/db.ts';
import type { Devices, DeviceRow } from '../devices/devices.ts';
import type { AccessVerifier } from '../security/accessJwt.ts';
import type { Registry } from '../providers/registry.ts';
import type { TaskManager } from '../requests/taskManager.ts';
import type { Ota } from '../ota/ota.ts';
import type { RateLimiter } from '../middleware/limits.ts';
import { inspectJpeg } from '../middleware/limits.ts';
import { AskRequest, CancelRequest, DiagReport, MODES, RegisterRequest, type Mode } from '../requests/schema.ts';
import { HttpError, Router, readBody, sendJson, type Ctx } from '../middleware/http.ts';

export interface DeviceApiDeps { cfg: Config; db: Db; devices: Devices; access?: AccessVerifier; reg: Registry; tasks: TaskManager; ota: Ota; limiter: RateLimiter; enrollLimiter: RateLimiter }

export const PRIVACY_NOTICE = 'Perguntas e imagens enviadas a um provedor externo sao processadas por esse servico segundo as politicas dele.';

export function deviceRouter(d: DeviceApiDeps): Router {
  const r = new Router();

  async function auth(c: Ctx, maxBody: number): Promise<DeviceRow> {
    if (c.via === 'tunnel' && d.cfg.deviceAuthMode === 'hmac+access') {
      try { await d.access!.verify(c.req.headers['cf-access-jwt-assertion'] as string | undefined, d.cfg.cloudflareAccessAudDevice); }
      catch (e) { d.db.securityLog('access_jwt_rejected', 'device', (e as Error).message); throw new HttpError(401, 'access_denied', 'Cloudflare Access recusou'); }
    }
    const body = await readBody(c.req, maxBody);
    c.body = body;
    const pathWithQuery = c.url.pathname + c.url.search;
    const a = d.devices.verify(c.req.method ?? '', pathWithQuery, c.req.headers, body);
    if (!a.ok) throw new HttpError(a.status, 'unauthorized', a.error);
    d.devices.touch(a.device.id, c.ip, (c.req.headers['x-firmware'] as string | undefined)?.slice(0, 32));
    return a.device;
  }
  function rate(id: string) { const x = d.limiter.take(id); if (!x.ok) throw new HttpError(429, 'rate_limited', x.reason, x.retryAfter); }

  r.add('GET', '/api/v1/health', (c) => sendJson(c.res, 200, { ok: true, protocol: 'mt1' }));

  r.add('POST', '/api/v1/device/register', async (c) => {
    const lim = d.enrollLimiter.take('enroll:' + c.ip);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', lim.reason, lim.retryAfter);
    const body = await readBody(c.req, 1024);
    let j: unknown; try { j = JSON.parse(Buffer.from(body).toString()); } catch { throw new HttpError(400, 'bad_json'); }
    const p = RegisterRequest.safeParse(j);
    if (!p.success) throw new HttpError(400, 'bad_request');
    try {
      const out = d.devices.register(p.data.code, p.data.device_id);
      sendJson(c.res, 201, { protocol: 'mt1', device_id: out.id, device_key: out.key });
    } catch { throw new HttpError(403, 'enrollment_rejected', 'codigo invalido ou expirado'); }
  });

  r.add('GET', '/api/v1/device/status', async (c) => {
    const dev = await auth(c, 0);
    sendJson(c.res, 200, { protocol: 'mt1', device_id: dev.id, name: dev.name, server_time: Math.floor(Date.now() / 1000), authorized: true });
  });

  r.add('GET', '/api/v1/device/config', async (c) => {
    await auth(c, 0);
    sendJson(c.res, 200, {
      protocol: 'mt1', providers: d.reg.deviceChoices(), default_mode: d.db.getSetting('defaultMode', 'short'),
      limits: { max_image_bytes: d.cfg.maxImageBytes, max_question: 4000, steps_per_page: d.cfg.stepsPerPage },
      privacy_notice: PRIVACY_NOTICE,
    });
  });

  r.add('POST', '/api/v1/device/diagnostics', async (c) => {
    const dev = await auth(c, 8192);
    let j: unknown; try { j = JSON.parse(Buffer.from(c.body!).toString()); } catch { throw new HttpError(400, 'bad_json'); }
    const p = DiagReport.safeParse(j);
    if (!p.success) throw new HttpError(400, 'bad_request');
    d.db.run('INSERT INTO device_diag (device_id, at, report) VALUES (?, ?, ?)', dev.id, Date.now(), JSON.stringify(p.data));
    d.db.run('UPDATE devices SET last_status = ?, ota_state = COALESCE(?, ota_state), firmware = COALESCE(?, firmware) WHERE id = ?',
      p.data.results.every(x => x.ok) ? 'ok' : 'falhas', p.data.ota_state ?? null, p.data.firmware ?? null, dev.id);
    sendJson(c.res, 200, { protocol: 'mt1', stored: true });
  });

  async function respond(c: Ctx, deviceId: string, taskRes: ReturnType<TaskManager['submit']>) {
    if (taskRes.error) throw new HttpError(taskRes.error.status, taskRes.error.code, taskRes.error.message);
    const t = taskRes.task!;
    // the device dropped the connection (e.g. ON key): stop waiting but keep the explicit cancel path
    await d.tasks.wait(t, d.cfg.waitMs);
    const v = d.tasks.view(t, 0);
    sendJson(c.res, v.status, v.body);
    void deviceId;
  }

  r.add('POST', '/api/v1/ai/ask', async (c) => {
    if (!String(c.req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'unsupported_media', 'use application/json');
    const dev = await auth(c, d.cfg.maxTextBytes);
    let j: unknown; try { j = JSON.parse(Buffer.from(c.body!).toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'JSON invalido'); }
    const p = AskRequest.safeParse(j);
    if (!p.success) throw new HttpError(400, 'bad_request', 'campos invalidos');
    if (!d.tasks.get(dev.id, p.data.request_id)) rate(dev.id);
    await respond(c, dev.id, d.tasks.submit({ id: p.data.request_id, deviceId: dev.id, sessionId: p.data.session_id, kind: 'text', mode: p.data.mode, requested: p.data.provider, question: p.data.question }));
  });

  r.add('POST', '/api/v1/ai/vision', async (c) => {
    if (String(c.req.headers['content-type'] ?? '') !== 'image/jpeg') throw new HttpError(415, 'unsupported_media', 'use image/jpeg');
    const dev = await auth(c, d.cfg.maxImageBytes);
    const h = (n: string) => String(c.req.headers[n] ?? '');
    const requestId = h('x-request-id'), mode = h('x-mode') as Mode, provider = h('x-provider') || 'auto', session = h('x-session-id') || undefined;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId) || !(MODES as readonly string[]).includes(mode) || !/^[a-z_]{2,32}$/.test(provider)) throw new HttpError(400, 'bad_request', 'cabecalhos invalidos');
    let prompt = '';
    if (h('x-prompt')) { if (h('x-prompt').length > 2048) throw new HttpError(400, 'bad_request'); prompt = Buffer.from(h('x-prompt'), 'base64').toString('utf8'); }
    const info = inspectJpeg(c.body!);
    if (!info.ok) throw new HttpError(415, 'bad_image', info.error);
    if (info.width > d.cfg.maxImageDim || info.height > d.cfg.maxImageDim) throw new HttpError(413, 'too_large', 'resolucao acima do limite');
    if (!d.tasks.get(dev.id, requestId)) rate(dev.id);
    await respond(c, dev.id, d.tasks.submit({ id: requestId, deviceId: dev.id, sessionId: session, kind: 'image', mode, requested: provider, image: Buffer.from(c.body!), prompt }));
  });

  r.add('POST', '/api/v1/requests/cancel', async (c) => {
    const dev = await auth(c, 512);
    let j: unknown; try { j = JSON.parse(Buffer.from(c.body!).toString()); } catch { throw new HttpError(400, 'bad_json'); }
    const p = CancelRequest.safeParse(j);
    if (!p.success) throw new HttpError(400, 'bad_request');
    sendJson(c.res, 200, { protocol: 'mt1', request_id: p.data.request_id, status: d.tasks.cancel(dev.id, p.data.request_id) });
  });

  r.add('GET', '/api/v1/requests/:id', async (c) => {
    const dev = await auth(c, 0);
    const t = d.tasks.get(dev.id, c.params.id);
    if (!t) throw new HttpError(404, 'not_found', 'requisicao desconhecida ou expirada');
    const wait = Math.min(Number(c.url.searchParams.get('wait') ?? '0') || 0, d.cfg.waitMs);
    if (wait) await d.tasks.wait(t, wait);
    const v = d.tasks.view(t, Number(c.url.searchParams.get('page') ?? '0') || 0);
    sendJson(c.res, v.status, v.body);
  });

  r.add('GET', '/api/v1/updates/manifest', async (c) => {
    await auth(c, 0);
    const m = d.ota.manifest();
    sendJson(c.res, 200, m ? { protocol: 'mt1', ...m } : { protocol: 'mt1', version: null });
  });

  r.add('GET', '/api/v1/updates/firmware', async (c) => {
    const dev = await auth(c, 0);
    const s = d.ota.stream(c.url.searchParams.get('version') ?? '');
    if (!s) throw new HttpError(404, 'not_found', 'versao nao aprovada');
    d.db.run('UPDATE devices SET ota_state = ? WHERE id = ?', 'baixando ' + c.url.searchParams.get('version'), dev.id);
    c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    s.stream.pipe(c.res);
  });

  return r;
}
