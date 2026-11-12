# Terminal Matemático (ESP32-S3) + servidor doméstico

Calculadora científica embarcada (LCD gráfico monocromático 128×32, teclado físico, câmera
OV3660, Wi-Fi, bateria Li-Po) cujo **modo NORMAL reproduz o comportamento da DEXIN
KK-82MS-B** (família fx-82MS), com área protegida por PIN discreto para consultas a IA por
texto/foto feitas **através de um servidor doméstico do proprietário**. O aparelho nunca
guarda senhas de contas nem chaves de API.

```
 Terminal ──Wi-Fi──► (LAN https) ─┐
                                  ├─► Servidor doméstico (Node/TS) ──► provedores: Claude Code CLI, Codex CLI,
 Terminal ──4G/Wi-Fi externo──► Cloudflare Tunnel + Access ─┘          API Anthropic, API OpenAI, Manual, Mock
                                  painel web do proprietário (Access + senha + TOTP)
```

| Parte | Diretório | Estado |
|---|---|---|
| Firmware ESP-IDF v5.4 (C) | `firmware/` | Núcleo portável testado no host (6 suítes, ASan/UBSan); build ESP32-S3 no CI; **não executado em hardware** |
| Servidor doméstico (TypeScript, Node ≥ 22.13) | `backend/` | Funcional e testado (29 testes); provedores reais dependem das suas contas/chaves |
| Painel do proprietário | `dashboard/` | Funcional (servido em `/admin/`) |
| Simulador web (PC/celular) | `simulator/` | Funcional, sem dependências; conecta ao servidor real |
| Implantação Linux / Cloudflare / Docker | `deploy/` | Scripts e unidade systemd prontos |
| Testes | `tests/` | simulador (82), integração simulador↔servidor (2), firmware host (6 suítes) |
| Documentação | `docs/` | ver abaixo — **relatório completo: [docs/RELATORIO.md](docs/RELATORIO.md)** |
| Hardware | `hardware/` | dados que faltam (pinagem, LCD, teclado) — nada foi inventado |

## Início rápido

```bash
npm --prefix backend ci
npm test                                   # simulador + servidor + integração + firmware (host)
node tools/serve_simulator.js 8080         # simulador em http://127.0.0.1:8080
```

Instalação no servidor Linux: [deploy/README.md](deploy/README.md).

## Documentos

[RELATORIO](docs/RELATORIO.md) · [ARQUITETURA](docs/ARCHITECTURE.md) · [SERVIDOR](docs/SERVER.md) ·
[PROVEDORES DE IA](docs/PROVIDERS.md) · [CLOUDFLARE](deploy/cloudflared/README.md) · [SEGURANÇA](docs/SECURITY.md) ·
[COMPATIBILIDADE DEXIN](docs/DEXIN_COMPAT.md) · [BUILD](docs/BUILD.md) · [PROVISIONAMENTO](docs/PROVISIONING.md) ·
[OTA](docs/OTA.md) · [PRÉVIA DA CÂMERA](docs/CAMERA_PREVIEW.md) · [MCP](docs/MCP.md) · [ESTADO](docs/STATUS.md) ·
[HARDWARE](hardware/README.md)
