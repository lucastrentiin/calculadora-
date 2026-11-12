# Atualização OTA pelo servidor doméstico

Pré-requisito: primeira gravação e validação por USB.

1. Aumente a versão do projeto e compile (com Secure Boot v2 a imagem sai assinada).
2. No servidor: `sudo /opt/terminal-matematico/deploy/linux/admin.sh ota-publish /caminho/terminal_matematico.bin`
   (o arquivo deve ser legível pelo usuário `terminalmat`). O servidor lê o cabeçalho ESP
   (magic `0xE9`, descritor do app, versão, projeto) e calcula o hash de validação.
3. No painel → **Atualizações**: aprove a versão. Só versões aprovadas aparecem no manifesto.
4. No aparelho: *Ajustes → Atualização (OTA)*.

Fluxo no aparelho: `GET /api/v1/updates/manifest` (assinado HMAC) → se a versão for maior,
`esp_https_ota` baixa `/api/v1/updates/firmware?version=…` **do mesmo servidor** (cabeçalhos
HMAC adicionados por `http_client_init_cb`; nunca de URL de terceiros), grava o slot inativo,
compara o hash com o manifesto, valida a imagem (assinatura com Secure Boot v2) e só então
troca o slot. No primeiro boot, `ota_mark_valid()` após o autoteste; reinício antes disso →
rollback automático. Dados ficam na partição `mtdata`, que a OTA não apaga.

**Estado:** código escrito e compilado no CI; nunca executado em hardware.
