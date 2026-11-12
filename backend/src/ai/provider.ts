import type { Mode, ModelSolution } from '../schema.ts';

export interface SolveInput {
  requestId: string;
  mode: Mode;
  question?: string;
  image?: { data: Uint8Array; mediaType: 'image/jpeg' };
  prompt?: string;
}

export type SolveResult =
  | { kind: 'ok'; solution: ModelSolution; model: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; status: number; error: string; retryable: boolean };

export interface AiProvider {
  readonly name: string;
  solve(input: SolveInput, signal: AbortSignal): Promise<SolveResult>;
}

const MODE_RULES: Record<Mode, string> = {
  fast: 'MODO RAPIDO: de apenas o resultado final e no maximo 1 etapa essencial.',
  short: 'MODO CURTO: resultado e um resumo dos passos essenciais (ate 6 etapas).',
  full: 'MODO COMPLETO: desenvolvimento detalhado: dados, formulas, substituicoes, transformacoes intermediarias, verificacao e resultado. Nao omita etapas.',
};

export function systemPrompt(mode: Mode): string {
  return [
    'Voce e o motor de explicacao de um terminal matematico com visor de 128x32 pixels.',
    'Responda sempre em portugues do Brasil, de forma objetiva.',
    'Escreva expressoes em texto ASCII linear (ex.: x = (-b + sqrt(b^2 - 4*a*c)) / (2*a)), sem LaTeX e sem markdown.',
    'Preencha "given" com os dados/variaveis identificados, "formulas" com as formulas usadas e "steps" na ordem da resolucao.',
    'Em "check", quando houver resultado numerico, forneca uma expressao aritmetica pura (apenas numeros, + - * / ^ ( ), sqrt, ln, log, sin, cos, tan, pi, e) cujo valor deve ser igual a "expected"; caso contrario use null.',
    'O dispositivo recalcula "check" localmente; nunca invente uma verificacao.',
    'Se a pergunta ou imagem nao tiver conteudo matematico ou de estudo, explique isso em "answer" e deixe "steps" vazio.',
    MODE_RULES[mode],
  ].join('\n');
}
