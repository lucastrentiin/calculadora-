/*
 * Application core: state machine, calculator, authentication flow,
 * privacy lock, protected menu, tools, settings, AI/camera flows.
 * Platform services are injected, so the same core runs in the browser
 * simulator and in Node tests. The C firmware (components/app_state) follows
 * the same state machine and rules.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./framebuffer.js'), require('./font.js'), require('./mathEngine.js'), require('./solvers.js'),
      require('./units.js'), require('./formulas.js'), require('./views.js'), require('./auth.js'), require('./aiResponse.js'), require('./sciCalc.js'));
  } else {
    const T = root.MT;
    T.AppModule = factory(T.Framebuffer, T.Font, T.MathEngine, T.Solvers, T.Units, T.Formulas, T.Views, T.Auth, T.AiResponse, T.SciCalc);
  }
})(typeof self !== 'undefined' ? self : this, function (Framebuffer, Font, M, Solvers, Units, Formulas, V, AuthMod, AiResp, Sci) {
  'use strict';

  const S = Object.freeze({
    NORMAL: 'NORMAL', AUTH_PENDING: 'AUTH_PENDING', AUTHENTICATED: 'AUTHENTICATED', TEXT_ENTRY: 'TEXT_ENTRY',
    AI_REQUEST: 'AI_REQUEST', AI_RESPONSE: 'AI_RESPONSE', CAMERA: 'CAMERA', MATH_TOOLS: 'MATH_TOOLS',
    SETTINGS: 'SETTINGS', PRIVACY_LOCK: 'PRIVACY_LOCK'
  });

  const COMBOS = {
    SSAA: ['SHIFT', 'SHIFT', 'ALPHA', 'ALPHA'],
    ASAS: ['ALPHA', 'SHIFT', 'ALPHA', 'SHIFT'],
    AASS: ['ALPHA', 'ALPHA', 'SHIFT', 'SHIFT']
  };

  const DEFAULT_SETTINGS = {
    angle: 'deg', responseMode: 'short', textMethod: 'A', largeFont: false, simpleMenus: false,
    scrollStep: 1, keyRepeat: 'normal', invert: false, autoLockSec: 120, sleepSec: 300,
    aiHistory: true, calcHistory: true, authCombo: 'SSAA', comboWindowMs: 3000, authTimeoutMs: 30000,
    multitapMs: 900, jpegQuality: 12, resolution: 'SVGA',
    // NORMAL mode (fx-82MS-class): MODE settings
    calcMode: 'COMP', regType: 'Lin', disp: 'norm1', dispDigits: 0, fracFmt: 'abc', decSep: 'dot', provider: 'auto', aiNoticeAck: false
  };

  const RESOLUTIONS = [['QVGA', '320x240'], ['VGA', '640x480'], ['SVGA', '800x600'], ['XGA', '1024x768'], ['UXGA', '1600x1200'], ['QXGA', '2048x1536']];
  const MODE_NAMES = { fast: 'Rapido', short: 'Curto', full: 'Completo' };

  function lcdPatternView(state) {
    return { state, protected: true, n: 0,
      onKey(ev, a) { if (ev.key === 'AC') { a.pop(); return true; } if (ev.key === 'RIGHT' || ev.key === 'EQ') this.n = (this.n + 1) % 4; if (ev.key === 'LEFT') this.n = (this.n + 3) % 4; return true; },
      render(fb) {
        for (let y = 0; y < fb.height; y++) for (let x = 0; x < fb.width; x++) {
          const on = [1, 0, (x + y) % 2, x === 0 || y === 0 || x === fb.width - 1 || y === fb.height - 1 ? 1 : 0][this.n];
          if (on) fb.setPixel(x, y, 1);
        }
      } };
  }
  function keyTestView(state) {
    const seen = new Set();
    return { state, protected: true, last: '',
      onKey(ev, a) { if (ev.key === 'AC' && this.last === 'AC') { a.pop(); return true; } this.last = ev.key; seen.add(ev.key); return true; },
      render(fb) { fb.drawText(2, 0, 'Tecla: ' + this.last); fb.drawText(2, 8, 'Testadas: ' + seen.size); fb.drawTiny(2, 26, 'AC 2X SAI  ON BLOQUEIA'); } };
  }

  /* ======================================================================
   * App
   * ==================================================================== */
  class App {
    constructor(platform, opts = {}) {
      this.p = platform;
      this.width = opts.width || 128;
      this.height = opts.height || 32;
      this.fb = new Framebuffer(this.width, this.height);
      this.settings = Object.assign({}, DEFAULT_SETTINGS, this.loadJSON('settings', {}));
      if (!['deg', 'rad', 'grad'].includes(this.settings.angle)) this.settings.angle = 'deg';
      if (!COMBOS[this.settings.authCombo]) this.settings.authCombo = 'SSAA';
      this.calc = new Sci.SciCalc(this);
      const hist = this.settings.calcHistory ? this.loadJSON('calc.history', []) : [];
      this.calc.history = Array.isArray(hist) ? hist.filter(h => h && Array.isArray(h.tokens)) : [];
      this.calc.load(this.loadJSON('calc.state', null));
      this.views = [];
      this.session = { authenticated: false };
      this.auth = new AuthMod.Auth({ crypto: platform.crypto, storage: platform.storage, now: () => this.now(), policy: opts.authPolicy });
      this.vault = new AuthMod.Vault({ crypto: platform.crypto, storage: platform.storage });
      this.shift = false; this.alpha = false;
      this.combo = [];
      this.pin = null;          // AUTH_PENDING buffer (array of digits), never rendered
      this.authToken = 0;
      this.authBusy = false;
      this.ai = null;           // current AI request
      this.remoteCancels = [];  // explicit tracking of requests that reached the server
      this.lastActivity = this.now();
      this.asleep = false;
      this.lastLock = null;
      this.draft = '';
      this.lockLatencies = [];
      this.formulaFavs = this.loadJSON('fav.formulas', []);
    }

    /* ---------------- platform helpers ---------------- */
    now() { return this.p.now(); }
    loadJSON(key, def) { try { const v = this.p.storage.get(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
    saveJSON(key, v) {
      try { this.p.storage.set(key, JSON.stringify(v)); return true; }
      catch (e) { this.log('storage_error', { key }); return false; } // full/failed storage never breaks the UI
    }
    saveSettings() { this.saveJSON('settings', this.settings); }
    saveCalcHistory() { if (this.settings.calcHistory) this.saveJSON('calc.history', this.calc.history.slice(0, 50)); }
    log(evt, data) { if (this.p.log) this.p.log(evt, data || {}); }

    get state() {
      if (this.pin) return S.AUTH_PENDING;
      const v = this.views[this.views.length - 1];
      return v ? v.state : S.NORMAL;
    }
    get top() { return this.views[this.views.length - 1] || null; }
    get isProtected() { return this.session.authenticated || this.views.some(v => v.protected); }

    layout() {
      const scale = this.settings.largeFont ? 2 : 1;
      const cw = 6 * scale, ch = 8 * scale, x0 = 3;
      return { scale, cw, ch, x0, cols: Math.floor((this.width - x0 - 5) / cw), rows: Math.floor(this.height / ch),
        titleRow: scale === 1 && !this.settings.simpleMenus && this.height >= 32, simple: this.settings.simpleMenus };
    }
    layout1() { return { scale: 1, cw: 6, ch: 8, x0: 3, cols: Math.floor((this.width - 8) / 6), rows: Math.floor(this.height / 8) }; }

    push(view) { this.views.push(view); return view; }
    pop() {
      const v = this.views.pop();
      if (v && v.dispose) v.dispose();
      if (v && v.onPop) v.onPop(this);
      return v;
    }
    replaceTop(view) { this.pop(); return this.push(view); }

    /* ---------------- key handling ---------------- */
    handleKey(ev) {
      if (typeof ev === 'string') ev = { key: ev };
      const t0 = this.p.perfNow ? this.p.perfNow() : this.now();
      this.lastActivity = this.now();
      if (this.asleep) { this.asleep = false; this.p.power && this.p.power.wake && this.p.power.wake(); return; }

      // 1) privacy key has the highest priority
      if (ev.key === 'ON') {
        if (this.isProtected || this.state !== S.NORMAL) {
          const wasProtected = this.isProtected;
          if (this.state === S.AUTH_PENDING) this.cancelAuth();
          else if (wasProtected) this.privacyLock('key', t0);
          else { while (this.views.length) this.pop(); } // unprotected tools: just back to calculator
          return;
        }
        this.calc.clear(); this.shift = false; this.alpha = false; // conventional ON: clear display
        return;
      }

      // 2) discreet authentication trigger (only from the plain calculator)
      if (this.state === S.NORMAL && !this.views.length) {
        if (this.detectCombo(ev.key)) { this.shift = false; this.alpha = false; this.beginAuth(); return; }
      }

      if (this.state === S.AUTH_PENDING) { this.authKey(ev); return; }

      // 3) modifiers
      if (ev.key === 'SHIFT') { this.shift = !this.shift; return; }
      if (ev.key === 'ALPHA' && (!this.top || !(this.top instanceof V.EditorView))) { this.alpha = !this.alpha; return; }
      const e = Object.assign({}, ev, { shift: !!(ev.shift || this.shift), alpha: !!(ev.alpha || this.alpha) });
      this.shift = false; this.alpha = false;

      if (this.top) { this.top.onKey(e, this); return; }
      this.calcKey(e);
    }

    detectCombo(key) {
      const seq = COMBOS[this.settings.authCombo] || COMBOS.SSAA;
      const now = this.now();
      this.combo.push({ key, at: now });
      this.combo = this.combo.filter(c => now - c.at <= this.settings.comboWindowMs).slice(-seq.length);
      if (this.combo.length === seq.length && this.combo.every((c, i) => c.key === seq[i])) { this.combo = []; return true; }
      return false;
    }

    calcKey(e) {
      if (e.key === 'MENU') { this.openTools(false); return; } // extension key (not on the original)
      this.calc.key(e);
    }

    powerOff() { this.asleep = true; if (this.p.power && this.p.power.sleep) this.p.power.sleep(); }

    /* ---------------- authentication ---------------- */
    beginAuth() {
      if (this.auth.isLocked()) { this.log('auth_ignored_locked'); return; } // stays fully silent
      if (!this.auth.hasPin()) { this.openPinSetup(); return; }
      this.pin = [];
      this.authStarted = this.now();
      this.log('auth_pending');
    }
    cancelAuth() {
      if (this.pin) this.pin.fill('0');
      this.pin = null; this.authBusy = false; this.authToken++;
    }
    authKey(ev) {
      if (this.authBusy) { if (ev.key === 'AC') this.cancelAuth(); return; }
      const k = ev.key;
      if (/^[0-9]$/.test(k)) { if (this.pin.length < this.auth.policy.maxLen) this.pin.push(k); return; }
      if (k === 'DEL') { this.pin.pop(); return; }
      if (k === 'AC') { this.cancelAuth(); return; }
      if (k === 'EQ') { this.submitPin(); return; }
      // any other key: abandon silently and behave like a normal calculator key
      this.cancelAuth();
      this.handleKey(ev);
    }
    submitPin() {
      const token = ++this.authToken;
      const pinStr = this.pin.join('');
      this.pin.fill('0');
      this.authBusy = true;
      const done = this.auth.verify(pinStr).then(res => {
        if (token !== this.authToken || !this.pin) { if (res.dataKey) res.dataKey.fill(0); return res; }
        this.pin = null; this.authBusy = false;
        if (res.ok) this.openSession(res.dataKey);
        else this.log('auth_failed', { failures: res.failures, locked: !!res.locked });
        return res;
      });
      this.pendingAuth = done;
      return done;
    }
    openSession(dataKey) {
      // fresh, never reused session id: async results are bound to it
      this.session = { authenticated: true, since: this.now(), id: this.p.crypto.uuid() };
      this.loadProviders(this.session.id);
      this.vaultReady = this.vault.open(dataKey);
      this.lastActivity = this.now();
      this.push(this.protectedMenu());
      this.log('session_open');
    }

    /* ---------------- privacy lock ---------------- */
    privacyLock(reason, t0) {
      const start = t0 != null ? t0 : (this.p.perfNow ? this.p.perfNow() : this.now());
      const from = this.state;
      this.lockState = S.PRIVACY_LOCK;
      // 1) visible UI first: drop every protected view (dispose wipes buffers)
      const views = this.views; this.views = [];
      this.cancelAuth();
      this.session = { authenticated: false };
      this.shift = false; this.alpha = false;
      // 2) cancel async work without awaiting it
      this.cancelAi('privacy_lock');
      if (this.p.camera && this.p.camera.isActive && this.p.camera.isActive()) { try { this.p.camera.deinit(); } catch (e) { /* ignore */ } }
      if (this.p.preview && this.p.preview.stop) this.p.preview.stop();
      for (let i = views.length - 1; i >= 0; i--) { try { if (views[i].dispose) views[i].dispose(); } catch (e) { /* ignore */ } }
      this.vault.close();
      this.draft = '';
      this.lockState = null;
      const end = this.p.perfNow ? this.p.perfNow() : this.now();
      this.lastLock = { reason, from, at: this.now(), ms: end - start };
      this.lockLatencies.push(end - start);
      if (this.lockLatencies.length > 50) this.lockLatencies.shift();
      if (this.p.requestRender) this.p.requestRender();
      this.log('privacy_lock', { reason, from });
    }

    /* ---------------- periodic work ---------------- */
    tick() {
      const now = this.now();
      if (this.pin && !this.authBusy && now - this.authStarted > this.settings.authTimeoutMs) this.cancelAuth();
      if (this.session.authenticated && now - this.lastActivity > this.settings.autoLockSec * 1000) this.privacyLock('inactivity');
      if (this.top && this.top.tick) this.top.tick(this);
      if (!this.asleep && this.settings.sleepSec > 0 && !this.ai && now - this.lastActivity > this.settings.sleepSec * 1000) {
        if (this.isProtected) this.privacyLock('sleep');
        this.asleep = true;
        if (this.p.power && this.p.power.sleep) this.p.power.sleep();
      }
      const bat = this.battery();
      if (bat.supported && bat.critical && this.isProtected) this.privacyLock('battery');
    }
    battery() { try { return this.p.battery ? this.p.battery.read() : { supported: false }; } catch (e) { return { supported: false }; } }

    /* ---------------- rendering ---------------- */
    render() {
      const fb = this.fb;
      fb.clear();
      if (!this.asleep) {
        if (this.top && !this.pin) this.top.render(fb, this);
        else this.renderCalc(fb);
        if (this.flash && this.now() < this.flash.until) {
          const w = Framebuffer.textWidth(this.flash.text) + 4;
          const x = Math.max(0, (fb.width - w) >> 1);
          fb.fillRect(x, 11, w, 10, 0); fb.drawRect(x, 11, w, 10); fb.drawText(x + 2, 12, this.flash.text);
        }
        if (this.settings.invert) fb.invertRect(0, 0, fb.width, fb.height);
      }
      return fb;
    }

    renderCalc(fb) {
      const L = this.layout();
      this.calc.render(fb, { cursorOn: Math.floor(this.now() / 500) % 2 === 0, scale: L.scale === 2 ? 2 : (this.calc.resultText().length <= 10 ? 2 : 1) });
      const bat = this.battery();
      if (bat.supported) {
        const x = this.width - 16;
        fb.fillRect(x - 1, 0, 12, 6, 0);
        fb.drawRect(x, 0, 9, 5); fb.vline(x + 9, 1, 3);
        const lvl = Math.round(7 * Math.max(0, Math.min(100, bat.percent)) / 100);
        if (!bat.low || Math.floor(this.now() / 500) % 2) fb.fillRect(x + 1, 1, lvl, 3);
      }
      if (this.pin) {
        // discreet authentication indicator: 3x3 dot in the top-right corner
        if (!this.authBusy || Math.floor(this.now() / 250) % 2) fb.fillRect(this.width - 3, 0, 3, 3, 1);
      }
    }

    /* ======================================================================
     * Screens
     * ==================================================================== */
    protectedMenu() {
      return new V.MenuView(S.AUTHENTICATED, 'Menu', [
        { label: 'Perguntar (texto)', select: (a) => a.withPrivacyNotice(() => a.openQuestion()) },
        { label: 'Camera', select: (a) => a.withPrivacyNotice(() => a.openCamera()) },
        { label: 'Ferramentas', select: (a) => a.openTools(true) },
        { label: 'Favoritos', select: (a) => a.openFavorites() },
        { label: 'Historico', select: (a) => a.openHistory() },
        { label: 'Modo resposta', value: (a) => MODE_NAMES[a.settings.responseMode], cycle: (a, d) => a.cycleSetting('responseMode', ['fast', 'short', 'full'], d) },
        { label: 'Assistente', value: (a) => ((a.providerChoices || []).find(c => c.id === a.settings.provider) || { label: 'AUTOMATICO' }).label, select: (a) => a.openAssistantMenu() },
        { label: 'Ajustes', select: (a) => a.openSettings() },
        { label: 'Bloquear', select: (a) => a.privacyLock('menu') }
      ], { protected: true, onBack: (a) => a.privacyLock('menu') }); // leaving the protected root ends the session
    }

    cycleSetting(key, values, dir) {
      const i = values.indexOf(this.settings[key]);
      this.settings[key] = values[(i + (dir < 0 ? -1 : 1) + values.length) % values.length];
      this.saveSettings();
    }

    /* ---------------- text question -> AI ---------------- */
    openQuestion(initial) {
      const ed = new V.EditorView(S.TEXT_ENTRY, 'Pergunta', (text, app) => {
        const q = text.trim();
        if (!q) return;
        app.draft = '';
        app.pop();
        app.startAi({ kind: 'text', question: q, mode: app.settings.responseMode });
      }, { method: this.settings.textMethod, initial: initial != null ? initial : this.draft, multitapMs: this.settings.multitapMs,
        onCancel: (app, v) => { app.draft = v.text; } });
      this.push(ed);
      return ed;
    }

    /** Providers offered by the home server (only configured/authorised ones). */
    loadProviders(sessionId) {
      this.providerChoices = this.providerChoices || [{ id: 'auto', label: 'AUTOMATICO' }];
      if (!this.p.ai || !this.p.ai.config) return Promise.resolve();
      return this.p.ai.config().then(c => {
        if (this.session.id !== sessionId) return; // session ended meanwhile
        this.providerChoices = (c && Array.isArray(c.providers) && c.providers.length) ? c.providers : [{ id: 'auto', label: 'AUTOMATICO' }];
        this.privacyNotice = c && c.privacy_notice;
        if (!this.providerChoices.some(x => x.id === this.settings.provider)) this.settings.provider = 'auto';
      }, () => { /* server down: AUTOMATICO only, calculator unaffected */ });
    }

    openAssistantMenu() {
      return this.push(new V.MenuView(S.AUTHENTICATED, 'Assistente', (a) => (a.providerChoices || [{ id: 'auto', label: 'AUTOMATICO' }]).map(c => ({
        label: (a.settings.provider === c.id ? '*' : '') + c.label,
        select: (x) => { x.settings.provider = c.id; x.saveSettings(); x.pop(); }
      })), { protected: true }));
    }

    /** The external-processing notice must be accepted once before the first AI use. */
    withPrivacyNotice(next) {
      if (this.settings.aiNoticeAck) return next();
      return this.push(new V.ReaderView(S.AUTHENTICATED, 'Aviso', [
        { kind: 'title', text: 'Privacidade' },
        { kind: 'text', text: this.privacyNotice || 'Perguntas e imagens enviadas a um provedor externo sao processadas por esse servico segundo as politicas dele.' },
        { kind: 'text', text: 'Fotos nao sao gravadas no aparelho.' },
        { kind: 'text', text: '= aceitar  AC voltar' }
      ], { protected: true, onEnter: (a) => { a.settings.aiNoticeAck = true; a.saveSettings(); a.pop(); next(); } }));
    }

    /** May an async AI result touch the screen? (session, cancellation and state checks) */
    aiResultAllowed(req) {
      if (this.ai !== req || req.cancelled) return false;
      if (!this.session.authenticated || this.session.id !== req.sessionId) return false;
      return this.state === S.AI_REQUEST && this.top && this.top.isAi && this.top.reqId === req.id;
    }

    startAi(payload) {
      const wifi = this.p.wifi ? this.p.wifi.status() : { connected: false };
      if (!wifi.connected) {
        this.push(new V.ReaderView(S.AI_RESPONSE, 'Erro', [{ kind: 'title', text: 'Sem conexao' }, { kind: 'text', text: 'Wi-Fi desconectado. Calculos offline continuam disponiveis. Configure em Ajustes > Wi-Fi.' }], { protected: true }));
        return null;
      }
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : { signal: {}, abort() {} };
      payload = Object.assign({ provider: this.settings.provider || 'auto', sessionId: this.session.id }, payload);
      const req = { id: this.p.crypto.uuid(), phase: 'conectando', sent: false, ctrl, payload, startedAt: this.now(), sessionId: this.session.id };
      this.ai = req;
      const busy = new V.BusyView(S.AI_REQUEST, () => [payload.kind === 'image' ? 'Analisando imagem' : 'Consultando', req.phase + '...', 'Modo ' + MODE_NAMES[payload.mode]], {
        onCancel: (app) => { app.cancelAi('user'); app.pop(); }
      });
      busy.isAi = true;
      busy.reqId = req.id;
      this.push(busy);
      const promise = this.p.ai.ask(Object.assign({ requestId: req.id }, payload), {
        signal: ctrl.signal,
        onPhase: (ph) => { req.phase = ph; if (ph === 'enviado' || ph === 'aguardando') req.sent = true; }
      }).then(resp => this.onAiResult(req, resp), err => this.onAiError(req, err));
      req.promise = promise;
      return req;
    }

    cancelAi(reason) {
      const req = this.ai;
      if (!req) return;
      this.ai = null;
      req.cancelled = true;
      try { req.ctrl.abort(); } catch (e) { /* ignore */ }
      if (req.payload && req.payload.image && req.payload.image.fill) req.payload.image.fill(0);
      if (req.sent) {
        // Already reached the server: cancellation cannot be assumed. Track it explicitly.
        const entry = { id: req.id, at: this.now(), reason, status: 'cancelamento solicitado' };
        this.remoteCancels.unshift(entry);
        if (this.remoteCancels.length > 20) this.remoteCancels.pop();
        Promise.resolve().then(() => this.p.ai.cancelRemote(req.id)).then(
          r => { entry.status = r && r.status ? r.status : 'desconhecido'; },
          () => { entry.status = 'sem confirmacao (rede)'; });
      }
      this.log('ai_cancel', { reason, sent: req.sent });
    }

    onAiResult(req, raw) {
      if (!this.aiResultAllowed(req)) { // late response after cancel/lock/new session: discard, never display
        if (raw && raw.image && raw.image.fill) raw.image.fill(0);
        const e = this.remoteCancels.find(x => x.id === req.id);
        if (e) e.lateResponseDiscarded = true;
        return;
      }
      this.ai = null;
      const v = AiResp.validate(raw);
      const top = this.top;
      if (top && top.isAi) this.pop();
      if (!v.ok) {
        this.push(new V.ReaderView(S.AI_RESPONSE, 'Erro', [{ kind: 'title', text: 'Resposta invalida' }, { kind: 'text', text: v.errors.join('; ') }], { protected: true }));
        return;
      }
      const resp = v.value;
      const ver = AiResp.verify(resp);
      const question = req.payload.kind === 'image' ? '(imagem da camera)' : req.payload.question;
      const blocks = AiResp.toDoc(resp, req.payload.mode, ver, { question });
      if (v.partial) blocks.push({ kind: 'text', text: 'Aviso: ' + v.errors.join('; ') });
      const item = { type: 'question', at: this.now(), title: question.slice(0, 40), question, resp, mode: req.payload.mode };
      if (this.settings.aiHistory && this.vault.isOpen && resp.status === 'ok') {
        this.vault.data.history.unshift(item);
        if (this.vault.data.history.length > 100) this.vault.data.history.pop();
        this.vault.save();
      }
      this.push(new V.ReaderView(S.AI_RESPONSE, 'Resposta', blocks, {
        protected: true,
        onFavorite: (app) => app.addFavorite({ type: 'resolution', title: question.slice(0, 40), blocks }),
        onEnter: (app) => app.openModeSwitch(resp, ver, question)
      }));
    }

    onAiError(req, err) {
      if (!this.aiResultAllowed(req)) return;
      this.ai = null;
      if (this.top && this.top.isAi) this.pop();
      const msg = err && err.message ? err.message : String(err);
      this.push(new V.ReaderView(S.AI_RESPONSE, 'Erro', [
        { kind: 'title', text: 'Falha na consulta' }, { kind: 'text', text: msg },
        { kind: 'text', text: req.sent ? 'O servidor pode ter recebido a solicitacao.' : 'A solicitacao nao foi enviada.' },
        { kind: 'text', text: '= tenta de novo, AC volta.' }
      ], { protected: true, onEnter: (app) => { app.pop(); app.startAi(req.payload); } }));
    }

    /** = on a response re-renders it in another mode without a new request. */
    openModeSwitch(resp, ver, question) {
      const modes = ['fast', 'short', 'full'];
      this.push(new V.MenuView(S.AI_RESPONSE, 'Ver como', modes.map(m => ({
        label: MODE_NAMES[m], select: (app) => { app.pop(); app.replaceTop(new V.ReaderView(S.AI_RESPONSE, 'Resposta', AiResp.toDoc(resp, m, ver, { question }), { protected: true, onEnter: (a) => a.openModeSwitch(resp, ver, question) })); }
      })), { protected: true }));
    }

    /* ---------------- camera ---------------- */
    openCamera() {
      const app = this;
      const cam = this.p.camera;
      const view = {
        state: S.CAMERA, protected: true, phase: 'init', msg: '', image: null, preview: null,
        resIdx: Math.max(0, RESOLUTIONS.findIndex(r => r[0] === app.settings.resolution)),
        async start() {
          this.phase = 'init';
          try { const d = await cam.init({ resolution: RESOLUTIONS[this.resIdx][0], quality: app.settings.jpegQuality }); if (app.top !== this) { cam.deinit(); return; } this.diag = d; this.phase = 'ready'; }
          catch (e) { if (app.top === this) { this.phase = 'error'; this.msg = e.message; } }
        },
        async capture() {
          this.phase = 'capturing';
          try {
            const img = await cam.capture({ resolution: RESOLUTIONS[this.resIdx][0], quality: app.settings.jpegQuality });
            if (app.top !== this) { img.data.fill(0); return; }
            this.image = img; this.phase = 'captured';
          } catch (e) { if (app.top === this) { this.phase = 'error'; this.msg = e.message; } }
        },
        onKey(ev, a) {
          const k = ev.key;
          if (k === 'AC') { a.pop(); return true; }
          if (this.phase === 'error') { if (k === 'EQ') this.start(); return true; }
          if (this.phase === 'ready') {
            if (k === 'LEFT' || k === 'RIGHT') { this.resIdx = Math.min(RESOLUTIONS.length - 1, Math.max(0, this.resIdx + (k === 'LEFT' ? -1 : 1))); a.settings.resolution = RESOLUTIONS[this.resIdx][0]; a.saveSettings(); return true; }
            if (k === 'UP' || k === 'DOWN') { a.settings.jpegQuality = Math.min(63, Math.max(4, a.settings.jpegQuality + (k === 'UP' ? -2 : 2))); a.saveSettings(); return true; }
            if (k === 'EQ') { this.capture(); return true; }
            if (k === 'MODE') { this.togglePreview(a); return true; }
          }
          if (this.phase === 'captured') {
            if (k === 'DEL') { this.image.data.fill(0); this.image = null; this.phase = 'ready'; return true; }
            if (k === 'EQ') {
              const data = this.image.data; this.image = null;
              a.pop(); // camera off before network transfer
              a.startAi({ kind: 'image', image: data, mime: 'image/jpeg', prompt: 'Analise o conteudo matematico da imagem.', mode: a.settings.responseMode });
              return true;
            }
          }
          return true;
        },
        togglePreview(a) {
          if (!a.p.preview) return;
          if (this.preview) { a.p.preview.stop(); this.preview = null; return; }
          this.preview = a.p.preview.start({ onCapture: () => { if (a.top === this && this.phase === 'ready') this.capture(); } });
        },
        render(fb, a) {
          const lines = {
            init: ['Camera: iniciando...'],
            ready: ['Camera pronta', RESOLUTIONS[this.resIdx][0] + ' ' + RESOLUTIONS[this.resIdx][1] + ' Q' + a.settings.jpegQuality, this.preview ? 'Previa ' + this.preview.code : '= capturar  MODE previa'],
            capturing: ['Capturando...'],
            captured: ['Foto: ' + (this.image ? Math.round(this.image.data.length / 1024) : 0) + ' KB', (this.image ? this.image.width + 'x' + this.image.height : ''), '= enviar  DEL refazer'],
            error: ['Erro da camera:', this.msg, '= tentar  AC sair']
          }[this.phase];
          lines.forEach((l, i) => fb.drawText(2, i * 8, String(l).slice(0, 20)));
          fb.drawTiny(2, 26, 'AC SAI');
        },
        dispose() {
          if (this.image) { this.image.data.fill(0); this.image = null; }
          if (this.preview && a2.p.preview) a2.p.preview.stop();
          this.preview = null;
          try { cam.deinit(); } catch (e) { /* ignore */ }
        }
      };
      const a2 = this;
      this.push(view);
      view.start();
      return view;
    }

    /* ---------------- tools (offline) ---------------- */
    openTools(prot) {
      const st = S.MATH_TOOLS;
      const P = { protected: prot };
      const reader = (title, lines) => new V.ReaderView(st, title, lines, Object.assign({}, P, {
        onFavorite: prot ? (app) => app.addFavorite({ type: 'result', title, blocks: lines }) : null
      }));
      const items = [
        { label: 'Resolver expressao', select: (a) => a.push(new V.FormView(st, 'Expressao', [{ key: 'e', label: 'f', type: 'expr', text: a.calc.expr }], (v, app) => app.openSteps(v.e, prot), P)) },
        { label: 'Equacao 1o grau', select: (a) => a.push(new V.FormView(st, 'ax+b=0', [{ key: 'a', label: 'a', type: 'num' }, { key: 'b', label: 'b', type: 'num' }],
          (v, app) => app.push(reader('1o grau', Solvers.linear(v.a, v.b).lines)), P)) },
        { label: 'Equacao 2o grau', select: (a) => a.push(new V.FormView(st, 'ax2+bx+c=0', [{ key: 'a', label: 'a', type: 'num' }, { key: 'b', label: 'b', type: 'num' }, { key: 'c', label: 'c', type: 'num' }],
          (v, app) => app.push(reader('2o grau', Solvers.quadratic(v.a, v.b, v.c).lines)), P)) },
        { label: 'Sistema 2x2', select: (a) => a.openSystem(2, prot, reader) },
        { label: 'Sistema 3x3', select: (a) => a.openSystem(3, prot, reader) },
        { label: 'Matriz 2x2', select: (a) => a.openMatrix(2, prot, reader) },
        { label: 'Matriz 3x3', select: (a) => a.openMatrix(3, prot, reader) },
        { label: 'Estatistica', select: (a) => a.push(new V.FormView(st, 'Dados (virgula)', [{ key: 'd', label: 'x', type: 'list' }],
          (v, app) => app.push(reader('Estatistica', Solvers.stats(v.d).lines)), P)) },
        { label: 'Tabela de valores', select: (a) => a.push(new V.FormView(st, 'Tabela f(x)', [
          { key: 'f', label: 'f(x)', type: 'expr' }, { key: 'a', label: 'inicio', type: 'num', text: '0' }, { key: 'b', label: 'fim', type: 'num', text: '10' }, { key: 's', label: 'passo', type: 'num', text: '1' }],
          (v, app) => app.push(reader('Tabela', Solvers.valueTable(v.f, v.a, v.b, v.s, { angle: app.settings.angle }).lines)), P)) },
        { label: 'Formulas', select: (a) => a.openFormulas(prot) },
        { label: 'Conversoes', select: (a) => a.openConversions(prot) }
      ];
      return this.push(new V.MenuView(st, 'Ferramentas', items, P));
    }

    openSteps(expr, prot) {
      const st = S.MATH_TOOLS;
      let blocks;
      try {
        const sol = M.solveSteps(expr, this.calc.ctx(this));
        blocks = [{ kind: 'title', text: 'Resolucao (local)' }, ...sol.steps.map((s, i) => ({ kind: 'math', text: M.pretty(s.expr), rule: i === 0 ? s.rule : (i + '. ' + s.rule) })),
          { kind: 'title', text: 'Resultado' }, { kind: 'math', text: M.formatNumber(sol.value) }];
        const fr = M.toFraction(sol.value);
        if (fr && fr.d !== 1) blocks.push({ kind: 'math', text: '= ' + fr.n + '/' + fr.d });
        if (sol.truncated) blocks.push({ kind: 'text', text: 'Limite de etapas atingido.' });
      } catch (e) {
        blocks = [{ kind: 'title', text: 'Erro' }, { kind: 'text', text: e.message || 'Erro' }];
      }
      return this.push(new V.ReaderView(st, 'Passos', blocks, { protected: !!prot || this.isProtected,
        onFavorite: this.vault.isOpen ? (app) => app.addFavorite({ type: 'resolution', title: expr.slice(0, 40), blocks }) : null }));
    }

    openSystem(n, prot, reader) {
      const names = ['x', 'y', 'z'];
      const fields = [];
      for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) fields.push({ key: 'a' + i + j, label: 'L' + (i + 1) + ' ' + names[j], type: 'num' }); fields.push({ key: 'b' + i, label: 'L' + (i + 1) + ' =', type: 'num' }); }
      return this.push(new V.FormView(S.MATH_TOOLS, 'Sistema ' + n + 'x' + n, fields, (v, app) => {
        const A = [], b = [];
        for (let i = 0; i < n; i++) { A.push([]); for (let j = 0; j < n; j++) A[i].push(v['a' + i + j]); b.push(v['b' + i]); }
        app.push(reader('Sistema', Solvers.linearSystem(A, b).lines));
      }, { protected: prot }));
    }

    openMatrix(n, prot, reader) {
      const fields = [{ key: 'op', label: 'op', type: 'choice', options: [{ label: 'det', value: 'det' }, { label: 'inversa', value: 'inv' }, { label: 'transp.', value: 'tr' }] }];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) fields.push({ key: 'm' + i + j, label: 'a' + (i + 1) + (j + 1), type: 'num' });
      return this.push(new V.FormView(S.MATH_TOOLS, 'Matriz ' + n + 'x' + n, fields, (v, app) => {
        const A = [];
        for (let i = 0; i < n; i++) { A.push([]); for (let j = 0; j < n; j++) A[i].push(v['m' + i + j]); }
        const lines = [{ kind: 'title', text: 'Matriz' }, ...Solvers.matrixLines('A', A)];
        if (v.op === 'det') lines.push({ kind: 'math', text: 'det(A) = ' + M.formatNumber(Solvers.det(A)) });
        else if (v.op === 'inv') { lines.push({ kind: 'text', text: 'Inversa (Gauss-Jordan):' }, ...Solvers.matrixLines('A^-1', Solvers.inverse(A))); }
        else lines.push(...Solvers.matrixLines('At', Solvers.transpose(A)));
        app.push(reader('Matriz', lines));
      }, { protected: prot }));
    }

    openFormulas(prot) {
      const st = S.MATH_TOOLS;
      const P = { protected: prot };
      const listView = (title, list) => new V.MenuView(st, title, () => list().map(f => ({
        label: (this.formulaFavs.includes(f.id) ? '*' : '') + f.name,
        select: (a) => a.openFormula(f, prot),
        fav: (a) => a.toggleFormulaFav(f.id)
      })), P);
      const items = [
        { label: 'Buscar...', select: (a) => a.push(new V.EditorView(st, 'Busca', (text, app) => { app.pop(); app.push(listView('Busca', () => Formulas.search(text))); }, { protected: prot, method: a.settings.textMethod })) },
        { label: 'Favoritas', select: (a) => a.push(listView('Favoritas', () => a.formulaFavs.map(id => Formulas.get(id)).filter(Boolean))) },
        ...Formulas.CATEGORIES.map(([id, name]) => ({ label: name, select: (a) => a.push(listView(name, () => Formulas.byCategory(id))) }))
      ];
      return this.push(new V.MenuView(st, 'Formulas', items, P));
    }

    toggleFormulaFav(id) {
      const i = this.formulaFavs.indexOf(id);
      if (i >= 0) this.formulaFavs.splice(i, 1); else this.formulaFavs.push(id);
      this.saveJSON('fav.formulas', this.formulaFavs);
    }

    openFormula(f, prot) {
      const blocks = [
        { kind: 'title', text: f.name }, { kind: 'math', text: M.pretty(f.formula) }, { kind: 'text', text: 'Variaveis:' },
        ...f.vars.map(([s, d, u]) => ({ kind: 'text', text: s + ': ' + d + (u !== '-' ? ' [' + u + ']' : '') })),
        { kind: 'text', text: 'Unidades: ' + f.units }, { kind: 'text', text: 'Categoria: ' + (Formulas.CATEGORIES.find(c => c[0] === f.cat) || [0, f.cat])[1] },
        { kind: 'title', text: 'Exemplo' }, { kind: 'math', text: Object.entries(f.example.in).map(([k, v]) => k + '=' + v).join(', ') + ' -> ' + f.out + '=' + M.formatNumber(f.example.out) },
        { kind: 'text', text: '= aplicar  M+ favorita' }
      ];
      return this.push(new V.ReaderView(S.MATH_TOOLS, f.name, blocks, {
        protected: prot,
        onFavorite: (a) => a.toggleFormulaFav(f.id),
        onEnter: (a) => a.push(new V.FormView(S.MATH_TOOLS, f.name, f.vars.map(([s]) => ({ key: s, label: s, type: 'num' })), (v, app) => {
          const r = Formulas.apply(f.id, v, { angle: f.angle || app.settings.angle });
          app.push(new V.ReaderView(S.MATH_TOOLS, f.name, r.lines.map(l => Object.assign({}, l, { text: M.pretty(l.text) })), {
            protected: prot, onFavorite: app.vault.isOpen ? (x) => x.addFavorite({ type: 'result', title: f.name, blocks: r.lines }) : null
          }));
        }, { protected: prot }))
      }));
    }

    openConversions(prot) {
      const st = S.MATH_TOOLS;
      return this.push(new V.MenuView(st, 'Conversoes', Units.CATEGORIES.map(cat => ({
        label: cat.name,
        select: (a) => {
          const opts = cat.units.map(u => ({ label: u[0], value: u[0] }));
          a.push(new V.FormView(st, cat.name, [
            { key: 'v', label: 'valor', type: 'num' },
            { key: 'from', label: 'de', type: 'choice', options: opts, idx: 0 },
            { key: 'to', label: 'para', type: 'choice', options: opts, idx: Math.min(1, opts.length - 1) }
          ], (v, app) => {
            const r = Units.explain(cat.id, v.from, v.to, v.v);
            app.push(new V.ReaderView(st, cat.name, [{ kind: 'title', text: cat.name },
              { kind: 'math', text: M.formatNumber(v.v) + ' ' + v.from + ' = ' + M.formatNumber(r.result) + ' ' + v.to },
              ...r.steps.map(s => ({ kind: 'math', text: s }))], { protected: prot }));
          }, { protected: prot, stepThrough: false }));
        }
      })), { protected: prot }));
    }

    /* ---------------- favorites & history (encrypted vault) ---------------- */
    addFavorite(item) {
      if (!this.vault.isOpen) return false;
      this.vault.data.favorites.unshift(Object.assign({ at: this.now() }, item));
      if (this.vault.data.favorites.length > 100) this.vault.data.favorites.pop();
      this.vault.save();
      this.flash = { text: 'Favorito salvo', until: this.now() + 800 };
      return true;
    }

    openFavorites() {
      const st = S.AUTHENTICATED;
      return this.push(new V.MenuView(st, 'Favoritos', (a) => {
        const out = [];
        a.formulaFavs.forEach(id => { const f = Formulas.get(id); if (f) out.push({ label: 'F ' + f.name, select: (x) => x.openFormula(f, true), del: (x) => x.toggleFormulaFav(id) }); });
        if (a.vault.isOpen) a.vault.data.favorites.forEach((fv, i) => out.push({
          label: { resolution: 'R ', result: 'V ', question: 'P ' }[fv.type] + fv.title,
          select: (x) => x.push(new V.ReaderView(S.AI_RESPONSE, fv.title, fv.blocks || [], { protected: true })),
          del: (x) => { x.vault.data.favorites.splice(i, 1); x.vault.save(); }
        }));
        return out;
      }, { protected: true }));
    }

    openHistory() {
      return this.push(new V.MenuView(S.AUTHENTICATED, 'Historico', (a) => {
        if (!a.vault.isOpen) return [];
        const items = a.vault.data.history.map((h, i) => ({
          label: h.title,
          select: (x) => {
            const ver = AiResp.verify(h.resp);
            x.push(new V.ReaderView(S.AI_RESPONSE, 'Historico', AiResp.toDoc(h.resp, h.mode, ver, { question: h.question }), {
              protected: true,
              onFavorite: (y) => y.addFavorite({ type: 'question', title: h.title, blocks: AiResp.toDoc(h.resp, h.mode, ver, { question: h.question }) }),
              onEnter: (y) => y.openQuestion(h.question)
            }));
          },
          del: (x) => { x.vault.data.history.splice(i, 1); x.vault.save(); }
        }));
        if (items.length) items.push({ label: 'Apagar tudo', select: (x) => { x.vault.data.history = []; x.vault.save(); } });
        return items;
      }, { protected: true }));
    }

    /* ---------------- settings ---------------- */
    openSettings() {
      const st = S.SETTINGS;
      const tog = (key) => ({ value: (a) => (a.settings[key] ? 'sim' : 'nao'), cycle: (a) => { a.settings[key] = !a.settings[key]; a.saveSettings(); } });
      const items = [
        Object.assign({ label: 'Modo resposta', value: (a) => MODE_NAMES[a.settings.responseMode], cycle: (a, d) => a.cycleSetting('responseMode', ['fast', 'short', 'full'], d) }),
        { label: 'Metodo texto', value: (a) => a.settings.textMethod, cycle: (a, d) => a.cycleSetting('textMethod', ['A', 'B'], d) },
        Object.assign({ label: 'Fonte grande' }, tog('largeFont')),
        Object.assign({ label: 'Menus simples' }, tog('simpleMenus')),
        { label: 'Rolagem (linhas)', value: (a) => a.settings.scrollStep, cycle: (a, d) => a.cycleSetting('scrollStep', [1, 2, 3], d) },
        { label: 'Repeticao teclas', value: (a) => a.settings.keyRepeat, cycle: (a, d) => a.cycleSetting('keyRepeat', ['off', 'lenta', 'normal', 'rapida'], d) },
        Object.assign({ label: 'Inverter cores' }, tog('invert')),
        { label: 'Multi-tap (ms)', value: (a) => a.settings.multitapMs, cycle: (a, d) => a.cycleSetting('multitapMs', [600, 900, 1200, 1500], d) },
        { label: 'Bloqueio auto (s)', value: (a) => a.settings.autoLockSec, cycle: (a, d) => a.cycleSetting('autoLockSec', [30, 60, 120, 300, 600], d) },
        { label: 'Suspensao (s)', value: (a) => a.settings.sleepSec, cycle: (a, d) => a.cycleSetting('sleepSec', [60, 120, 300, 600, 0], d) },
        Object.assign({ label: 'Historico IA' }, tog('aiHistory')),
        Object.assign({ label: 'Historico calc.' }, tog('calcHistory'), { cycle: (a) => { a.settings.calcHistory = !a.settings.calcHistory; if (!a.settings.calcHistory) a.p.storage.remove('calc.history'); a.saveSettings(); } }),
        { label: 'Apagar historico', select: (a) => { if (a.vault.isOpen) { a.vault.data.history = []; a.vault.save(); } a.calc.history = []; a.p.storage.remove('calc.history'); a.flash = { text: 'Apagado', until: a.now() + 800 }; } },
        { label: 'Combinacao acesso', value: (a) => a.settings.authCombo, cycle: (a, d) => a.cycleSetting('authCombo', Object.keys(COMBOS), d) },
        { label: 'Alterar PIN', select: (a) => a.openPinChange() },
        { label: 'Wi-Fi', select: (a) => a.openWifi() },
        { label: 'Req. canceladas', select: (a) => a.push(new V.ReaderView(st, 'Canceladas', a.remoteCancels.length ? a.remoteCancels.map(c => ({ kind: 'text', text: c.id.slice(0, 8) + ' ' + c.reason + ': ' + c.status + (c.lateResponseDiscarded ? ' (resposta tardia descartada)' : '') })) : [{ kind: 'text', text: 'Nenhuma' }], { protected: true })) },
        { label: 'Diagnostico', select: (a) => a.openDiagnostics() },
        { label: 'Autodiagnostico', select: (a) => a.openSelfTest() },
        { label: 'Atualizacao (OTA)', select: (a) => a.openOta() }
      ];
      return this.push(new V.MenuView(st, 'Ajustes', items, { protected: true }));
    }

    openPinSetup() {
      // First use only: no PIN exists yet (no fixed default PIN in firmware).
      return this.push(new V.FormView(S.SETTINGS, 'Criar PIN 6-8', [
        { key: 'p1', label: 'PIN', type: 'pin' }, { key: 'p2', label: 'Repita', type: 'pin' }
      ], (v, app, form) => {
        if (v.p1 !== v.p2) { form.error = 'PINs diferentes'; return; }
        if (!AuthMod.validPin(v.p1, app.auth.policy)) { form.error = 'Use 6 a 8 digitos'; return; }
        form.fields.forEach(f => { f.text = ''; });
        app.pinSetupPromise = app.auth.setPin(v.p1).then(key => { app.views = []; app.vault.close(); app.openSession(key); return app.vaultReady.then(() => app.vault.save()); });
      }, { protected: true }));
    }

    openPinChange() {
      return this.push(new V.FormView(S.SETTINGS, 'Alterar PIN', [
        { key: 'old', label: 'Atual', type: 'pin' }, { key: 'p1', label: 'Novo', type: 'pin' }, { key: 'p2', label: 'Repita', type: 'pin' }
      ], (v, app, form) => {
        if (v.p1 !== v.p2) { form.error = 'PINs diferentes'; return; }
        if (!AuthMod.validPin(v.p1, app.auth.policy)) { form.error = 'Use 6 a 8 digitos'; return; }
        form.fields.forEach(f => { f.text = ''; });
        app.pinChangePromise = app.auth.verify(v.old).then(r => {
          if (!r.ok) { form.error = 'PIN atual incorreto'; return false; }
          r.dataKey.fill(0);
          return app.auth.setPin(v.p1).then(k => app.vault.rekey(k)).then(() => { if (app.top === form) app.pop(); app.flash = { text: 'PIN alterado', until: app.now() + 800 }; return true; });
        });
      }, { protected: true }));
    }

    openWifi() {
      const w = this.p.wifi;
      return this.push(new V.MenuView(S.SETTINGS, 'Wi-Fi', (a) => [
        { label: 'Estado', value: () => { const s = w.status(); return s.connected ? s.ssid : (s.error || 'desconectado'); } },
        { label: 'Conectar', select: () => w.connect() },
        { label: 'Adicionar rede', select: (x) => x.addWifiFlow() },
        ...w.list().map(n => ({ label: 'Rede: ' + n.ssid, value: () => 'DEL', del: () => w.remove(n.ssid), select: () => w.connect(n.ssid) }))
      ], { protected: true }));
    }

    addWifiFlow() {
      const ssidEd = new V.EditorView(S.TEXT_ENTRY, 'SSID', (ssid, app) => {
        app.pop();
        app.push(new V.EditorView(S.TEXT_ENTRY, 'Senha', (pass, app2, ed) => {
          app2.p.wifi.add(ssid, pass);
          ed.buf.wipe();
          app2.pop();
          app2.p.wifi.connect(ssid);
        }, { masked: true, method: app.settings.textMethod }));
      }, { method: this.settings.textMethod });
      return this.push(ssidEd);
    }

    openDiagnostics() {
      const b = this.battery();
      const w = this.p.wifi ? this.p.wifi.status() : {};
      const cd = this.p.camera && this.p.camera.diag ? this.p.camera.diag() : { text: 'n/d' };
      const lat = this.lockLatencies;
      const blocks = [
        { kind: 'title', text: 'Diagnostico' },
        { kind: 'text', text: 'Bateria: ' + (b.supported ? b.percent + '%' + (b.charging ? ' carregando' : '') : 'sem circuito de medicao') },
        { kind: 'text', text: 'Wi-Fi: ' + (w.connected ? 'conectado ' + w.ssid + ' RSSI ' + w.rssi : 'desconectado') },
        { kind: 'text', text: 'Camera: ' + cd.text },
        { kind: 'text', text: 'Bloqueio privacidade: ' + (lat.length ? 'ultimo ' + lat[lat.length - 1].toFixed(2) + ' ms, max ' + Math.max(...lat).toFixed(2) + ' ms (n=' + lat.length + ')' : 'sem medicoes') },
        { kind: 'text', text: 'Plataforma: ' + (this.p.name || '?') }
      ];
      return this.push(new V.ReaderView(S.SETTINGS, 'Diag', blocks, { protected: true }));
    }

    /* ---------------- self diagnostics (no secrets, no protected content) ---------------- */
    openSelfTest() {
      const st = S.SETTINGS;
      const show = (title, rows) => this.push(new V.ReaderView(st, title, [{ kind: 'title', text: title }, ...rows.map(r => ({ kind: 'text', text: (r.ok === true ? 'OK  ' : r.ok === false ? 'FALHA ' : '--  ') + r.t }))], { protected: true }));
      const items = [
        { label: 'LCD (padroes)', select: (a) => a.push(lcdPatternView(st)) },
        { label: 'Teclado e setas', select: (a) => a.push(keyTestView(st)) },
        { label: 'Camera / JPEG', select: async (a) => {
          const cam = a.p.camera;
          try { await cam.init({ resolution: 'QVGA', quality: 20 }); const img = await cam.capture({ resolution: 'QVGA', quality: 20 });
            const jpegOk = img.data[0] === 0xFF && img.data[1] === 0xD8; img.data.fill(0); cam.deinit();
            show('Camera', [{ ok: true, t: 'Sensor iniciado' }, { ok: jpegOk, t: 'Captura JPEG ' + img.width + 'x' + img.height }]);
          } catch (e) { try { cam.deinit(); } catch (x) { /* ignore */ } show('Camera', [{ ok: false, t: e.message }]); }
        } },
        { label: 'Armazenamento', select: (a) => {
          let ok = false;
          try { a.p.storage.set('selftest', 'x1'); ok = a.p.storage.get('selftest') === 'x1'; a.p.storage.remove('selftest'); } catch (e) { ok = false; }
          show('Armazenamento', [{ ok, t: 'Escrita/leitura' }, { ok: !a.vault.corrupt, t: 'Cofre integro' }]);
        } },
        { label: 'Wi-Fi e servidor', select: async (a) => {
          const w = a.p.wifi.status();
          const rows = [{ ok: w.connected, t: 'Wi-Fi ' + (w.connected ? w.ssid : 'desconectado') }];
          try { const r = await a.p.ai.status(); rows.push({ ok: !!(r && r.authorized), t: 'Servidor: dispositivo autorizado' }); }
          catch (e) { rows.push({ ok: false, t: 'Servidor: ' + e.message }); }
          if (a.top && a.top.state === st) show('Rede', rows);
        } },
        { label: 'Bateria', select: (a) => { const b = a.battery(); show('Bateria', [{ ok: b.supported ? !b.low : null, t: b.supported ? b.percent + '%' : 'sem circuito de medicao' }]); } },
        { label: 'PSRAM / Flash', select: () => show('Memoria', [{ ok: null, t: 'Somente no hardware (firmware)' }]) },
        { label: 'Tecla ON', select: () => show('Tecla ON', [{ ok: null, t: 'Pressione ON: deve voltar ao modo NORMAL e encerrar a sessao.' }]) }
      ];
      return this.push(new V.MenuView(st, 'Autodiagnostico', items, { protected: true }));
    }

    openOta() {
      const ota = this.p.ota;
      const view = new V.BusyView(S.SETTINGS, () => view.lines2, { onCancel: (a) => a.pop() });
      view.isAi = false;
      view.lines2 = ['Verificando...'];
      this.push(view);
      if (!ota) { view.lines2 = ['OTA indisponivel']; return view; }
      ota.check().then(r => {
        if (!r.available) { view.lines2 = ['Firmware atual', 'v' + r.current]; return; }
        view.lines2 = ['Nova versao v' + r.version, 'Aplicando...'];
        return ota.apply(p => { view.lines2 = ['Atualizando', p + '%']; }).then(
          res => { view.lines2 = res.ok ? ['Atualizado v' + r.version, 'Reinicie'] : ['Falha: ' + res.error, 'Mantida versao atual']; });
      }).catch(e => { view.lines2 = ['Erro OTA:', String(e.message || e)]; });
      return view;
    }
  }

  return { App, Calculator: Sci.SciCalc, STATES: S, COMBOS, DEFAULT_SETTINGS, RESOLUTIONS };
});
