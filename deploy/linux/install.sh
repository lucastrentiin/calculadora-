#!/usr/bin/env bash
# Instala o servidor domestico do Terminal Matematico em Linux com systemd.
#  - cria o usuario de servico "terminalmat" (sem login, sem sudo)
#  - copia o projeto para /opt/terminal-matematico (somente leitura para o servico)
#  - dados em /var/lib/terminal-matematico (0700), configuracao em /etc/terminal-matematico
#  - NAO altera outros servicos, firewall, cloudflared existente, nginx etc.
#  - idempotente: pode ser executado de novo para atualizar o codigo
# Uso (na pasta do projeto extraido):  sudo deploy/linux/install.sh [--dry-run]
set -euo pipefail

APP=terminal-matematico
SVC_USER=terminalmat
PREFIX=/opt/$APP
DATA=/var/lib/$APP
ETC=/etc/$APP
UNIT=/etc/systemd/system/$APP.service
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

run() { echo "+ $*"; [ "$DRY" -eq 1 ] || "$@"; }

if [ "$(id -u)" -ne 0 ]; then echo "execute com sudo (o servico em si NAO roda como root)"; exit 1; fi
[ -f "$SRC/backend/package.json" ] || { echo "execute a partir do projeto extraido (backend/ nao encontrado em $SRC)"; exit 1; }

echo "== Verificando requisitos (somente leitura)"
port="$(grep -E '^SERVER_LOCAL_PORT=' "$ETC/server.env" 2>/dev/null | cut -d= -f2 || true)"
if ! "$SRC/deploy/linux/check-requirements.sh" "${port:-8787}"; then
  if systemctl is-active --quiet "$APP" 2>/dev/null; then echo "(porta ocupada pelo proprio $APP: atualizacao)"; else echo "corrija as falhas acima"; exit 1; fi
fi
NODE="$(command -v node)"

echo "== Usuario de servico"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  run useradd --system --user-group --home-dir "$DATA/cli-home" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

echo "== Diretorios"
run install -d -m 0755 -o root -g root "$PREFIX"
run install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$DATA" "$DATA/cli-home"
run install -d -m 0750 -o root -g "$SVC_USER" "$ETC" "$ETC/tls"

echo "== Codigo (root:root, somente leitura para o servico)"
for d in backend dashboard simulator docs deploy tools; do
  run rm -rf "${PREFIX:?}/$d.new"
  run cp -a "$SRC/$d" "$PREFIX/$d.new"
  run rm -rf "${PREFIX:?}/$d.new/node_modules" "${PREFIX:?}/$d.new/data"
  run rm -rf "${PREFIX:?}/$d"
  run mv "$PREFIX/$d.new" "$PREFIX/$d"
done
run chown -R root:root "$PREFIX"
run chmod -R go-w "$PREFIX"

echo "== Dependencias (sem scripts de pos-instalacao)"
if [ "$DRY" -eq 0 ]; then (cd "$PREFIX/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund); else echo "+ npm ci --omit=dev --ignore-scripts"; fi

echo "== Configuracao"
if [ ! -f "$ETC/server.env" ]; then
  run install -m 0640 -o root -g "$SVC_USER" "$SRC/deploy/env/production.env.example" "$ETC/server.env"
  echo "   -> edite $ETC/server.env (Cloudflare, LAN) antes de expor o servico"
else
  echo "   $ETC/server.env existente mantido"
fi

echo "== systemd"
run install -m 0644 "$SRC/deploy/linux/$APP.service" "$UNIT"
if [ "$NODE" != "/usr/bin/node" ] && [ "$DRY" -eq 0 ]; then
  sed -i "s|^ExecStart=/usr/bin/env node|ExecStart=$NODE|" "$UNIT"
fi
run systemctl daemon-reload
run systemctl enable "$APP"
run systemctl restart "$APP"

cat <<EOF

Instalado. Proximos passos (somente no console do servidor):
  1) Criar o proprietario:  sudo $PREFIX/deploy/linux/admin.sh create SEU_USUARIO
  2) Cadastrar o terminal:   sudo $PREFIX/deploy/linux/admin.sh device-add terminal-1
  3) (opcional) Login dos aplicativos CLI oficiais como o usuario de servico, nunca como root:
       sudo -u $SVC_USER -H codex login
       sudo -u $SVC_USER -H claude      # e use /login dentro dele, ou configure ANTHROPIC_API_KEY pelo painel
  4) Cloudflare Tunnel: deploy/cloudflared/README.md
  5) Painel: https://<hostname-admin>/admin/ (protegido pelo Cloudflare Access)
Logs: journalctl -u $APP -f
EOF
