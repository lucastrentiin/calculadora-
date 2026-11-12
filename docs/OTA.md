# Atualização OTA

Pré-requisito: primeira gravação e validação por USB.

1. Incremente `PROJECT_VER`/versão e compile (com Secure Boot v2 a imagem sai assinada).
2. Obtenha o hash de validação: `esptool.py --chip esp32s3 image_info build/terminal_matematico.bin`
   (linha "Validation Hash").
3. Publique por HTTPS o binário e um manifesto:
   ```json
   {"version": "0.2.0", "url": "https://updates.example/fw-0.2.0.bin", "sha256": "<validation hash>"}
   ```
4. Configure `CONFIG_MT_OTA_MANIFEST_URL`. No aparelho: *Ajustes → Atualização (OTA)*.

O aparelho baixa para o slot inativo (`ota_0`/`ota_1`), confere o hash, valida a imagem
(assinatura com Secure Boot v2) e só então troca o slot de boot. No primeiro boot da nova
versão, `ota_mark_valid()` é chamado depois do autoteste; se o aparelho reiniciar antes disso
o bootloader volta à versão anterior (rollback). Configurações e dados ficam na partição
`mtdata`, que a OTA nunca apaga. Mensagens de sucesso/erro aparecem no LCD.
