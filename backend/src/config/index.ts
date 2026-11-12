/**
 * Configuration from environment variables (see deploy/env/*.env.example).
 * Nothing here assumes OS, IP, ports or domain: everything is a parameter.
 */
import { resolve } from 'node:path';

export type Profile = 'development' | 'production';

export interface Config {
  profile: Profile;
  dataDir: string;
  /** Loopback listener used by cloudflared (Cloudflare Tunnel). */
  tunnelHost: string;
  tunnelPort: number;
  /** Optional LAN listener (HTTPS) for direct device access at home. */
  lanEnabled: boolean;
  lanHost: string;
  lanPort: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  adminOnLan: boolean;
  allowInsecureHttp: boolean;
  publicHostname?: string;
  cloudflareTunnelId?: string;
  cloudflareAccessEnabled: boolean;
  cloudflareTeamDomain?: string;  // e.g. myteam.cloudflareaccess.com
  cloudflareAccessAudDevice?: string;
  cloudflareAccessAudAdmin?: string;
  deviceAuthMode: 'hmac' | 'hmac+access';
  adminAuthMode: 'password' | 'password+access';
  adminRequireTotp: boolean;
  adminSessionMinutes: number;
  masterKey?: string;             // base64, else data/master.key
  maxConcurrentTasks: number;
  maxQueuePerDevice: number;
  taskTimeoutMs: number;
  waitMs: number;                 // how long POST /ai/* waits before answering 202
  resultTtlMs: number;
  maxTextBytes: number;
  maxImageBytes: number;
  maxImageDim: number;
  ratePerMinute: number;
  dailyQuota: number;
  clockSkewSec: number;
  stepsPerPage: number;
  codexBin: string;
  claudeBin: string;
  cliHome?: string;               // HOME for CLI processes (dedicated service user)
  corsOrigin?: string;
}

function int(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`variavel ${name} invalida`);
  return Math.floor(n);
}
const bool = (env: NodeJS.ProcessEnv, name: string, def: boolean) => (env[name] == null || env[name] === '' ? def : env[name] === '1' || env[name] === 'true');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const profile = (env.MT_PROFILE ?? 'development') as Profile;
  if (profile !== 'development' && profile !== 'production') throw new Error('MT_PROFILE deve ser development ou production');
  const prod = profile === 'production';
  const cfg: Config = {
    profile,
    dataDir: resolve(env.MT_DATA_DIR ?? 'data'),
    tunnelHost: env.SERVER_LOCAL_HOST ?? '127.0.0.1',
    tunnelPort: int(env, 'SERVER_LOCAL_PORT', 8787),
    lanEnabled: bool(env, 'LAN_ENABLED', false),
    lanHost: env.LAN_HOST ?? '0.0.0.0',
    lanPort: int(env, 'LAN_PORT', 8443),
    tlsCertFile: env.TLS_CERT_FILE || undefined,
    tlsKeyFile: env.TLS_KEY_FILE || undefined,
    adminOnLan: bool(env, 'ADMIN_ON_LAN', false),
    allowInsecureHttp: bool(env, 'ALLOW_INSECURE_HTTP', false),
    publicHostname: env.PUBLIC_HOSTNAME || undefined,
    cloudflareTunnelId: env.CLOUDFLARE_TUNNEL_ID || undefined,
    cloudflareAccessEnabled: bool(env, 'CLOUDFLARE_ACCESS_ENABLED', false),
    cloudflareTeamDomain: env.CLOUDFLARE_TEAM_DOMAIN || undefined,
    cloudflareAccessAudDevice: env.CLOUDFLARE_ACCESS_AUD_DEVICE || undefined,
    cloudflareAccessAudAdmin: env.CLOUDFLARE_ACCESS_AUD_ADMIN || undefined,
    deviceAuthMode: (env.DEVICE_AUTH_MODE ?? 'hmac') as Config['deviceAuthMode'],
    adminAuthMode: (env.ADMIN_AUTH_MODE ?? 'password') as Config['adminAuthMode'],
    adminRequireTotp: bool(env, 'ADMIN_REQUIRE_TOTP', prod),
    adminSessionMinutes: int(env, 'ADMIN_SESSION_MINUTES', 30),
    masterKey: env.MT_MASTER_KEY || undefined,
    maxConcurrentTasks: int(env, 'MAX_CONCURRENT_TASKS', 2),
    maxQueuePerDevice: int(env, 'MAX_QUEUE_PER_DEVICE', 2),
    taskTimeoutMs: int(env, 'TASK_TIMEOUT_MS', 180_000),
    waitMs: int(env, 'REQUEST_WAIT_MS', 25_000),
    resultTtlMs: int(env, 'RESULT_TTL_MS', 15 * 60_000),
    maxTextBytes: int(env, 'MAX_TEXT_BYTES', 8 * 1024),
    maxImageBytes: int(env, 'MAX_IMAGE_BYTES', 3 * 1024 * 1024),
    maxImageDim: int(env, 'MAX_IMAGE_DIM', 4096),
    ratePerMinute: int(env, 'RATE_PER_MINUTE', 10),
    dailyQuota: int(env, 'DAILY_QUOTA', 300),
    clockSkewSec: int(env, 'CLOCK_SKEW_SEC', 300),
    stepsPerPage: int(env, 'STEPS_PER_PAGE', 20),
    codexBin: env.CODEX_BIN ?? 'codex',
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    cliHome: env.CLI_HOME || undefined,
    corsOrigin: env.CORS_ORIGIN || undefined,
  };
  if (!['hmac', 'hmac+access'].includes(cfg.deviceAuthMode)) throw new Error('DEVICE_AUTH_MODE invalido');
  if (!['password', 'password+access'].includes(cfg.adminAuthMode)) throw new Error('ADMIN_AUTH_MODE invalido');
  if ((cfg.deviceAuthMode === 'hmac+access' || cfg.adminAuthMode === 'password+access') && (!cfg.cloudflareAccessEnabled || !cfg.cloudflareTeamDomain)) {
    throw new Error('modo +access exige CLOUDFLARE_ACCESS_ENABLED=1 e CLOUDFLARE_TEAM_DOMAIN');
  }
  if (prod && cfg.allowInsecureHttp && cfg.lanEnabled) throw new Error('ALLOW_INSECURE_HTTP nao e permitido no LAN em producao');
  return cfg;
}
