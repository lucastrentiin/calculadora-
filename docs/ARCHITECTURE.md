# Arquitetura

## Visão geral

```
┌──────────── Terminal (ESP32-S3) ─────────────┐   HTTPS mt1    ┌──────────── Servidor doméstico (Node 22, TS) ───────────────┐
│ keypad ─► app_state ─► display               │  (HMAC por     │ listener 127.0.0.1:SERVER_LOCAL_PORT  ◄── cloudflared       │
│   ├─ calculator (fx-82MS) ─ math_engine      │   dispositivo) │ listener LAN HTTPS (opcional)                               │
│   ├─ authentication / security / vault       │ ─────────────► │ deviceApi /api/v1  ─ devices (HMAC, anti-replay, Access JWT) │
│   ├─ ai_client (worker, polling, failover)   │ ◄───────────── │ TaskManager (fila, idempotência, cancelamento, paginação)   │
│   ├─ camera / preview, wifi, ota, power      │                │ Registry ─► Mock │ Manual │ Claude Code CLI │ Codex CLI      │
│   └─ privacy_lock (ON)                       │                │             │ API Anthropic │ API OpenAI │ (SIWC: indisp.)  │
└──────────────────────────────────────────────┘                │ verify (motor matemático do simulador) ─ SQLite cifrado     │
                                                                │ adminApi /admin ─ painel (senha scrypt + TOTP + Access)     │
                                                                └──────────────────────────────────────────────────────────────┘
```

O **simulador** (`simulator/js/core/*`) é a referência executável: mesma gramática
matemática, mesmos estados, mesmo protocolo. O servidor reutiliza o motor matemático do
simulador para verificar as respostas dos provedores. Fontes, fórmulas e conversões do
firmware são geradas a partir do simulador (`npm run gen`, conferido no CI).

## Máquina de estados (terminal)

| Estado | Entrada | Saída |
|---|---|---|
| NORMAL | sempre no boot; após bloqueio | combinação (SSAA/ASAS/AASS) → AUTH_PENDING; MENU → ferramentas offline |
| AUTH_PENDING | combinação | PIN correto → AUTHENTICATED (novo `session_id`); errado/AC/timeout/outra tecla → NORMAL silencioso |
| AUTHENTICATED | menu protegido: 1 Perguntar, 2 Câmera, 3 Ferramentas, 4 Favoritos, 5 Histórico, 6 Modo, 7 Assistente, 8 Ajustes, 9 Bloquear | |
| TEXT_ENTRY | Perguntar / Wi-Fi | envio → AI_REQUEST |
| AI_REQUEST | requisição | resultado da **mesma sessão** → AI_RESPONSE; AC cancela |
| AI_RESPONSE | leitura com rolagem | |
| CAMERA | menu | captura → AI_REQUEST |
| MATH_TOOLS / SETTINGS | menus | |
| PRIVACY_LOCK | ON, inatividade, suspensão, bateria crítica, saída do menu | transitório → NORMAL |

## Protocolo mt1 (terminal ↔ servidor)

* Autenticação: `HMAC-SHA256(chave, MÉTODO\nCAMINHO?query\nTS\nNONCE\nhex(sha256(corpo)))` nos
  cabeçalhos `X-Device-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature`, `X-Protocol: mt1`;
  janela de ±5 min, nonce de uso único. Pelo túnel, também `CF-Access-Client-Id/Secret`
  (token de serviço) → JWT do Access validado pelo servidor.
* `POST /api/v1/ai/ask` (JSON: `request_id`, `session_id`, `question`, `mode`, `provider`) e
  `POST /api/v1/ai/vision` (JPEG bruto + `X-Request-Id`, `X-Mode`, `X-Provider`, `X-Session-Id`, `X-Prompt`).
* Resposta `200` (resultado v1) ou `202` (em processamento) → `GET /api/v1/requests/:id?wait=20000`
  (*long polling*, abaixo do limite de ~100 s da Cloudflare); passos longos paginados (`?page=n`),
  o terminal junta as páginas.
* `POST /api/v1/requests/cancel {"request_id"}` → "cancelado no servidor", "já concluído" ou
  "desconhecido"; o terminal registra o resultado (*Ajustes → Req. canceladas*).
* Failover LAN → túnel **somente antes do envio**: uma requisição que já saiu nunca é
  reenviada automaticamente a outro endereço ou provedor.
* Também: `/device/register` (código de uso único), `/device/status`, `/device/config`
  (provedores que o proprietário liberou), `/device/diagnostics`, `/updates/manifest`,
  `/updates/firmware`, `/health`.

## Sessão e respostas tardias

Cada autenticação gera um `session_id` aleatório. A requisição carrega esse id; o resultado
só é exibido se o aparelho ainda estiver na mesma sessão, no estado AI_REQUEST, com a mesma
geração de requisição. Bloqueio, novo login, cancelamento ou reinício descartam o resultado
(apagado da RAM). O boot é sempre em NORMAL.

## Bloqueio de privacidade (ON)

Ganchos não bloqueantes, em ordem: (1) UI — remove telas (cada uma apaga seus buffers),
encerra a sessão e o `session_id`, invalida PBKDF2 em andamento, pede *flush* do LCD;
(2) cancelamento — nova geração no cliente de IA (resultado tardio descartado), câmera e
prévia param, cancelamento remoto se já enviado; (3) limpeza — fecha o cofre. Latência
medida (`pl_get_stats`); meta < 100 ms a confirmar no LCD real.

## Servidor: provedores

Interface comum `AIProvider` (`info`, `refresh`, `executeText`, `executeImage`, `cancel`).
Seleção por política do proprietário (padrão + reserva opcional, nunca automática para
provedor faturável sem autorização). Detalhes: [PROVIDERS.md](PROVIDERS.md).

## Firmware: camadas

* Portáveis (host-testadas): `math_engine`, `calculator`, `display`, `math_renderer`,
  `virtual_keyboard`, `security`, `authentication`, `history`, `favorites`, `settings`,
  `ai_client` (protocolo), `privacy_lock`, `power_manager`, `keypad` (núcleo), `formulas`,
  `conversions`, `app_state`.
* ESP-IDF (`*_esp.c`, compilam no CI): matriz de teclado, transporte HTTPS, câmera/prévia,
  Wi-Fi, OTA, ADC/suspensão, `main.c`.
* Inexistente por falta de dado de hardware: driver do controlador do LCD (interface pronta;
  drivers `console` e `null` para bring-up).
