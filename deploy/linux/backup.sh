#!/usr/bin/env bash
# Backup cifrado do servidor domestico (banco + chave mestra + configuracao).
#  - copia consistente do SQLite via VACUUM INTO (o servico pode continuar rodando)
#  - cifrado com senha (gpg AES256; sem gpg: openssl AES-256-CBC + PBKDF2 600k + HMAC-SHA256)
#  - logins dos aplicativos CLI (cli-home) NAO entram no backup: refaca o login apos restaurar
# Uso: sudo deploy/linux/backup.sh /caminho/destino
set -euo pipefail
APP=terminal-matematico
DATA=/var/lib/$APP
DEST="${1:?uso: backup.sh <diretorio-destino>}"
[ "$(id -u)" -eq 0 ] || { echo "use sudo"; exit 1; }
umask 077
mkdir -p "$DEST"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chown terminalmat:terminalmat "$work"
stamp="$(date +%Y%m%d-%H%M%S)"
sudo -u terminalmat -H bash -c 'set -a; . /etc/'"$APP"'/server.env; set +a; cd /opt/'"$APP"'/backend && exec node --disable-warning=ExperimentalWarning src/cli/admin.ts backup "$1"' b "$work/mt.sqlite.db"
mkdir "$work/pkg"
mv "$work/mt.sqlite.db" "$work/pkg/"
[ -f "$DATA/master.key" ] && cp -p "$DATA/master.key" "$work/pkg/"
[ -d "$DATA/firmware" ] && cp -a "$DATA/firmware" "$work/pkg/"
cp -p "/etc/$APP/server.env" "$work/pkg/"
tar -C "$work/pkg" -czf "$work/backup.tar.gz" .
out="$DEST/$APP-$stamp.tar.gz"
if command -v gpg >/dev/null 2>&1; then
  gpg --symmetric --cipher-algo AES256 --pinentry-mode loopback -o "$out.gpg" "$work/backup.tar.gz"
  echo "backup: $out.gpg"
else
  read -r -s -p "Senha do backup: " pw; echo
  read -r -s -p "Repita: " pw2; echo
  [ "$pw" = "$pw2" ] || { echo "senhas diferentes"; exit 1; }
  PW="$pw" openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:PW -in "$work/backup.tar.gz" -out "$out.enc"
  # integridade (a senha nunca aparece na linha de comando)
  PW="$pw" node -e 'const c=require("crypto"),f=require("fs");const k=c.createHash("sha256").update("mt-backup-hmac:"+process.env.PW).digest();process.stdout.write(c.createHmac("sha256",k).update(f.readFileSync(process.argv[1])).digest("hex")+"\n")' "$out.enc" > "$out.enc.hmac"
  unset pw pw2
  echo "backup: $out.enc (+ .hmac)"
fi
echo "Guarde a senha separadamente. Sem ela o backup nao pode ser restaurado."
