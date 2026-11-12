/**
 * TaskManager: queue + execution of AI requests.
 *  - idempotency per (device, request_id): same id while running -> same task;
 *    finished -> cached result is returned (no duplicate billing)
 *  - global concurrency limit + per-device queue limit
 *  - per-task private temp dir (0700) deleted in `finally`
 *  - timeout and cancellation (kills CLI processes / aborts HTTP)
 *  - results kept in memory for RESULT_TTL and served in pages
 *  - question/image content never logged; history persisted only if enabled
 */
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/index.ts';
import type { Db } from '../storage/db.ts';
import type { SecretBox } from '../security/crypto.ts';
import type { Registry } from '../providers/registry.ts';
import type { AIProvider, TaskOutcome } from '../providers/types.ts';
import { ManualProvider } from '../providers/manual/manual.ts';
import { normalise, page, statusResponse, type DeviceResponse, type FullResult, type Mode } from './schema.ts';
import { verifySolution } from './verify.ts';

export type TaskState = 'queued' | 'running' | 'waiting_manual' | 'done' | 'cancelled';

export interface Task {
  id: string;            // request_id from the device
  deviceId: string;
  sessionId?: string;
  kind: 'text' | 'image';
  mode: Mode;
  requested: string;
  provider?: AIProvider;
  question?: string;
  image?: Buffer;
  prompt?: string;
  state: TaskState;
  createdAt: number;
  finishedAt?: number;
  controller: AbortController;
  result?: FullResult;
  final?: DeviceResponse;   // for error/refused results
  waiters: (() => void)[];
  sentToProvider: boolean;
}

export interface Privacy { historyQuestions: boolean; historyResponses: boolean; storeImages: boolean; retentionDays: number; diagLogs: boolean }
export const DEFAULT_PRIVACY: Privacy = { historyQuestions: false, historyResponses: false, storeImages: false, retentionDays: 30, diagLogs: true };

export class TaskManager {
  private tasks = new Map<string, Task>();
  private queue: Task[] = [];
  private running = 0;
  private cfg: Config;
  private db: Db;
  private box: SecretBox;
  private reg: Registry;
  private tmpRoot: string;
  constructor(cfg: Config, db: Db, box: SecretBox, reg: Registry) {
    this.cfg = cfg; this.db = db; this.box = box; this.reg = reg;
    this.tmpRoot = join(cfg.dataDir, 'tmp');
    mkdirSync(this.tmpRoot, { recursive: true, mode: 0o700 });
    for (const d of readdirSync(this.tmpRoot)) rmSync(join(this.tmpRoot, d), { recursive: true, force: true }); // crash recovery
  }
  privacy(): Privacy { return { ...DEFAULT_PRIVACY, ...this.db.getSetting<Partial<Privacy>>('privacy', {}) }; }
  private key(deviceId: string, id: string) { return deviceId + ':' + id; }

  get(deviceId: string, id: string): Task | undefined { return this.tasks.get(this.key(deviceId, id)); }
  stats() { return { running: this.running, queued: this.queue.length, cached: this.tasks.size }; }
  pendingManual(): { id: string; deviceId: string; kind: string; question?: string; hasImage: boolean; createdAt: number }[] {
    return [...this.tasks.values()].filter(t => t.state === 'waiting_manual')
      .map(t => ({ id: t.id, deviceId: t.deviceId, kind: t.kind, question: t.question, hasImage: !!t.image, createdAt: t.createdAt }));
  }
  manualImage(deviceId: string, id: string): Buffer | undefined { const t = this.get(deviceId, id); return t?.state === 'waiting_manual' ? t.image : undefined; }

  submit(t: Omit<Task, 'state' | 'createdAt' | 'controller' | 'waiters' | 'sentToProvider' | 'provider'>): { task?: Task; error?: { status: number; code: string; message: string } } {
    this.gc();
    const k = this.key(t.deviceId, t.id);
    const existing = this.tasks.get(k);
    if (existing) return { task: existing }; // idempotent
    const active = [...this.tasks.values()].filter(x => x.deviceId === t.deviceId && (x.state === 'queued' || x.state === 'running' || x.state === 'waiting_manual')).length;
    if (active >= this.cfg.maxQueuePerDevice) return { error: { status: 429, code: 'queue_full', message: 'fila do dispositivo cheia' } };
    const sel = this.reg.select(t.requested, t.kind === 'image');
    if (!sel.provider) return { error: { status: 503, code: 'provider_unavailable', message: sel.error ?? 'indisponivel' } };
    const task: Task = { ...t, provider: sel.provider, state: 'queued', createdAt: Date.now(), controller: new AbortController(), waiters: [], sentToProvider: false };
    this.tasks.set(k, task);
    this.queue.push(task);
    this.pump();
    return { task };
  }

  /** Wait until the task finishes or `ms` elapses. */
  wait(task: Task, ms: number): Promise<void> {
    if (task.state === 'done' || task.state === 'cancelled') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      task.waiters.push(() => { clearTimeout(t); res(); });
    });
  }

  view(task: Task, pageIndex = 0): { status: number; body: unknown } {
    if (task.state === 'queued' || task.state === 'running' || task.state === 'waiting_manual') {
      return { status: 202, body: { protocol: 'mt1', request_id: task.id, status: task.state === 'waiting_manual' ? 'waiting_manual' : 'processing', provider: task.provider?.id } };
    }
    if (task.state === 'cancelled') return { status: 200, body: { protocol: 'mt1', request_id: task.id, status: 'cancelled' } };
    if (task.final) return { status: 200, body: task.final };
    return { status: 200, body: page(task.result as FullResult, pageIndex, this.cfg.stepsPerPage) };
  }

  cancel(deviceId: string, id: string): string {
    const t = this.get(deviceId, id);
    if (!t) return 'desconhecido no servidor';
    if (t.state === 'done') return 'ja concluido no servidor';
    if (t.state === 'cancelled') return 'cancelado no servidor';
    const wasSent = t.sentToProvider;
    this.finish(t, 'cancelled');
    t.controller.abort();
    t.provider?.cancel(t.id);
    this.queue = this.queue.filter(q => q !== t);
    // an external provider may already have processed the prompt; only the result is discarded
    return wasSent ? 'cancelado no servidor (o provedor pode ja ter processado)' : 'cancelado no servidor';
  }

  /** Owner answers a manual request from the dashboard. */
  completeManual(deviceId: string, id: string, text: string): boolean {
    const t = this.get(deviceId, id);
    if (!t || t.state !== 'waiting_manual') return false;
    this.complete(t, { kind: 'ok', solution: ManualProvider.fromPasted(text), model: 'manual' }, 'manual');
    return true;
  }

  private pump(): void {
    while (this.running < this.cfg.maxConcurrentTasks && this.queue.length) {
      const t = this.queue.shift() as Task;
      if (t.state !== 'queued') continue;
      this.running++;
      void this.execute(t).finally(() => { this.running--; this.pump(); });
    }
  }

  private async execute(t: Task): Promise<void> {
    t.state = 'running';
    const started = Date.now();
    const workDir = join(this.tmpRoot, randomUUID());
    mkdirSync(workDir, { mode: 0o700 });
    const timer = setTimeout(() => t.controller.abort(), this.cfg.taskTimeoutMs + 5000);
    let provider = t.provider as AIProvider;
    try {
      let imagePath: string | undefined;
      if (t.image) { imagePath = join(workDir, 'imagem.jpg'); writeFileSync(imagePath, t.image, { mode: 0o600 }); }
      const input = { requestId: t.id, mode: t.mode, question: t.question, prompt: t.prompt, workDir,
        image: t.image && imagePath ? { path: imagePath, mediaType: 'image/jpeg' as const, bytes: t.image } : undefined };
      t.sentToProvider = true;
      let out: TaskOutcome = t.kind === 'image' ? await provider.executeImage(input, t.controller.signal) : await provider.executeText(input, t.controller.signal);
      if (out.kind === 'error' && out.retryable && t.state === 'running') {
        const next = this.reg.failover(provider.id, t.kind === 'image'); // only if owner allowed it
        if (next) { provider = next; t.provider = next; out = t.kind === 'image' ? await next.executeImage(input, t.controller.signal) : await next.executeText(input, t.controller.signal); }
      }
      if ((t.state as TaskState) === 'cancelled') return;
      if (out.kind === 'pending_manual') { t.state = 'waiting_manual'; return; }
      this.complete(t, out, provider.id);
    } catch {
      if ((t.state as TaskState) !== 'cancelled') this.complete(t, { kind: 'error', code: 'internal', message: 'erro interno', retryable: false }, provider.id);
    } finally {
      clearTimeout(timer);
      rmSync(workDir, { recursive: true, force: true });
      if (t.state !== 'waiting_manual' && !this.privacy().storeImages) t.image = undefined;
      this.db.run('INSERT OR REPLACE INTO request_log (id, device_id, at, provider, kind, status, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        t.id, t.deviceId, started, provider.id, t.kind, t.state, Date.now() - started, t.final?.error?.code ?? null);
    }
  }

  private complete(t: Task, out: TaskOutcome, providerId: string): void {
    const meta = { requestId: t.id, provider: providerId, mode: t.mode, kind: (providerId === 'manual' ? 'manual' : t.kind) as DeviceResponse['kind'] };
    if (out.kind === 'ok') {
      t.result = normalise({ ...meta, responseId: randomUUID(), model: out.model }, out.solution, verifySolution(out.solution.check));
      const pv = this.privacy();
      if (pv.historyQuestions || pv.historyResponses) {
        this.db.run('INSERT INTO history (device_id, at, provider, mode, kind, question_enc, response_enc) VALUES (?, ?, ?, ?, ?, ?, ?)',
          t.deviceId, Date.now(), providerId, t.mode, t.kind,
          pv.historyQuestions && t.question ? this.box.seal(t.question, 'history') : null,
          pv.historyResponses ? this.box.seal(JSON.stringify({ ...t.result.base, steps: t.result.steps }), 'history') : null);
      }
    } else if (out.kind === 'refused') t.final = statusResponse(meta, 'refused', 'refused', out.reason);
    else if (out.kind === 'error') t.final = statusResponse(meta, 'error', out.code, out.message);
    this.finish(t, 'done');
  }

  private finish(t: Task, state: 'done' | 'cancelled'): void {
    t.state = state;
    t.finishedAt = Date.now();
    t.question = this.privacy().historyQuestions ? t.question : undefined;
    for (const w of t.waiters.splice(0)) w();
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, t] of this.tasks) if (t.finishedAt && now - t.finishedAt > this.cfg.resultTtlMs) this.tasks.delete(k);
    for (const t of this.tasks.values()) if (t.state === 'waiting_manual' && now - t.createdAt > 30 * 60_000) { t.final = statusResponse({ requestId: t.id, provider: 'manual', mode: t.mode, kind: 'manual' }, 'error', 'timeout', 'Sem resposta manual em 30 min'); t.image = undefined; this.finish(t, 'done'); }
  }

  /** Retention policy (called hourly). */
  purge(): void {
    const days = this.privacy().retentionDays;
    const cut = Date.now() - days * 86400_000;
    this.db.run('DELETE FROM history WHERE at < ?', cut);
    this.db.run('DELETE FROM request_log WHERE at < ?', cut);
    this.db.run('DELETE FROM device_diag WHERE at < ?', cut);
    this.db.run('DELETE FROM security_log WHERE at < ?', Date.now() - Math.max(days, 90) * 86400_000);
    this.gc();
  }
}
