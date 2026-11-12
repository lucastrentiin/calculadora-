/**
 * ManualProvider: no programmatic AI. The question (or image) appears in the
 * dashboard "Manual" queue; the owner uses the official app himself and pastes
 * the answer, which is converted to the structured format. Labelled as manual,
 * never presented as an automatic integration.
 */
import { BaseProvider } from '../base.ts';
import type { TaskOutcome } from '../types.ts';
import type { ModelSolution } from '../../requests/schema.ts';

export class ManualProvider extends BaseProvider {
  readonly id = 'manual';
  readonly name = 'Manual (painel)';
  constructor() {
    super();
    this.state = { ...this.state, status: 'ready', statusDetail: 'Respostas coladas pelo proprietario no painel', billing: 'manual',
      auth: { state: 'n/a', method: 'nenhuma' }, models: ['manual'], model: 'manual',
      notes: ['Nao e integracao automatica: o proprietario copia a pergunta para o app oficial e cola a resposta.'] };
    this.caps({ supportsText: true, supportsImages: true, supportsStructuredOutput: false, supportsCancel: true });
  }
  async refresh(): Promise<void> { /* always available */ }
  executeText(): Promise<TaskOutcome> { return Promise.resolve({ kind: 'pending_manual' }); }
  override executeImage(): Promise<TaskOutcome> { return Promise.resolve({ kind: 'pending_manual' }); }

  /** Turn pasted text into the structured format: first line = answer, following lines = steps. */
  static fromPasted(text: string): ModelSolution {
    const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 200);
    const answer = (lines[0] ?? '').slice(0, 1000);
    return {
      answer, original_expression: '', given: [], formulas: [],
      steps: lines.slice(1).map((l, i) => ({ title: 'Parte ' + (i + 1), math: /[=+\-*/^]/.test(l) && l.length < 160 ? l : '', text: /[=+\-*/^]/.test(l) && l.length < 160 ? '' : l })),
      check: null, uncertainty: ['Resposta inserida manualmente pelo proprietario.'], notes: 'Integracao manual',
    };
  }
}

/** "Sign in with ChatGPT" token sharing: not usable here (see docs/PROVIDERS.md). */
export class SiwcProvider extends BaseProvider {
  readonly id = 'siwc';
  readonly name = 'ChatGPT (Sign in with ChatGPT)';
  constructor() {
    super();
    this.state = { ...this.state, status: 'unavailable', billing: 'subscription', auth: { state: 'n/a', method: 'OAuth (PKCE)' },
      statusDetail: 'Indisponivel: programa da OpenAI exige client_id aprovado; documentacao nao verificavel neste ambiente',
      notes: ['Use o Codex CLI (login com a conta ChatGPT) ou a API oficial.', 'Nenhum token de sessao do site ChatGPT e utilizado.'] };
  }
  async refresh(): Promise<void> { /* stays unavailable until an approved client_id exists */ }
  executeText(): Promise<TaskOutcome> { return Promise.resolve({ kind: 'error', code: 'unavailable', message: this.state.statusDetail, retryable: false }); }
}
