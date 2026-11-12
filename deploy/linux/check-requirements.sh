#!/usr/bin/env bash
# Verifica requisitos do servidor domestico SEM alterar nada no sistema.
# Uso: deploy/linux/check-requirements.sh [porta_tunel] [porta_lan]
set -u
TUNNEL_PORT="${1:-8787}"
LAN_PORT="${2:-8443}"
ok=0; warn=0; bad=0
pass() { echo "  [OK]    $*"; ok=$((ok+1)); }
note() { echo "  [AVISO] $*"; warn=$((warn+1)); }
fail() { echo "  [FALHA] $*"; bad=$((bad+1)); }

echo "== Sistema"
if [ -r /etc/os-release ]; then . /etc/os-release; pass "SO: ${PRETTY_NAME:-desconhecido}"; else note "SO nao identificado (/etc/os-release ausente)"; fi
pass "Arquitetura: $(uname -m)"
command -v systemctl >/dev/null 2>&1 && pass "systemd presente" || note "systemd ausente: use deploy/docker ou inicie manualmente"

echo "== Node.js"
if command -v node >/dev/null 2>&1; then
  v="$(node -p 'process.versions.node')"
  maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; }; then pass "Node $v (>= 22.13, node:sqlite e TypeScript nativo)"; else fail "Node $v: requer >= 22.13"; fi
else fail "node nao encontrado (instale Node.js 22 LTS ou superior pelo gerenciador oficial)"; fi
command -v npm >/dev/null 2>&1 && pass "npm $(npm -v)" || fail "npm nao encontrado"

echo "== Portas (somente leitura)"
in_use() { if command -v ss >/dev/null 2>&1; then ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; else (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; fi; }
in_use "$TUNNEL_PORT" && fail "porta $TUNNEL_PORT ja esta em uso: escolha outra SERVER_LOCAL_PORT" || pass "porta $TUNNEL_PORT livre (listener do tunel, 127.0.0.1)"
in_use "$LAN_PORT" && note "porta $LAN_PORT em uso: escolha outra LAN_PORT se for usar o listener LAN" || pass "porta $LAN_PORT livre (listener LAN opcional)"

echo "== Servicos existentes (nada sera alterado)"
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-unit-files 2>/dev/null | grep -q '^terminal-matematico.service' && note "terminal-matematico.service ja existe (reinstalacao/atualizacao)" || pass "nome de servico livre"
  systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared' && note "cloudflared ja instalado como servico: o instalador NAO mexe nele; adicione as regras de ingress manualmente" || pass "cloudflared nao instalado como servico"
fi
id terminalmat >/dev/null 2>&1 && note "usuario terminalmat ja existe (sera reutilizado)" || pass "usuario terminalmat sera criado"

echo "== Ferramentas opcionais"
for b in cloudflared codex claude openssl gpg; do
  if command -v "$b" >/dev/null 2>&1; then pass "$b encontrado"; else note "$b nao encontrado (opcional)"; fi
done

echo "== Recursos"
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
[ "${mem_kb:-0}" -ge 1000000 ] && pass "memoria: $((mem_kb/1024)) MB" || note "memoria baixa ($((mem_kb/1024)) MB): use MAX_CONCURRENT_TASKS=1"
free_kb="$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print $4}')"
[ "${free_kb:-0}" -ge 1000000 ] && pass "disco livre em /var/lib: $((free_kb/1024)) MB" || note "pouco disco livre em /var/lib"

echo
echo "Resumo: $ok ok, $warn avisos, $bad falhas"
[ "$bad" -eq 0 ]
