/**
 * ClaudeCodeProvider — the unmodified official Claude Code binary (`claude -p`).
 *
 * What the official docs say (checked: code.claude.com legal-and-compliance,
 * headless, cli-reference, authentication; Consumer Terms; Agent SDK note):
 *  - An end user may sign in to the unmodified Claude Code binary with his own
 *    subscription; headless `-p` and `claude setup-token` are documented for
 *    scripts. Plan limits assume ordinary, individual use.
 *  - Third parties may not offer claude.ai login, route requests through plan
 *    credentials on behalf of users, or collect/store/intermediate those tokens.
 *  - Consumer Terms forbid automated access except via an API key or where
 *    explicitly permitted -> the API-key mode is the unambiguous path.
 *
 * Solution implemented here:
 *  1. auth "api_key": Claude Code runs with ANTHROPIC_API_KEY (encrypted in
 *     the server, Console billing). Clearly permitted.
 *  2. auth "subscription": allowed ONLY for the single owner, on his own
 *     server, for his own questions; disabled by default and gated by an
 *     explicit acknowledgment in the dashboard. The server never reads,
 *     copies or forwards ~/.claude credentials and never serves other people.
 *  - Images: headless image input is not documented -> not offered here
 *    (use the Anthropic API provider for photos).
 *  - Tools are disabled and the run happens in an empty private directory.
 */
import { JSON_SCHEMA_FOR_CLI } from '../../requests/schema.ts';
import { BaseProvider, classifyCliError, parseSolution } from '../base.ts';
import { redact, runProcess } from '../cliRunner.ts';
import type { ProviderContext } from '../context.ts';
import { systemPrompt, type TaskInput, type TaskOutcome } from '../types.ts';

export interface ClaudeFlags { jsonSchema: boolean; outputFormat: boolean; tools: boolean; disallowed: boolean; permissionMode: boolean; noSession: boolean; maxTurns: boolean; restricted: boolean; model: boolean }

export function detectClaudeFlags(help: string): ClaudeFlags {
  const has = (re: RegExp) => re.test(help);
  return {
    jsonSchema: has(/--json-schema\b/), outputFormat: has(/--output-format\b/), tools: has(/--tools\b/), disallowed: has(/--disallowedTools\b|--disallowed-tools\b/),
    permissionMode: has(/--permission-mode\b/), noSession: has(/--no-session-persistence\b/), maxTurns: has(/--max-turns\b/), restricted: has(/--restricted\b/), model: has(/--model\b/),
  };
}

export function buildClaudeArgs(f: ClaudeFlags, model?: string): string[] {
  if (!f.outputFormat) throw new Error('versao do Claude Code sem --output-format');
  if (!f.tools && !f.disallowed) throw new Error('versao do Claude Code sem forma de desativar ferramentas: recusada');
  const a = ['-p', '--output-format', 'json'];
  if (f.jsonSchema) a.push('--json-schema', JSON.stringify(JSON_SCHEMA_FOR_CLI));
  if (f.tools) a.push('--tools', ''); else a.push('--disallowedTools', '*');
  if (f.permissionMode) a.push('--permission-mode', 'dontAsk');
  if (f.restricted) a.push('--restricted');
  if (f.noSession) a.push('--no-session-persistence');
  if (f.maxTurns) a.push('--max-turns', '3');
  if (f.model && model) a.push('--model', model);
  return a;
}

export class ClaudeCodeProvider extends BaseProvider {
  readonly id = 'claude_code';
  readonly name = 'Claude (Claude Code)';
  private ctx: ProviderContext;
  flags: ClaudeFlags | null = null;
  constructor(ctx: ProviderContext) {
    super();
    this.ctx = ctx;
    this.state.notes = [
      'Binario oficial e nao modificado do Claude Code, executado com "claude -p".',
      'Modo chave de API: permitido pelos termos (cobranca no Console).',
      'Modo assinatura: somente uso pessoal do proprietario; desativado por padrao; os Termos do Consumidor restringem acesso automatizado fora da API.',
      'Imagens nao sao enviadas por este adaptador (entrada de imagem no modo headless nao e documentada).',
      'Nunca le, copia ou encaminha credenciais do claude.ai.',
    ];
  }
  private conf() { return this.ctx.settings(this.id, { enabled: false, model: '', acknowledged: false, authMode: 'api_key' }); }
  private env(): Record<string, string> | null {
    const c = this.conf();
    if (c.authMode === 'api_key') { const k = this.ctx.secret('anthropic_api_key'); return k ? { ANTHROPIC_API_KEY: k } : null; }
    return {}; // subscription: CLI uses the owner's own login in its HOME
  }
  private run(args: string[], cwd: string, timeoutMs: number, input?: string, signal?: AbortSignal, env?: Record<string, string>) {
    return runProcess(this.ctx.cfg.claudeBin, args, { cwd, timeoutMs, input, signal, env, home: this.ctx.cfg.cliHome });
  }

  async refresh(): Promise<void> {
    const tmp = this.ctx.cfg.dataDir;
    const c = this.conf();
    this.state.billing = c.authMode === 'api_key' ? 'api_metered' : 'subscription';
    const v = await this.run(['--version'], tmp, 10_000);
    if (v.error || v.code !== 0) { this.state.status = 'not_installed'; this.state.statusDetail = 'Claude Code nao encontrado (' + this.ctx.cfg.claudeBin + ')'; this.flags = null; return; }
    this.state.version = v.stdout.trim().split('\n')[0].slice(0, 60);
    const h = await this.run(['--help'], tmp, 10_000);
    this.flags = detectClaudeFlags(h.stdout + h.stderr);
    this.caps({ supportsText: true, supportsImages: false, supportsStructuredOutput: this.flags.jsonSchema, supportsCancel: true });
    this.state.model = c.model;
    this.state.models = c.model ? [c.model] : [];
    if (c.authMode === 'api_key') {
      const has = this.ctx.hasSecret('anthropic_api_key');
      this.state.auth = { state: has ? 'ok' : 'missing', method: 'chave de API (Console)' };
      if (!has) { this.state.status = 'not_configured'; this.state.statusDetail = 'Cadastre a chave da API Anthropic'; return; }
    } else {
      const st = await this.run(['auth', 'status'], tmp, 15_000);
      let method = 'desconhecido';
      try { method = String((JSON.parse(st.stdout) as { authMethod?: string }).authMethod ?? method); } catch { /* text output */ }
      this.state.auth = { state: st.code === 0 ? 'ok' : 'missing', method: 'assinatura (' + method + ')', detail: st.code === 0 ? 'autenticado' : redact(st.stderr || st.stdout) };
      if (st.code !== 0) { this.state.status = 'not_authenticated'; this.state.statusDetail = 'Execute "claude auth login" como o usuario do servico'; return; }
      if (!c.acknowledged) { this.state.status = 'disabled'; this.state.statusDetail = 'Modo assinatura exige confirmacao explicita do proprietario (uso pessoal)'; return; }
    }
    try { buildClaudeArgs(this.flags); } catch (e) { this.state.status = 'unavailable'; this.state.statusDetail = (e as Error).message; return; }
    if (!c.enabled) { this.state.status = 'disabled'; this.state.statusDetail = 'Desativado no painel'; return; }
    this.state.status = 'ready';
    this.state.statusDetail = 'Pronto';
  }

  async executeText(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> {
    if (!this.flags || this.state.status !== 'ready') return { kind: 'error', code: 'unavailable', message: this.state.statusDetail || 'indisponivel', retryable: false };
    const env = this.env();
    if (!env) return { kind: 'error', code: 'auth', message: 'Chave da API ausente', retryable: false };
    const args = buildClaudeArgs(this.flags, this.conf().model || undefined);
    const prompt = systemPrompt(input.mode) + '\nResponda SOMENTE com JSON no formato pedido.\n\nPERGUNTA (dados do usuario):\n' + (input.question ?? '');
    const ac = this.track(input.requestId, signal);
    try {
      const r = await this.run(args, input.workDir, this.ctx.cfg.taskTimeoutMs, prompt, ac.signal, env);
      if (r.aborted) return { kind: 'error', code: 'cancelled', message: 'cancelado', retryable: false };
      if (r.timedOut) return { kind: 'error', code: 'timeout', message: 'Tempo esgotado no Claude Code', retryable: true };
      let out: { result?: string; structured_output?: unknown; is_error?: boolean; model?: string } = {};
      try { out = JSON.parse(r.stdout); } catch { /* not json */ }
      if (r.code !== 0 || out.is_error) { const c = classifyCliError((out.result ?? '') + r.stderr + r.stdout); return { kind: 'error', code: c.code, message: c.message, retryable: c.code === 'unavailable' }; }
      const parsed = parseSolution(out.structured_output ?? out.result ?? r.stdout);
      if (!parsed || parsed.kind !== 'ok') return { kind: 'error', code: 'bad_output', message: 'Resposta do Claude Code fora do formato esperado', retryable: true };
      return { ...parsed, model: this.conf().model || 'claude-code (padrao)' };
    } finally { this.untrack(input.requestId); }
  }
}
