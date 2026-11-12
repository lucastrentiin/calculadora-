# Estado da implementação

Legenda: **Real** = código funcional e testado · **Simulado** = existe só como simulação ·
**Escrito, não validado** = código ESP-IDF escrito, compilado no CI, nunca executado em hardware ·
**Pendente** = depende de dado de hardware ainda inexistente.

| Requisito | Simulador | Firmware (C) | Observação |
|---|---|---|---|
| Motor matemático, erros, formatação | Real | Real (testado no host) | parser próprio, sem `eval` |
| Resolução passo a passo | Real | Real | redução da árvore, uma operação por etapa |
| Equações 1º/2º grau, sistemas 2×2/3×3, estatística | Real | Real | |
| Matrizes (det/inversa/transposta), tabela de valores | Real | Pendente (só simulador) | |
| Fórmulas (46) e conversões (10 categorias) | Real | Real (tabelas geradas) | exemplos verificados nos testes |
| Estados, PIN discreto, bloqueio por tentativas | Real | Real | |
| Tecla ON / PRIVACY_LOCK em todos os estados | Real (medido ~0,2 ms no navegador) | Real no host; latência no LCD: **medir** | |
| Rolagem vertical e horizontal | Real | Real | |
| Teclado virtual (A) e multi-tap (B) | Real | Real | |
| Modos rápido/curto/completo | Real | Real | |
| Histórico e favoritos criptografados | Real (WebCrypto) | Real (AES-GCM) | |
| Cliente IA, cancelamento explícito | Simulado ou backend real | Protocolo Real; transporte HTTPS escrito, não validado | |
| Backend + Claude | — | — | Real (testes com mock; chamada real requer chave) |
| Câmera OV3660 | Simulado (canvas/webcam) | Escrito, não validado | pinos pendentes |
| Prévia no celular | Simulado | Escrito, não validado | |
| Wi-Fi, provisionamento pelo celular | Simulado | Escrito, não validado | |
| OTA assinado + rollback | Simulado | Escrito, não validado | |
| Bateria | Simulado | ADC escrito, não validado | circuito pendente |
| Suspensão | Simulado | Política Real; light sleep escrito | pinos de wake pendentes |
| Driver do LCD | Canvas | **Pendente** | interface + drivers console/null prontos |
| Teclado físico | Botões/PC | Matriz escrita, não validada | pinos e mapa pendentes |
| Acessibilidade (fonte grande, menus simples, inversão, rolagem, repetição) | Real | Real (repetição no núcleo do teclado) | |
| Flash Encryption / Secure Boot | — | Configuração pronta | só comprovável no hardware |
