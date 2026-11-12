import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/config/index.ts';
import { createApp, type AppOverrides } from '../src/app.ts';
import { signRequest } from '../src/devices/devices.ts';
import { Db } from '../src/storage/db.ts';
import { SecretBox } from '../src/security/crypto.ts';

export function tempDir(prefix = 'mt-'): string { return mkdtempSync(join(tmpdir(), prefix)); }

export async function startApp(env: Record<string, string> = {}, o: AppOverrides = {}) {
  const dataDir = tempDir();
  const cfg: Config = loadConfig({ MT_DATA_DIR: dataDir, REQUEST_WAIT_MS: '2000', ...env } as NodeJS.ProcessEnv);
  const logs: Record<string, unknown>[] = [];
  const app = createApp(cfg, { db: Db.memory(), box: new SecretBox(randomBytes(32)), log: (e) => logs.push(e), ...o });
  await app.reg.refreshAll();
  const listen = (h: (q: never, r: never) => Promise<void>) => new Promise<{ server: Server; base: string }>((res) => {
    const server = createServer((q, r) => { void h(q as never, r as never); });
    server.listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
  const tunnel = await listen(app.tunnelHandler as never);
  const lan = await listen(app.lanHandler as never);
  return {
    app, cfg, logs, base: tunnel.base, lanBase: lan.base,
    close: async () => { await new Promise<void>(r => tunnel.server.close(() => r())); await new Promise<void>(r => lan.server.close(() => r())); app.close(); },
  };
}

export function signed(method: string, pathWithQuery: string, body: Uint8Array, dev: { id: string; key: string }, extra: Record<string, string> = {}, ctype = 'application/json'): RequestInit {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(12).toString('hex');
  return {
    method,
    headers: { 'X-Device-Id': dev.id, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': signRequest(dev.key, method, pathWithQuery, ts, nonce, body), 'X-Protocol': 'mt1', ...(method === 'GET' ? {} : { 'Content-Type': ctype }), ...extra },
    body: method === 'GET' ? undefined : (body as unknown as BodyInit),
  };
}

export const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

export function jpeg(w = 640, h = 480, size = 2000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03], 20);
  b.set([0xff, 0xda, 0x00, 0x02], 40);
  b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}

/** Writes a fake CLI (node script) that mimics the official binaries for tests. */
export function fakeCli(kind: 'codex' | 'claude', behaviour: { loggedIn?: boolean; sleepMs?: number; fail?: string; noSandbox?: boolean; answer?: string } = {}): string {
  const dir = tempDir('fakecli-');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, kind);
  const answer = JSON.stringify({ answer: behaviour.answer ?? 'x = 2', original_expression: '2x=4', given: [], formulas: ['x = b/a'], steps: [{ title: 'Dividir', math: 'x = 4/2', text: '' }], check: { expression: '4/2', expected: 2, angle: 'rad' }, uncertainty: [], notes: '' });
  const script = `#!/usr/bin/env node
const a = process.argv.slice(2), fs = require('fs');
const B = ${JSON.stringify(behaviour)};
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify({ args: a, cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n');
if (a[0] === '--version') { console.log('${kind}-fake 9.9.9'); process.exit(0); }
if ('${kind}' === 'codex') {
  if (a[0] === 'exec' && a[1] === '--help') { console.log((B.noSandbox ? '' : '--sandbox <MODE> ') + '--output-schema <FILE> --output-last-message <FILE> --image <FILE> --skip-git-repo-check --model <M> --json'); process.exit(0); }
  if (a[0] === 'login' && a[1] === 'status') { if (B.loggedIn === false) { console.error('Not logged in'); process.exit(1); } console.log('Logged in using ChatGPT'); process.exit(0); }
  if (a[0] === 'logout') { console.log('Successfully logged out'); process.exit(0); }
  if (a[0] === 'exec') {
    let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => setTimeout(() => {
      if (B.fail) { console.error(B.fail); process.exit(1); }
      const i = a.indexOf('--output-last-message'); fs.writeFileSync(a[i + 1], ${JSON.stringify(answer)}); process.exit(0);
    }, B.sleepMs || 0));
  }
} else {
  if (a[0] === '--help') { console.log('-p --print --output-format <f> --json-schema <s> --tools <t> --disallowedTools --permission-mode <m> --no-session-persistence --max-turns <n> --model <m>'); process.exit(0); }
  if (a[0] === 'auth' && a[1] === 'status') { if (B.loggedIn === false) { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(1); } console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
  if (a[0] === '-p') {
    let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => setTimeout(() => {
      if (B.fail) { console.log(JSON.stringify({ is_error: true, result: B.fail })); process.exit(1); }
      console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok', structured_output: ${answer}, hasKey: !!process.env.ANTHROPIC_API_KEY })); process.exit(0);
    }, B.sleepMs || 0));
  }
}
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}
