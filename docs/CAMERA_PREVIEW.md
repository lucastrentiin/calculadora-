# Prévia da câmera no celular

Recurso **opcional** (`CONFIG_MT_CAM_PREVIEW`). O aparelho funciona sem ele.

## Funcionamento

1. Na tela protegida da câmera, `MODE` inicia a sessão; o LCD mostra um código de 8 caracteres.
2. No celular (mesma rede): `http://<ip-do-aparelho>/?c=<CODIGO>`.
3. A página mostra um fluxo MJPEG em baixa resolução e um botão **Capturar**.
4. A sessão termina automaticamente após 120 s, com 5 códigos errados, ao sair da tela,
   ou com a tecla ON.

## Proteções

* só disponível após autenticação por PIN; servidor ativo apenas durante a sessão;
* código aleatório comparado em tempo constante, nunca registrado em log;
* nenhuma imagem é gravada; nenhum acesso pela internet (sem relay, sem port forwarding).

## Limitações avaliadas

| Fator | Impacto |
|---|---|
| Sem TLS | celulares rejeitam certificados autoassinados; o tráfego na LAN não é cifrado. Use só em redes confiáveis (ex.: hotspot próprio). |
| Hotspot do celular | muitos isolam clientes; nesse caso o celular que é o hotspot ainda alcança o aparelho, outros não. |
| Wi-Fi/RAM | QVGA a 1–5 quadros/s; quadros em PSRAM (2 buffers). Resoluções altas degradam a prévia. |
| Energia | câmera + Wi-Fi é o maior consumo; a sessão é curta por padrão. |
