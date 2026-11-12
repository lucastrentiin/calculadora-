# Implantação do servidor doméstico (Linux)

Alvo validado: Linux com systemd (Debian/Ubuntu/Fedora e derivados, x86-64 ou ARM64) e
Node.js ≥ 22.13. Nenhum outro serviço do servidor é alterado.

## 1. Copiar o projeto

```bash
scp terminal-matematico-*.tar.gz usuario@servidor:/tmp/
ssh usuario@servidor
mkdir -p ~/tm && tar -xzf /tmp/terminal-matematico-*.tar.gz -C ~/tm && cd ~/tm/terminal-matematico
```

## 2. Verificar (somente leitura) e instalar

```bash
deploy/linux/check-requirements.sh          # SO, Node, portas, serviços existentes, memória/disco
sudo deploy/linux/install.sh --dry-run      # mostra o que faria
sudo deploy/linux/install.sh                # instala/atualiza (idempotente)
```

O instalador cria o usuário de serviço `terminalmat` (sem login, sem sudo), copia o código
para `/opt/terminal-matematico` (somente leitura para o serviço), dados em
`/var/lib/terminal-matematico` (0700) e configuração em `/etc/terminal-matematico/server.env`
(0640). A unidade `terminal-matematico.service` roda **sem root**, com `ProtectSystem=strict`,
`NoNewPrivileges`, `MemoryMax=768M` e escrita apenas no diretório de dados.

## 3. Primeiros comandos (console do servidor)

```bash
sudo /opt/terminal-matematico/deploy/linux/admin.sh create SEU_USUARIO      # senha + segredo TOTP
sudo /opt/terminal-matematico/deploy/linux/admin.sh device-add terminal-1   # chave do terminal (uma vez)
sudo /opt/terminal-matematico/deploy/linux/admin.sh check
```

## 4. Acesso

* **Na rede de casa (opcional):** `deploy/linux/gen-lan-cert.sh` gera CA local + certificado;
  ative `LAN_ENABLED=1`. O painel continua fora da LAN (`ADMIN_ON_LAN=0`).
* **Fora de casa:** Cloudflare Tunnel + Access → [cloudflared/README.md](cloudflared/README.md).
  Nunca use encaminhamento de portas no roteador.

## 5. Aplicativos de IA (opcional, no painel → "Aplicativos de IA")

* API oficial (Anthropic/OpenAI): cole a chave no painel (fica cifrada no banco).
* Claude Code / Codex CLI: instale o binário oficial e faça o login **como o usuário de
  serviço**, nunca como root: `sudo -u terminalmat -H codex login`. Detalhes e limites de uso
  das assinaturas: [docs/PROVIDERS.md](../docs/PROVIDERS.md).

## 6. Operação

| Tarefa | Comando |
|---|---|
| Logs | `journalctl -u terminal-matematico -f` (sem perguntas, tokens ou PINs) |
| Backup cifrado | `sudo deploy/linux/backup.sh /mnt/backup` |
| Restaurar | `sudo deploy/linux/restore.sh arquivo.tar.gz.gpg` |
| Atualizar | extrair a nova versão e `sudo deploy/linux/install.sh` |
| Remover (mantém dados) | `sudo deploy/linux/uninstall.sh` |

Alternativas: [docker/](docker/) (sem os CLIs de IA dentro do container) e
[windows/README.md](windows/README.md) (não testado).
