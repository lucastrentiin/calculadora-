/**
 * Official Anthropic API (Console key, metered billing) via @anthropic-ai/sdk.
 * Structured outputs + server-side refusal fallback; image input supported.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ModelSolution } from '../../requests/schema.ts';
import { BaseProvider } from '../base.ts';
import type { ProviderContext } from '../context.ts';
import { systemPrompt, type TaskInput, type TaskOutcome } from '../types.ts';

export interface MessagesClient {
  beta: { messages: { parse: Anthropic['beta']['messages']['parse'] } };
  models?: { list: Anthropic['models']['list'] };
}

export class AnthropicApiProvider extends BaseProvider {
  readonly id = 'anthropic_api';
  readonly name = 'Claude (API oficial)';
  private ctx: ProviderContext;
  private clientFactory: (key: string) => MessagesClient;
  constructor(ctx: ProviderContext, clientFactory?: (key: string) => MessagesClient) {
    super();
    this.ctx = ctx;
    this.clientFactory = clientFactory ?? ((key) => new Anthropic({ apiKey: key, maxRetries: 1 }));
    this.state.billing = 'api_metered';
    this.caps({ supportsText: true, supportsImages: true, supportsStructuredOutput: true, supportsCancel: true });
    this.state.notes = ['Cobranca por uso no Claude Console (independente da assinatura Claude).'];
  }
  private conf() { return this.ctx.settings(this.id, { enabled: true, model: 'claude-opus-5-5', acknowledged: true }); }
  async refresh(): Promise<void> {
    const c = this.conf();
    const key = this.ctx.secret('anthropic_api_key');
    this.state.model = c.model;
    this.state.auth = { state: key ? 'ok' : 'missing', method: 'chave de API' };
    if (!key) { this.state.status = 'not_configured'; this.state.statusDetail = 'Sem chave da API Anthropic'; return; }
    this.state.status = c.enabled ? 'ready' : 'disabled';
    this.state.statusDetail = c.enabled ? 'Pronto' : 'Desativado no painel';
  }
  override async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    await this.refresh();
    const key = this.ctx.secret('anthropic_api_key');
    if (!key) return { ok: false, detail: 'sem chave' };
    try {
      const client = this.clientFactory(key);
      const ids: string[] = [];
      if (client.models) for await (const m of client.models.list()) { ids.push(m.id); if (ids.length > 50) break; }
      this.state.models = ids;
      this.state.lastTest = { at: Date.now(), ok: true, detail: `${ids.length} modelos` };
      return { ok: true, detail: `${ids.length} modelos disponiveis` };
    } catch (e) {
      const m = mapAnthropicError(e);
      this.state.lastTest = { at: Date.now(), ok: false, detail: m.kind === 'error' ? m.message : 'erro' };
      return { ok: false, detail: m.kind === 'error' ? m.message : 'erro' };
    }
  }
  private async call(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> {
    const key = this.ctx.secret('anthropic_api_key');
    if (!key) return { kind: 'error', code: 'auth', message: 'Sem chave da API Anthropic', retryable: false };
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (input.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image.bytes.toString('base64') } });
    content.push({ type: 'text', text: input.question ?? input.prompt ?? 'Analise o conteudo matematico da imagem.' });
    const ac = this.track(input.requestId, signal);
    try {
      const msg = await this.clientFactory(key).beta.messages.parse({
        model: this.conf().model, max_tokens: input.mode === 'full' ? 16000 : 8000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        system: systemPrompt(input.mode),
        output_config: { effort: 'medium', format: betaZodOutputFormat(ModelSolution) },
        messages: [{ role: 'user', content }],
      }, { signal: ac.signal, timeout: this.ctx.cfg.taskTimeoutMs });
      if (msg.stop_reason === 'refusal') return { kind: 'refused', reason: 'O servico de IA recusou esta solicitacao.' };
      if (msg.stop_reason === 'max_tokens') return { kind: 'error', code: 'bad_output', message: 'Resposta excedeu o limite', retryable: true };
      if (!msg.parsed_output) return { kind: 'error', code: 'bad_output', message: 'Resposta fora do formato', retryable: true };
      return { kind: 'ok', solution: msg.parsed_output, model: msg.model };
    } catch (e) { return mapAnthropicError(e, ac.signal); } finally { this.untrack(input.requestId); }
  }
  executeText(i: TaskInput, s: AbortSignal) { return this.call(i, s); }
  override executeImage(i: TaskInput, s: AbortSignal) { return this.call(i, s); }
}

export function mapAnthropicError(err: unknown, signal?: AbortSignal): TaskOutcome {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return { kind: 'error', code: 'cancelled', message: 'cancelado', retryable: false };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'error', code: 'timeout', message: 'Tempo esgotado no servico de IA', retryable: true };
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'error', code: 'unavailable', message: 'Servico de IA inacessivel (rede/TLS)', retryable: true };
  if (err instanceof Anthropic.RateLimitError) return { kind: 'error', code: 'rate_limit', message: 'Limite de uso da API', retryable: true };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { kind: 'error', code: 'auth', message: 'Chave invalida, revogada ou sem permissao', retryable: false };
  if (err instanceof Anthropic.BadRequestError) {
    const m = String((err as Error).message).toLowerCase();
    if (m.includes('credit') || m.includes('billing')) return { kind: 'error', code: 'billing', message: 'Sem creditos na conta da API', retryable: false };
    return { kind: 'error', code: 'internal', message: 'Solicitacao rejeitada pelo servico', retryable: false };
  }
  if (err instanceof Anthropic.InternalServerError) return { kind: 'error', code: 'unavailable', message: 'Servico de IA indisponivel', retryable: true };
  if (err instanceof Anthropic.APIError) return { kind: 'error', code: 'internal', message: 'Erro no servico de IA', retryable: true };
  return { kind: 'error', code: 'internal', message: 'Erro interno', retryable: false };
}
