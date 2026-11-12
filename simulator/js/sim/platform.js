/*
 * SIMULATED platform services for the browser simulator and Node tests.
 * Everything in this file is a stand-in for hardware/network behaviour:
 *   storage   -> localStorage / memory   (hardware: NVS with encryption)
 *   crypto    -> WebCrypto               (hardware: mbedTLS/PSA + HW accel)
 *   ai        -> MockAI (simulated) or HttpAI (real backend over HTTPS)
 *   camera    -> canvas/webcam JPEG      (hardware: esp32-camera OV3660)
 *   wifi, battery, power, ota, preview -> state machines driven by the sim panel
 * Nothing here is a security guarantee; see docs/SECURITY.md.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../core/mathEngine.js'), require('../core/solvers.js'));
  else { root.MT = root.MT || {}; root.MT.SimPlatform = factory(root.MT.MathEngine, root.MT.Solvers); }
})(typeof self !== 'undefined' ? self : this, function (M, Solvers) {
  'use strict';

  const subtle = () => globalThis.crypto.subtle;

  /* ------------------------------ storage ------------------------------ */
  class MemoryStorage {
    constructor() { this.m = new Map(); }
    get(k) { return this.m.has(k) ? this.m.get(k) : null; }
    set(k, v) { this.m.set(k, String(v)); }
    remove(k) { this.m.delete(k); }
    keys() { return Array.from(this.m.keys()); }
  }
  class LocalStorage {
    constructor(prefix = 'mt.') { this.prefix = prefix; this.fallback = new MemoryStorage(); }
    get(k) { try { return localStorage.getItem(this.prefix + k); } catch (e) { return this.fallback.get(k); } }
    set(k, v) { try { localStorage.setItem(this.prefix + k, v); } catch (e) { this.fallback.set(k, v); } }
    remove(k) { try { localStorage.removeItem(this.prefix + k); } catch (e) { this.fallback.remove(k); } }
    clearAll() { try { Object.keys(localStorage).filter(k => k.startsWith(this.prefix)).forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ } }
  }

  /* ------------------------------ crypto ------------------------------- */
  const webCrypto = {
    randomBytes(n) { const u = new Uint8Array(n); globalThis.crypto.getRandomValues(u); return u; },
    async pbkdf2(pin, salt, iterations, len) {
      const key = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, len * 8);
      return new Uint8Array(bits);
    },
    async sha256(bytes) { return new Uint8Array(await subtle().digest('SHA-256', bytes)); },
    async aesGcmEncrypt(keyBytes, iv, pt) {
      const k = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
      return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, k, pt));
    },
    async aesGcmDecrypt(keyBytes, iv, ct) {
      const k = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
      return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, k, ct));
    },
    async hmacSha256(keyBytes, data) {
      const k = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await subtle().sign('HMAC', k, data));
    },
    uuid() { return globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : Array.from(this.randomBytes(16), b => b.toString(16).padStart(2, '0')).join(''); }
  };
  const hex = (u8) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

  /* ------------------------------ AI: simulated ------------------------ */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal && signal.addEventListener) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelado')); }, { once: true });
    });
  }

  /** Builds a contract-v1 response from the local engine (marked as simulation). */
  function simulatedAnswer(payload) {
    const mode = payload.mode || 'short';
    const base = { version: 1, request_id: payload.requestId, mode, status: 'ok', given: [], formulas: [], steps: [], check: null, notes: 'RESPOSTA SIMULADA (sem IA real).', truncated: false };
    const q = payload.kind === 'image' ? '2x^2-5x+3=0' : String(payload.question || '');
    const quad = q.replace(/\s/g, '').match(/^([+-]?\d*\.?\d*)x\^2([+-]\d*\.?\d*)x([+-]\d+\.?\d*)=0$/);
    if (quad) {
      const n = (s) => (s === '' || s === '+' ? 1 : s === '-' ? -1 : Number(s));
      const a = n(quad[1]), b = n(quad[2]), c = Number(quad[3]);
      const r = Solvers.quadratic(a, b, c);
      base.answer = r.roots.length ? 'x = ' + r.roots.map(M.formatNumber).join(' ou x = ') : 'Sem raizes reais';
      base.given = [{ name: 'a', value: String(a) }, { name: 'b', value: String(b) }, { name: 'c', value: String(c) }];
      base.formulas = ['D = b^2 - 4ac', 'x = (-b +- sqrt(D)) / (2a)'];
      base.steps = [
        { title: 'Identificar coeficientes', math: `a=${a}, b=${b}, c=${c}`, text: 'Comparando com ax^2+bx+c=0.' },
        { title: 'Discriminante', math: `D = (${b})^2 - 4*(${a})*(${c}) = ${M.formatNumber(r.d)}`, text: 'O sinal de D define o numero de raizes reais.' },
        { title: 'Aplicar Bhaskara', math: `x = (${-b} +- sqrt(${M.formatNumber(r.d)})) / ${2 * a}`, text: 'Substituicao direta.' },
        ...r.roots.map((x, i) => ({ title: 'Raiz ' + (i + 1), math: 'x' + (i + 1) + ' = ' + M.formatNumber(x), text: '' }))
      ];
      if (r.roots.length) base.check = { expression: `${a}*(${M.formatNumber(r.roots[0])})^2+(${b})*(${M.formatNumber(r.roots[0])})+(${c})`, expected: 0, angle: 'rad' };
      return base;
    }
    const exprMatch = q.match(/[-+*/^().\d\s a-z]*\d[-+*/^().\d\s a-z]*/i);
    if (exprMatch) {
      const expr = exprMatch[0].trim().replace(/^[a-z ]+/i, '').replace(/[a-z ]+$/i, '');
      try {
        const sol = M.solveSteps(expr, { angle: 'rad' });
        base.answer = expr + ' = ' + M.formatNumber(sol.value);
        base.steps = sol.steps.slice(1).map(s => ({ title: s.rule, math: s.expr, text: 'Etapa calculada pelo motor local (simulacao).' }));
        base.check = { expression: expr, expected: sol.value, angle: 'rad' };
        return base;
      } catch (e) { /* fall through */ }
    }
    base.answer = 'Explicacao simulada para: ' + q.slice(0, 60);
    base.steps = Array.from({ length: 12 }, (_, i) => ({ title: 'Paragrafo ' + (i + 1), math: '', text: 'Este e um texto longo simulado para testar a quebra automatica de linhas e a rolagem vertical do visor de 128x32 pixels sem perder conteudo. ' + 'Bloco ' + (i + 1) + '.' }));
    return base;
  }

  class MockAI {
    constructor(opts = {}) { this.latencyMs = opts.latencyMs != null ? opts.latencyMs : 1200; this.failMode = opts.failMode || 'none'; this.server = new Map(); this.name = 'IA simulada'; }
    async ask(payload, { signal, onPhase } = {}) {
      const ph = (p) => onPhase && onPhase(p);
      ph('conectando');
      await sleep(this.latencyMs * 0.2, signal);
      if (this.failMode === 'offline') throw new Error('Servidor inacessivel (simulado)');
      ph('enviando');
      await sleep(this.latencyMs * 0.2, signal);
      ph('enviado');
      this.server.set(payload.requestId, 'processing');
      ph('aguardando');
      await sleep(this.latencyMs * 0.6, signal);
      if (this.server.get(payload.requestId) === 'cancelled') throw new Error('cancelado no servidor');
      this.server.set(payload.requestId, 'done');
      switch (this.failMode) {
        case 'timeout': throw new Error('Tempo esgotado (simulado)');
        case 'http500': throw new Error('Erro 503 do servidor (simulado)');
        case 'invalid': return { version: 1, status: 'ok' }; // missing fields
        case 'garbage': return 'not json';
        case 'refused': return { version: 1, request_id: payload.requestId, mode: payload.mode, status: 'refused', answer: '', notes: 'Solicitacao recusada (simulado).' };
        case 'huge': { const r = simulatedAnswer(payload); r.steps = Array.from({ length: 500 }, (_, i) => ({ title: 'Etapa ' + i, math: 'x'.repeat(3000), text: 'y'.repeat(3000) })); return r; }
        case 'mismatch': { const r = simulatedAnswer(payload); if (r.check) r.check.expected += 1; return r; }
        default: return simulatedAnswer(payload);
      }
    }
    async cancelRemote(id) {
      await sleep(50);
      const st = this.server.get(id);
      if (st === 'processing') { this.server.set(id, 'cancelled'); return { status: 'cancelado no servidor' }; }
      if (st === 'done') return { status: 'ja concluido no servidor' };
      return { status: 'desconhecido no servidor' };
    }
  }

  /* ------------------------------ AI: real backend -------------------- */
  class HttpAI {
    constructor({ baseUrl, deviceId, deviceKeyB64, timeoutMs = 60000 }) {
      this.baseUrl = baseUrl.replace(/\/$/, ''); this.deviceId = deviceId; this.timeoutMs = timeoutMs; this.name = 'Backend real';
      const raw = atob(deviceKeyB64); this.key = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) this.key[i] = raw.charCodeAt(i);
    }
    async headers(method, path, body) {
      const ts = Math.floor(Date.now() / 1000).toString();
      const nonce = hex(webCrypto.randomBytes(12));
      const bodyHash = hex(await webCrypto.sha256(body));
      const msg = new TextEncoder().encode([method, path, ts, nonce, bodyHash].join('\n'));
      const sig = hex(await webCrypto.hmacSha256(this.key, msg));
      return { 'X-Device-Id': this.deviceId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig };
    }
    async ask(payload, { signal, onPhase } = {}) {
      const ph = (p) => onPhase && onPhase(p);
      let path, body, ctype;
      if (payload.kind === 'image') {
        path = '/v1/image'; body = payload.image; ctype = 'image/jpeg';
      } else {
        path = '/v1/ask'; body = new TextEncoder().encode(JSON.stringify({ request_id: payload.requestId, question: payload.question, mode: payload.mode })); ctype = 'application/json';
      }
      const h = await this.headers('POST', path, body);
      h['Content-Type'] = ctype;
      if (payload.kind === 'image') { h['X-Request-Id'] = payload.requestId; h['X-Mode'] = payload.mode; h['X-Prompt'] = btoa(unescape(encodeURIComponent(payload.prompt || ''))); }
      ph('enviando');
      const t = setTimeout(() => ph('aguardando'), 300);
      try {
        const res = await fetch(this.baseUrl + path, { method: 'POST', headers: h, body, signal });
        ph('enviado');
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error('HTTP ' + res.status + (json && json.error ? ': ' + json.error : ''));
        return json;
      } finally { clearTimeout(t); }
    }
    async cancelRemote(id) {
      const path = '/v1/requests/' + encodeURIComponent(id) + '/cancel';
      const body = new Uint8Array(0);
      const res = await fetch(this.baseUrl + path, { method: 'POST', headers: await this.headers('POST', path, body), body });
      const j = await res.json().catch(() => ({}));
      return { status: j.status || ('HTTP ' + res.status) };
    }
  }

  /* ------------------------------ camera ------------------------------ */
  const RES = { QVGA: [320, 240], VGA: [640, 480], SVGA: [800, 600], XGA: [1024, 768], UXGA: [1600, 1200], QXGA: [2048, 1536] };
  class SimCamera {
    constructor(opts = {}) { this.active = false; this.failInit = false; this.failCapture = false; this.makeJpeg = opts.makeJpeg || null; this.lastDiag = 'nao iniciada'; }
    isActive() { return this.active; }
    async init(cfg) {
      await sleep(150);
      if (this.failInit) { this.lastDiag = 'falha init (simulada)'; throw new Error('sensor nao detectado'); }
      this.active = true; this.cfg = cfg; this.lastDiag = 'OV3660 simulado ' + cfg.resolution;
      return { sensor: 'OV3660 (simulado)', pid: 0x3660 };
    }
    async capture(cfg) {
      if (!this.active) throw new Error('camera desligada');
      await sleep(120);
      if (this.failCapture) throw new Error('falha de captura (simulada)');
      const [w, h] = RES[cfg.resolution] || RES.SVGA;
      let data;
      if (this.makeJpeg) data = await this.makeJpeg(w, h, cfg.quality);
      else { data = new Uint8Array(2048 + w); data[0] = 0xFF; data[1] = 0xD8; data[2] = 0xFF; data[data.length - 2] = 0xFF; data[data.length - 1] = 0xD9; }
      return { data, width: w, height: h, format: 'jpeg' };
    }
    deinit() { this.active = false; this.lastDiag = 'desligada'; }
    diag() { return { text: this.lastDiag }; }
  }

  /* ------------------------------ wifi/battery/power/ota -------------- */
  class SimWifi {
    constructor(storage) { this.storage = storage; this.connected = true; this.ssid = 'Hotspot-Sim'; this.rssi = -58; this.error = ''; this.failNext = false; }
    list() { try { return JSON.parse(this.storage.get('sim.wifi') || '[]'); } catch (e) { return []; } }
    save(l) { this.storage.set('sim.wifi', JSON.stringify(l)); }
    add(ssid, pass) { const l = this.list().filter(n => n.ssid !== ssid); l.push({ ssid, passLen: pass.length }); this.save(l); this.secrets = this.secrets || {}; this.secrets[ssid] = pass; }
    remove(ssid) { this.save(this.list().filter(n => n.ssid !== ssid)); if (this.secrets) delete this.secrets[ssid]; }
    connect(ssid) { if (this.failNext) { this.connected = false; this.error = 'falha de autenticacao'; return false; } this.connected = true; this.ssid = ssid || this.ssid; this.error = ''; return true; }
    disconnect() { this.connected = false; }
    status() { return { connected: this.connected, ssid: this.ssid, rssi: this.rssi, error: this.error }; }
  }
  class SimBattery {
    constructor() { this.supported = true; this.percent = 80; this.charging = false; }
    read() { return { supported: this.supported, percent: this.percent, charging: this.charging, low: this.percent <= 15, critical: this.percent <= 3 }; }
  }
  class SimOta {
    constructor() { this.current = '0.1.0'; this.available = null; this.failApply = false; }
    async check() { await sleep(300); return this.available ? { available: true, version: this.available, current: this.current } : { available: false, current: this.current }; }
    async apply(onProgress) {
      for (let p = 0; p <= 100; p += 20) { onProgress(p); await sleep(150); }
      if (this.failApply) return { ok: false, error: 'assinatura invalida (simulado)' };
      this.current = this.available; this.available = null;
      return { ok: true };
    }
  }
  class SimPreview {
    constructor() { this.session = null; this.listeners = []; }
    start({ onCapture }) {
      this.session = { code: hex(webCrypto.randomBytes(3)).toUpperCase(), onCapture, startedAt: Date.now() };
      this.listeners.forEach(f => f(this.session));
      return this.session;
    }
    stop() { this.session = null; this.listeners.forEach(f => f(null)); }
    onChange(f) { this.listeners.push(f); }
  }

  function createPlatform(opts = {}) {
    const storage = opts.storage || new MemoryStorage();
    let clock = opts.clock || (() => Date.now());
    const p = {
      name: 'simulador',
      now: () => clock(),
      perfNow: opts.perfNow || (() => (globalThis.performance ? performance.now() : Date.now())),
      storage, crypto: webCrypto,
      ai: opts.ai || new MockAI(opts.aiOpts),
      camera: opts.camera || new SimCamera(opts.cameraOpts),
      wifi: opts.wifi || new SimWifi(storage),
      battery: opts.battery || new SimBattery(),
      ota: new SimOta(),
      preview: new SimPreview(),
      power: { sleeping: false, sleep() { this.sleeping = true; }, wake() { this.sleeping = false; } },
      log: opts.log || (() => {}),
      setClock(f) { clock = f; }
    };
    return p;
  }

  return { createPlatform, MemoryStorage, LocalStorage, webCrypto, MockAI, HttpAI, SimCamera, SimWifi, SimBattery, simulatedAnswer, hex };
});
