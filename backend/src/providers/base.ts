/** Shared helpers for adapters. */
import { ModelSolution } from '../requests/schema.ts';
import type { AIProvider, Capabilities, ProviderInfo, TaskInput, TaskOutcome } from './types.ts';
import { extractJson } from './types.ts';

export abstract class BaseProvider implements AIProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  protected state: Omit<ProviderInfo, 'id' | 'name'> = {
    status: 'not_configured', statusDetail: '', billing: 'none',
    capabilities: { supportsText: false, supportsImages: false, supportsStructuredOutput: false, supportsCancel: true },
    auth: { state: 'unknown', method: '' }, models: [], model: '', notes: [],
  };
  protected running = new Map<string, AbortController>();

  info(): ProviderInfo { return { id: this.id, name: this.name, ...this.state }; }
  abstract refresh(): Promise<void>;
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    await this.refresh();
    const ok = this.state.status === 'ready';
    this.state.lastTest = { at: Date.now(), ok, detail: this.state.statusDetail };
    return { ok, detail: this.state.statusDetail };
  }
  abstract executeText(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome>;
  executeImage(_input: TaskInput, _signal: AbortSignal): Promise<TaskOutcome> {
    return Promise.resolve({ kind: 'error', code: 'not_supported', message: `${this.name} nao suporta imagens`, retryable: false });
  }
  cancel(requestId: string): void { this.running.get(requestId)?.abort(); }

  protected caps(c: Partial<Capabilities>): void { this.state.capabilities = { ...this.state.capabilities, ...c }; }

  /** Track a cancellable run linked to the task signal. */
  protected track(requestId: string, signal: AbortSignal): AbortController {
    const ac = new AbortController();
    signal.addEventListener('abort', () => ac.abort(), { once: true });
    this.running.set(requestId, ac);
    return ac;
  }
  protected untrack(requestId: string): void { this.running.delete(requestId); }
}

export function parseSolution(raw: unknown): TaskOutcome | null {
  const obj = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  // tolerate missing optional arrays from CLIs without strict schemas
  const filled = { original_expression: '', given: [], formulas: [], steps: [], check: null, uncertainty: [], notes: '', ...o };
  const r = ModelSolution.safeParse(filled);
  return r.success ? { kind: 'ok', solution: r.data, model: '' } : null;
}

export function classifyCliError(text: string): { code: 'auth' | 'rate_limit' | 'billing' | 'unavailable' | 'internal'; message: string } {
  const t = text.toLowerCase();
  if (/(not logged in|login required|unauthori[sz]ed|authenticat|please run .*login|invalid api key|oauth)/.test(t)) return { code: 'auth', message: 'Aplicativo nao autenticado ou credencial revogada' };
  if (/(usage limit|rate limit|too many requests|quota|limit reached|429)/.test(t)) return { code: 'rate_limit', message: 'Limite de uso da conta atingido' };
  if (/(credit|billing|payment|insufficient)/.test(t)) return { code: 'billing', message: 'Sem creditos ou faturamento pendente' };
  if (/(network|econn|enotfound|timed out|503|502|overloaded)/.test(t)) return { code: 'unavailable', message: 'Servico indisponivel' };
  return { code: 'internal', message: 'Falha ao executar o aplicativo' };
}
