# Provisionamento

## 1. Identidade do terminal no servidor

```bash
sudo /opt/terminal-matematico/deploy/linux/admin.sh device-add terminal-1
# device_id : terminal-1
# device_key: <base64, 32 bytes>   (exibida uma única vez; cifrada no banco do servidor)
```

Alternativa: painel → Dispositivos → "Gerar código de cadastro" (uso único, 15 min) e
`POST /api/v1/device/register`. Revogar/rotacionar: painel → Dispositivos (rotação com 24 h
de carência para a chave anterior).

## 2. Gravar no aparelho (partição `mtdata`, namespace `mt`)

```bash
TMP=$(mktemp -d)
node tools/provision_device.js terminal-1 '<device_key>' \
     --lan https://192.168.1.10:8443 --remote https://api.seudominio \
     --cf-id '<client id do token de serviço>' --cf-secret '<segredo>' > $TMP/prov.csv
python $IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py \
    generate $TMP/prov.csv $TMP/mtdata.bin 0x100000                 # desenvolvimento
#   encrypt  $TMP/prov.csv $TMP/mtdata.bin 0x100000 --inputkey nvs_key.bin   # produção
esptool.py --chip esp32s3 write_flash 0xC20000 $TMP/mtdata.bin
rm -rf $TMP
```

O aparelho recebe **apenas** credenciais do próprio servidor (chave HMAC e, se usar o túnel,
o token de serviço do Access). Nenhuma chave de provedor de IA, senha de conta ou cookie.
`lan_url`/`remote_url` também podem vir do `menuconfig` (`MT_BACKEND_URL`, `MT_BACKEND_REMOTE_URL`).
Para a LAN com certificado próprio, coloque a CA em `firmware/certs/backend_ca.pem` e ative
`MT_BACKEND_PINNED_CA` (usada só para a URL da LAN; a URL remota usa o bundle público).

## 3. PIN

Não há PIN de fábrica: a primeira combinação abre a criação do PIN (6–8 dígitos).

## 4. Wi-Fi

No aparelho (*Ajustes → Wi-Fi*) ou pelo celular (SoftAP com prova de posse exibida no LCD,
app oficial "ESP SoftAP Provisioning").
