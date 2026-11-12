# Arquitetura

## Visão geral

```
 ┌──────────── Dispositivo (ESP32-S3) ────────────┐        ┌──── Backend (Node/TS) ────┐
 │ keypad ─► app_state ─► display (framebuffer)   │ HTTPS  │ auth HMAC por dispositivo │
 │             │  ├─ calculator / math_engine     │ ─────► │ limites, validação JPEG   │──► API Claude
 │             │  ├─ authentication / security    │ JSON   │ cancelamento explícito    │   (chave só aqui)
 │             │  ├─ history / favorites (cofre)  │ ◄───── │ resposta v1 validada      │
 │             │  ├─ ai_client (worker)           │        └───────────────────────────┘
 │             │  ├─ camera (tarefa própria)      │
 │             │  ├─ wifi / ota / power_manager   │
 │             └─ privacy_lock (ganchos)          │
 └────────────────────────────────────────────────┘
```

O **simulador** implementa o mesmo modelo em JavaScript (`simulator/js/core/*`), com
serviços de plataforma simulados (`simulator/js/sim/platform.js`). O firmware em C segue as
mesmas regras, gramática matemática, contrato de resposta e códigos de erro. Fontes, tabela
de fórmulas e fatores de conversão do firmware são **gerados** a partir do simulador
(`npm run gen`), e o CI verifica se estão atualizados.

## Máquina de estados

| Estado | Entrada | Saída |
|---|---|---|
| NORMAL | inicial; após bloqueio | combinação → AUTH_PENDING; MENU → MATH_TOOLS (não protegido) |
| AUTH_PENDING | combinação configurável | PIN correto → AUTHENTICATED; errado/AC/timeout/outra tecla → NORMAL (silencioso) |
| AUTHENTICATED | sessão aberta (menu protegido) | itens do menu; AC no menu raiz encerra a sessão |
| TEXT_ENTRY | Perguntar / SSID / senha | `SHIFT+=` ou `=` (método B) envia |
| AI_REQUEST | envio | resposta → AI_RESPONSE; AC cancela |
| AI_RESPONSE | resposta/erro | leitura com rolagem; `=` troca o modo de exibição |
| CAMERA | menu | captura → AI_REQUEST |
| MATH_TOOLS | menu (protegido ou não) | ferramentas offline |
| SETTINGS | menu | ajustes, PIN, Wi-Fi, OTA, diagnóstico |
| PRIVACY_LOCK | ON / inatividade / suspensão / bateria crítica | transitório → NORMAL |

O estado corrente é o da tela no topo da pilha (`views`); `AUTH_PENDING` é um sobre-estado
do NORMAL (a tela matemática continua visível).

## Bloqueio de privacidade (ON)

`privacy_lock` executa ganchos em ordem de prioridade, todos **não bloqueantes**:

1. **UI**: descarta todas as telas (cada `dispose` limpa seus buffers), encerra a sessão,
   apaga o buffer do PIN e invalida verificações PBKDF2 em andamento; pede um *flush* imediato.
2. **Cancelamento**: incrementa a geração do cliente de IA (resposta tardia é descartada),
   para a câmera e a prévia web.
3. **Limpeza**: fecha o cofre (zera a chave de dados e o conteúdo em RAM).

Se a requisição de IA já tinha sido enviada, o cancelamento remoto
(`POST /v1/requests/:id/cancel`) é registrado com estado explícito
(solicitado → cancelado / já concluído / desconhecido / sem confirmação) e pode ser consultado
em *Ajustes → Req. canceladas*. A latência é medida (`pl_get_stats`, *Diagnóstico*); a meta
de < 100 ms precisa ser confirmada no hardware final (inclui o tempo de escrita no LCD).

## Navegação

* Menus e teclado virtual: setas movem o foco, `=`/→ seleciona, `AC`/← volta.
* Páginas de leitura: ↑/↓ rolam linhas (passo configurável; `SHIFT` = página), ←/→ rolam
  horizontalmente a linha matemática em foco; a rolagem horizontal só para em limites de
  token (nunca corta números, nomes ou notação científica). Texto comum é quebrado por palavra.
* Indicadores: barra de rolagem à direita, setas de continuidade, barra de foco à esquerda.

## Camadas no firmware

* **Portáveis** (compilam no host, testadas): `math_engine`, `display` (framebuffer/fontes),
  `math_renderer`, `virtual_keyboard`, `security` (interface), `authentication`, `history`,
  `favorites`, `settings`, `ai_client` (protocolo/validação), `privacy_lock`, `power_manager`
  (política), `keypad` (núcleo), `calculator`, `formulas`, `conversions`, `app_state`.
* **Dependentes de hardware/ESP-IDF** (`*_esp.c`, compilam só no IDF): matriz de teclado,
  transporte HTTPS, câmera e prévia, Wi-Fi/provisionamento, OTA, ADC/suspensão, `main.c`.
* **Ainda inexistente por falta de dado de hardware**: driver do controlador LCD
  (interface `display_driver_t` pronta; drivers `console` e `null` disponíveis).

Dependências entre componentes seguem um grafo acíclico: `app_state` no topo; componentes
de baixo nível não conhecem a UI.
