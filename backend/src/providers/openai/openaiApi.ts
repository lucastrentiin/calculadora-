/**
 * Official OpenAI API (platform key, metered billing) via the `openai` SDK,
 * Responses API with structured output (zodTextFormat) and image input.
 * No model name is assumed: the owner selects one from models.list().
 */
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { ModelSolution } from '../../requests/schema.ts';
import { BaseProvider } from '../base.ts';
import type { ProviderContext } from '../context.ts';
import { systemPrompt, type TaskInput, type TaskOutcome } from '../types.ts';

export interface OpenAIClientLike {
  responses: { parse: OpenAI['responses']['parse'] };
  models?: { list: OpenAI['models']['list'] };
}

export class OpenAIApiProvider extends BaseProvider {
  readonly id = 'openai_api';
  readonly name = 'ChatGPT (API oficial)';
  private ctx: ProviderContext;
  private clientFactory: (key: string) => OpenAIClientLike;
  constructor(ctx: ProviderContext, clientFactory?: (key: string) => OpenAIClientLike) {
    super();
    this.ctx = ctx;
    this.clientFactory = clientFactory ?? ((key) => new OpenAI({ apiKey: key, maxRetries: 1 }));
    this.state.billing = 'api_metered';
    this.caps({ supportsText: true, supportsImages: true, supportsStructuredOutput: true, supportsCancel: true });
    this.state.notes = ['Cobranca por uso na plataforma da OpenAI (independente do plano ChatGPT).'];
  }
  private conf() { return this.ctx.settings(this.id, { enabled: true, model: '', acknowledged: true }); }
  async refresh(): Promise<void> {
    const c = this.conf();
    const key = this.ctx.secret('openai_api_key');
    this.state.model = c.model;
    this.state.auth = { state: key ? 'ok' : 'missing', method: 'chave de API' };
    if (!key) { this.state.status = 'not_configured'; this.state.statusDetail = 'Sem chave da API OpenAI'; return; }
    if (!c.model) { this.state.status = 'not_configured'; this.state.statusDetail = 'Escolha um modelo (Testar lista os disponiveis)'; return; }
    this.state.status = c.enabled ? 'ready' : 'disabled';
    this.state.statusDetail = c.enabled ? 'Pronto' : 'Desativado no painel';
  }
  override async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    await this.refresh();
    const key = this.ctx.secret('openai_api_key');
    if (!key) return { ok: false, detail: 'sem chave' };
    try {
      const client = this.clientFactory(key);
      const ids: string[] = [];
      if (client.models) for await (const m of client.models.list()) { ids.push(m.id); if (ids.length > 200) break; }
      this.state.models = ids.sort();
      this.state.lastTest = { at: Date.now(), ok: true, detail: `${ids.length} modelos` };
      return { ok: true, detail: `${ids.length} modelos disponiveis` };
    } catch (e) {
      const m = mapOpenAIError(e);
      const d = m.kind === 'error' ? m.message : 'erro';
      this.state.lastTest = { at: Date.now(), ok: false, detail: d };
      return { ok: false, detail: d };
    }
  }
  private async call(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> {
    const key = this.ctx.secret('openai_api_key');
    const model = this.conf().model;
    if (!key || !model) return { kind: 'error', code: 'auth', message: 'API OpenAI nao configurada', retryable: false };
    const content: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: input.question ?? input.prompt ?? 'Analise o conteudo matematico da imagem.' }];
    if (input.image) content.push({ type: 'input_image', image_url: 'data:image/jpeg;base64,' + input.image.bytes.toString('base64'), detail: 'auto' });
    const ac = this.track(input.requestId, signal);
    try {
      const r = await this.clientFactory(key).responses.parse({
        model, instructions: systemPrompt(input.mode),
        input: [{ role: 'user', content }],
        text: { format: zodTextFormat(ModelSolution, 'solution') },
      }, { signal: ac.signal, timeout: this.ctx.cfg.taskTimeoutMs });
      if (!r.output_parsed) return { kind: 'error', code: 'bad_output', message: 'Resposta fora do formato', retryable: true };
      return { kind: 'ok', solution: r.output_parsed, model: r.model };
    } catch (e) { return mapOpenAIError(e, ac.signal); } finally { this.untrack(input.requestId); }
  }
  executeText(i: TaskInput, s: AbortSignal) { return this.call(i, s); }
  override executeImage(i: TaskInput, s: AbortSignal) { return this.call(i, s); }
}

export function mapOpenAIError(err: unknown, signal?: AbortSignal): TaskOutcome {
  if (signal?.aborted || err instanceof OpenAI.APIUserAbortError) return { kind: 'error', code: 'cancelled', message: 'cancelado', retryable: false };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { kind: 'error', code: 'timeout', message: 'Tempo esgotado', retryable: true };
  if (err instanceof OpenAI.APIConnectionError) return { kind: 'error', code: 'unavailable', message: 'Servico inacessivel (rede/TLS)', retryable: true };
  if (err instanceof OpenAI.RateLimitError) {
    const quota = String((err as Error).message).toLowerCase().includes('quota');
    return { kind: 'error', code: quota ? 'billing' : 'rate_limit', message: quota ? 'Sem creditos/cota na API' : 'Limite de uso da API', retryable: !quota };
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return { kind: 'error', code: 'auth', message: 'Chave invalida, revogada ou sem permissao', retryable: false };
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError) return { kind: 'error', code: 'internal', message: 'Solicitacao rejeitada (modelo/parametros)', retryable: false };
  if (err instanceof OpenAI.InternalServerError) return { kind: 'error', code: 'unavailable', message: 'Servico indisponivel', retryable: true };
  if (err instanceof OpenAI.APIError) return { kind: 'error', code: 'internal', message: 'Erro no servico de IA', retryable: true };
  return { kind: 'error', code: 'internal', message: 'Erro interno', retryable: false };
}
