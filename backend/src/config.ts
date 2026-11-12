/**
 * Runtime configuration (environment variables only; no secrets in code).
 * The Anthropic API key is read by the official SDK from ANTHROPIC_API_KEY and
 * never leaves this server.
 */
export interface Config {
  port: number;
  host: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  allowInsecureHttp: boolean;
  devicesFile: string;
  aiProvider: 'anthropic' | 'mock';
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  aiTimeoutMs: number;
  maxTextBytes: number;
  maxImageBytes: number;
  maxImageDim: number;
  ratePerMinute: number;
  dailyQuota: number;
  clockSkewSec: number;
  corsOrigin?: string;
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`variavel ${name} invalida`);
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.AI_PROVIDER ?? 'anthropic') as Config['aiProvider'];
  if (provider !== 'anthropic' && provider !== 'mock') throw new Error('AI_PROVIDER deve ser anthropic ou mock');
  const effort = (env.AI_EFFORT ?? 'medium') as Config['effort'];
  return {
    port: int('PORT', 8443),
    host: env.HOST ?? '0.0.0.0',
    tlsCertFile: env.TLS_CERT_FILE || undefined,
    tlsKeyFile: env.TLS_KEY_FILE || undefined,
    allowInsecureHttp: env.ALLOW_INSECURE_HTTP === '1',
    devicesFile: env.DEVICES_FILE ?? 'data/devices.json',
    aiProvider: provider,
    model: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    effort,
    aiTimeoutMs: int('AI_TIMEOUT_MS', 90_000),
    maxTextBytes: int('MAX_TEXT_BYTES', 8 * 1024),
    maxImageBytes: int('MAX_IMAGE_BYTES', 3 * 1024 * 1024),
    maxImageDim: int('MAX_IMAGE_DIM', 4096),
    ratePerMinute: int('RATE_PER_MINUTE', 10),
    dailyQuota: int('DAILY_QUOTA', 300),
    clockSkewSec: int('CLOCK_SKEW_SEC', 300),
    corsOrigin: env.CORS_ORIGIN || undefined, // only for the browser simulator; devices do not need CORS
  };
}
