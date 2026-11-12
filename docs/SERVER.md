# Servidor doméstico

`backend/` — Node.js ≥ 22.13, TypeScript executado nativamente, sem build. Dependências de
produção: `zod`, `@anthropic-ai/sdk`, `openai` (SDKs oficiais). Banco: `node:sqlite`.

## Módulos (`backend/src`)

| Pasta | Conteúdo |
|---|---|
| `config/` | todas as opções vêm de variáveis de ambiente (`deploy/env/*.env.example`); perfis `development` / `production` |
| `storage/` | SQLite: dispositivos, cadastros, administradores, sessões, configurações, segredos, histórico, favoritos, log de segurança, log de requisições, firmware, diagnósticos |
| `security/` | `SecretBox` (AES-256-GCM, chave mestra `master.key` 0600 ou `MT_MASTER_KEY`), scrypt, TOTP (RFC 6238), JWT do Cloudflare Access (RS256 + JWKS) |
| `devices/` | cadastro por código de uso único, chave HMAC por dispositivo (cifrada), anti-replay, rotação com carência de 24 h, revogação |
| `auth/` | proprietário: senha scrypt + TOTP, sessão `mt_admin` (HttpOnly, SameSite=Strict, Secure), CSRF, bloqueio por tentativas |
| `providers/` | adaptadores (ver [PROVIDERS.md](PROVIDERS.md)) e `cliRunner` (execução segura de processos) |
| `requests/` | esquemas Zod, `TaskManager` (fila, concorrência, idempotência por `request_id`, timeout, cancelamento, paginação, retenção) e verificação matemática local |
| `ota/` | publicação de firmware (inspeção do cabeçalho ESP), aprovação, manifesto, download |
| `diagnostics/` | estado do servidor, versão, `cloudflared` (somente leitura) |
| `middleware/` | roteador HTTP, limites de corpo, taxa por dispositivo/dia, inspeção de JPEG |
| `api/` | `deviceApi` (`/api/v1`) e `adminApi` (`/admin`) |
| `cli/admin.ts` | administração só pelo console: `create`, `device-add`, `enroll`, `revoke`, `ota-publish`, `backup`, `check` |

## Listeners

* **Túnel:** HTTP em `127.0.0.1:SERVER_LOCAL_PORT`, alcançado só pelo `cloudflared` local.
* **LAN (opcional):** HTTPS com certificado próprio (`deploy/linux/gen-lan-cert.sh`). O painel
  não é servido na LAN salvo `ADMIN_ON_LAN=1`.
* O servidor sobe mesmo sem nenhum aplicativo de IA instalado.

## Painel (`/admin/`)

Dashboard (estado, fila, provedores, dispositivos), **Aplicativos de IA** (estado, testar,
habilitar, confirmar termos, chave da API, logout do Codex), **Dispositivos** (cadastro,
rotação, revogação, diagnósticos recebidos), **Configurações** (padrões de resposta,
privacidade: guardar perguntas/respostas/imagens — tudo desligado por padrão —, retenção),
**Histórico e favoritos** (exportar/apagar), **Manual** (fila de perguntas para resposta
manual), **Acesso remoto** (túnel/Access), **Atualizações** (aprovar firmware), **Segurança**
(sessões, troca de senha, log de eventos).

## Privacidade e retenção

Padrão: **não** guardar perguntas, respostas nem imagens; resultados ficam em memória por
`RESULT_TTL_MS` (15 min) para o polling e somem; logs de acesso só com método, rota
normalizada, status e duração (sem corpo, query, tokens, PIN ou imagem). Retenção
configurável (30 dias) para o que o dono decidir guardar.

## Testes (`backend/tests`, 29)

`device-api` (HMAC, replay, relógio, idempotência, 202/polling, paginação, cancelamento,
limites de imagem, política de reserva, privacidade), `admin-access` (login, TOTP, CSRF,
Access JWT, segredos nunca devolvidos, painel fora da LAN), `providers` (argumentos e saída
dos CLIs com binários falsos, recusa sem sandbox, redação de segredos, SDKs com clientes
falsos), `ota-crypto` (cabeçalho ESP, SecretBox, persistência).
