/** Deterministic provider for tests and offline development (AI_PROVIDER=mock). */
import type { AiProvider, SolveInput, SolveResult } from './provider.ts';

export class MockProvider implements AiProvider {
  readonly name = 'mock';
  delayMs: number;
  next: ((input: SolveInput) => SolveResult) | null = null;
  calls: SolveInput[] = [];
  constructor(delayMs = 0) { this.delayMs = delayMs; }

  solve(input: SolveInput, signal: AbortSignal): Promise<SolveResult> {
    this.calls.push(input);
    return new Promise((resolve) => {
      const done = () => {
        if (this.next) { resolve(this.next(input)); return; }
        resolve({
          kind: 'ok', model: 'mock',
          solution: {
            answer: input.image ? 'Imagem recebida (' + input.image.data.length + ' bytes)' : 'Resposta simulada',
            given: [], formulas: [],
            steps: [{ title: 'Simulacao', math: '1+1 = 2', text: 'Provedor mock.' }],
            check: { expression: '1+1', expected: 2, angle: 'rad' },
            notes: 'mock',
          },
        });
      };
      const t = setTimeout(done, this.delayMs);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve({ kind: 'error', status: 499, error: 'cancelado', retryable: false }); }, { once: true });
    });
  }
}
