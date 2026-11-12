# Segurança

## Camadas

| Camada | Mecanismo | Comprovado em |
|---|---|---|
| PIN | PBKDF2-HMAC-SHA256 (salt 16 B), verificador `SHA-256(dk[0:32])`; PIN nunca armazenado; sem PIN de fábrica | testes host + simulador |
| Tentativas | 5 erros → 30 s, dobrando até 1 h; persistido | testes |
| Cofre do aparelho | AES-256-GCM com `dk[32:64]` (só em RAM durante a sessão): histórico e favoritos | testes |
| Sessão | `session_id` aleatório por login; resultados de outra sessão descartados; boot sempre NORMAL | testes (C e JS) |
| Tecla ON | bloqueio imediato, limpeza de buffers, cancelamento local e remoto | testes; latência no LCD **a medir** |
| Dispositivo ↔ servidor | HMAC-SHA256 (método, caminho+query, timestamp, nonce, hash do corpo), ±5 min, nonce único, chave por dispositivo cifrada no servidor, rotação/revogação | testes + vetor cruzado C↔TS |
| Transporte | HTTPS obrigatório no firmware (http só em build de desenvolvimento); CA local fixada para a LAN, bundle público para o túnel | código; **validar no hardware** |
| Acesso remoto | Cloudflare Tunnel (sem portas abertas) + Access: token de serviço para o terminal, login+MFA para o painel; JWT verificado também no servidor | testes com JWT local; **não testado com conta Cloudflare** |
| Painel | scrypt + TOTP + sessão HttpOnly/SameSite=Strict/Secure + CSRF + Access; ausente na LAN por padrão | testes |
| Segredos do servidor | AES-256-GCM (`master.key` 0600); nunca devolvidos pela API; nunca em logs | testes |
| Processos de IA | sem shell, argumentos em vetor, prompt por stdin, diretório 0700, ambiente mínimo, timeout, kill do grupo, ferramentas desligadas, sandbox somente leitura (Codex), usuário sem privilégios | testes com binários falsos |
| Serviço | usuário `terminalmat`, systemd endurecido, `UMask=0077`, escrita só em `/var/lib/terminal-matematico` | revisão (não executado com systemd neste ambiente) |
| Firmware em repouso | NVS criptografado, Flash Encryption, Secure Boot v2 (`sdkconfig.defaults.production`) | **somente no hardware — não validado** |
| OTA | TLS + HMAC + aprovação no painel + hash + assinatura + rollback | **somente no hardware — não validado** |

## Proibições respeitadas

Nenhuma senha de conta ou chave de API no aparelho; nenhum endpoint interno de sites de IA,
cookie, token de navegador, Selenium/Playwright/Puppeteer para chats, scraping ou técnica
para contornar limites; nenhum comando montado por concatenação ou executado por shell;
nenhum parâmetro que conceda acesso irrestrito aos CLIs; CLIs nunca como root; nenhum
comando sugerido pelo modelo é executado; painel e CLIs não são publicados por
encaminhamento de portas; nenhum segredo real no repositório; nenhuma cobrança ou repetição
automática em provedor faturável sem política explícita do dono; nenhum sistema existente
do servidor é alterado pelos scripts; logs sem senhas, tokens, PINs ou imagens.

## Produção do firmware (irreversível — só após validação física)

1. `espsecure.py generate_signing_key --version 2 secure_boot_signing_key.pem` (fora do repositório).
2. Compilar com `SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.production"`.
3. Escolher o esquema de criptografia do NVS (HMAC em eFuse recomendado no S3).
4. Testar primeiro em placa descartável: eFuses não voltam atrás.

## Limitações conhecidas

* Sem RTC com bateria, o tempo de bloqueio do PIN só corre com o aparelho ligado.
* JavaScript não garante zeragem de memória (simulador); no C a limpeza é explícita.
* A prévia da câmera no celular usa HTTP na LAN com código de sessão curto (ver `CAMERA_PREVIEW.md`).
* Pedido já entregue a um provedor pode ter sido processado mesmo após cancelamento; o
  sistema garante apenas que o resultado não é exibido nem armazenado.
