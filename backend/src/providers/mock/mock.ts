/**
 * MockProvider: always available, no network, no credentials. Uses the
 * deterministic engine to produce real step-by-step answers for arithmetic
 * and quadratic equations; everything is labelled as demonstration.
 */
import { MathEngine } from '../../requests/verify.ts';
import type { ModelSolution } from '../../requests/schema.ts';
import { BaseProvider } from '../base.ts';
import type { TaskInput, TaskOutcome } from '../types.ts';

export class MockProvider extends BaseProvider {
  readonly id = 'mock';
  readonly name = 'Demonstracao (local)';
  delayMs: number;
  constructor(delayMs = 300) {
    super();
    this.delayMs = delayMs;
    this.state = { ...this.state, status: 'ready', statusDetail: 'Sempre disponivel (sem IA real)', billing: 'none', auth: { state: 'n/a', method: 'nenhuma' },
      models: ['mock-math'], model: 'mock-math', notes: ['Respostas de demonstracao geradas pelo motor matematico local.'] };
    this.caps({ supportsText: true, supportsImages: true, supportsStructuredOutput: true, supportsCancel: true });
  }
  async refresh(): Promise<void> { /* nothing to probe */ }

  private wait(signal: AbortSignal): Promise<boolean> {
    return new Promise((res) => {
      const t = setTimeout(() => res(true), this.delayMs);
      signal.addEventListener('abort', () => { clearTimeout(t); res(false); }, { once: true });
    });
  }

  static solve(q: string): ModelSolution {
    const sol: ModelSolution = { answer: '', original_expression: q.slice(0, 200), given: [], formulas: [], steps: [], check: null, uncertainty: ['Resposta de demonstracao (MockProvider).'], notes: 'Modo demonstracao: sem IA real.' };
    const compact = q.replace(/\s/g, '');
    const quad = compact.match(/([+-]?\d*\.?\d*)x\^2([+-]\d*\.?\d*)x([+-]\d+\.?\d*)=0/);
    if (quad) {
      const n = (s: string) => (s === '' || s === '+' ? 1 : s === '-' ? -1 : Number(s));
      const a = n(quad[1]), b = n(quad[2]), c = Number(quad[3]);
      const d = b * b - 4 * a * c;
      sol.given = [{ name: 'a', value: String(a) }, { name: 'b', value: String(b) }, { name: 'c', value: String(c) }];
      sol.formulas = ['D = b^2 - 4ac', 'x = (-b +- sqrt(D)) / (2a)'];
      sol.steps.push({ title: 'Discriminante', math: `D = (${b})^2 - 4*(${a})*(${c}) = ${MathEngine.formatNumber(d)}`, text: 'O sinal de D define as raizes reais.' });
      if (d >= 0) {
        const x1 = (-b - Math.sqrt(d)) / (2 * a), x2 = (-b + Math.sqrt(d)) / (2 * a);
        sol.steps.push({ title: 'Bhaskara', math: `x = (${-b} +- sqrt(${MathEngine.formatNumber(d)}))/${2 * a}`, text: 'Substituicao direta.' });
        sol.answer = `x1 = ${MathEngine.formatNumber(Math.min(x1, x2))}, x2 = ${MathEngine.formatNumber(Math.max(x1, x2))}`;
        sol.check = { expression: `${a}*(${MathEngine.formatNumber(x1)})^2+(${b})*(${MathEngine.formatNumber(x1)})+(${c})`, expected: 0, angle: 'rad' };
      } else sol.answer = 'Sem raizes reais (D < 0)';
      return sol;
    }
    const m = q.match(/[-+*/^().\d\s]*\d[-+*/^().\d\s]*/);
    if (m) {
      const expr = m[0].trim();
      try {
        const s = MathEngine.solveSteps(expr, { angle: 'rad' });
        sol.original_expression = expr;
        sol.steps = s.steps.slice(1).map(st => ({ title: st.rule, math: st.expr, text: '' }));
        sol.answer = `${expr} = ${MathEngine.formatNumber(s.value)}`;
        sol.check = { expression: expr, expected: s.value, angle: 'rad' };
        return sol;
      } catch { /* fall through */ }
    }
    sol.answer = 'Demonstracao: pergunta recebida (' + q.length + ' caracteres).';
    sol.steps = [{ title: 'Demonstracao', math: '', text: 'Configure um provedor real no painel para respostas de IA.' }];
    return sol;
  }

  async executeText(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> {
    if (!(await this.wait(signal))) return { kind: 'error', code: 'cancelled', message: 'cancelado', retryable: false };
    return { kind: 'ok', solution: MockProvider.solve(input.question ?? ''), model: 'mock-math' };
  }
  override async executeImage(input: TaskInput, signal: AbortSignal): Promise<TaskOutcome> {
    if (!(await this.wait(signal))) return { kind: 'error', code: 'cancelled', message: 'cancelado', retryable: false };
    const s = MockProvider.solve('2x^2-5x+3=0');
    s.uncertainty.push(`Imagem de ${input.image?.bytes.length ?? 0} bytes recebida; o Mock nao le imagens e usa um exemplo fixo.`);
    return { kind: 'ok', solution: s, model: 'mock-math' };
  }
}
