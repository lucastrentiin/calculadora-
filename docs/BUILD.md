# Compilar, executar e testar

## Requisitos

* Node.js ≥ 22.13 (TypeScript executado nativamente; `node:sqlite`)
* CMake ≥ 3.16, GCC/Clang e OpenSSL (headers) para os testes de host do firmware
* ESP-IDF v5.4.x para o firmware (o CI usa o container `espressif/idf:v5.4.2`)

## Tudo de uma vez

```bash
npm --prefix backend ci
npm test        # test:sim + test:backend + test:integration + test:firmware
```

## Simulador

```bash
node tools/serve_simulator.js 8080          # ou abra simulator/index.html
node tools/serve_simulator.js 8080 --lan    # celular na mesma rede
npm run test:sim
```

Teclado do PC: números/operadores, Enter `=`, Backspace `DEL`, Esc `AC`, setas, F1 `ON`,
F2 `SHIFT`, F3 `ALPHA`, F4 `MODE`, F6 `MENU`, Insert `M+`, `h` hyp, `d` °'", `k` ENG, `o` Pol,
`u` x³, `v` RCL, `C` nCr. Painel lateral: Wi-Fi, bateria, falhas simuladas, câmera, OTA, e
"IA" para apontar para o servidor real (URL local, URL remota, token do Access, id e chave).

## Servidor doméstico (desenvolvimento)

```bash
cd backend
set -a; . ../deploy/env/development.env.example; set +a
npm run admin -- create dono              # senha + TOTP (TOTP opcional em desenvolvimento)
npm run admin -- device-add sim-1         # chave do dispositivo (exibida uma vez)
npm start                                 # http://127.0.0.1:8787  (painel em /admin/)
npm run typecheck && npm test
```

Produção: [deploy/README.md](../deploy/README.md).

## Firmware – testes de host

```bash
npm run test:firmware      # CMake + CTest, AddressSanitizer/UBSan
```

## Firmware – ESP32-S3

```bash
cd firmware
idf.py set-target esp32s3
idf.py menuconfig          # Terminal Matematico: URL LAN/remota, pinos (quando existirem), câmera, OTA
idf.py build flash monitor
```

Sem LCD/teclado definidos, os drivers de bring-up espelham o visor em ASCII no monitor serial
e leem teclas digitadas nele. Após alterar fontes/fórmulas/conversões no simulador: `npm run gen`.
