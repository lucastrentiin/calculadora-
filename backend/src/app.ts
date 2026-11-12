/**
 * HTTP request handler (transport-agnostic: used by the HTTPS server and tests).
 *
 *  GET  /v1/health                      public, no data
 *  POST /v1/ask                         JSON {request_id, question, mode}
 *  POST /v1/image                       raw image/jpeg body; X-Request-Id, X-Mode, X-Prompt (base64 UTF-8)
 *  POST /v1/requests/:id/cancel         explicit cancellation of an in-flight request
 *
 * All /v1 endpoints except health require HMAC device authentication.
 * Bodies are never logged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AskRequest, MODES, statusResponse, toDeviceResponse, type DeviceResponse, type Mode } from './schema.ts';
import type { DeviceAuthenticator } from './deviceAuth.ts';
import { inspectJpeg, type RateLimiter } from './limits.ts';
import type { AiProvider, SolveInput } from './ai/provider.ts';
import type { Config } from './config.ts';

export interface Deps {
  config: Config;
  auth: DeviceAuthenticator;
  limiter: RateLimiter;
  provider: AiProvider;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

type Flight = { controller: AbortController; status: 'processing' | 'done' | 'cancelled'; at: number };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const SEC_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), ...SEC_HEADERS, ...extra });
  res.end(json);
}

function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > max) { reject(new HttpError(413, 'corpo grande demais')); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'corpo grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', () => reject(new HttpError(400, 'falha na leitura')));
  });
}

export function createHandler(deps: Deps) {
  const { config, auth, limiter, provider } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const flights = new Map<string, Flight>();

  function gcFlights(): void {
    const limit = now() - 10 * 60_000;
    for (const [k, f] of flights) if (f.status !== 'processing' && f.at < limit) flights.delete(k);
  }

  async function runSolve(deviceId: string, input: SolveInput, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = deviceId + ':' + input.requestId;
    const existing = flights.get(key);
    if (existing) throw new HttpError(409, existing.status === 'processing' ? 'requisicao ja em andamento' : 'request_id ja utilizado');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs + 5000);
    const flight: Flight = { controller, status: 'processing', at: now() };
    flights.set(key, flight);
    // device dropped the connection (e.g. privacy lock): stop the upstream call too
    res.on('close', () => { if (!res.writableFinished && flight.status === 'processing') { flight.status = 'cancelled'; controller.abort(); } });
    let result;
    try { result = await provider.solve(input, controller.signal); }
    finally { clearTimeout(timer); }
    if (flight.status === 'cancelled') { send(res, 409, { error: 'cancelado', status: 'cancelado no servidor' }); return; }
    flight.status = 'done'; flight.at = now();
    let body: DeviceResponse;
    if (result.kind === 'ok') body = toDeviceResponse(input.requestId, input.mode, result.solution);
    else if (result.kind === 'refused') body = statusResponse(input.requestId, input.mode, 'refused', result.reason);
    else { send(res, result.status === 499 ? 409 : result.status, { error: result.error, retryable: result.retryable }); return; }
    send(res, 200, body);
    void req;
  }

  async function authed(req: IncomingMessage, path: string, maxBody: number): Promise<{ deviceId: string; body: Uint8Array }> {
    const body = await readBody(req, maxBody);
    const a = auth.verify(req.method ?? '', path, req.headers, body);
    if (!a.ok) throw new HttpError(a.status, a.error);
    return { deviceId: a.deviceId, body };
  }

  function rate(deviceId: string): void {
    const r = limiter.take(deviceId);
    if (!r.ok) { const e = new HttpError(429, r.reason ?? 'limite'); (e as HttpError & { retryAfter?: number }).retryAfter = r.retryAfter; throw e; }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    let deviceId: string | undefined;
    if (config.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Timestamp, X-Nonce, X-Signature, X-Request-Id, X-Mode, X-Prompt',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
    }
    try {
      if (req.method === 'GET' && path === '/v1/health') { send(res, 200, { ok: true, provider: provider.name }); return; }

      if (req.method === 'POST' && path === '/v1/ask') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'use application/json');
        const a = await authed(req, path, config.maxTextBytes);
        deviceId = a.deviceId;
        let json: unknown;
        try { json = JSON.parse(Buffer.from(a.body).toString('utf8')); } catch { throw new HttpError(400, 'JSON invalido'); }
        const parsed = AskRequest.safeParse(json);
        if (!parsed.success) throw new HttpError(400, 'campos invalidos');
        rate(deviceId);
        await runSolve(deviceId, { requestId: parsed.data.request_id, mode: parsed.data.mode, question: parsed.data.question }, req, res);
        return;
      }

      if (req.method === 'POST' && path === '/v1/image') {
        if (String(req.headers['content-type'] ?? '') !== 'image/jpeg') throw new HttpError(415, 'use image/jpeg');
        const a = await authed(req, path, config.maxImageBytes);
        deviceId = a.deviceId;
        const requestId = String(req.headers['x-request-id'] ?? '');
        const mode = String(req.headers['x-mode'] ?? '') as Mode;
        if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId) || !(MODES as readonly string[]).includes(mode)) throw new HttpError(400, 'cabecalhos invalidos');
        let prompt = '';
        const rawPrompt = req.headers['x-prompt'];
        if (typeof rawPrompt === 'string' && rawPrompt) {
          if (rawPrompt.length > 2048) throw new HttpError(400, 'prompt longo demais');
          prompt = Buffer.from(rawPrompt, 'base64').toString('utf8');
        }
        const info = inspectJpeg(a.body);
        if (!info.ok) throw new HttpError(415, info.error);
        if (info.width > config.maxImageDim || info.height > config.maxImageDim) throw new HttpError(413, 'resolucao acima do limite');
        rate(deviceId);
        await runSolve(deviceId, { requestId, mode, image: { data: a.body, mediaType: 'image/jpeg' }, prompt }, req, res);
        return;
      }

      const m = path.match(/^\/v1\/requests\/([A-Za-z0-9-]{8,64})\/cancel$/);
      if (req.method === 'POST' && m) {
        const a = await authed(req, path, 0);
        deviceId = a.deviceId;
        gcFlights();
        const f = flights.get(deviceId + ':' + m[1]);
        if (!f) { send(res, 200, { status: 'desconhecido no servidor' }); return; }
        if (f.status === 'processing') {
          f.status = 'cancelled'; f.at = now(); f.controller.abort();
          // the AI provider may already have received the prompt; only the result is discarded
          send(res, 200, { status: 'cancelado no servidor' });
          return;
        }
        send(res, 200, { status: f.status === 'done' ? 'ja concluido no servidor' : 'cancelado no servidor' });
        return;
      }

      throw new HttpError(404, 'nao encontrado');
    } catch (err) {
      if (err instanceof HttpError) {
        const extra: Record<string, string> = {};
        const ra = (err as HttpError & { retryAfter?: number }).retryAfter;
        if (ra) extra['Retry-After'] = String(ra);
        send(res, err.status, { error: err.message }, extra);
      } else {
        send(res, 500, { error: 'erro interno' });
      }
    } finally {
      log({ t: new Date(started).toISOString(), method: req.method, path: path.replace(/\/v1\/requests\/[^/]+/, '/v1/requests/:id'), device: deviceId, status: res.statusCode, ms: now() - started });
    }
  };
}
