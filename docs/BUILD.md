# Compilar, executar e testar

## Requisitos

* Node.js ≥ 22.18 (TypeScript é executado nativamente com *type stripping*)
* CMake ≥ 3.16, GCC/Clang e OpenSSL (headers) para os testes de host do firmware
* ESP-IDF v5.4.x para compilar o firmware (ou use o job de CI com `espressif/idf:v5.4.2`)

## Simulador

```bash
# opção 1: abrir simulator/index.html diretamente no navegador
# opção 2: servidor estático (também para celular)
node tools/serve_simulator.js 8080 --lan
npm run test:sim        # 56 testes (node --test)
```

Teclado do PC: números/operadores, Enter `=`, Backspace `DEL`, Esc `AC`, setas, F1 `ON`,
F2 `SHIFT`, F3 `ALPHA`, F4 `MODE`, F6 `MENU`, Insert `M+`. O painel lateral controla Wi-Fi,
bateria, falhas de IA e câmera, OTA e permite executar um autoteste no navegador.

Para usar o backend real a partir do simulador: inicie o backend com `CORS_ORIGIN`, provisione
um dispositivo e preencha URL, Device ID e chave no painel "IA".

## Backend

```bash
cd backend
npm ci
npm run typecheck && npm test
npm run provision -- dev-001 "meu aparelho"     # imprime a chave UMA vez
# desenvolvimento local sem IA real:
AI_PROVIDER=mock ALLOW_INSECURE_HTTP=1 PORT=8080 npm start
# produção (TLS direto ou atrás de proxy TLS):
ANTHROPIC_API_KEY=... TLS_CERT_FILE=... TLS_KEY_FILE=... npm start
```

Endpoints: `GET /v1/health`, `POST /v1/ask`, `POST /v1/image` (JPEG bruto),
`POST /v1/requests/:id/cancel`. Configuração: `backend/.env.example`.
Modelo padrão: `claude-opus-5-5` com saída estruturada e *fallback* de recusa no servidor
(`ANTHROPIC_MODEL` e `AI_EFFORT` ajustáveis).

## Firmware – testes de host (sem hardware)

```bash
npm run test:firmware   # CMake + CTest, com AddressSanitizer/UBSan
```

## Firmware – ESP32-S3

```bash
cd firmware
idf.py set-target esp32s3
idf.py menuconfig        # "Terminal Matematico": backend, pinos (quando definidos), câmera...
idf.py build flash monitor
```

Sem LCD e sem teclado definidos, use os drivers de bring-up (padrão): o visor é espelhado em
ASCII no monitor serial e as teclas são digitadas no próprio monitor
(dígitos, `+ - * / ^ ( )`, Enter `=`, Esc `AC`, `O`=ON, `S`=SHIFT, `A`=ALPHA, `M`=MENU,
`u/d/h/o` setas).

Depois de alterar fontes, fórmulas ou conversões no simulador: `npm run gen`.
