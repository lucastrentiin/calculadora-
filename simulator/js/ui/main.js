/* Browser glue: LCD canvas, clickable keypad, PC keyboard, simulation panel. */
(function () {
  'use strict';
  const { Keys, SimPlatform, Framebuffer } = window.MT;
  const App = window.MT.AppModule.App;
  const $ = (id) => document.getElementById(id);

  /* ---------- platform (simulated) ---------- */
  const storage = new SimPlatform.LocalStorage('mt.');
  const logEl = $('log');
  function log(evt, data) {
    const line = new Date().toLocaleTimeString() + ' ' + evt + (data && Object.keys(data).length ? ' ' + JSON.stringify(data) : '');
    logEl.textContent = (line + '\n' + logEl.textContent).slice(0, 8000);
  }
  let webcamStream = null;
  const camVideo = document.createElement('video');
  camVideo.muted = true; camVideo.playsInline = true;

  function drawSynthetic(ctx, w, h) {
    ctx.fillStyle = '#f4f1e8'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c9d6e8'; ctx.lineWidth = Math.max(1, w / 400);
    for (let y = h / 10; y < h; y += h / 10) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.fillStyle = '#1b2a6b'; ctx.font = `italic ${Math.round(h / 7)}px Georgia, serif`;
    ctx.fillText($('camText').value, w * 0.08, h * 0.55);
  }
  function drawFrame(ctx, w, h) {
    if (webcamStream && camVideo.readyState >= 2) ctx.drawImage(camVideo, 0, 0, w, h); else drawSynthetic(ctx, w, h);
  }
  async function makeJpeg(w, h, quality) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    drawFrame(c.getContext('2d'), w, h);
    const q = Math.max(0.1, Math.min(0.95, 1 - (quality - 4) / 70)); // esp32-camera: lower = better
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', q));
    return new Uint8Array(await blob.arrayBuffer());
  }

  const platform = SimPlatform.createPlatform({ storage, log, cameraOpts: { makeJpeg } });
  const mockAi = platform.ai;
  let app = new App(platform, { width: 128, height: 32 });
  window.app = app; // handy for debugging in the console

  /* ---------- LCD ---------- */
  const lcd = $('lcd');
  const ctx = lcd.getContext('2d');
  const img = ctx.createImageData(128, 32);
  function paint() {
    const fb = app.render();
    const px = fb.pixels;
    for (let i = 0; i < px.length; i++) {
      const on = px[i];
      img.data[i * 4] = on ? 27 : 159; img.data[i * 4 + 1] = on ? 36 : 176; img.data[i * 4 + 2] = on ? 22 : 138; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    fb.resetDirty();
    $('stateBadge').textContent = app.state;
    $('stateOut').textContent = app.state + (app.isProtected ? ' (protegido)' : '');
    if (app.lastLock) $('lockOut').textContent = app.lastLock.ms.toFixed(2) + ' ms (' + app.lastLock.reason + ' de ' + app.lastLock.from + ')';
  }
  platform.requestRender = paint;
  setInterval(() => { app.tick(); paint(); }, 50);

  /* ---------- keypad ---------- */
  const pad = $('keypad');
  const FN = new Set(['SHIFT', 'ALPHA', 'MODE', 'MENU', 'FRAC', 'STO', 'RCL', 'DEL', 'AC']);
  const REPEATABLE = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT', 'DEL']);
  const REPEAT = { off: null, lenta: [600, 250], normal: [450, 140], rapida: [300, 70] };

  function press(ev) {
    const t0 = performance.now();
    app.handleKey(ev);
    paint();
    if (ev.key === 'ON') log('tecla ON', { ms: (performance.now() - t0).toFixed(2) });
  }

  function makeKey(code, label, shiftLabel) {
    const b = document.createElement('button');
    b.className = 'key' + (FN.has(code) ? ' fn' : '') + (code === 'EQ' ? ' eq' : '') + (code === 'ON' ? ' on' : '');
    if (shiftLabel) { const s = document.createElement('span'); s.className = 'sh'; s.textContent = shiftLabel; b.appendChild(s); }
    b.appendChild(document.createTextNode(label));
    b.setAttribute('aria-label', code);
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; b.classList.remove('down'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.classList.add('down');
      press({ key: code });
      const rep = REPEAT[app.settings.keyRepeat];
      if (rep && REPEATABLE.has(code)) timer = setTimeout(() => { timer = setInterval(() => press({ key: code }), rep[1]); }, rep[0]);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => b.addEventListener(t, stop));
    return b;
  }
  function row(keys) {
    const r = document.createElement('div');
    r.className = 'row'; r.style.gridTemplateColumns = `repeat(${keys.length}, 1fr)`;
    keys.forEach(k => r.appendChild(makeKey(...k)));
    return r;
  }
  Keys.LAYOUT.forEach((keys, i) => {
    pad.appendChild(row(keys));
    if (i === 0) {
      const d = document.createElement('div'); d.className = 'dpad';
      const cells = [null, ['UP', '▲'], null, ['LEFT', '◀'], null, ['RIGHT', '▶'], null, ['DOWN', '▼'], null];
      cells.forEach(c => d.appendChild(c ? makeKey(c[0], c[1]) : document.createElement('span')));
      pad.appendChild(d);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const textMode = app.state === 'TEXT_ENTRY';
    const ev = Keys.fromKeyboard(e, textMode);
    if (!ev) return;
    e.preventDefault();
    press(ev);
  });

  /* ---------- simulation panel ---------- */
  $('wifiOn').onchange = (e) => { if (e.target.checked) platform.wifi.connect(); else platform.wifi.disconnect(); };
  const bat = () => { platform.battery.supported = $('batSupported').checked; platform.battery.percent = Number($('batLevel').value); platform.battery.charging = $('batCharging').checked; $('batOut').textContent = $('batLevel').value + '%'; };
  ['batSupported', 'batLevel', 'batCharging'].forEach(id => { $(id).oninput = bat; });

  function configureAi() {
    mockAi.failMode = $('aiFail').value;
    mockAi.latencyMs = Number($('aiLatency').value) || 0;
    if ($('aiSource').value === 'http') {
      try {
        platform.ai = new SimPlatform.HttpAI({ baseUrl: $('aiUrl').value, remoteUrl: $('aiRemote').value, deviceId: $('aiDevice').value, deviceKeyB64: $('aiKey').value,
          accessClientId: $('aiCfId').value, accessClientSecret: $('aiCfSecret').value });
        log('IA: servidor domestico', {});
      }
      catch (e) { log('IA: configuracao invalida', { erro: e.message }); platform.ai = mockAi; }
    } else platform.ai = mockAi;
  }
  ['aiSource', 'aiFail', 'aiLatency', 'aiUrl', 'aiRemote', 'aiDevice', 'aiKey', 'aiCfId', 'aiCfSecret'].forEach(id => { $(id).onchange = configureAi; });

  $('camFailInit').onchange = (e) => { platform.camera.failInit = e.target.checked; };
  $('camFailCap').onchange = (e) => { platform.camera.failCapture = e.target.checked; };
  $('camWebcam').onchange = async (e) => {
    if (e.target.checked) {
      try { webcamStream = await navigator.mediaDevices.getUserMedia({ video: true }); camVideo.srcObject = webcamStream; await camVideo.play(); }
      catch (err) { log('webcam indisponivel', { erro: err.message }); e.target.checked = false; }
    } else if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  };

  // simulated phone preview page
  const pv = $('preview'), pvCtx = $('pvCanvas').getContext('2d');
  let pvTimer = null;
  platform.preview.onChange((s) => {
    clearInterval(pvTimer);
    if (!s) { pv.classList.add('hidden'); return; }
    pv.classList.remove('hidden'); pv.parentElement.open = true;
    $('pvCode').textContent = s.code;
    pvTimer = setInterval(() => {
      drawFrame(pvCtx, 320, 240);
      if (Date.now() - s.startedAt > 120000) platform.preview.stop(); // automatic session end
    }, 200);
  });
  $('pvCapture').onclick = () => { const s = platform.preview.session; if (s && s.onCapture) s.onCapture(); };

  $('otaVer').onchange = (e) => { platform.ota.available = e.target.value.trim() || null; };
  $('otaFail').onchange = (e) => { platform.ota.failApply = e.target.checked; };
  $('btnReset').onclick = () => {
    if (!confirm('Apagar PIN, histórico, favoritos e ajustes do simulador?')) return;
    storage.clearAll();
    app = new App(platform, { width: 128, height: 32 }); window.app = app;
    log('dados do simulador apagados');
  };
  $('btnSelftest').onclick = async () => {
    const out = $('selftestOut');
    out.textContent = 'executando...';
    const res = await window.MT.SelfTest.run();
    out.textContent = res.map(r => (r.ok ? 'OK   ' : 'FALHA ') + r.name + (r.ok ? '' : ' -> ' + r.err)).join('\n');
  };

  void Framebuffer;
  paint();
})();
