#!/usr/bin/env bash
# Gera uma CA local + certificado do servidor para o listener HTTPS da LAN.
# A CA (ca.crt) vai para firmware/certs/backend_ca.pem (CONFIG_MT_BACKEND_PINNED_CA=y).
# A chave da CA fica offline (ca.key): guarde-a fora do servidor ou apague-a apos emitir.
# Uso: deploy/linux/gen-lan-cert.sh <diretorio-saida> <IP-ou-nome-na-LAN> [mais nomes/IPs...]
set -euo pipefail
OUT="${1:?uso: gen-lan-cert.sh <saida> <ip-ou-nome> [...]}"; shift
[ $# -ge 1 ] || { echo "informe ao menos um IP ou nome da LAN"; exit 1; }
umask 077
mkdir -p "$OUT"
san=""
for n in "$@"; do
  if [[ "$n" =~ ^[0-9.]+$ ]]; then san="$san,IP:$n"; elif [[ "$n" =~ ^[A-Za-z0-9.-]+$ ]]; then san="$san,DNS:$n"; else echo "nome invalido: $n"; exit 1; fi
done
san="${san#,}"
openssl ecparam -name prime256v1 -genkey -noout -out "$OUT/ca.key"
openssl req -x509 -new -key "$OUT/ca.key" -sha256 -days 3650 -subj "/CN=Terminal Matematico CA local" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$OUT/ca.crt"
openssl ecparam -name prime256v1 -genkey -noout -out "$OUT/server.key"
openssl req -new -key "$OUT/server.key" -subj "/CN=$1" -out "$OUT/server.csr"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san" > "$OUT/ext.cnf"
openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial -days 825 -sha256 -extfile "$OUT/ext.cnf" -out "$OUT/server.crt"
rm -f "$OUT/server.csr" "$OUT/ext.cnf" "$OUT/ca.srl"
chmod 0644 "$OUT/ca.crt" "$OUT/server.crt"
cat <<EOF
Gerado em $OUT:
  server.crt / server.key -> /etc/terminal-matematico/tls/ (server.key: dono terminalmat, modo 0600)
  ca.crt                  -> firmware/certs/backend_ca.pem e menuconfig: MT_BACKEND_PINNED_CA=y
  ca.key                  -> guarde OFFLINE (necessaria apenas para renovar)
SAN: $san
Depois: LAN_ENABLED=1 em /etc/terminal-matematico/server.env e 'sudo systemctl restart terminal-matematico'.
Observacao: o firmware usa a CA fixada SOMENTE para a URL da LAN; a URL remota (Cloudflare)
e validada pelo bundle publico de CAs do ESP-IDF.
EOF
