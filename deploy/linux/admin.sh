#!/usr/bin/env bash
# Executa o CLI administrativo como o usuario de servico, com a configuracao instalada.
# Uso: sudo /opt/terminal-matematico/deploy/linux/admin.sh <comando> [args]
#   create <usuario> | device-add <id> [nome] | enroll [nome] | revoke <id> | ota-publish <arquivo.bin> | backup <destino.db> | check
set -euo pipefail
APP=terminal-matematico
[ "$(id -u)" -eq 0 ] || { echo "use sudo"; exit 1; }
[ $# -ge 1 ] || { sed -n '3,4p' "$0"; exit 1; }
exec sudo -u terminalmat -H bash -c 'set -a; . /etc/'"$APP"'/server.env; set +a; cd /opt/'"$APP"'/backend && exec node --disable-warning=ExperimentalWarning src/cli/admin.ts "$@"' admin "$@"
