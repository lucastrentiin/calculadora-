/** Server diagnostics and remote-access status (no secrets in the output). */
import { cpus, freemem, loadavg, totalmem, uptime, platform, arch, release } from 'node:os';
import { statfsSync } from 'node:fs';
import type { Config } from '../config/index.ts';
import type { Db } from '../storage/db.ts';
import { runProcess } from '../providers/cliRunner.ts';

export const VERSION = '0.2.0';

export function serverDiagnostics(cfg: Config) {
  let disk: { freeMB: number; totalMB: number } | null = null;
  try { const s = statfsSync(cfg.dataDir); disk = { freeMB: Math.round((s.bavail * s.bsize) / 1048576), totalMB: Math.round((s.blocks * s.bsize) / 1048576) }; } catch { /* unsupported */ }
  return {
    version: VERSION, node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpus: cpus().length,
    load: loadavg().map(n => Math.round(n * 100) / 100), memFreeMB: Math.round(freemem() / 1048576), memTotalMB: Math.round(totalmem() / 1048576),
    processRssMB: Math.round(process.memoryUsage().rss / 1048576), uptimeS: Math.round(uptime()), processUptimeS: Math.round(process.uptime()), disk,
    profile: cfg.profile,
  };
}

export async function remoteAccessStatus(cfg: Config, db: Db) {
  const cloudflared = await runProcess('cloudflared', ['--version'], { cwd: cfg.dataDir, timeoutMs: 5000 });
  let tunnel: string = 'nao configurado';
  if (cfg.cloudflareTunnelId && cloudflared.code === 0) {
    const info = await runProcess('cloudflared', ['tunnel', 'info', cfg.cloudflareTunnelId], { cwd: cfg.dataDir, timeoutMs: 15_000 });
    tunnel = info.code === 0 ? (/CONNECTOR ID|connector/i.test(info.stdout) ? 'conectado' : 'sem conectores ativos') : 'nao foi possivel consultar (credenciais do cloudflared?)';
  }
  let https: string = 'nao verificado';
  if (cfg.publicHostname) {
    try {
      const r = await fetch(`https://${cfg.publicHostname}/api/v1/health`, { signal: AbortSignal.timeout(8000) });
      https = `HTTPS OK (HTTP ${r.status})` + (r.status === 403 || r.status === 302 ? ' - Cloudflare Access ativo' : '');
    } catch (e) { https = 'falha: ' + (e as Error).message.slice(0, 80); }
  }
  return {
    publicHostname: cfg.publicHostname ?? null, tunnelId: cfg.cloudflareTunnelId ? cfg.cloudflareTunnelId.slice(0, 8) + '…' : null,
    cloudflaredInstalled: cloudflared.code === 0, cloudflaredVersion: cloudflared.code === 0 ? cloudflared.stdout.trim().split('\n')[0] : null,
    tunnel, accessEnabled: cfg.cloudflareAccessEnabled, deviceAuthMode: cfg.deviceAuthMode, adminAuthMode: cfg.adminAuthMode, https,
    lan: { enabled: cfg.lanEnabled, port: cfg.lanPort, tls: !!cfg.tlsCertFile },
    lastAccesses: db.all('SELECT id, name, last_seen, last_ip FROM devices ORDER BY last_seen DESC LIMIT 10'),
    recentErrors: db.all("SELECT at, event, actor FROM security_log WHERE event LIKE '%failed%' OR event LIKE '%rejected%' OR event LIKE '%blocked%' ORDER BY at DESC LIMIT 20"),
  };
}
