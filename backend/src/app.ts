/** Composition root: builds every service and the two request handlers. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config/index.ts';
import { Db } from './storage/db.ts';
import { SecretBox } from './security/crypto.ts';
import { AccessVerifier } from './security/accessJwt.ts';
import { Devices } from './devices/devices.ts';
import { AdminAuth } from './auth/admin.ts';
import { ProviderContext } from './providers/context.ts';
import { Registry } from './providers/registry.ts';
import { MockProvider } from './providers/mock/mock.ts';
import { ManualProvider, SiwcProvider } from './providers/manual/manual.ts';
import { CodexCLIProvider } from './providers/openai/codexCli.ts';
import { OpenAIApiProvider } from './providers/openai/openaiApi.ts';
import { ClaudeCodeProvider } from './providers/anthropic/claudeCode.ts';
import { AnthropicApiProvider } from './providers/anthropic/anthropicApi.ts';
import type { AIProvider } from './providers/types.ts';
import { TaskManager } from './requests/taskManager.ts';
import { Ota } from './ota/ota.ts';
import { RateLimiter } from './middleware/limits.ts';
import { HttpError, Router, clientIp, sendJson, type Ctx } from './middleware/http.ts';
import { deviceRouter } from './api/deviceApi.ts';
import { adminRouter } from './api/adminApi.ts';

export interface AppOverrides { db?: Db; box?: SecretBox; providers?: (ctx: ProviderContext) => AIProvider[]; access?: AccessVerifier; log?: (e: Record<string, unknown>) => void }

export function createApp(cfg: Config, o: AppOverrides = {}) {
  const db = o.db ?? Db.open(cfg.dataDir);
  const box = o.box ?? SecretBox.load(cfg.dataDir, cfg.masterKey);
  const access = o.access ?? (cfg.cloudflareTeamDomain ? new AccessVerifier(cfg.cloudflareTeamDomain) : undefined);
  const devices = new Devices(db, box, cfg.clockSkewSec);
  const admin = new AdminAuth(db, box, { sessionMinutes: db.getSetting('sessionMinutes', cfg.adminSessionMinutes), requireTotp: cfg.adminRequireTotp });
  const pctx = new ProviderContext(cfg, db, box);
  const providers = o.providers ? o.providers(pctx) : [
    new MockProvider(), new CodexCLIProvider(pctx), new ClaudeCodeProvider(pctx), new AnthropicApiProvider(pctx), new OpenAIApiProvider(pctx), new ManualProvider(), new SiwcProvider(),
  ];
  const reg = new Registry(db, providers);
  const tasks = new TaskManager(cfg, db, box, reg);
  const ota = new Ota(db, cfg.dataDir);
  const limiter = new RateLimiter(cfg.ratePerMinute, cfg.dailyQuota);
  const enrollLimiter = new RateLimiter(5, 50);
  const loginLimiter = new RateLimiter(10, 200);
  const here = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = resolve(join(here, '..', '..', 'dashboard'));
  const dev = deviceRouter({ cfg, db, devices, access, reg, tasks, ota, limiter, enrollLimiter });
  const adm = adminRouter({ cfg, db, admin, devices, access, reg, pctx, tasks, ota, loginLimiter, box, dashboardDir });
  const log = o.log ?? (() => {});

  function handler(via: 'tunnel' | 'lan') {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const started = Date.now();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const c: Ctx = { req, res, url, path: url.pathname, params: {}, via, ip: clientIp(req, via) };
      try {
        if (cfg.corsOrigin && url.pathname.startsWith('/api/')) {
          res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin);
          res.setHeader('Vary', 'Origin');
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Timestamp, X-Nonce, X-Signature, X-Protocol, X-Request-Id, X-Mode, X-Provider, X-Session-Id, X-Prompt, X-Firmware', 'Access-Control-Max-Age': '600' });
            res.end();
            return;
          }
        }
        const router: Router = url.pathname.startsWith('/admin') ? adm : dev;
        const m = router.match(req.method ?? 'GET', url.pathname);
        if (!m) throw new HttpError(404, 'not_found', 'nao encontrado');
        c.params = m.params;
        await m.h(c);
      } catch (e) {
        if (e instanceof HttpError) sendJson(res, e.status, { protocol: 'mt1', error: { code: e.code, message: e.message } }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
        else { sendJson(res, 500, { protocol: 'mt1', error: { code: 'internal', message: 'erro interno' } }); log({ level: 'error', msg: (e as Error).message }); }
      } finally {
        // never log bodies, questions, tokens or query strings
        log({ t: new Date(started).toISOString(), via, method: req.method, path: url.pathname.replace(/\/requests\/[^/]+/, '/requests/:id').replace(/\/(devices|manual)\/[^/]+/, '/$1/:id'), status: res.statusCode, ms: Date.now() - started });
      }
    };
  }

  const timer = setInterval(() => tasks.purge(), 3600_000);
  timer.unref();
  return { db, box, devices, admin, reg, tasks, ota, pctx, tunnelHandler: handler('tunnel'), lanHandler: handler('lan'), close: () => { clearInterval(timer); db.close(); } };
}
