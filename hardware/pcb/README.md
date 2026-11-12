# Placa do teclado — versão preliminar para orçamento

Gerada por `node tools/gen_keypad_pcb.js` (saída em `hardware/pcb/out/`).

## O que é

Placa única que substitui a placa original da calculadora (formato 82MS), no mesmo arranjo
da VovoCorp: **frente** com os contatos das teclas, **verso** com os componentes, e a tela
**fora da placa**, numa barra ligada por cabo flexível soldado na borda de cima. Câmera
também por cabo (aparece por um furo na tampa traseira) e bateria por fios. Tem 50 teclas com contato em pente (os pinos de carbono da borracha fecham o
contato), matriz 9 linhas × 7 colunas roteada em duas camadas, tecla ON separada (pino
próprio para acordar o ESP32) e uma fileira de 18 ilhas para os fios: R0–R8, C0–C6, ON e GND.

Verificações automáticas a cada geração: folga mínima de 0,15 mm entre sinais diferentes,
0,3 mm até a borda, e continuidade de cada sinal até a sua ilha. Os arquivos foram lidos
sem erro por um leitor Gerber independente (gerbonara).

## O que ainda NÃO é (não mande fabricar esta versão)

* **Contorno e posição das teclas são estimados.** A JS-82MS-A ainda não foi medida. Se
  as teclas não caírem exatamente sob os pinos de carbono, a placa não funciona.
* **Módulo ESP32-S3, conector da câmera, solda do cabo da tela, carregador/regulador e
  bateria estão só reservados** (contornos na serigrafia do verso, sem ilhas de solda).
  Entram na versão final, com as peças escolhidas. Com o módulo ESP32-S3 direto na placa,
  o MCP23017 deixa de ser necessário.
* Sem furos de fixação: dependem dos pinos da carcaça.

O orçamento sai certo mesmo assim, porque o preço da placa depende de tamanho, camadas,
espessura, acabamento e quantidade — e esses já são os da versão final.

## Parâmetros para o orçamento

| Campo no site | Valor |
|---|---|
| Camadas | 2 |
| Dimensões | 70 × 100 mm |
| Quantidade | 5 (mínimo) |
| Espessura | **0,8 mm** (perto da placa original; 1,0 mm também serve) |
| Material | FR-4 |
| Acabamento | **Protótipo: HASL sem chumbo** (cotado em R$ 158 contra R$ 428 com ENIG, 5 placas). Os contatos ficam levemente ondulados e oxidam com o tempo: não tocar com os dedos, limpar com álcool isopropílico antes de montar e quando uma tecla falhar, guardar em lugar seco. **Versão final: ENIG** |
| Cobre | 1 oz |
| Máscara / serigrafia | verde / branca (qualquer cor) |
| Trilha / espaço mínimos | 0,2 / 0,2 mm |
| Menor furo | 0,3 mm (vias), 1,0 mm (ilhas de fio) |
| Montagem (PCBA) | Não, por enquanto |

Envie o arquivo `terminal-teclado-gerber-v1.zip`. A placa tem 70 × 100 mm, então entra na
faixa até 100 × 100 mm, em que muitas fábricas cobram mais barato. Some frete e impostos de
importação, que costumam pesar mais que a placa.
