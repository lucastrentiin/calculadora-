/**
 * CodexCLIProvider — official OpenAI Codex CLI, logged in by the owner with
 * his own ChatGPT account (`codex login`, run by him in a terminal as the
 * service user). This adapter never reads, copies or forwards the CLI tokens:
 * it only runs the unmodified binary non-interactively.
 *
 * Capabilities are DETECTED from the installed version (`codex exec --help`),
 * not assumed. The adapter refuses to run unless a read-only sandbox flag is
 * available. It is disabled until the owner acknowledges, in the dashboard,
 * that he reviewed the current OpenAI terms/plan limits for this personal use.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSON_SCHEMA_FOR_CLI } from '../../requests/schema.ts';
import { BaseProvider, classifyCliError, parseSolution } from '../base.ts';
import { redact, runProcess } from '../cliRunner.ts';
import type { ProviderContext } from '../context.ts';
import { systemPrompt, type TaskInput, type TaskOutcome } from '../types.ts';

export interface CodexFlags { sandbox: boolean; outputSchema: boolean; lastMessage: boolean; image: boolean; skipGit: boolean; model: boolean; json: boolean }

export function detectCodexFlags(help: string): CodexFlags {
  const has = (re: RegExp) => re.test(help);
  return {
    sandbox: has(/--sandbox\b/), outputSchema: has(/--output-schema\b/), lastMessage: has(/--output-last-message\b/),
    image: has(/--image\b/), skipGit: has(/--skip-git-repo-check\b/), model: has(/--model\b/), json: has(/--json\b/),
  };
}

export function buildCodexArgs(f: CodexFlags, o: { schemaFile?: string; outFile: string; model?: string; imageFile?: string }): string[] {
  if (!f.sandbox) throw new Error('versao do Codex CLI sem --sandbox: execucao recusada por seguranca');
  const a = ['exec', '--sandbox', 'read-only'];
  if (f.skipGit) a.push('--skip-git-repo-check');
  if (f.lastMessage) a.push('--output-last-message', o.outFile);
  if (f.outputSchema && o.schemaFile) a.push('--output-schema', o.schemaFile);
  if (f.model && o.model) a.push('--model', o.model);
  if (o.imageFile) { if (!f.image) throw new Error('Codex CLI instalado nao aceita imagens'); a.push('--image', o.imageFile); }
  a.push('-'); // prompt from stdin
  return a;
}

export class CodexCLIProvider extends BaseProvider {
  readonly id = 'codex_cli';
  readonly name = 'ChatGPT (Codex CLI)';
  private ctx: ProviderContext;
  flags: CodexFlags | null = null;
  constructor(ctx: ProviderContext) {
    super();
    this.ctx = ctx;
    this.state.billing = 'subscription';
    this.state.notes = [
      'Usa o binario oficial do Codex CLI autenticado pelo proprietario (codex login).',
      'Nao le nem copia tokens; nao usa endpoints internos do ChatGPT.',
      'Limites do plano ChatGPT se aplicam. Confira os termos atuais da OpenAI antes de habilitar.',
    ];
  }
  private conf() { return this.ctx.settings(this.id, { enabled: false, model: '', acknowledged: false }); }
  private run(args: string[], cwd: string, timeoutMs: number, input?: string, signal?: AbortSignal) {
    return runProcess(this.ctx.cfg.codexBin, args, { cwd, timeoutMs, input, signal, home: this.ctx.cfg.cliHome });
  }

  async refresh(): Promise<void> {
    const tmp = this.ctx.cfg.dataDir;
    const v = await this.run(['--version'], tmp, 10_000);
    if (v.error || v.code !== 0) { this.state.status = 'not_installed'; this.state.statusDetail = 'Codex CLI nao encontrado (' + this.ctx.cfg.codexBin + ')'; this.flags = null; return; }
    this.state.version = v.stdout.trim().split('\n')[0].slice(0, 60);
    const h = await this.run(['exec', '--help'], tmp, 10_000);
    this.flags = detectCodexFlags(h.stdout + h.stderr);
    this.caps({ supportsText: true, supportsImages: this.flags.image, supportsStructuredOutput: this.flags.outputSchema, supportsCancel: true });
    const st = await this.run(['login', 'status'], tmp, 15_000);
    const authOk = st.code === 0;
    this.state.auth = { state: authOk ? 'ok' : 'missing', method: 'conta ChatGPT (codex login)', detail: redact((st.stdout || st.stderr).trim().split('\n')[0] ?? '') };
    const c = this.conf();
    this.state.model = c.model;
    this.state.models = c.model ? [c.model] : [];
    if (!this.flags.sandbox) { this.state.status = 'unavailable'; this.state.statusDetail = 'Versao sem --sandbox read-only: recusada'; return; }
    if (!authOk) { this.state.status = 'not_authenticated'; this.state.statusDetail = 'Execute "codex login" como o usuario do servico'; return; }
    if (!c.acknowledged || !c.enabled) { this.state.status = 'disabled'; this.state.statusDetail = 'Instalado e autenticado; habilite no painel apos revisar os termos'; return; }
    this.state.status = 'ready';
    this.state.statusDetail = 'Pronto';
  }

  private async exec(input: TaskInput, signal: AbortSignal, imageFile?: string): Promise<TaskOutcome> {
    if (!this.flags || this.state.status !== 'ready') return { kind: 'error', code: 'unavailable', message: this.state.statusDetail || 'indisponivel', retryable: false };
    const schemaFile = join(input.workDir, 'schema.json');
    const outFile = join(input.workDir, 'last.txt');
    writeFileSync(schemaFile, JSON.stringify(JSON_SCHEMA_FOR_CLI), { mode: 0o600 });
    let args: string[];
    try { args = buildCodexArgs(this.flags, { schemaFile, outFile, model: this.conf().model || undefined, imageFile }); }
    catch (e) { return { kind: 'error', code: 'not_supported', message: (e as Error).message, retryable: false }; }
    const prompt = systemPrompt(input.mode) + '\nResponda SOMENTE com um objeto JSON no formato do schema.\n\nPERGUNTA (dados do usuario):\n' +
      (input.question ?? input.prompt ?? 'Analise o conteudo matematico da imagem anexada.');
    const ac = this.track(input.requestId, signal);
    try {
      const r = await this.run(args, input.workDir, this.ctx.cfg.taskTimeoutMs, prompt, ac.signal);
      if (r.aborted) return { kind: 'error', code: 'cancelled', message: 'cancelado', retryable: false };
      if (r.timedOut) return { kind: 'error', code: 'timeout', message: 'Tempo esgotado no Codex CLI', retryable: true };
      if (r.code !== 0) { const c = classifyCliError(r.stderr + r.stdout); return { kind: 'error', code: c.code, message: c.message, retryable: c.code === 'unavailable' }; }
      let text = r.stdout;
      try { const { readFileSync } = await import('node:fs'); text = readFileSync(outFile, 'utf8'); } catch { /* use stdout */ }
      const parsed = parseSolution(text);
      if (!parsed || parsed.kind !== 'ok') return { kind: 'error', code: 'bad_output', message: 'Resposta do Codex fora do formato esperado', retryable: true };
      return { ...parsed, model: this.conf().model || 'codex (padrao da conta)' };
    } finally { this.untrack(input.requestId); }
  }
  executeText(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> { return this.exec(input, signal); }
  override executeImage(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> {
    if (!this.state.capabilities.supportsImages || !input.image) return Promise.resolve({ kind: 'error', code: 'not_supported', message: 'Codex CLI instalado nao aceita imagens', retryable: false });
    return this.exec(input, signal, input.image.path);
  }
  async logout(): Promise<string> { const r = await this.run(['logout'], this.ctx.cfg.dataDir, 15_000); await this.refresh(); return redact(r.stdout || r.stderr); }
}
