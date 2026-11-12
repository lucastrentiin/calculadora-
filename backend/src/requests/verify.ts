/**
 * Server-side deterministic verification, reusing the exact engine of the
 * simulator (simulator/js/core/mathEngine.js, CommonJS/UMD) so device,
 * simulator and server agree on grammar and results.
 */
import { createRequire } from 'node:module';
import type { DeviceResponse, ModelSolution } from './schema.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const MathEngine = require('../../../simulator/js/core/mathEngine.js') as {
  calculate(e: string, ctx?: { angle?: 'deg' | 'rad'; vars?: Record<string, number> }): { ok: boolean; value: number; text: string; message?: string };
  solveSteps(e: string, ctx?: { angle?: 'deg' | 'rad' }): { steps: { rule: string; expr: string }[]; value: number; truncated: boolean };
  formatNumber(v: number): string;
};

export function verifySolution(check: ModelSolution['check'] | DeviceResponse['check']): DeviceResponse['verification'] {
  if (!check) return { state: 'none', detail: 'Sem verificacao numerica disponivel' };
  const r = MathEngine.calculate(check.expression, { angle: check.angle });
  if (!r.ok) return { state: 'error', detail: ('Verificacao falhou: ' + (r.message ?? '')).slice(0, 200) };
  const tol = 1e-9 * Math.max(1, Math.abs(check.expected), Math.abs(r.value));
  if (Math.abs(r.value - check.expected) <= tol) return { state: 'match', detail: `Servidor confere: ${check.expression} = ${r.text}`.slice(0, 200) };
  return { state: 'mismatch', detail: `DIVERGENCIA: servidor ${r.text} != IA ${MathEngine.formatNumber(check.expected)}`.slice(0, 200) };
}
