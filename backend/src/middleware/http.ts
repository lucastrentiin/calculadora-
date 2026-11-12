/** Minimal HTTP utilities: router, bounded body reader, security headers, cookies. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number; code: string; retryAfter?: number;
  constructor(status: number, code: string, message?: string, retryAfter?: number) { super(message ?? code); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  params: Record<string, string>;
  via: 'tunnel' | 'lan';
  ip: string;
  body?: Uint8Array;
}

export type Handler = (c: Ctx) => Promise<void> | void;

export const SEC_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), ...SEC_HEADERS,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...extra });
  res.end(json);
}

export function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > max) { reject(new HttpError(413, 'too_large', 'corpo grande demais')); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'too_large', 'corpo grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', () => reject(new HttpError(400, 'read_error', 'falha na leitura')));
  });
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (h ?? '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}

export function clientIp(req: IncomingMessage, via: 'tunnel' | 'lan'): string {
  // Only trust Cloudflare's header on the loopback tunnel listener (cloudflared is the only client).
  if (via === 'tunnel') { const v = req.headers['cf-connecting-ip']; if (typeof v === 'string' && v) return v; }
  return req.socket.remoteAddress ?? '';
}

type Route = { method: string; re: RegExp; keys: string[]; h: Handler };
export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, h: Handler): this {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k: string) => { keys.push(k); return '([A-Za-z0-9_.-]+)'; }) + '$');
    this.routes.push({ method, re, keys, h });
    return this;
  }
  match(method: string, path: string): { h: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) { const params: Record<string, string> = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; }); return { h: r.h, params }; }
    }
    return null;
  }
}
