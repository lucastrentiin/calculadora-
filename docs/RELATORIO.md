# Relatório final — Terminal Matemático (ESP32-S3) + servidor doméstico

Data: 12/11/2026 · Branch: `claude/math-terminal-esp32-firmware-qkl27k`

## 0. Resumo honesto

**O que está pronto e comprovado por testes automatizados**

* Simulador completo (PC e celular), incluindo o modo NORMAL estilo DEXIN KK-82MS-B,
  área protegida, IA via servidor real, câmera simulada, ferramentas, histórico/favoritos.
* Firmware em C: todo o núcleo portável (calculadora científica, motor matemático, estados,
  PIN, cofre, bloqueio ON, cliente mt1, UI) compila e passa nos testes de host com
  AddressSanitizer/UBSan; a camada ESP-IDF compila para ESP32-S3 no CI.
* Servidor doméstico: API mt1, painel, provedores, segurança, OTA, implantação Linux.

**O que NÃO pode ser declarado pronto** (e não é declarado em nenhum lugar do projeto)

1. **Nada foi executado em hardware.** Não existe placa, LCD, teclado, câmera nem bateria
   neste ambiente. O código ESP-IDF está "escrito e compilado", não "validado".
2. **Pinagem, controlador do LCD e matriz do teclado não foram inventados** (instrução do
   projeto). Ficam como parâmetros de `menuconfig`; ver `hardware/README.md`.
3. **Compatibilidade 100 % com a DEXIN KK-82MS-B não é declarada**: tudo foi implementado e
   testado contra o comportamento documentado da família fx-82MS, mas a comparação com a
   unidade física ainda não foi feita (procedimento pronto em `DEXIN_COMPAT.md` §4).
4. **Nenhuma conta real de IA ou Cloudflare foi usada.** Claude Code, Codex, API Anthropic e
   API OpenAI foram testados com binários/clientes falsos; Cloudflare Access com JWT gerado
   localmente. Funciona de ponta a ponta com o MockProvider e o provedor Manual.
5. **Secure Boot, Flash Encryption e NVS cifrado** estão configurados, mas **não validados**
   (só é possível no equipamento, e são operações irreversíveis — não foram ativadas).
6. `systemd`/instalação real não foram executados aqui (o container não tem systemd); os
   scripts foram verificados quanto à sintaxe e as partes executáveis foram testadas
   (geração de certificado, backup do banco, verificação de requisitos, servidor em perfil de
   produção com TLS na LAN).

## 1. Testes executados (resultado real desta entrega)

| Suíte | Comando | Resultado |
|---|---|---|
| Simulador (7 arquivos, inclui `dexin.test.js` e `session.test.js`) | `npm run test:sim` | **82/82** |
| Servidor (typecheck + 4 arquivos) | `cd backend && npx tsc --noEmit && npm test` | **tsc ok, 29/29** |
| Integração simulador ↔ servidor real (processo separado) | `npm run test:integration` | **2/2** |
| Firmware host — motor matemático | `test_math_engine` | **112 verificações, 0 falhas** |
| Firmware host — UI (framebuffer, fontes, rolagem, teclados) | `test_ui_core` | **194 / 0** |
| Firmware host — segurança e armazenamento | `test_security_storage` | **76 / 0** |
| Firmware host — cliente de IA mt1 | `test_ai_client` | **78 / 0** |
| Firmware host — estados/aplicação | `test_app_state` | **149 / 0** |
| Firmware host — calculadora NORMAL | `test_calculator` | **80 / 0** |
| Tabelas geradas do firmware atualizadas | `node tools/gen_firmware_tables.js --check` | ok |
| Build ESP-IDF v5.4.2 para ESP32-S3 | CI `firmware-esp-idf-build` | ver §11 |
| Implantação | `gen-lan-cert.sh` + `openssl verify`; servidor em perfil de produção com LAN TLS (`curl --cacert` → 200; sem CA → recusado; `/admin/` na LAN → 404; sem JWT do Access → 401); `admin backup` (VACUUM INTO, 0600); `check-requirements.sh` | ok |

## 2. Especificação original — requisito por requisito

| # | Requisito | Situação |
|---|---|---|
| 1 | Arquitetura modular, testável | Componentes ESP-IDF com núcleo portável; simulador como referência executável; servidor separado. ✅ |
| 2 | Estados NORMAL, AUTH_PENDING, AUTHENTICATED, TEXT_ENTRY, AI_REQUEST, AI_RESPONSE, CAMERA, MATH_TOOLS, SETTINGS, PRIVACY_LOCK | Implementados no simulador e no firmware, testados (inclusive bloqueio a partir de cada estado). ✅ |
| 3 | Autenticação discreta por PIN, só indicador, verificador PBKDF2, bloqueio por tentativas, sem PIN padrão | ✅ testado (PIN nunca gravado nem logado) |
| 4 | Tecla ON = bloqueio de privacidade < 100 ms, sem animação, cancela tarefas, limpa buffers, trata requisição já enviada | ✅ lógica testada; cancelamento remoto com estado registrado. Medido ~0,2 ms no navegador; **no LCD real: medir** |
| 5 | Interface LCD 128×32 monocromática | Framebuffer, fontes 5×7/3×5, indicadores, renderizador matemático ✅; **driver do controlador: pendente (modelo não definido)** |
| 6 | Rolagem vertical e horizontal (sem cortar tokens) | ✅ testado |
| 7 | Entrada de texto A (QWERTY virtual) e B (multi-tap) | ✅ testado |
| 8 | Motor matemático offline sem `eval` | Parser próprio (JS e C), erros tipados ✅ |
| 9 | Resolução passo a passo | ✅ (local, via MENU → ferramentas) |
| 10 | Modos RÁPIDO / CURTO / COMPLETO | ✅ |
| 11 | Cliente de IA HTTPS + backend TS; chave nunca no aparelho; nomes de modelo não inventados | ✅ mt1; OpenAI sem modelo padrão (dono escolhe da lista); Anthropic `claude-opus-5-5` |
| 12 | Câmera OV3660 | Driver escrito (esp32-camera), simulador com canvas/webcam; **pinos pendentes** |
| 13 | Prévia da câmera no celular | Escrita (HTTP local + código de sessão) e simulada |
| 14 | Biblioteca de fórmulas | 46 fórmulas com exemplos verificados ✅ |
| 15 | Ferramentas/simuladores matemáticos | equações 1º/2º grau, sistemas 2×2/3×3, estatística, tabela, matrizes (matrizes/tabela só no simulador) |
| 16 | Favoritos e histórico | cofre AES-GCM no aparelho ✅; no servidor opcional e desligado por padrão ✅ |
| 17 | Conversões de unidades | 10 categorias ✅ |
| 18 | Segurança (TLS, NVS/Flash encryption, Secure Boot) | TLS ✅ código; eFuses/criptografia física **não validados** (ver §0) |
| 19 | OTA assinado com rollback | ✅ servidor; firmware escrito (agora via servidor doméstico com HMAC e aprovação) |
| 20 | Acessibilidade | fonte grande, menus simples, inversão, passo de rolagem, repetição de teclas ✅ |
| 21 | Gerenciador de Wi-Fi | escrito + simulado; provisionamento SoftAP com prova de posse |
| 22 | Energia | política testada; ADC e light sleep escritos; **circuito pendente** |
| 23 | Simulador PC/celular | ✅ |
| 24 | Organização do repositório | `firmware/ backend/ simulator/ dashboard/ deploy/ tests/ docs/ hardware/ tools/` ✅ |
| 25–26 | Testes obrigatórios e documentação | ver §1 e `docs/` ✅ |
| 27 | Não declarar como pronto o que é simulado | este relatório e `STATUS.md` ✅ |

## 3. Adendo — servidor doméstico, integrações e sessão

| Item | Situação |
|---|---|
| Arquitetura terminal → Wi-Fi → (Tunnel/Access) → servidor Node TS → adaptadores | ✅ |
| Interface `AIProvider` e provedores Codex CLI, Claude Code, API OpenAI, API Anthropic, Mock, Manual | ✅ (contas reais não testadas) |
| Avaliação do Sign in with ChatGPT | marcado **indisponível**: requer `client_id` aprovado; nenhum fluxo inventado |
| Painel: Dashboard, Aplicativos de IA, Dispositivos, Configurações, Histórico/favoritos, Segurança, Acesso remoto, Atualizações (+ Manual) | ✅ |
| Rotas versionadas `/api/v1/...` | ✅ (simulador, firmware e servidor usam as mesmas) |
| `session_id` contra respostas tardias; boot sempre NORMAL | ✅ simulador e firmware, com testes |
| Camadas criptográficas (TLS, HMAC, Access, AES-GCM em repouso no servidor e no aparelho) | ✅ (eFuses: §0) |
| Perfis DEVELOPMENT / PRODUCTION | ✅ (`MT_PROFILE`; produção força TOTP, proíbe HTTP na LAN) |
| Autodiagnóstico | simulador (LCD, teclado, câmera, armazenamento, rede, bateria) ✅; firmware: tela de diagnóstico + envio a `/api/v1/device/diagnostics` ✅; painel exibe |
| OTA a partir do servidor | ✅ (publicar → aprovar → manifesto assinado) |
| Privacidade e retenção | padrão não guardar perguntas/respostas/imagens; retenção 30 dias configurável ✅ |
| Implantação Linux, Windows se possível, SQLite | Linux ✅ (systemd endurecido, instalador idempotente, backup cifrado); Windows: notas, **não testado**; Docker ✅ (sem CLIs) |
| Parâmetros Cloudflare (`PUBLIC_HOSTNAME`, `SERVER_LOCAL_PORT`, `CLOUDFLARE_TUNNEL_ID`, `CLOUDFLARE_ACCESS_ENABLED`, `DEVICE_AUTH_MODE`, `ADMIN_AUTH_MODE`) | ✅ todos em `deploy/env/production.env.example` |
| TaskManager | ✅ fila, concorrência, idempotência, timeout, cancelamento, paginação |
| Estudo MCP opcional | `docs/MCP.md` (recomendação: não implementar agora) |
| "Não afirmar que integração por assinatura está pronta só porque o CLI aceita login" | respeitado: painel exige *Testar*; documentação diz "não verificado" |

### A solução para o Claude (pedido explícito)

`claude_code` com dois modos: **api_key** (permitido sem ambiguidade; chave cifrada no
servidor, passada só por variável de ambiente ao binário oficial) e **subscription** (somente
o próprio dono, no próprio servidor, binário oficial sem modificação, desligado por padrão,
com confirmação explícita no painel; o servidor nunca toca em `~/.claude`). Ferramentas do
Claude Code sempre desligadas, sem sessão persistida, `--max-turns 3`, saída JSON com
esquema. Alternativa para fotos: `anthropic_api` (SDK oficial, saída estruturada). Detalhes:
`docs/PROVIDERS.md`.

## 4. Requisito obrigatório — compatibilidade com a DEXIN KK-82MS-B

* Inventário completo e tabela de mapeamento (tecla física, primária, SHIFT, ALPHA,
  comportamento por modo, estado, testes, conferência física) em `docs/DEXIN_COMPAT.md`.
* Implementado no simulador **e no firmware C**: COMP/SD/REG (Lin, Log, Exp, Pwr, Inv, Quad),
  Deg/Rad/Gra, Fix/Sci/Norm1/Norm2, ENG/ENG←, ab/c e d/c, DMS e ←, DRG►, Pol/Rec (E/F),
  Rnd, Ran#, nCr/nPr infixos, x!, x⁻¹, x³/∛, ˣ√, hyp, STO/RCL A–F X Y M, M+/M−, Ans, REPLAY,
  INS/sobrescrever, CLR (Mcl/Scl, Mode, All), %, S-SUM/S-VAR, DT/CL, frequência `;`, edição
  de dados, x̂/ŷ, erros Math/Syntax/Stack/Arg ERROR e Data Full, vírgula decimal, SHIFT AC = OFF.
* NORMAL não mostra IA, câmera nem servidor e não precisa de rede (teste dedicado).
* **Divergências registradas**: multi-instrução `:` não implementada (tecla não confirmada);
  contraste do LCD; aparência do LCD (matricial vs. segmentos); precisão (double vs. BCD 15
  dígitos); algoritmo do Ran#; no firmware, o cursor de erro volta ao início/fim e não ao token
  exato. **Status: compatível segundo documentação — conferência física pendente.**

## 5. Restrições de segurança (todas cumpridas)

Sem senhas de contas ou chaves de API no ESP32 · sem endpoints internos do ChatGPT/claude.ai,
cookies, tokens de navegador, Selenium/Playwright/Puppeteer em chats, scraping, endpoints não
documentados, contorno de limites · comandos nunca concatenados nem via shell (`spawn` com
vetor de argumentos e prompt por stdin) · nenhum parâmetro que desative segurança ou dê acesso
irrestrito (Codex só com `--sandbox read-only`; Claude Code só com ferramentas desligadas) ·
CLIs nunca como root (usuário `terminalmat`) · nenhum comando sugerido pelo modelo é
executado · painel/IA nunca expostos por encaminhamento de portas; CLIs, sockets e processos
nunca expostos pelo subdomínio (ingress só `/api/v1` e `/admin`, resto 404) · nenhum segredo
real no repositório · cookies/senhas de provedores nunca armazenados · provedores não usados
para contornar limites · nenhuma cobrança automática nem repetição automática em provedor
faturável sem política explícita · scripts não alteram sistemas existentes (verificação
somente leitura, sem tocar em cloudflared/nginx/firewall) · nenhum sucesso de teste inventado
(§1 traz a saída real) · Secure Boot/Flash Encryption não declarados validados nem ativados ·
logs sem senhas, tokens, PINs ou imagens.

## 6. Como levar para o Linux

1. Copie `terminal-matematico-<versão>.tar.gz` para o servidor e extraia.
2. `deploy/linux/check-requirements.sh` → `sudo deploy/linux/install.sh`.
3. `sudo /opt/terminal-matematico/deploy/linux/admin.sh create SEU_USUARIO` e `device-add terminal-1`.
4. Cloudflare: `deploy/cloudflared/README.md`. LAN (opcional): `deploy/linux/gen-lan-cert.sh`.
5. Painel → Aplicativos de IA → configure Claude (API ou assinatura) e/ou Codex; *Testar*.
6. Firmware: `docs/BUILD.md` e `docs/PROVISIONING.md`.

## 7. O que falta para fechar o projeto (dependências externas)

1. Escolher/informar: controlador do LCD, pinagem completa, matriz do teclado, circuito de
   bateria e carregador, módulo OV3660 exato → escrever o driver do LCD e preencher `menuconfig`.
2. Primeiro boot na placa: medir latência do ON no LCD, tempo do PBKDF2 (ajustar iterações),
   consumo, câmera, Wi-Fi, OTA e rollback.
3. Conferência física com a DEXIN (procedimento pronto).
4. Testar cada provedor com as contas/chaves do dono pelo botão *Testar* do painel.
5. Criar túnel e aplicações do Access na conta Cloudflare e verificar com `curl` (instruções prontas).
6. Só depois: gerar chaves de produção e ativar Secure Boot/Flash Encryption em placa descartável.

## 8. Mapa de diretórios

```
firmware/   ESP-IDF v5.4: main/, components/ (19 componentes), partitions.csv, sdkconfig.defaults(.production)
backend/    servidor doméstico TypeScript (src/{config,auth,devices,providers,requests,security,storage,ota,diagnostics,middleware,api,cli}, tests/)
dashboard/  painel web do proprietário
simulator/  simulador web (js/core = referência executável, js/sim, js/ui)
deploy/     linux/ (systemd, install, uninstall, check, admin, backup, restore, gen-lan-cert), cloudflared/, env/, docker/, windows/
tests/      simulator/, integration/, firmware/ (host, CTest)
tools/      geração de tabelas do firmware, servidor do simulador, provisionamento NVS
docs/       este relatório e a documentação técnica
hardware/   dados de hardware que faltam
```

## 9. Histórico das principais correções durante o desenvolvimento

Construtor do app no navegador; sequência de testes de navegação; câmera recapturando ao
confirmar; vazamentos detectados pelo ASan no teardown; dependências `esp_timer`/`esp_partition`/
`esp_app_format` no build IDF; conflito `openai`×`zod` (atualizado para `openai` 7); fixture
JPEG; tokenização de `nCr` infixo; REPLAY recalculando com Ans novo; `(−)` após resultado
continuando de Ans; tipo anônimo `ai_client_t` no build IDF (declaração antecipada da OTA).

## 10. Integrações verificadas

| Integração | Verificada como |
|---|---|
| Simulador ↔ servidor real | E2E automatizado (processo real, HMAC, polling, cancelamento) |
| Firmware (C) ↔ protocolo do servidor | vetor de assinatura cruzado C↔Node; transporte falso nos testes |
| Servidor ↔ Mock / Manual | E2E |
| Servidor ↔ Claude Code / Codex | binários falsos (argumentos, stdin, saída, erros, timeouts) |
| Servidor ↔ API Anthropic / OpenAI | clientes falsos com o formato dos SDKs oficiais |
| Servidor ↔ Cloudflare Access | JWT RS256 + JWKS gerados no teste |
| Terminal real ↔ qualquer coisa | **não verificado (sem hardware)** |

## 11. CI

Workflow `.github/workflows/ci.yml`: simulador + tabelas + servidor + integração + sintaxe dos
scripts; testes de host do firmware (ASan/UBSan); build ESP-IDF v5.4.2 (esp32s3).
O resultado do último run está registrado na mensagem de entrega.
