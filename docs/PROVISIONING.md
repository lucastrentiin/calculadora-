# Provisionamento seguro

## 1. Identidade do dispositivo no backend

```bash
cd backend && npm run provision -- dev-001 "unidade 1"
# device_id : dev-001
# device_key: <base64 de 32 bytes>   (exibida uma única vez)
```

O backend guarda a chave em `DEVICES_FILE` (permissão 0600, fora do Git). Para revogar:
`npm run provision -- --disable dev-001` e `kill -HUP` no processo.

## 2. Gravar a identidade no aparelho (partição `mtdata`)

```bash
TMP=$(mktemp -d)
node tools/provision_device.js dev-001 '<device_key>' > $TMP/prov.csv
python $IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py \
    generate $TMP/prov.csv $TMP/mtdata.bin 0x100000          # desenvolvimento
#   encrypt  $TMP/prov.csv $TMP/mtdata.bin 0x100000 --inputkey nvs_key.bin   # produção (esquema flash-enc)
esptool.py --chip esp32s3 write_flash 0xC20000 $TMP/mtdata.bin
rm -rf $TMP
```

Com o esquema HMAC de criptografia do NVS, grave a partição pelo próprio firmware em um
modo de fábrica, ou gere-a com a chave derivada do eFuse (documentação ESP-IDF "NVS Encryption").

## 3. PIN

Não há PIN de fábrica. No primeiro uso a combinação de acesso abre a tela de criação do PIN.

## 4. Wi-Fi

* No aparelho: *Ajustes → Wi-Fi → Adicionar rede* (SSID e senha pelo teclado virtual ou multi-tap).
* Pelo celular: provisionamento SoftAP com prova de posse aleatória exibida no LCD
  (`wifi_manager_start_provisioning`), usando o app oficial "ESP SoftAP Provisioning".
