import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, mapError, type MessagesClient } from '../src/ai/anthropic.ts';

type Captured = { params: Record<string, unknown>; options: Record<string, unknown> };

function fakeClient(reply: unknown, captured: Captured[]): MessagesClient {
  return {
    beta: {
      messages: {
        parse: ((params: Record<string, unknown>, options: Record<string, unknown>) => {
          captured.push({ params, options });
          if (reply instanceof Error) return Promise.reject(reply);
          return Promise.resolve(reply);
        }) as unknown as MessagesClient['beta']['messages']['parse'],
      },
    },
  };
}

const solution = { answer: 'x = 2', given: [], formulas: [], steps: [], check: { expression: '1+1', expected: 2, angle: 'rad' }, notes: '' };

test('builds a structured-output request with image, fallbacks, effort and timeout', async () => {
  const cap: Captured[] = [];
  const p = new AnthropicProvider({ model: 'claude-opus-5-5', effort: 'medium', timeoutMs: 1234, client: fakeClient({ stop_reason: 'end_turn', parsed_output: solution, model: 'claude-opus-5-5' }, cap) });
  const r = await p.solve({ requestId: 'r1', mode: 'full', image: { data: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' }, prompt: 'resolva' }, new AbortController().signal);
  assert.equal(r.kind, 'ok');
  const { params, options } = cap[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal((params.output_config as { effort: string }).effort, 'medium');
  assert.ok((params.output_config as { format: unknown }).format);
  const content = (params.messages as { content: { type: string; source?: { media_type: string; data: string } }[] }[])[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source?.media_type, 'image/jpeg');
  assert.equal(content[0].source?.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.equal(content[1].type, 'text');
  assert.match(String(params.system), /MODO COMPLETO/);
  assert.equal(options.timeout, 1234);
  assert.ok(!('thinking' in params), 'thinking omitido (adaptativo por padrao)');
});

test('refusal, max_tokens and unparsed output are handled', async () => {
  const mk = (reply: unknown) => new AnthropicProvider({ model: 'm', effort: 'low', timeoutMs: 1, client: fakeClient(reply, []) });
  const sig = new AbortController().signal;
  assert.equal((await mk({ stop_reason: 'refusal', parsed_output: null }).solve({ requestId: 'r', mode: 'fast', question: 'q' }, sig)).kind, 'refused');
  const mt = await mk({ stop_reason: 'max_tokens', parsed_output: null }).solve({ requestId: 'r', mode: 'fast', question: 'q' }, sig);
  assert.equal(mt.kind === 'error' && mt.status, 502);
  const np = await mk({ stop_reason: 'end_turn', parsed_output: null }).solve({ requestId: 'r', mode: 'fast', question: 'q' }, sig);
  assert.equal(np.kind, 'error');
});

test('SDK errors map to safe HTTP statuses', () => {
  const headers = new Headers();
  const st = (e: unknown, s?: AbortSignal) => { const r = mapError(e, s); return r.kind === 'error' ? r.status : 0; };
  assert.equal(st(new Anthropic.RateLimitError(429, {}, 'x', headers)), 503);
  assert.equal(st(new Anthropic.AuthenticationError(401, {}, 'secret detail', headers)), 500);
  assert.equal(st(new Anthropic.InternalServerError(500, {}, 'x', headers)), 503);
  assert.equal(st(new Anthropic.APIConnectionTimeoutError()), 504);
  assert.equal(st(new Anthropic.APIConnectionError({ message: 'x' })), 503);
  const ac = new AbortController(); ac.abort();
  assert.equal(st(new Error('aborted'), ac.signal), 499);
  const auth = mapError(new Anthropic.AuthenticationError(401, {}, 'sk-ant-secret', headers));
  assert.ok(auth.kind === 'error' && !auth.error.includes('sk-ant'));
});
