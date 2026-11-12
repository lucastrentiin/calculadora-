# Cloudflare Tunnel + Access para o servidor doméstico

Objetivo: o terminal (fora de casa) e o proprietário (painel) alcançam o servidor
**sem abrir portas no roteador**. O `cloudflared` cria uma conexão de saída até a
Cloudflare; o servidor só escuta em `127.0.0.1:SERVER_LOCAL_PORT`.

> Nada aqui altera um `cloudflared` já existente. Se você já usa um túnel para outros
> serviços, apenas **acrescente** as regras de `ingress` abaixo ao seu arquivo, antes da
> regra final `http_status:404`.

## 1. Túnel

```bash
cloudflared tunnel login                      # abre o navegador da sua conta Cloudflare
cloudflared tunnel create terminal-matematico # anote o UUID -> CLOUDFLARE_TUNNEL_ID
cloudflared tunnel route dns terminal-matematico api.seudominio
cloudflared tunnel route dns terminal-matematico painel.seudominio
sudo cp deploy/cloudflared/config.yml.example /etc/cloudflared/config.yml   # edite os <...>
sudo cloudflared service install               # somente se ainda não houver serviço cloudflared
```

## 2. Access (Zero Trust → Access → Applications)

| Aplicação | Hostname | Política | Vai para |
|---|---|---|---|
| Terminal Matemático – API | `api.seudominio` | **Service Auth** com um *Service Token* | `CLOUDFLARE_ACCESS_AUD_DEVICE` |
| Terminal Matemático – Painel | `painel.seudominio` | e-mail do proprietário + MFA | `CLOUDFLARE_ACCESS_AUD_ADMIN` |

* Copie o **Application Audience (AUD) tag** de cada aplicação para `server.env`.
* `CLOUDFLARE_TEAM_DOMAIN=<seu-time>.cloudflareaccess.com`.
* O *Service Token* (Client ID + Client Secret) do terminal vai para o NVS do aparelho:
  `node tools/provision_device.js <id> <chave> --remote https://api.seudominio --cf-id <ID> --cf-secret <SEGREDO>`
  (nunca no código-fonte; veja `docs/PROVISIONING.md`).

## 3. Variáveis do servidor (`/etc/terminal-matematico/server.env`)

```
PUBLIC_HOSTNAME=api.seudominio
CLOUDFLARE_TUNNEL_ID=<uuid>
CLOUDFLARE_ACCESS_ENABLED=1
CLOUDFLARE_TEAM_DOMAIN=<seu-time>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD_DEVICE=<aud da API>
CLOUDFLARE_ACCESS_AUD_ADMIN=<aud do painel>
DEVICE_AUTH_MODE=hmac+access
ADMIN_AUTH_MODE=password+access
```

O servidor verifica o JWT `Cf-Access-Jwt-Assertion` (RS256, chaves em
`https://<time>.cloudflareaccess.com/cdn-cgi/access/certs`) **além** da assinatura HMAC
do dispositivo e da senha+TOTP do proprietário. Sem o JWT válido a requisição é recusada
mesmo que alguém alcance o listener.

## 4. Verificação

```bash
curl -s https://api.seudominio/api/v1/health                 # sem token: bloqueado pelo Access (403/302)
curl -s -H "CF-Access-Client-Id: <ID>" -H "CF-Access-Client-Secret: <SEGREDO>" \
     https://api.seudominio/api/v1/health                    # {"ok":true,"protocol":"mt1"}
curl -s https://api.seudominio/admin/                        # 404 (o painel só existe no outro hostname)
```

No painel: **Acesso remoto** mostra se o `cloudflared` está instalado/ativo (somente leitura).

## Limites conhecidos

* Não foi possível testar contra uma conta Cloudflare real neste ambiente: a configuração
  acima segue a documentação pública do Cloudflare Tunnel/Access e foi validada apenas
  localmente (JWT de teste assinado pelos testes automatizados).
* A Cloudflare encerra respostas que demoram mais de ~100 s; por isso o servidor responde
  `202` e o terminal faz *long polling* de até 20 s por requisição.
