/*
 * AI response contract (version 1) – device side.
 *  - validate(): strict structural validation with size limits; never trusts the server
 *  - verify(): recomputes check.expression with the deterministic engine
 *  - toDoc(): converts to reader blocks according to the response mode,
 *    clearly separating [IA] content from [LOCAL] verification.
 * The same contract is enforced by backend/src/schema.ts and
 * firmware/components/ai_client (ai_response.c).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mathEngine.js'));
  else { root.MT = root.MT || {}; root.MT.AiResponse = factory(root.MT.MathEngine); }
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  const LIMITS = { answer: 1000, field: 2000, steps: 80, given: 30, formulas: 20, notes: 2000, totalChars: 60000 };
  const MODES = ['fast', 'short', 'full'];
  const MODE_LABEL = { fast: 'Rapido', short: 'Curto', full: 'Completo' };

  function str(v, max, name, errors, required) {
    if (v == null) { if (required) errors.push(name + ' ausente'); return ''; }
    if (typeof v !== 'string') { errors.push(name + ' nao e texto'); return ''; }
    if (v.length > max) { errors.push(name + ' longo demais'); return v.slice(0, max); }
    return v;
  }

  /** Returns { ok, value, errors, partial } */
  function validate(obj) {
    const errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['resposta nao e objeto'] };
    if (obj.version !== 1) errors.push('versao incompativel');
    const status = obj.status;
    if (!['ok', 'refused', 'error'].includes(status)) errors.push('status invalido');
    const mode = MODES.includes(obj.mode) ? obj.mode : 'short';
    const out = {
      version: 1, request_id: str(obj.request_id, 64, 'request_id', errors, false), mode, status: status || 'error',
      answer: str(obj.answer, LIMITS.answer, 'answer', errors, status === 'ok'),
      given: [], formulas: [], steps: [], check: null,
      notes: str(obj.notes, LIMITS.notes, 'notes', errors, false),
      truncated: obj.truncated === true
    };
    if (Array.isArray(obj.given)) {
      if (obj.given.length > LIMITS.given) { errors.push('given excede limite'); out.truncated = true; }
      out.given = obj.given.slice(0, LIMITS.given).filter(g => g && typeof g === 'object')
        .map(g => ({ name: str(g.name, 100, 'given.name', errors), value: str(g.value, 200, 'given.value', errors) }));
    }
    if (Array.isArray(obj.formulas)) {
      if (obj.formulas.length > LIMITS.formulas) { errors.push('formulas excede limite'); out.truncated = true; }
      out.formulas = obj.formulas.slice(0, LIMITS.formulas).map(f => str(f, 300, 'formula', errors));
    }
    if (Array.isArray(obj.steps)) {
      if (obj.steps.length > LIMITS.steps) { errors.push('steps excede limite'); out.truncated = true; }
      out.steps = obj.steps.slice(0, LIMITS.steps).filter(s => s && typeof s === 'object').map(s => ({
        title: str(s.title, 200, 'step.title', errors), math: str(s.math, LIMITS.field, 'step.math', errors), text: str(s.text, LIMITS.field, 'step.text', errors)
      }));
    }
    // protocol mt1 extras (optional; shown when present)
    out.provider = str(obj.provider, 40, 'provider', errors, false);
    out.model = str(obj.model, 80, 'model', errors, false);
    out.original_expression = str(obj.original_expression, LIMITS.field, 'original_expression', errors, false);
    out.uncertainty = Array.isArray(obj.uncertainty) ? obj.uncertainty.slice(0, 10).map(u => str(u, 300, 'uncertainty', errors)) : [];
    if (obj.verification && typeof obj.verification === 'object' && ['match', 'mismatch', 'none', 'error'].includes(obj.verification.state)) {
      out.serverVerification = { state: obj.verification.state, detail: str(obj.verification.detail, 200, 'verification', errors) };
    }
    if (obj.error && typeof obj.error === 'object') out.error = { code: str(obj.error.code, 40, 'error.code', errors), message: str(obj.error.message, 300, 'error.message', errors) };
    if (obj.check && typeof obj.check === 'object') {
      const e = str(obj.check.expression, 256, 'check.expression', errors);
      const x = obj.check.expected;
      const angle = obj.check.angle === 'deg' ? 'deg' : 'rad';
      if (e && typeof x === 'number' && isFinite(x)) out.check = { expression: e, expected: x, angle };
    }
    const size = JSON.stringify(out).length;
    if (size > LIMITS.totalChars) { errors.push('resposta excede limite total'); return { ok: false, errors }; }
    // structural errors (missing/invalid status, version) are fatal; length overflows are kept as partial
    const fatal = errors.some(e => /versao|status|nao e objeto|ausente|nao e texto/.test(e));
    return { ok: !fatal, value: out, errors, partial: errors.length > 0 };
  }

  function verify(resp) {
    if (!resp.check) return { state: 'none', text: 'Sem verificacao local disponivel' };
    const r = M.calculate(resp.check.expression, { angle: resp.check.angle });
    if (!r.ok) return { state: 'error', text: 'Verificacao local falhou: ' + r.message };
    const exp = resp.check.expected;
    const tol = 1e-9 * Math.max(1, Math.abs(exp), Math.abs(r.value));
    if (Math.abs(r.value - exp) <= tol || r.text === M.formatNumber(exp)) return { state: 'match', value: r.value, text: 'Confere: ' + resp.check.expression + ' = ' + r.text };
    return { state: 'mismatch', value: r.value, text: 'DIVERGENCIA: local ' + r.text + ' != IA ' + M.formatNumber(exp) };
  }

  function toDoc(resp, mode, verification, meta = {}) {
    const m = MODES.includes(mode) ? mode : resp.mode;
    const B = [];
    const title = (t) => B.push({ kind: 'title', text: t });
    const text = (t) => { if (t) B.push({ kind: 'text', text: t }); };
    const math = (t, rule) => { if (t) B.push({ kind: 'math', text: t, rule }); };
    if (meta.question) { title('Pergunta'); text(meta.question); }
    const ERR_TEXT = { billing: 'Sem creditos ou faturamento pendente no provedor.', auth: 'Provedor nao autenticado ou credencial revogada.', rate_limit: 'Limite de uso do provedor atingido.',
      unavailable: 'Provedor indisponivel.', timeout: 'Tempo esgotado no provedor.', provider_unavailable: 'Provedor nao configurado no servidor.' };
    if (resp.status === 'refused') { title('[IA] Recusado'); text(resp.notes || 'O servico recusou a solicitacao.'); return B; }
    if (resp.status === 'error') { title('[IA] Erro'); text((resp.error && ERR_TEXT[resp.error.code]) || resp.notes || 'Erro no servico.'); return B; }
    title('[IA] Resultado (' + MODE_LABEL[m] + ')');
    if (resp.provider) text('Fonte: ' + resp.provider + (resp.model ? ' / ' + resp.model : ''));
    math(resp.answer);
    if (m !== 'fast' && resp.original_expression) { text('Enunciado:'); math(resp.original_expression); }
    if (m !== 'fast') {
      if (m === 'full' && resp.given.length) { title('Dados'); resp.given.forEach(g => math(g.name + ' = ' + g.value)); }
      if (m === 'full' && resp.formulas.length) { title('Formulas'); resp.formulas.forEach(f => math(f)); }
      const steps = m === 'short' ? resp.steps.slice(0, 6) : resp.steps;
      if (steps.length) {
        title('Etapas');
        steps.forEach((s, i) => {
          text((i + 1) + '. ' + (s.title || ''));
          math(s.math);
          if (m === 'full') text(s.text);
        });
        if (m === 'short' && resp.steps.length > steps.length) text('(' + (resp.steps.length - steps.length) + ' etapas a mais no modo Completo)');
      }
      if (m === 'full' && resp.notes) { title('Observacoes'); text(resp.notes); }
    }
    if (resp.uncertainty && resp.uncertainty.length) { title('[IA] Incertezas'); resp.uncertainty.forEach(u => text('- ' + u)); }
    if (resp.serverVerification && resp.serverVerification.state !== 'none') { title('[SERVIDOR] Verificacao'); text(resp.serverVerification.detail); }
    title('[LOCAL] Verificacao');
    text(verification.text);
    if (resp.truncated) text('Aviso: resposta truncada por limite de tamanho.');
    return B;
  }

  return { validate, verify, toDoc, LIMITS, MODES, MODE_LABEL };
});
