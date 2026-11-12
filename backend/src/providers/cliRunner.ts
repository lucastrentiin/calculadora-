/**
 * Safe process runner for official AI CLIs.
 *  - never uses a shell; arguments are passed as an array (no string concatenation)
 *  - prompt goes through stdin (not visible in `ps`, no argument injection)
 *  - isolated working directory (private temp dir), minimal environment
 *  - hard timeout + cancellation (SIGTERM, then SIGKILL on the process group)
 *  - output size caps (memory guard)
 */
import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  home?: string;
  maxOutputBytes?: number;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; truncated: boolean; error?: string }

const BASE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'XDG_CONFIG_HOME'];

export function runProcess(bin: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const k of BASE_ENV_KEYS) if (process.env[k]) env[k] = process.env[k] as string;
    env.HOME = o.home ?? process.env.HOME ?? o.cwd;
    env.NO_COLOR = '1';
    env.CI = '1';
    Object.assign(env, o.env ?? {});
    const max = o.maxOutputBytes ?? 1024 * 1024;
    let out = '', err = '', truncated = false, timedOut = false, aborted = false, done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd: o.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: (e as Error).message });
      return;
    }
    const kill = () => {
      if (child.exitCode != null || child.killed) return;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => { if (out.length < max) out += d.toString('utf8'); else truncated = true; });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 64 * 1024) err += d.toString('utf8'); });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: null, stdout: out, stderr: err, timedOut, aborted, truncated, error: e.message }); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: out.slice(0, max), stderr: err, timedOut, aborted, truncated });
    });
    child.stdin.on('error', () => { /* process exited early */ });
    if (o.input != null) child.stdin.end(o.input); else child.stdin.end();
  });
}

/** Removes anything that looks like a secret before showing CLI output in the dashboard/logs. */
export function redact(s: string): string {
  return s
    .replace(/(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})/g, '[redigido]')
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redigido]')
    .replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, '[jwt-redigido]')
    .replace(/("?(?:access|refresh|id)_?token"?\s*[:=]\s*)"?[^",\s]+"?/gi, '$1[redigido]')
    .slice(0, 400);
}
