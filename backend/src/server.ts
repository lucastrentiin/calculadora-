/**
 * Entry point. Serves HTTPS directly when TLS_CERT_FILE/TLS_KEY_FILE are set.
 * Plain HTTP is only allowed with ALLOW_INSECURE_HTTP=1 (local development or
 * behind a TLS-terminating reverse proxy); the firmware always requires HTTPS.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { createHandler } from './app.ts';
import { DeviceAuthenticator, FileDeviceStore } from './deviceAuth.ts';
import { RateLimiter } from './limits.ts';
import { AnthropicProvider } from './ai/anthropic.ts';
import { MockProvider } from './ai/mock.ts';

const config = loadConfig();
const store = new FileDeviceStore(config.devicesFile);
const provider = config.aiProvider === 'mock'
  ? new MockProvider(500)
  : new AnthropicProvider({ model: config.model, effort: config.effort, timeoutMs: config.aiTimeoutMs });

if (config.aiProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY nao definida (ou use AI_PROVIDER=mock).');
  process.exit(1);
}

const handler = createHandler({
  config,
  auth: new DeviceAuthenticator(store, config.clockSkewSec),
  limiter: new RateLimiter(config.ratePerMinute, config.dailyQuota),
  provider,
  log: (e) => console.log(JSON.stringify(e)),
});

process.on('SIGHUP', () => { store.reload(); console.log('devices recarregados'); });

const onRequest = (req: Parameters<typeof handler>[0], res: Parameters<typeof handler>[1]) => { void handler(req, res); };
let server;
if (config.tlsCertFile && config.tlsKeyFile) {
  server = createHttpsServer({ cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile), minVersion: 'TLSv1.2' }, onRequest);
} else if (config.allowInsecureHttp) {
  console.warn('AVISO: HTTP sem TLS (somente desenvolvimento ou atras de proxy TLS).');
  server = createHttpServer(onRequest);
} else {
  console.error('Defina TLS_CERT_FILE e TLS_KEY_FILE (ou ALLOW_INSECURE_HTTP=1 para desenvolvimento).');
  process.exit(1);
}
server.requestTimeout = config.aiTimeoutMs + 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, config.host, () => console.log(`backend em ${config.host}:${config.port} provedor=${provider.name} modelo=${config.model}`));
