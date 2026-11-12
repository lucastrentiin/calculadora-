#!/usr/bin/env bash
# Restaura um backup criado por backup.sh. Para o servico, substitui banco/chave/config e reinicia.
# Uso: sudo deploy/linux/restore.sh arquivo.tar.gz.gpg|arquivo.tar.gz.enc
set -euo pipefail
APP=terminal-matematico
DATA=/var/lib/$APP
IN="${1:?uso: restore.sh <arquivo>}"
[ "$(id -u)" -eq 0 ] || { echo "use sudo"; exit 1; }
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
case "$IN" in
  *.gpg) gpg --decrypt --pinentry-mode loopback -o "$work/b.tar.gz" "$IN" ;;
  *.enc)
    read -r -s -p "Senha do backup: " pw; echo
    if [ -f "$IN.hmac" ]; then
      exp="$(cat "$IN.hmac")"
      got="$(PW="$pw" node -e 'const c=require("crypto"),f=require("fs");const k=c.createHash("sha256").update("mt-backup-hmac:"+process.env.PW).digest();process.stdout.write(c.createHmac("sha256",k).update(f.readFileSync(process.argv[1])).digest("hex"))' "$IN")"
      [ "$exp" = "$got" ] || { echo "HMAC invalido: arquivo alterado ou senha errada"; exit 1; }
    fi
    PW="$pw" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:PW -in "$IN" -out "$work/b.tar.gz"; unset pw ;;
  *) echo "formato desconhecido"; exit 1 ;;
esac
mkdir "$work/x"
tar -C "$work/x" --no-same-owner -xzf "$work/b.tar.gz"
[ -f "$work/x/mt.sqlite.db" ] || { echo "backup sem banco"; exit 1; }
read -r -p "Substituir os dados atuais de $DATA? Digite RESTAURAR: " ans
[ "$ans" = "RESTAURAR" ] || { echo "cancelado"; exit 1; }
systemctl stop "$APP"
stamp="$(date +%Y%m%d-%H%M%S)"
[ -f "$DATA/mt.sqlite" ] && mv "$DATA/mt.sqlite" "$DATA/mt.sqlite.antes-$stamp"
install -m 0600 -o terminalmat -g terminalmat "$work/x/mt.sqlite.db" "$DATA/mt.sqlite"
[ -f "$work/x/master.key" ] && install -m 0600 -o terminalmat -g terminalmat "$work/x/master.key" "$DATA/master.key"
[ -d "$work/x/firmware" ] && { rm -rf "$DATA/firmware"; cp -a "$work/x/firmware" "$DATA/firmware"; chown -R terminalmat:terminalmat "$DATA/firmware"; }
[ -f "$work/x/server.env" ] && install -m 0640 -o root -g terminalmat "$work/x/server.env" "/etc/$APP/server.env"
rm -f "$DATA"/mt.sqlite-wal "$DATA"/mt.sqlite-shm
systemctl start "$APP"
echo "restaurado. Refaca o login dos aplicativos CLI se necessario (sudo -u terminalmat -H codex login)."
