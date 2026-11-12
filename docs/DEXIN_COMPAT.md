# Compatibilidade do modo NORMAL com a calculadora DEXIN KK-82MS-B

> **Estado honesto:** a compatibilidade foi construída a partir do comportamento documentado da
> família fx-82MS (a KK-82MS-B segue esse layout e conjunto de funções). **Nenhuma comparação com a
> unidade física foi feita ainda.** Portanto este projeto **não declara 100 % de compatibilidade**.
> Cada linha abaixo diz se a função está implementada no simulador, no firmware, se tem teste
> automatizado e se foi conferida contra o aparelho físico (coluna "Físico" — hoje sempre "pendente").

Referência de código:

| Camada | Arquivo |
|---|---|
| Simulador (referência executável) | `simulator/js/core/sciCalc.js`, `simulator/js/core/mathEngine.js`, `simulator/js/core/keys.js` |
| Testes do simulador | `tests/simulator/dexin.test.js` (17 cenários), `tests/simulator/app.test.js`, `tests/simulator/math.test.js` |
| Firmware | `firmware/components/calculator`, `firmware/components/math_engine` (seção 5) |

## 1. Regras do modo NORMAL (verificadas por teste)

- Liga sempre em NORMAL (`app_state` no firmware, `App` no simulador; testes `session.test.js` e `app_state` host test).
- Não exige PIN, rede, servidor ou IA (`dexin.test.js` → "modo NORMAL nao mostra IA...").
- Não mostra indicador de IA, câmera, Wi-Fi ou servidor. O único indicador extra é o discreto de autenticação, que só aparece durante a sequência secreta (ver `docs/SECURITY.md`).
- A tecla **MENU** é a única tecla extra em relação ao original (ferramentas offline). Ela não altera o comportamento das demais teclas.

## 2. Inventário de funções e mapeamento de teclas

Legenda — Estado: **SIM** = implementado e testado no simulador **e** no firmware C (seção 5); **FW** = (marca antiga, equivalente a SIM); **—** = não implementado. "Físico": comparação com o aparelho real.

| Tecla física | Primária | SHIFT | ALPHA | Comportamento por modo | Estado | Teste | Físico |
|---|---|---|---|---|---|---|---|
| SHIFT | ativa 2ª função (indicador `S`) | — | — | todos | SIM, FW | app.test | pendente |
| ALPHA | ativa letra (indicador `A`) | — | — | todos | SIM | dexin "memorias" | pendente |
| MODE | menus COMP/SD/REG → Deg/Rad/Gra → Fix/Sci/Norm → Disp | CLR (Mcl/Scl, Mode, All) | — | Mcl em COMP, Scl em SD/REG | SIM | dexin "CLR", "formatos", "SD" | pendente |
| ON | liga / limpa | — | — | — | SIM, FW | session.test | pendente |
| x⁻¹ | `^(-1)` | x! | — | COMP | SIM, FW | dexin "potencias", "fatorial" | pendente |
| nCr | `nCr` infixo | nPr | — | COMP | SIM | dexin "fatorial" | pendente |
| Pol( | Pol(x,y) → r, θ em E/F | Rec(r,θ) → x, y em E/F | — | COMP | SIM | dexin "fatorial" | pendente |
| x³ | `^3` | ∛ | — | COMP | SIM | dexin "potencias" | pendente |
| ab/c | separador ┘ / alterna fração↔decimal | d/c (fração imprópria) | — | COMP | SIM | dexin "fracoes" | pendente |
| √ | raiz quadrada | — | — | COMP | SIM, FW | dexin "potencias" | pendente |
| x² | `^2` | — | — | COMP | SIM, FW | dexin "potencias" | pendente |
| ^ | potência | ˣ√ | — | COMP | SIM, FW | dexin "potencias" | pendente |
| log | log₁₀ | 10ˣ | — | COMP | SIM, FW | dexin "logaritmos" | pendente |
| ln | ln | eˣ | — | COMP | SIM, FW | dexin "logaritmos" | pendente |
| (−) | sinal negativo (não continua de Ans) | — | A | COMP | SIM, FW | dexin "aritmetica" | pendente |
| °'" | entrada sexagesimal | ← (decimal↔DMS) | B | COMP | SIM | dexin "graus-minutos" | pendente |
| hyp | prefixo hiperbólico | — | C | COMP | SIM | dexin "trigonometria" | pendente |
| sin / cos / tan | trig. no modo angular | sin⁻¹ / cos⁻¹ / tan⁻¹ | D / E / F | COMP | SIM | dexin "trigonometria" | pendente |
| RCL | RCL + variável | STO + variável | — | COMP | SIM | dexin "memorias" | pendente |
| ENG | notação de engenharia (expoente ↓) | ← (expoente ↑) | — | COMP | SIM | dexin "formatos" | pendente |
| ( / ) | parênteses (até 24 níveis de pilha) | — | X em `)` | COMP | SIM, FW | dexin "erros" (Stack) | pendente |
| , | separador de argumentos | ; (frequência em SD/REG) | Y | SD/REG | SIM | dexin "SD" | pendente |
| M+ | M += valor; em SD/REG = **DT** | M− (em SD/REG = **CL**) | M | COMP / SD / REG | SIM | dexin "memorias", "SD" | pendente |
| 0–9, . | dígitos | 0 → Rnd(, . → Ran# | — | todos | SIM, FW | dexin "fatorial" | pendente |
| 1 / 2 | dígitos | S-SUM / S-VAR (somente SD/REG) | — | SD/REG | SIM | dexin "SD", "REG" | pendente |
| DEL | apaga | INS (alterna inserir/sobrescrever) | — | todos | SIM, FW | dexin "edicao" | pendente |
| AC | limpa entrada | OFF | — | todos | SIM, FW | app.test | pendente |
| × ÷ + − | operadores | — | — | todos | SIM, FW | dexin "aritmetica" | pendente |
| EXP | ×10ⁿ | π | — | COMP | SIM, FW | dexin "aritmetica", "trigonometria" | pendente |
| Ans | último resultado | DRG► (°, ʳ, ᵍ) | — | COMP | SIM | dexin "DRG" | pendente |
| = | calcula | % | — | COMP | SIM | dexin "porcentagem" | pendente |
| ◄ ► ▲ ▼ (REPLAY) | cursor / histórico / navegação de menus | — | — | todos | SIM, FW | dexin "edicao" | pendente |

### Telas de MODE implementadas

| Toque | Tela | Opções |
|---|---|---|
| MODE ×1 | `COMP SD REG` | 1 COMP, 2 SD, 3 REG → `Lin Log Exp` ► `Pwr Inv Quad` |
| MODE ×2 | `Deg Rad Gra` | 1/2/3 |
| MODE ×3 | `Fix Sci Norm` | Fix 0–9, Sci 0–9 (0 = 10 dígitos), Norm 1/2 |
| MODE ×4 | `Disp` | ab/c ou d/c ► Dot ou Comma |
| SHIFT MODE | `Mcl/Scl Mode All` | limpa memórias/dados, configuração, tudo |

### Mensagens de erro

`Math ERROR`, `Syntax ERROR`, `Stack ERROR`, `Arg ERROR`, `Data Full` — com ◄/► o cursor volta à posição do erro (dexin "edicao", "erros").

### Estatística (SD / REG)

- SD: n, Σx, Σx², x̄, xσn, xσn-1; frequência com `;`; edição de dados com ▲▼; `CL` apaga o dado corrente; `Scl` apaga todos. Limite de 80 entradas → `Data Full`.
- REG: Lin, Log, Exp, Pwr, Inv, Quad; Σx, Σy, Σxy, Σx², Σy², Σx²y, Σx³, Σx⁴; A, B, C, r; x̂, ŷ (x̂1/x̂2 em Quad).

## 3. Divergências conhecidas / itens não verificados

| Item | Situação |
|---|---|
| Multi-instrução com `:` (ALPHA) | **Não implementado** — não foi confirmada a tecla no modelo DEXIN. |
| Contraste do LCD (SHIFT MODE ▼ no original) | Depende do hardware de display ainda não definido; não implementado. |
| Layout exato de caracteres no LCD | O LCD do projeto é 128×32 matricial; o original é segmentado + matriz. Indicadores e símbolos foram reproduzidos com glifos 5×7 próprios (`font.js`), não com a aparência idêntica. |
| Precisão interna | Simulador usa IEEE-754 double (≈15–16 dígitos) e exibe 10 dígitos; o original usa 15 dígitos BCD. Pode haver diferença no último dígito em casos-limite. |
| Algoritmo de Ran# | Gerador diferente; apenas o intervalo (0,000–0,999, 3 casas) é compatível. |
| Ordem de prioridade de casos exóticos (multiplicação implícita, ex. `2sin30`) | Implementada segundo documentação da família; requer confirmação física. |
| Desligamento automático (~6 min) | Implementado no `power_manager` do firmware com valor configurável; tempo exato do original não confirmado. |
| Localização do erro no firmware | O motor C não informa a posição do erro: ◄/► voltam ao fim (sintaxe) ou ao início (matemático), não ao token exato como no simulador. |

## 4. Procedimento de teste físico (para concluir a auditoria)

Materiais: calculadora DEXIN KK-82MS-B nova (bateria cheia), terminal (ou simulador `npm run sim`), esta planilha.

1. **Reset** em ambos: SHIFT MODE 3 = (All) no original; SHIFT MODE 3 no terminal.
2. Para cada linha de `tests/simulator/dexin.test.js`, digite a mesma sequência de teclas nos dois aparelhos e anote o texto exibido no visor (linha de entrada e resultado), incluindo indicadores (S, A, M, D/R/G, FIX/SCI, SD/REG).
3. Repita os casos de borda: `1÷0`, `(−)8^(1÷3)`, `69!`, `70!`, 25 parênteses abertos, `Pol(0,0)`, `10^100`, `1E-99÷10`, fração com > 10 dígitos, DMS de valor negativo, `0^0`, `sin(1E10)`.
4. Registre cada diferença na tabela da seção 3 com: sequência, visor do original, visor do terminal, classificação (bug / limitação de hardware / aceitável).
5. Corrija bugs no simulador **primeiro**, ajuste `dexin.test.js` com o valor real do aparelho, depois porte para o firmware.
6. Só após todas as linhas da seção 2 terem "Físico = OK" o projeto pode declarar compatibilidade integral.

## 5. Firmware C

O modo NORMAL completo foi portado para `firmware/components/calculator` (+ extensões em
`math_engine`: GRA, frações `┘`, DMS `°`, sufixos DRG `ᵒʳᵍ`, `nCr`/`nPr` infixos, `Pol(`/`Rec(`
com E/F, `Rnd(`, `Ran#`, estimativas `x̂`/`ŷ`). Todas as linhas marcadas **SIM** na seção 2 valem
também para o firmware; os mesmos cenários de `dexin.test.js` estão em
`tests/firmware/src/test_calculator.c` (80 verificações) e `test_math_engine.c` (seção `sci82ms`).
Variáveis, Ans e dados estatísticos persistem na NVS (`calc`); a configuração de MODE persiste
nos ajustes. A tecla extra `MENU` abre as ferramentas offline (resolução passo a passo etc.).

Teclas novas do teclado lógico (precisam constar do mapa físico, `hardware/KEYPAD.md`):
`HYP`, `DMS`, `ENG`, `NCR`, `POL`, `CUBE`.
