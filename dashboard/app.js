/* Painel do servidor domestico. Sem dependencias externas; todo texto dinamico via textContent. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const main = $('#main');
  let csrf = '';

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'class') e.className = v;
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  }
  const card = (title, ...kids) => el('div', { class: 'card' }, title ? el('h2', {}, title) : null, ...kids);
  const badge = (s) => el('span', { class: 'badge ' + s }, s);
  const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500); }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.method = opts.method || 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (init.method !== 'GET') init.headers['X-CSRF-Token'] = csrf;
    const r = await fetch('/admin/api' + path, init);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('login necessario'); }
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return j;
  }
  const act = (fn) => async (ev) => { try { ev && ev.preventDefault && ev.preventDefault(); await fn(ev); } catch (e) { toast(e.message); } };

  /* ---------------- login ---------------- */
  async function showLogin() {
    $('#nav').classList.add('hidden'); $('#logoutBtn').classList.add('hidden'); $('#who').textContent = '';
    const st = await fetch('/admin/api/state').then(r => r.json()).catch(() => ({}));
    main.replaceChildren();
    if (!st.hasAdmin) {
      main.append(el('div', { class: 'card login' }, el('h2', {}, 'Configuração inicial'),
        el('p', {}, 'Nenhum proprietário cadastrado. Por segurança a conta é criada apenas no console do servidor:'),
        el('pre', {}, 'cd backend\nnpm run admin -- create <usuario>')));
      return;
    }
    const u = el('input', { autocomplete: 'username' }), p = el('input', { type: 'password', autocomplete: 'current-password' }), c = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });
    main.append(el('form', { class: 'card login', on: { submit: act(async () => {
      const j = await api('/login', { body: { username: u.value, password: p.value, code: c.value || undefined } });
      csrf = j.csrf; p.value = ''; boot();
    }) } }, el('h2', {}, 'Entrar'), el('label', {}, 'Usuário'), u, el('label', {}, 'Senha'), p,
      el('label', {}, 'Código TOTP' + (st.totp ? ' (obrigatório)' : ' (se cadastrado)')), c, el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit' }, 'Entrar'))));
  }

  /* ---------------- pages ---------------- */
  const pages = {
    async dashboard() {
      const d = await api('/dashboard');
      const s = d.server;
      return [el('h1', {}, 'Dashboard'), el('div', { class: 'grid' },
        card('Servidor', el('div', {}, 'Versão ' + s.version + ' · ' + s.profile), el('div', { class: 'muted' }, `${s.platform}/${s.arch} · Node ${s.node} · ${s.cpus} CPUs`),
          el('div', {}, `Memória livre ${s.memFreeMB}/${s.memTotalMB} MB · processo ${s.processRssMB} MB`), el('div', {}, 'Carga ' + s.load.join(' / ')),
          s.disk ? el('div', {}, `Disco livre ${s.disk.freeMB} MB`) : null, el('div', { class: 'muted' }, 'Em execução há ' + Math.round(s.processUptimeS / 60) + ' min')),
        card('Dispositivos', el('div', {}, `${d.devices.online} online de ${d.devices.total}`), el('div', {}, `${d.requests24h} solicitações em 24 h`), el('div', { class: 'muted' }, `fila ${d.tasks.queued} · executando ${d.tasks.running}`)),
        card('Provedor preferido', el('div', {}, d.policy.preferred), el('div', { class: 'muted' }, 'Failover automático: ' + (d.policy.allowFailover ? 'autorizado' : 'desligado'))),
        card('Integrações', ...d.providers.map(p => el('div', {}, badge(p.status), ' ', p.name, el('div', { class: 'muted' }, p.detail))))),
        card('Últimas falhas', d.failures.length ? el('table', {}, ...d.failures.map(f => el('tr', {}, el('td', {}, fmt(f.at)), el('td', {}, f.provider), el('td', {}, f.kind), el('td', {}, f.error)))) : el('div', { class: 'muted' }, 'Nenhuma'))];
    },

    async apps() {
      const d = await api('/providers');
      const secretCard = card('Chaves de API (opcionais, cobrança por uso)', el('p', { class: 'muted' }, 'Armazenadas criptografadas no servidor; nunca são exibidas nem enviadas ao dispositivo.'),
        ...d.secrets.map(s => {
          const inp = el('input', { type: 'password', placeholder: s.set ? '•••••• (configurada)' : 'não configurada', autocomplete: 'off' });
          return el('div', {}, el('label', {}, s.name), inp, el('div', { class: 'row' },
            el('button', { on: { click: act(async () => { await api('/secrets', { body: { name: s.name, value: inp.value } }); inp.value = ''; toast('salvo'); render(); }) } }, 'Salvar'),
            el('button', { class: 'danger', on: { click: act(async () => { await api('/secrets', { body: { name: s.name, value: null } }); toast('removida'); render(); }) } }, 'Remover')));
        }));
      const ids = d.providers.map(p => p.id);
      const pref = el('select', {}, ...ids.map(i => el('option', { value: i, selected: i === d.policy.preferred }, i)));
      const fail = el('input', { type: 'checkbox', checked: d.policy.allowFailover });
      const policy = card('Seleção', el('label', {}, 'Provedor preferido (modo AUTOMÁTICO)'), pref,
        el('label', { class: 'check' }, fail, 'Permitir repetir automaticamente em outro provedor após falha (pode gerar cobrança)'),
        el('div', { class: 'row' }, el('button', { class: 'primary', on: { click: act(async () => { await api('/selection', { body: { preferred: pref.value, allowFailover: fail.checked } }); toast('salvo'); }) } }, 'Salvar'),
          el('button', { on: { click: act(async () => { await api('/providers/refresh', { body: {} }); render(); }) } }, 'Atualizar estado')));
      const cards = d.providers.map(p => {
        const model = el('input', { value: p.model || '', placeholder: 'modelo (opcional)' });
        const ack = el('input', { type: 'checkbox' });
        const auth = p.id === 'claude_code' ? el('select', {}, el('option', { value: 'api_key' }, 'Chave de API (permitido pelos termos)'), el('option', { value: 'subscription' }, 'Assinatura do proprietário (uso pessoal)')) : null;
        const needsAck = p.id === 'codex_cli' || p.id === 'claude_code';
        const save = (extra) => act(async () => { const r = await api('/providers/' + p.id + '/settings', { body: Object.assign({ model: model.value }, extra) }); toast(r.info.statusDetail || r.info.status); render(); });
        return card(p.name,
          el('div', {}, badge(p.status), ' ', p.statusDetail),
          el('div', { class: 'muted' }, `Cobrança: ${p.billing} · Autenticação: ${p.auth.method} (${p.auth.state})${p.auth.detail ? ' — ' + p.auth.detail : ''}`),
          p.version ? el('div', { class: 'muted' }, 'Versão: ' + p.version) : null,
          el('div', { class: 'muted' }, `Texto: ${p.capabilities.supportsText ? 'sim' : 'não'} · Imagens: ${p.capabilities.supportsImages ? 'sim' : 'não'} · Saída estruturada: ${p.capabilities.supportsStructuredOutput ? 'sim' : 'não'}`),
          p.models.length ? el('div', { class: 'muted' }, 'Modelos: ' + p.models.slice(0, 30).join(', ')) : null,
          p.lastTest ? el('div', { class: 'muted' }, `Último teste ${fmt(p.lastTest.at)}: ${p.lastTest.ok ? 'ok' : 'falha'} — ${p.lastTest.detail}`) : null,
          el('ul', {}, ...p.notes.map(n => el('li', { class: 'muted' }, n))),
          ['mock', 'manual', 'siwc'].includes(p.id) ? null : el('div', {},
            el('label', {}, 'Modelo'), model, auth ? [el('label', {}, 'Modo de autenticação'), auth] : null,
            needsAck ? el('label', { class: 'check' }, ack, p.id === 'claude_code'
              ? 'Confirmo que sou o único usuário, que li os termos atuais da Anthropic e que o modo assinatura é apenas para meu uso pessoal (sem terceiros).'
              : 'Confirmo que revisei os termos e limites atuais do meu plano ChatGPT/Codex para este uso pessoal.') : null,
            el('div', { class: 'row' },
              el('button', { class: 'primary', on: { click: save(Object.assign({ enabled: true }, needsAck ? { acknowledged: ack.checked } : {}, auth ? { authMode: auth.value } : {})) } }, 'Salvar e habilitar'),
              el('button', { on: { click: save({ enabled: false }) } }, 'Desabilitar'),
              el('button', { on: { click: act(async () => { const r = await api('/providers/' + p.id + '/test', { body: {} }); toast((r.result.ok ? 'OK: ' : 'Falha: ') + r.result.detail); render(); }) } }, 'Testar'),
              p.id === 'codex_cli' ? el('button', { class: 'danger', on: { click: act(async () => { await api('/providers/codex_cli/logout', { body: {} }); toast('desconectado'); render(); }) } }, 'Desconectar conta') : null)),
          p.id === 'codex_cli' && p.status === 'not_authenticated' ? el('pre', {}, 'No servidor, como usuário do serviço:\n  sudo -u terminalmat -H codex login') : null,
          p.id === 'claude_code' && p.status === 'not_authenticated' ? el('pre', {}, 'No servidor, como usuário do serviço:\n  sudo -u terminalmat -H claude auth login') : null);
      });
      return [el('h1', {}, 'Aplicativos de IA'), policy, secretCard, ...cards];
    },

    async devices() {
      const d = await api('/devices');
      const name = el('input', { placeholder: 'nome do dispositivo' });
      const out = el('pre', { class: 'hidden' });
      return [el('h1', {}, 'Dispositivos'),
        card('Cadastrar dispositivo', name, el('div', { class: 'row' }, el('button', { class: 'primary', on: { click: act(async () => {
          const r = await api('/devices/enroll', { body: { name: name.value } });
          out.textContent = `Código de cadastro (uso único, ${r.expiresInMin} min): ${r.code}\nNo dispositivo/ferramenta: POST /api/v1/device/register {"code": "..."}`;
          out.classList.remove('hidden');
        }) } }, 'Gerar código')), out),
        ...d.devices.map(x => {
          const nm = el('input', { value: x.name });
          const keyOut = el('pre', { class: 'hidden' });
          return card(x.id, el('div', {}, badge(x.enabled ? 'ok' : 'bad'), ' ', x.enabled ? 'autorizado' : 'revogado'),
            el('div', { class: 'muted' }, `Firmware ${x.firmware || '?'} · último acesso ${fmt(x.last_seen)} · IP ${x.last_ip || '—'}`),
            el('div', { class: 'muted' }, `Autodiagnóstico: ${x.last_status || '—'} · OTA: ${x.ota_state || '—'}`), nm,
            el('div', { class: 'row' },
              el('button', { on: { click: act(async () => { await api(`/devices/${x.id}/rename`, { body: { name: nm.value } }); toast('renomeado'); }) } }, 'Renomear'),
              x.enabled ? el('button', { class: 'danger', on: { click: act(async () => { await api(`/devices/${x.id}/revoke`, { body: {} }); render(); }) } }, 'Revogar')
                : el('button', { on: { click: act(async () => { await api(`/devices/${x.id}/authorize`, { body: {} }); render(); }) } }, 'Autorizar'),
              el('button', { on: { click: act(async () => { const r = await api(`/devices/${x.id}/rotate`, { body: {} }); keyOut.textContent = 'Nova chave (exibida uma vez): ' + r.device_key + '\n' + r.note; keyOut.classList.remove('hidden'); }) } }, 'Rotacionar chave'),
              el('button', { on: { click: act(async () => { const r = await api(`/devices/${x.id}/diag`); keyOut.textContent = JSON.stringify(r.reports, null, 2); keyOut.classList.remove('hidden'); }) } }, 'Diagnósticos'),
              el('button', { class: 'danger', on: { click: act(async () => { if (confirm('Excluir ' + x.id + '?')) { await api(`/devices/${x.id}/delete`, { body: {} }); render(); } }) } }, 'Excluir')), keyOut);
        })];
    },

    async settings() {
      const s = await api('/settings');
      const mode = el('select', {}, ...['fast', 'short', 'full'].map(m => el('option', { value: m, selected: s.defaultMode === m }, { fast: 'Rápido', short: 'Curto', full: 'Completo' }[m])));
      const ck = (k, t) => { const i = el('input', { type: 'checkbox', checked: s.privacy[k] }); i.dataset.k = k; return [i, el('label', { class: 'check' }, i, t)]; };
      const items = [ck('historyQuestions', 'Guardar texto das perguntas no histórico'), ck('historyResponses', 'Guardar respostas no histórico'), ck('storeImages', 'Manter imagens após o processamento (padrão: não)'), ck('diagLogs', 'Guardar relatórios de diagnóstico')];
      const ret = el('input', { type: 'number', min: '1', max: '3650', value: s.privacy.retentionDays });
      const sess = el('input', { type: 'number', min: '5', max: '720', value: s.sessionMinutes });
      return [el('h1', {}, 'Configurações'),
        card('Respostas', el('label', {}, 'Modo de resposta padrão'), mode),
        card('Privacidade e retenção', el('p', { class: 'muted' }, 'Perguntas e imagens enviadas a um provedor externo são processadas por esse serviço segundo as políticas dele. Desligar o histórico apaga os registros existentes.'),
          ...items.map(x => x[1]), el('label', {}, 'Retenção (dias)'), ret),
        card('Sessão do painel', el('label', {}, 'Expiração por inatividade (min)'), sess),
        card('Limites e rede (somente leitura; definidos no arquivo de ambiente)', el('pre', {}, JSON.stringify({ limits: s.limits, network: s.network }, null, 2))),
        el('button', { class: 'primary', on: { click: act(async () => {
          const privacy = { retentionDays: Number(ret.value) };
          for (const [i] of items) privacy[i.dataset.k] = i.checked;
          await api('/settings', { body: { defaultMode: mode.value, privacy, sessionMinutes: Number(sess.value) } });
          toast('salvo');
        }) } }, 'Salvar configurações')];
    },

    async history() {
      const q = el('input', { placeholder: 'pesquisar' });
      const list = el('div');
      const load = act(async () => {
        const d = await api('/history?q=' + encodeURIComponent(q.value));
        list.replaceChildren(...(d.items.length ? d.items.map(h => card(fmt(h.at) + ' · ' + h.provider + ' · ' + h.mode,
          h.question ? el('div', {}, 'P: ' + h.question) : el('div', { class: 'muted' }, '(pergunta não armazenada)'),
          h.response ? el('pre', {}, (() => { try { const r = JSON.parse(h.response); return r.answer + '\n' + (r.steps || []).map(s => '- ' + s.title + ': ' + s.math).join('\n'); } catch { return h.response; } })()) : null,
          el('div', { class: 'row' }, el('button', { on: { click: act(async () => { await api('/favorites', { body: { kind: 'resolution', title: (h.question || 'resolução').slice(0, 60), content: h.response || h.question } }); toast('favoritado'); }) } }, 'Favoritar'),
            el('button', { class: 'danger', on: { click: act(async () => { await api('/history/delete', { body: { id: h.id } }); load(); }) } }, 'Apagar'))))
          : [el('div', { class: 'muted' }, 'Sem registros (o histórico pode estar desativado em Configurações).')]));
      });
      const favs = el('div');
      const loadFav = act(async () => {
        const d = await api('/favorites');
        favs.replaceChildren(...d.items.map(f => card(f.kind + ': ' + f.title, el('pre', {}, f.content), el('button', { class: 'danger', on: { click: act(async () => { await api('/favorites', { body: { deleteId: f.id } }); loadFav(); }) } }, 'Remover'))));
      });
      const ft = el('input', { placeholder: 'título' }), fc = el('textarea', { placeholder: 'fórmula ou resolução' });
      setTimeout(() => { load(); loadFav(); });
      return [el('h1', {}, 'Histórico e favoritos'),
        card('Histórico', el('div', { class: 'row' }, q, el('button', { on: { click: load } }, 'Pesquisar'),
          el('a', { class: 'btn', href: '/admin/api/history/export' }, 'Exportar meus dados'),
          el('button', { class: 'danger', on: { click: act(async () => { if (confirm('Apagar todo o histórico?')) { await api('/history/delete', { body: { all: true } }); load(); } }) } }, 'Apagar tudo')), list),
        card('Salvar fórmula ou resolução', ft, fc, el('div', { class: 'row' }, el('button', { on: { click: act(async () => { await api('/favorites', { body: { kind: 'formula', title: ft.value, content: fc.value } }); ft.value = fc.value = ''; loadFav(); }) } }, 'Salvar'))),
        el('h2', {}, 'Favoritos'), favs];
    },

    async manual() {
      const d = await api('/manual');
      return [el('h1', {}, 'Integração manual'),
        el('p', { class: 'muted' }, 'Não é integração automática: copie a pergunta (ou baixe a imagem) para o aplicativo oficial, depois cole aqui a resposta. A primeira linha vira o resultado; as demais, etapas.'),
        ...(d.pending.length ? d.pending.map(p => {
          const ans = el('textarea', { placeholder: 'cole a resposta' });
          const img = p.hasImage ? el('img', { class: 'preview', alt: 'imagem enviada' }) : null;
          if (img) fetch(`/admin/api/manual/${p.deviceId}/${p.id}/image`, { credentials: 'same-origin' }).then(r => r.blob()).then(b => { img.src = URL.createObjectURL(b); });
          return card(fmt(p.createdAt) + ' · ' + p.deviceId, p.question ? el('pre', {}, p.question) : null, img,
            p.question ? el('button', { on: { click: act(async () => { await navigator.clipboard.writeText(p.question); toast('copiado'); }) } }, 'Copiar pergunta') : null,
            ans, el('div', { class: 'row' }, el('button', { class: 'primary', on: { click: act(async () => { await api(`/manual/${p.deviceId}/${p.id}`, { body: { answer: ans.value } }); toast('enviado ao dispositivo'); render(); }) } }, 'Responder')));
        }) : [card(null, el('div', { class: 'muted' }, 'Nenhuma pergunta aguardando.'))])];
    },

    async remote() {
      const r = await api('/remote');
      return [el('h1', {}, 'Acesso remoto'), el('div', { class: 'grid' },
        card('Cloudflare', el('div', {}, 'Subdomínio: ' + (r.publicHostname || 'não configurado')), el('div', {}, 'Túnel: ' + r.tunnel + (r.tunnelId ? ' (' + r.tunnelId + ')' : '')),
          el('div', {}, 'cloudflared: ' + (r.cloudflaredInstalled ? r.cloudflaredVersion : 'não instalado')), el('div', {}, 'Access: ' + (r.accessEnabled ? 'habilitado' : 'desligado')),
          el('div', {}, 'Dispositivos: ' + r.deviceAuthMode + ' · Painel: ' + r.adminAuthMode), el('div', {}, 'HTTPS: ' + r.https)),
        card('Rede local', el('div', {}, 'LAN: ' + (r.lan.enabled ? 'porta ' + r.lan.port + (r.lan.tls ? ' (TLS)' : ' (sem TLS!)') : 'desligada')))),
        card('Últimos acessos', el('table', {}, ...r.lastAccesses.map(a => el('tr', {}, el('td', {}, a.id), el('td', {}, a.name), el('td', {}, fmt(a.last_seen)), el('td', {}, a.last_ip || ''))))),
        card('Erros de acesso', el('table', {}, ...r.recentErrors.map(e => el('tr', {}, el('td', {}, fmt(e.at)), el('td', {}, e.event), el('td', {}, e.actor || '')))))];
    },

    async updates() {
      const d = await api('/updates');
      return [el('h1', {}, 'Atualizações (OTA)'),
        el('p', { class: 'muted' }, 'Firmwares são registrados no console (npm run admin -- ota-publish arquivo.bin) e só são distribuídos depois de aprovados aqui. A autenticidade é verificada no dispositivo (Secure Boot v2).'),
        card('Manifesto atual', el('pre', {}, JSON.stringify(d.manifest, null, 2))),
        ...d.firmware.map(f => card('v' + f.version, el('div', { class: 'muted' }, `${f.size} bytes · sha256 ${f.sha256.slice(0, 16)}… · hash de validação ${f.validation_hash ? f.validation_hash.slice(0, 16) + '…' : 'ausente'}`),
          el('div', {}, f.approved ? badge('ok') : badge('warn'), ' ', f.approved ? 'aprovado' : 'aguardando aprovação'),
          el('div', { class: 'row' }, el('button', { on: { click: act(async () => { await api('/updates/' + encodeURIComponent(f.version), { body: { approved: !f.approved } }); render(); }) } }, f.approved ? 'Retirar' : 'Aprovar'))))];
    },

    async security() {
      const s = await api('/security');
      const o = el('input', { type: 'password' }), n = el('input', { type: 'password' });
      return [el('h1', {}, 'Segurança'),
        card('Estado', el('div', {}, `Versão ${s.version} · perfil ${s.profile} · TOTP ${s.totpRequired ? 'obrigatório' : 'opcional'} · ${s.accessMode}`)),
        card('Sessões ativas', el('table', {}, ...s.sessions.map(x => el('tr', {}, el('td', {}, x.username), el('td', {}, fmt(x.created_at)), el('td', {}, x.ip || ''), el('td', {}, x.ua || ''),
          el('td', {}, el('button', { class: 'danger', on: { click: act(async () => { await api('/security/sessions/' + x.id + '/revoke', { body: {} }); render(); }) } }, 'Encerrar')))))),
        card('Trocar senha', el('label', {}, 'Atual'), o, el('label', {}, 'Nova (mín. 12)'), n,
          el('div', { class: 'row' }, el('button', { on: { click: act(async () => { await api('/security/password', { body: { old: o.value, new: n.value } }); toast('senha alterada; entre novamente'); showLogin(); }) } }, 'Alterar'))),
        card('Log de segurança (sem dados sensíveis)', el('table', {}, ...s.log.map(l => el('tr', {}, el('td', {}, fmt(l.at)), el('td', {}, l.event), el('td', {}, l.actor || ''), el('td', {}, l.detail || '')))))];
    },
  };

  async function render() {
    const name = (location.hash || '#dashboard').slice(1);
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + name));
    try { main.replaceChildren(...(await (pages[name] || pages.dashboard)())); } catch (e) { if (e.message !== 'login necessario') main.replaceChildren(card('Erro', e.message)); }
  }

  async function boot() {
    try {
      const me = await api('/me');
      csrf = me.csrf;
      $('#who').textContent = me.username;
      $('#nav').classList.remove('hidden');
      $('#logoutBtn').classList.remove('hidden');
      render();
    } catch { /* showLogin already called */ }
  }
  window.addEventListener('hashchange', render);
  $('#logoutBtn').addEventListener('click', act(async () => { await api('/logout', { body: {} }); csrf = ''; showLogin(); }));
  $('#menuBtn').addEventListener('click', () => $('#nav').classList.toggle('hidden'));
  boot();
})();
