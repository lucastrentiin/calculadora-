import { z } from 'zod';

export const MODES = ['fast', 'short', 'full'] as const;
export type Mode = (typeof MODES)[number];

export const LIMITS = {
  answer: 1000,
  field: 2000,
  steps: 80,
  given: 30,
  formulas: 20,
  notes: 2000,
  question: 4000,
  checkExpr: 256,
} as const;

/** Body of POST /v1/ask */
export const AskRequest = z.object({
  request_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  question: z.string().min(1).max(LIMITS.question),
  mode: z.enum(MODES),
}).strict();
export type AskRequest = z.infer<typeof AskRequest>;

/**
 * Structured output requested from the model. Kept simple so it is supported by
 * structured outputs (no length constraints here: limits are enforced afterwards).
 */
export const ModelSolution = z.object({
  answer: z.string().describe('Resposta final curta, em portugues'),
  given: z.array(z.object({ name: z.string(), value: z.string() })).describe('Dados e variaveis identificados'),
  formulas: z.array(z.string()).describe('Formulas utilizadas'),
  steps: z.array(z.object({
    title: z.string(),
    math: z.string().describe('Expressao matematica da etapa em texto ASCII linear'),
    text: z.string().describe('Explicacao da etapa'),
  })),
  check: z.object({
    expression: z.string().describe('Expressao aritmetica pura cujo valor deve ser igual a expected'),
    expected: z.number(),
    angle: z.enum(['rad', 'deg']),
  }).nullable().describe('Verificacao numerica deterministica, ou null se nao houver valor numerico'),
  notes: z.string(),
});
export type ModelSolution = z.infer<typeof ModelSolution>;

/** Contract v1 returned to the device (mirrors simulator/js/core/aiResponse.js). */
export const DeviceResponse = z.object({
  version: z.literal(1),
  request_id: z.string(),
  mode: z.enum(MODES),
  status: z.enum(['ok', 'refused', 'error']),
  answer: z.string().max(LIMITS.answer),
  given: z.array(z.object({ name: z.string().max(100), value: z.string().max(200) })).max(LIMITS.given),
  formulas: z.array(z.string().max(300)).max(LIMITS.formulas),
  steps: z.array(z.object({ title: z.string().max(200), math: z.string().max(LIMITS.field), text: z.string().max(LIMITS.field) })).max(LIMITS.steps),
  check: z.object({ expression: z.string().max(LIMITS.checkExpr), expected: z.number(), angle: z.enum(['rad', 'deg']) }).nullable(),
  notes: z.string().max(LIMITS.notes),
  truncated: z.boolean(),
});
export type DeviceResponse = z.infer<typeof DeviceResponse>;

const CHECK_ALLOWED = /^[0-9+\-*/^().,\sA-Za-z_]+$/;
const CHECK_FUNCS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sqrt', 'cbrt', 'root', 'ln', 'log', 'log2', 'exp', 'abs', 'pi', 'e', 'E', 'nCr', 'nPr', 'floor', 'ceil', 'round']);

/** Only expressions the device engine understands are forwarded as checks. */
export function sanitizeCheck(c: ModelSolution['check']): DeviceResponse['check'] {
  if (!c || !Number.isFinite(c.expected)) return null;
  const e = c.expression.trim();
  if (!e || e.length > LIMITS.checkExpr || !CHECK_ALLOWED.test(e)) return null;
  const words = e.match(/[A-Za-z_]+/g) ?? [];
  if (words.some(w => !CHECK_FUNCS.has(w))) return null;
  return { expression: e, expected: c.expected, angle: c.angle };
}

function cut(s: string, max: number, flag: { t: boolean }): string {
  if (s.length <= max) return s;
  flag.t = true;
  return s.slice(0, max - 1) + '…';
}

/** Apply device limits; never fails, marks `truncated` when something was cut. */
export function toDeviceResponse(requestId: string, mode: Mode, sol: ModelSolution): DeviceResponse {
  const f = { t: false };
  const steps = sol.steps.slice(0, LIMITS.steps);
  if (sol.steps.length > LIMITS.steps) f.t = true;
  const out: DeviceResponse = {
    version: 1,
    request_id: requestId,
    mode,
    status: 'ok',
    answer: cut(sol.answer, LIMITS.answer, f),
    given: sol.given.slice(0, LIMITS.given).map(g => ({ name: cut(g.name, 100, f), value: cut(g.value, 200, f) })),
    formulas: sol.formulas.slice(0, LIMITS.formulas).map(x => cut(x, 300, f)),
    steps: steps.map(s => ({ title: cut(s.title, 200, f), math: cut(s.math, LIMITS.field, f), text: cut(s.text, LIMITS.field, f) })),
    check: sanitizeCheck(sol.check),
    notes: cut(sol.notes, LIMITS.notes, f),
    truncated: false,
  };
  if (sol.given.length > LIMITS.given || sol.formulas.length > LIMITS.formulas) f.t = true;
  out.truncated = f.t;
  return DeviceResponse.parse(out);
}

export function statusResponse(requestId: string, mode: Mode, status: 'refused' | 'error', notes: string): DeviceResponse {
  return { version: 1, request_id: requestId, mode, status, answer: '', given: [], formulas: [], steps: [], check: null, notes, truncated: false };
}
