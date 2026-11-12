/**
 * Home server entry point.
 *  - tunnel listener: plain HTTP on 127.0.0.1:SERVER_LOCAL_PORT, reachable only
 *    by cloudflared on this machine (TLS terminates at Cloudflare; Access in front)
 *  - optional LAN listener: HTTPS (own certificate) for direct device access at home
 * The server starts even when no AI app is installed (MockProvider is always there).
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config/index.ts';
import { createApp } from './app.ts';

process.umask(0o077); // data files (sqlite, WAL, temp images) readable only by the service user
const cfg = loadConfig();
const app = createApp(cfg, { log: (e) => console.log(JSON.stringify(e)) });
await app.reg.refreshAll();
setInterval(() => { void app.reg.refreshAll(); }, 5 * 60_000).unref();

const servers: { close: (cb: () => void) => void }[] = [];
const tunnel = createHttpServer((q, r) => { void app.tunnelHandler(q, r); });
tunnel.requestTimeout = cfg.taskTimeoutMs + 60_000;
tunnel.headersTimeout = 15_000;
if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.tunnelHost)) console.warn('AVISO: listener do tunel fora do loopback; os cabecalhos do Cloudflare podem ser forjados na rede.');
tunnel.listen(cfg.tunnelPort, cfg.tunnelHost, () => console.log(`tunel (cloudflared) em http://${cfg.tunnelHost}:${cfg.tunnelPort}`));
servers.push(tunnel);

if (cfg.lanEnabled) {
  if (cfg.tlsCertFile && cfg.tlsKeyFile) {
    const lan = createHttpsServer({ cert: readFileSync(cfg.tlsCertFile), key: readFileSync(cfg.tlsKeyFile), minVersion: 'TLSv1.2' }, (q, r) => { void app.lanHandler(q, r); });
    lan.requestTimeout = cfg.taskTimeoutMs + 60_000;
    lan.listen(cfg.lanPort, cfg.lanHost, () => console.log(`LAN HTTPS em ${cfg.lanHost}:${cfg.lanPort}`));
    servers.push(lan);
  } else if (cfg.allowInsecureHttp) {
    console.warn('AVISO: LAN sem TLS (somente desenvolvimento).');
    const lan = createHttpServer((q, r) => { void app.lanHandler(q, r); });
    lan.listen(cfg.lanPort, cfg.lanHost, () => console.log(`LAN HTTP (dev) em ${cfg.lanHost}:${cfg.lanPort}`));
    servers.push(lan);
  } else {
    console.error('LAN_ENABLED exige TLS_CERT_FILE/TLS_KEY_FILE (ou ALLOW_INSECURE_HTTP=1 em desenvolvimento).');
    process.exit(1);
  }
}

const shutdown = () => { let n = servers.length; for (const s of servers) s.close(() => { if (--n === 0) { app.close(); process.exit(0); } }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
