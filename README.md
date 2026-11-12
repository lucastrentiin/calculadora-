# Terminal Matemático (ESP32-S3)

Firmware, backend e simulador de um terminal matemático com LCD gráfico monocromático
(referência 128×32), teclado físico, câmera OV3660, Wi-Fi e consulta opcional a IA.

O dispositivo funciona como calculadora científica offline. Funções protegidas
(IA por texto/imagem, histórico e favoritos privados, ajustes) ficam atrás de uma
autenticação discreta por PIN. A tecla **ON** age como bloqueio de privacidade de um toque.

| Parte | Diretório | Estado |
|---|---|---|
| Simulador web (PC e celular) | `simulator/` | Funcional, sem dependências externas |
| Backend seguro de IA (TypeScript) | `backend/` | Funcional; provedor Claude via SDK oficial; provedor mock |
| Firmware ESP-IDF (C) | `firmware/` | Núcleo portável testado no host; camada ESP compilada no CI; **não validado em hardware** |
| Testes | `tests/` | Simulador (node --test), firmware no host (CTest + ASan/UBSan) |
| Documentação | `docs/` | Arquitetura, segurança, build, provisionamento, OTA, prévia da câmera |
| Hardware | `hardware/` | Dados que faltam para fechar a integração |

## Início rápido

```bash
# Simulador: abra simulator/index.html no navegador (duplo clique), ou:
node tools/serve_simulator.js 8080          # http://127.0.0.1:8080
node tools/serve_simulator.js 8080 --lan    # para abrir no celular na mesma rede

# Todos os testes (simulador + backend + firmware no host)
cd backend && npm ci && cd ..
npm test
```

No simulador: digite contas normalmente. Para a área protegida pressione
`SHIFT SHIFT ALPHA ALPHA` (padrão configurável); na primeira vez é pedido para criar o PIN
(6 a 8 dígitos). Depois, a combinação mostra apenas um ponto no canto superior direito:
digite o PIN e `=`. `ON` volta imediatamente ao modo normal.

Detalhes: [docs/BUILD.md](docs/BUILD.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/STATUS.md](docs/STATUS.md) ·
[hardware/README.md](hardware/README.md)
