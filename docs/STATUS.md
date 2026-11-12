# Estado da implementação

Legenda: **Real** = funcional e coberto por testes automatizados · **Simulado** = existe só no
simulador · **Escrito** = código ESP-IDF compilado no CI, **nunca executado em hardware** ·
**Pendente** = depende de dado/equipamento inexistente · **Não verificado** = depende de
conta/serviço externo não disponível aqui.

| Requisito | Simulador | Firmware (C) | Servidor | Observação |
|---|---|---|---|---|
| Modo NORMAL estilo DEXIN KK-82MS-B (COMP/SD/REG, Deg/Rad/Gra, Fix/Sci/Norm/ENG, frações, DMS, Pol/Rec, nCr/nPr, memórias, erros) | Real | Real (host) | — | comparação com a unidade física **pendente** (DEXIN_COMPAT.md) |
| Motor matemático sem `eval`, passo a passo | Real | Real | Real (verificação) | |
| Equações, sistemas, estatística, fórmulas (46), conversões | Real | Real | — | matrizes/tabela só no simulador |
| Estados, PIN discreto, tentativas, sessão com id | Real | Real | — | |
| Tecla ON / PRIVACY_LOCK | Real | Real (host) | cancelamento Real | latência no LCD real: medir |
| Rolagem, teclado virtual (A) e multi-tap (B), acessibilidade | Real | Real | — | |
| Histórico/favoritos cifrados | Real (WebCrypto) | Real (AES-GCM) | Real (opcional, desligado por padrão) | |
| Protocolo mt1 (HMAC, 202/polling, paginação, cancelamento, failover antes do envio) | Real (E2E com servidor) | Real (host, transporte falso) | Real | transporte HTTPS ESP: Escrito |
| Aviso de privacidade, menu Assistente (provedores), diagnóstico enviado ao servidor | Real | Real (host) | Real | |
| Provedores: Mock, Manual | Real | — | Real | |
| Provedores: Claude Code CLI, Codex CLI | — | — | Real com binários falsos | contas reais: **Não verificado** |
| Provedores: API Anthropic, API OpenAI | — | — | Real com clientes falsos | chaves reais: **Não verificado** |
| Sign in with ChatGPT | — | — | marcado indisponível | exige client_id aprovado |
| Painel (dashboard, apps, dispositivos, config, histórico, manual, remoto, OTA, segurança) | — | — | Real | |
| Cloudflare Tunnel + Access | — | token no NVS: Real (host) | verificação JWT Real (JWT local) | conta Cloudflare: **Não verificado** |
| Listener LAN HTTPS + CA local | — | CA só para LAN: Escrito | Real (testado com curl) | |
| Implantação Linux (systemd, instalador, backup) | — | — | scripts testados parcialmente | systemd/instalação real: **não executados aqui** |
| Câmera OV3660 + prévia no celular | Simulado | Escrito | — | pinos pendentes |
| Wi-Fi e provisionamento | Simulado | Escrito | — | |
| OTA assinado pelo servidor + rollback | Simulado | Escrito | Real | |
| Bateria, suspensão | Simulado | política Real; ADC/sleep Escritos | — | circuito pendente |
| Driver do LCD | Canvas | **Pendente** | — | controlador não definido |
| Teclado físico | botões/PC | matriz Escrita | — | pinos/mapa pendentes |
| Flash Encryption / Secure Boot / NVS cifrado | — | configuração pronta | — | **só no hardware; não validado** |
