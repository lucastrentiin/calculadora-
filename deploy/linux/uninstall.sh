#!/usr/bin/env bash
# Remove o servico. Por padrao MANTEM dados (/var/lib/terminal-matematico) e configuracao (/etc/terminal-matematico).
# Uso: sudo deploy/linux/uninstall.sh [--purge]   (--purge apaga dados, chave mestra e usuario: irreversivel)
set -euo pipefail
APP=terminal-matematico
[ "$(id -u)" -eq 0 ] || { echo "use sudo"; exit 1; }
systemctl disable --now "$APP" 2>/dev/null || true
rm -f "/etc/systemd/system/$APP.service"
systemctl daemon-reload
rm -rf "/opt/$APP"
if [ "${1:-}" = "--purge" ]; then
  read -r -p "Apagar DEFINITIVAMENTE dados, historico, chaves cifradas e o usuario terminalmat? Digite APAGAR: " ans
  if [ "$ans" = "APAGAR" ]; then
    rm -rf "/var/lib/$APP" "/etc/$APP"
    userdel terminalmat 2>/dev/null || true
    echo "dados removidos"
  else echo "cancelado: dados mantidos"; fi
else
  echo "servico removido; dados mantidos em /var/lib/$APP e configuracao em /etc/$APP"
fi
echo "cloudflared e demais servicos do sistema nao foram alterados."
