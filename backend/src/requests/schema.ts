/**
 * Protocol mt1 contracts (device <-> home server). Response "version": 1 keeps
 * compatibility with the device validators (simulator aiResponse.js and
 * firmware ai_response.c), which ignore the extra fields they do not render.
 */
import { z } from 'zod';

export const MODES = ['fast', 'short', 'full'] as const;
export type Mode = (typeof MODES)[number];

export const LIMITS = { answer: 1000, field: 2000, steps: 200, given: 30, formulas: 20, notes: 2000, question: 4000, checkExpr: 256 } as const;

const ID = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

export const AskRequest = z.object({
  request_id: ID,
  session_id: z.string().regex(/^[A-Za-z0-9-]{4,64}$/).optional(),
  question: z.string().min(1).max(LIMITS.question),
  mode: z.enum(MODES),
  provider: z.string().regex(/^[a-z_]{2,32}$/).default('auto'),
}).strict();
export type AskRequest = z.infer<typeof AskRequest>;

export const CancelRequest = z.object({ request_id: ID }).strict();
export const RegisterRequest = z.object({ code: z.string().min(8).max(64), device_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), firmware: z.string().max(32).optional() }).strict();
export const DiagReport = z.object({
  firmware: z.string().max(32).optional(),
  results: z.array(z.object({ test: z.string().max(32), ok: z.boolean(), detail: z.string().max(120).optional() })).max(40),
  ota_state: z.string().max(32).optional(),
}).strict();

/** Structured output requested from every provider. */
export const ModelSolution = z.object({
  answer: z.string().describe('Resposta final curta, em portugues'),
  original_expression: z.string().describe('Expressao/enunciado original identificado, ou vazio'),
  given: z.array(z.object({ name: z.string(), value: z.string() })),
  formulas: z.array(z.string()),
  steps: z.array(z.object({ title: z.string(), math: z.string(), text: z.string() })),
  check: z.object({ expression: z.string(), expected: z.number(), angle: z.enum(['rad', 'deg']) }).nullable(),
  uncertainty: z.array(z.string()).describe('Alertas de incerteza (leitura da imagem, ambiguidades); vazio se nenhum'),
  notes: z.string(),
});
export type ModelSolution = z.infer<typeof ModelSolution>;

export const JSON_SCHEMA_FOR_CLI = {
  type: 'object', additionalProperties: false,
  required: ['answer', 'original_expression', 'given', 'formulas', 'steps', 'check', 'uncertainty', 'notes'],
  properties: {
    answer: { type: 'string' }, original_expression: { type: 'string' },
    given: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: { type: 'string' }, value: { type: 'string' } } } },
    formulas: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'math', 'text'], properties: { title: { type: 'string' }, math: { type: 'string' }, text: { type: 'string' } } } },
    check: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['expression', 'expected', 'angle'], properties: { expression: { type: 'string' }, expected: { type: 'number' }, angle: { type: 'string', enum: ['rad', 'deg'] } } }] },
    uncertainty: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
} as const;

export const Verification = z.object({ state: z.enum(['match', 'mismatch', 'none', 'error']), detail: z.string().max(200) });

export const DeviceResponse = z.object({
  version: z.literal(1),
  protocol: z.literal('mt1'),
  request_id: z.string(),
  response_id: z.string(),
  provider: z.string(),
  model: z.string(),
  kind: z.enum(['text', 'image', 'manual']),
  mode: z.enum(MODES),
  status: z.enum(['ok', 'refused', 'error']),
  answer: z.string().max(LIMITS.answer),
  original_expression: z.string().max(LIMITS.field),
  given: z.array(z.object({ name: z.string().max(100), value: z.string().max(200) })).max(LIMITS.given),
  formulas: z.array(z.string().max(300)).max(LIMITS.formulas),
  steps: z.array(z.object({ title: z.string().max(200), math: z.string().max(LIMITS.field), text: z.string().max(LIMITS.field) })),
  check: z.object({ expression: z.string().max(LIMITS.checkExpr), expected: z.number(), angle: z.enum(['rad', 'deg']) }).nullable(),
  verification: Verification,
  uncertainty: z.array(z.string().max(300)).max(10),
  notes: z.string().max(LIMITS.notes),
  truncated: z.boolean(),
  page: z.object({ index: z.number().int(), count: z.number().int(), steps_total: z.number().int() }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type DeviceResponse = z.infer<typeof DeviceResponse>;

const CHECK_ALLOWED = /^[0-9+\-*/^().,\sA-Za-z_]+$/;
const CHECK_FUNCS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sqrt', 'cbrt', 'root', 'ln', 'log', 'log2', 'exp', 'abs', 'pi', 'e', 'E', 'nCr', 'nPr', 'floor', 'ceil', 'round']);

export function sanitizeCheck(c: ModelSolution['check']): DeviceResponse['check'] {
  if (!c || !Number.isFinite(c.expected)) return null;
  const e = c.expression.trim();
  if (!e || e.length > LIMITS.checkExpr || !CHECK_ALLOWED.test(e)) return null;
  if ((e.match(/[A-Za-z_]+/g) ?? []).some(w => !CHECK_FUNCS.has(w))) return null;
  return { expression: e, expected: c.expected, angle: c.angle };
}

function cut(s: string, max: number, flag: { t: boolean }): string {
  if (s.length <= max) return s;
  flag.t = true;
  return s.slice(0, max - 1) + '…';
}

export interface FullResult {
  base: Omit<DeviceResponse, 'steps' | 'page'>;
  steps: DeviceResponse['steps'];
}

/** Normalise a provider solution (never fails; marks truncated when cutting). */
export function normalise(meta: { requestId: string; responseId: string; provider: string; model: string; kind: DeviceResponse['kind']; mode: Mode },
  sol: ModelSolution, verification: DeviceResponse['verification']): FullResult {
  const f = { t: false };
  if (sol.steps.length > LIMITS.steps || sol.given.length > LIMITS.given || sol.formulas.length > LIMITS.formulas) f.t = true;
  const steps = sol.steps.slice(0, LIMITS.steps).map(s => ({ title: cut(s.title, 200, f), math: cut(s.math, LIMITS.field, f), text: cut(s.text, LIMITS.field, f) }));
  return {
    steps,
    base: {
      version: 1, protocol: 'mt1', request_id: meta.requestId, response_id: meta.responseId, provider: meta.provider, model: meta.model,
      kind: meta.kind, mode: meta.mode, status: 'ok',
      answer: cut(sol.answer, LIMITS.answer, f), original_expression: cut(sol.original_expression ?? '', LIMITS.field, f),
      given: sol.given.slice(0, LIMITS.given).map(g => ({ name: cut(g.name, 100, f), value: cut(g.value, 200, f) })),
      formulas: sol.formulas.slice(0, LIMITS.formulas).map(x => cut(x, 300, f)),
      check: sanitizeCheck(sol.check), verification,
      uncertainty: (sol.uncertainty ?? []).slice(0, 10).map(u => cut(u, 300, f)),
      notes: cut(sol.notes, LIMITS.notes, f), truncated: f.t, error: null,
    },
  };
}

export function page(full: FullResult, index: number, perPage: number): DeviceResponse {
  const count = Math.max(1, Math.ceil(full.steps.length / perPage));
  const i = Math.min(Math.max(0, index), count - 1);
  return DeviceResponse.parse({ ...full.base, steps: full.steps.slice(i * perPage, (i + 1) * perPage), page: { index: i, count, steps_total: full.steps.length } });
}

export function statusResponse(meta: { requestId: string; provider: string; mode: Mode; kind: DeviceResponse['kind'] }, status: 'refused' | 'error', code: string, message: string): DeviceResponse {
  return {
    version: 1, protocol: 'mt1', request_id: meta.requestId, response_id: meta.requestId, provider: meta.provider, model: '', kind: meta.kind, mode: meta.mode, status,
    answer: '', original_expression: '', given: [], formulas: [], steps: [], check: null, verification: { state: 'none', detail: '' }, uncertainty: [],
    notes: message, truncated: false, page: { index: 0, count: 1, steps_total: 0 }, error: { code, message },
  };
}
