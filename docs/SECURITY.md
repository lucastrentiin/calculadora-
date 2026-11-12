# Segurança

## O que está implementado (e onde é comprovado)

| Mecanismo | Implementação | Comprovado em |
|---|---|---|
| Verificador do PIN | PBKDF2-HMAC-SHA256 (salt 16 B aleatório), armazena `SHA-256(dk[0:32])`; nunca o PIN | testes de host e simulador |
| Chave de dados | `dk[32:64]` do mesmo PBKDF2; existe só em RAM com a sessão aberta | testes |
| Cofre privado | AES-256-GCM (IV aleatório, AAD fixo), histórico de IA e favoritos | testes (blob não contém texto puro; chave errada falha) |
| Tentativas | 5 erros → bloqueio 30 s, dobra a cada erro (máx. 1 h); persistido; contagem só avança com o aparelho ligado (sem RTC) | testes |
| Bloqueio automático | inatividade configurável, suspensão e bateria crítica disparam PRIVACY_LOCK | testes |
| Limpeza de buffers | `sec_wipe` (volátil) em PIN, textos, respostas, imagens, chaves | revisão + testes de comportamento |
| Logs | eventos sem PIN, perguntas, respostas, SSID ou senha | testes verificam ausência no log |
| Autenticação do dispositivo | HMAC-SHA256 sobre método, caminho, timestamp, nonce e hash do corpo; janela de 5 min; anti-replay | testes do backend e vetor cruzado C↔TS |
| Chave da IA | apenas no backend (`ANTHROPIC_API_KEY`); o firmware nunca a recebe | arquitetura |
| HTTPS | firmware recusa `http://` (exceto build de desenvolvimento); valida certificado com bundle de CAs ou CA fixada | código; **validar no hardware** |
| Credenciais Wi-Fi | partição NVS `mtdata`, criptografada com `CONFIG_NVS_ENCRYPTION` | **somente no hardware** |
| Flash Encryption / Secure Boot v2 | `sdkconfig.defaults.production` | **somente no hardware** |
| OTA | TLS + verificação de hash do manifesto + assinatura (Secure Boot v2) + rollback | **somente no hardware** |

O simulador usa WebCrypto e `localStorage`: **não** oferece proteção real contra quem tem
acesso ao navegador. Ele demonstra o comportamento funcional, não a segurança física.

## Iterações do PBKDF2

O padrão do firmware é 60 000 (`CONFIG_MT_PBKDF2_ITERATIONS`). É obrigatório medir no
ESP32-S3 final (aceleração SHA por hardware) e ajustar para ~0,5–1 s por verificação.
A verificação roda na tarefa `crypto`, sem bloquear a interface nem a tecla ON.

## Produção (irreversível)

1. Gere a chave de assinatura: `espsecure.py generate_signing_key --version 2 secure_boot_signing_key.pem`
   (guarde fora do repositório; `.gitignore` já bloqueia `*.pem`).
2. Compile com `SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.production"`.
3. Escolha o esquema de criptografia do NVS (HMAC com chave em eFuse é recomendado no S3).
4. Teste primeiro em uma placa descartável: eFuses queimados não podem ser revertidos.
5. Desative logs verbosos e o modo de download inseguro (já no arquivo de produção).

## Limitações conhecidas

* Sem RTC com bateria, o tempo de bloqueio só corre com o aparelho ligado (é persistido).
* JavaScript não garante zeragem de memória; no C a limpeza é explícita.
* A prévia da câmera usa HTTP na rede local (sem TLS) e é protegida por código de sessão de
  uso curto; não a habilite em redes não confiáveis (ver `CAMERA_PREVIEW.md`).
* Uma requisição já entregue ao provedor de IA pode ter sido processada mesmo após o
  cancelamento; o sistema só garante que a resposta não é exibida nem armazenada.
