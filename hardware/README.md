# Dados de hardware necessários para concluir a integração

Nada abaixo foi inventado no código: cada item tem uma interface abstrata e testes, e fica
aguardando o dado. Os campos correspondem ao `menuconfig` ("Terminal Matematico").

## Módulo ESP32-S3 (REQUIREMENTS)
* Modelo exato (ex.: família N16R8), tipo de PSRAM (octal/quad) e tensão da flash.
* GPIOs reservados pelo módulo (PSRAM octal ocupa GPIOs 33–37 em vários módulos).

## Display (DISPLAY)
* Controlador (e datasheet), barramento (SPI/I²C/paralelo), pinos (CS, DC, RST, CLK, MOSI,
  backlight), sequência de inicialização, bias/contraste, organização da memória (páginas),
  orientação, frequência máxima do barramento, inversão por hardware.
* Implementar `display_driver_t` (`firmware/components/display/include/display.h`); o
  framebuffer já está no formato de páginas de 8 pixels.

## Teclado (KEYPAD)
* Número de linhas/colunas, GPIOs, diodos anti-ghosting (sim/não), posição de cada tecla
  (`CONFIG_MT_KEYPAD_KEYMAP`, nomes como em `keypad.h`), se ON é tecla separada com função de
  wake-up, tempo de assentamento do scan.
* Teclas lógicas exigidas pelo modo NORMAL (layout fx-82MS + MENU): `SHIFT ALPHA MODE MENU ON`,
  `INV NCR POL CUBE FRAC SQRT SQR POW LOG LN NEG DMS HYP SIN COS TAN RCL ENG LPAREN RPAREN COMMA STO`,
  `K0..K9 DOT EXP ANS ADD SUB MUL DIV EQ DEL AC`, `UP DOWN LEFT RIGHT` (51 teclas lógicas). Se o teclado
  físico da DEXIN for reaproveitado, a matriz real precisa ser levantada com multímetro.

## Câmera (CAMERA)
* Módulo OV3660 exato, pinos D0–D7, XCLK, PCLK, VSYNC, HREF, SCCB SDA/SCL, PWDN, RESET,
  frequência de XCLK suportada, alimentação/LDO e se PWDN desliga de fato o sensor.

## Energia (POWER)
* Célula Li-Po (capacidade, curva), carregador (CI e pino de status), divisor resistivo e canal
  ADC para medir a bateria (ou fuel gauge e barramento), consumo alvo, comportamento em
  brown-out. Sem circuito de medição o firmware **não** exibe nível de bateria.

## Mecânica e validação
* Tempo de escrita de um quadro completo no LCD (para fechar a medição < 100 ms da tecla ON).
* Medir PBKDF2 (`CONFIG_MT_PBKDF2_ITERATIONS`) e consumo em light sleep.
