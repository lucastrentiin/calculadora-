/**
 * Claude provider using the official Anthropic TypeScript SDK.
 * - Structured outputs (betaZodOutputFormat) so the reply always matches ModelSolution
 * - Server-side refusal fallbacks (beta "server-side-fallback-2026-07-01", fallbacks: "default")
 * - Timeouts and cancellation through AbortSignal
 * The API key comes from ANTHROPIC_API_KEY (read by the SDK); it is never logged or returned.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ModelSolution, type Mode } from '../schema.ts';
import { systemPrompt, type AiProvider, type SolveInput, type SolveResult } from './provider.ts';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Minimal surface of the SDK used here (lets tests inject a fake client). */
export interface MessagesClient {
  beta: { messages: { parse: Anthropic['beta']['messages']['parse'] } };
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: MessagesClient;
  private model: string;
  private effort: Effort;
  private timeoutMs: number;

  constructor(opts: { model: string; effort: Effort; timeoutMs: number; client?: MessagesClient }) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.timeoutMs = opts.timeoutMs;
    this.client = opts.client ?? new Anthropic({ maxRetries: 1 });
  }

  private userContent(input: SolveInput) {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (input.image) {
      content.push({ type: 'image', source: { type: 'base64', media_type: input.image.mediaType, data: Buffer.from(input.image.data).toString('base64') } });
    }
    const text = input.image
      ? (input.prompt?.trim() || 'Analise o conteudo matematico, documento ou texto da imagem e resolva/explique.')
      : (input.question ?? '');
    content.push({ type: 'text', text });
    return content;
  }

  async solve(input: SolveInput, signal: AbortSignal): Promise<SolveResult> {
    const mode: Mode = input.mode;
    try {
      const msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: mode === 'full' ? 16000 : 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(mode),
        output_config: { effort: this.effort, format: betaZodOutputFormat(ModelSolution) },
        messages: [{ role: 'user', content: this.userContent(input) }],
      }, { signal, timeout: this.timeoutMs });

      if (msg.stop_reason === 'refusal') {
        return { kind: 'refused', reason: 'O servico de IA recusou esta solicitacao.' };
      }
      if (msg.stop_reason === 'max_tokens') {
        return { kind: 'error', status: 502, error: 'Resposta excedeu o limite de tamanho', retryable: true };
      }
      const parsed = msg.parsed_output;
      if (!parsed) return { kind: 'error', status: 502, error: 'Resposta da IA fora do formato esperado', retryable: true };
      return { kind: 'ok', solution: parsed, model: msg.model };
    } catch (err) {
      return mapError(err, signal);
    }
  }
}

export function mapError(err: unknown, signal?: AbortSignal): SolveResult {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return { kind: 'error', status: 499, error: 'cancelado', retryable: false };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'error', status: 504, error: 'Tempo esgotado no servico de IA', retryable: true };
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'error', status: 503, error: 'Servico de IA indisponivel', retryable: true };
  if (err instanceof Anthropic.RateLimitError) return { kind: 'error', status: 503, error: 'Servico de IA ocupado', retryable: true };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'error', status: 500, error: 'Configuracao do servidor invalida', retryable: false }; // never echo details
  }
  if (err instanceof Anthropic.BadRequestError) return { kind: 'error', status: 502, error: 'Solicitacao rejeitada pelo servico de IA', retryable: false };
  if (err instanceof Anthropic.InternalServerError) return { kind: 'error', status: 503, error: 'Servico de IA indisponivel', retryable: true };
  if (err instanceof Anthropic.APIError) return { kind: 'error', status: 502, error: 'Erro no servico de IA', retryable: true };
  return { kind: 'error', status: 500, error: 'Erro interno', retryable: false };
}
