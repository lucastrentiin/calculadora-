import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { loadConfig } from '../src/config/index.ts';
import { Db } from '../src/storage/db.ts';
import { SecretBox } from '../src/security/crypto.ts';
import { ProviderContext } from '../src/providers/context.ts';
import { CodexCLIProvider, buildCodexArgs, detectCodexFlags } from '../src/providers/openai/codexCli.ts';
import { ClaudeCodeProvider, buildClaudeArgs, detectClaudeFlags } from '../src/providers/anthropic/claudeCode.ts';
import { AnthropicApiProvider, mapAnthropicError, type MessagesClient } from '../src/providers/anthropic/anthropicApi.ts';
import { OpenAIApiProvider, mapOpenAIError, type OpenAIClientLike } from '../src/providers/openai/openaiApi.ts';
import { redact } from '../src/providers/cliRunner.ts';
import { fakeCli, tempDir } from './helpers.ts';

function ctx(env: Record<string, string> = {}) {
  const cfg = loadConfig({ MT_DATA_DIR: tempDir(), TASK_TIMEOUT_MS: '3000', ...env } as NodeJS.ProcessEnv);
  return new ProviderContext(cfg, Db.memory(), new SecretBox(randomBytes(32)));
}
const input = (q = 'quanto e 4/2') => ({ requestId: 'r-' + randomBytes(4).toString('hex'), mode: 'full' as const, question: q, workDir: mkdtempSync(join(tmpdir(), 'w-')) });
const calls = (bin: string) => readFileSync(join(dirname(bin), 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { args: string[]; cwd: string; env: string[] });

test('Codex CLI: flags detected from --help, read-only sandbox mandatory, prompt via stdin', () => {
  const f = detectCodexFlags('--sandbox <M> --output-schema <F> --output-last-message <F> --image <F> --skip-git-repo-check --model <M>');
  const a = buildCodexArgs(f, { schemaFile: '/t/s.json', outFile: '/t/o.txt', model: 'm1', imageFile: '/t/i.jpg' });
  assert.deepEqual(a.slice(0, 3), ['exec', '--sandbox', 'read-only']);
  assert.equal(a[a.length - 1], '-');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox') && !a.some(x => /danger|full-auto|workspace-write/.test(x)));
  assert.throws(() => buildCodexArgs(detectCodexFlags('--model'), { outFile: 'o' }), /sandbox/);
  assert.throws(() => buildCodexArgs({ ...f, image: false }, { outFile: 'o', imageFile: 'i' }), /imagens/);
});

test('Codex CLI provider end to end with a fake binary: states, execution, isolation', async () => {
  const c = ctx({ CODEX_BIN: fakeCli('codex', { loggedIn: false }) });
  const p = new CodexCLIProvider(c);
  await p.refresh();
  assert.equal(p.info().status, 'not_authenticated');
  const bin = fakeCli('codex');
  const c2 = ctx({ CODEX_BIN: bin });
  const p2 = new CodexCLIProvider(c2);
  await p2.refresh();
  assert.equal(p2.info().status, 'disabled', 'desativado ate o proprietario confirmar');
  c2.saveSettings('codex_cli', { enabled: true, acknowledged: true });
  await p2.refresh();
  assert.equal(p2.info().status, 'ready');
  assert.equal(p2.info().capabilities.supportsImages, true);
  const i = input();
  const out = await p2.executeText(i, new AbortController().signal);
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.equal(out.solution.answer, 'x = 2');
  const last = calls(bin).at(-1)!;
  assert.equal(last.cwd, i.workDir, 'diretorio isolado');
  assert.ok(!last.env.includes('ANTHROPIC_API_KEY') && !last.env.includes('MT_MASTER_KEY'), 'ambiente minimo');
  assert.ok(last.args.includes('read-only'));
  assert.equal((await new CodexCLIProvider(ctx({ CODEX_BIN: '/nao/existe' })).refresh(), 'ok'), 'ok');
});

test('Codex CLI: timeout, cancellation and usage-limit classification', async () => {
  const slow = ctx({ CODEX_BIN: fakeCli('codex', { sleepMs: 10_000 }), TASK_TIMEOUT_MS: '800' });
  slow.saveSettings('codex_cli', { enabled: true, acknowledged: true });
  const p = new CodexCLIProvider(slow);
  await p.refresh();
  const t0 = Date.now();
  const r = await p.executeText(input(), new AbortController().signal);
  assert.equal(r.kind === 'error' && r.code, 'timeout');
  assert.ok(Date.now() - t0 < 5000);
  const ac = new AbortController();
  const pr = p.executeText(input(), ac.signal);
  setTimeout(() => ac.abort(), 200);
  const r2 = await pr;
  assert.equal(r2.kind === 'error' && r2.code, 'cancelled');
  const lim = ctx({ CODEX_BIN: fakeCli('codex', { fail: 'You have hit your usage limit' }) });
  lim.saveSettings('codex_cli', { enabled: true, acknowledged: true });
  const p3 = new CodexCLIProvider(lim);
  await p3.refresh();
  const r3 = await p3.executeText(input(), new AbortController().signal);
  assert.equal(r3.kind === 'error' && r3.code, 'rate_limit');
});

test('Claude Code: tools disabled, no bypass, API-key mode passes the key only via env', async () => {
  const f = detectClaudeFlags('-p --output-format --json-schema --tools --permission-mode --no-session-persistence --max-turns --model');
  const a = buildClaudeArgs(f, 'opus');
  assert.ok(a.includes('-p') && a.includes('--tools'));
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!a.some(x => /bypassPermissions|dangerously/.test(x)));
  assert.throws(() => buildClaudeArgs(detectClaudeFlags('--output-format')), /ferramentas/);

  const bin = fakeCli('claude');
  const c = ctx({ CLAUDE_BIN: bin });
  const p = new ClaudeCodeProvider(c);
  await p.refresh();
  assert.equal(p.info().status, 'not_configured', 'modo padrao = chave de API');
  c.setSecret('anthropic_api_key', 'sk-ant-teste');
  c.saveSettings('claude_code', { enabled: true });
  await p.refresh();
  assert.equal(p.info().status, 'ready');
  assert.equal(p.info().capabilities.supportsImages, false, 'imagens nao documentadas no modo headless');
  const out = await p.executeText(input(), new AbortController().signal);
  assert.equal(out.kind, 'ok');
  const last = calls(bin).at(-1)!;
  assert.ok(last.env.includes('ANTHROPIC_API_KEY'));
  assert.ok(!last.args.join(' ').includes('sk-ant'), 'chave nunca em argumentos');
});

test('Claude Code subscription mode requires explicit owner acknowledgment', async () => {
  const c = ctx({ CLAUDE_BIN: fakeCli('claude') });
  c.saveSettings('claude_code', { enabled: true, authMode: 'subscription' });
  const p = new ClaudeCodeProvider(c);
  await p.refresh();
  assert.equal(p.info().status, 'disabled');
  c.saveSettings('claude_code', { acknowledged: true });
  await p.refresh();
  assert.equal(p.info().status, 'ready');
  assert.equal(p.info().billing, 'subscription');
  const n = ctx({ CLAUDE_BIN: fakeCli('claude', { loggedIn: false }) });
  n.saveSettings('claude_code', { enabled: true, authMode: 'subscription', acknowledged: true });
  const p2 = new ClaudeCodeProvider(n);
  await p2.refresh();
  assert.equal(p2.info().status, 'not_authenticated');
});

test('official API adapters: structured request, image input, error mapping', async () => {
  const c = ctx();
  c.setSecret('anthropic_api_key', 'k');
  const captured: Record<string, unknown>[] = [];
  const sol = { answer: '2', original_expression: '', given: [], formulas: [], steps: [], check: null, uncertainty: [], notes: '' };
  const fakeA: MessagesClient = { beta: { messages: { parse: ((p: Record<string, unknown>) => { captured.push(p); return Promise.resolve({ stop_reason: 'end_turn', parsed_output: sol, model: 'claude-opus-5-5' }); }) as never } } };
  const pa = new AnthropicApiProvider(c, () => fakeA);
  await pa.refresh();
  const r = await pa.executeImage({ ...input(), image: { path: '', mediaType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8]) } }, new AbortController().signal);
  assert.equal(r.kind, 'ok');
  assert.equal((captured[0].messages as { content: { type: string }[] }[])[0].content[0].type, 'image');
  assert.equal(captured[0].fallbacks, 'default');
  const h = new Headers();
  assert.equal(mapAnthropicError(new Anthropic.AuthenticationError(401, {}, 'x', h)).kind === 'error' && (mapAnthropicError(new Anthropic.AuthenticationError(401, {}, 'x', h)) as { code: string }).code, 'auth');
  assert.equal((mapAnthropicError(new Anthropic.APIConnectionError({ message: 'tls' })) as { code: string }).code, 'unavailable');

  c.setSecret('openai_api_key', 'k');
  const po = new OpenAIApiProvider(c, () => ({ responses: { parse: ((p: Record<string, unknown>) => { captured.push(p); return Promise.resolve({ output_parsed: sol, model: 'm-x' }); }) as never } }) as OpenAIClientLike);
  await po.refresh();
  assert.equal(po.info().status, 'not_configured', 'sem modelo escolhido nao inventa nome');
  c.saveSettings('openai_api', { model: 'modelo-escolhido' });
  await po.refresh();
  assert.equal(po.info().status, 'ready');
  const r2 = await po.executeImage({ ...input(), image: { path: '', mediaType: 'image/jpeg', bytes: Buffer.from([1]) } }, new AbortController().signal);
  assert.equal(r2.kind, 'ok');
  assert.match(JSON.stringify(captured.at(-1)), /input_image/);
  assert.equal((mapOpenAIError(new OpenAI.RateLimitError(429, { message: 'You exceeded your current quota' }, 'You exceeded your current quota', new Headers())) as { code: string }).code, 'billing');
});

test('redaction removes keys and tokens from CLI output', () => {
  const s = redact('token sk-ant-abcdefghijklmnop and access_token: "abc.def" Bearer xyz.123');
  assert.ok(!s.includes('sk-ant-abc') && !s.includes('xyz.123') && !s.includes('abc.def'));
});
