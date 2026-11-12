# Estudo: MCP (Model Context Protocol) — opcional, não implementado

**Pergunta:** vale expor o servidor doméstico via MCP (para que um app de IA consulte
ferramentas do terminal) ou consumir servidores MCP a partir dele?

**Conclusão:** não implementar agora.

* O fluxo do terminal é uma pergunta → uma resposta estruturada; não há ferramenta externa
  que o modelo precise chamar. Os CLIs rodam com **ferramentas desligadas** de propósito
  (sem acesso a arquivos, shell ou rede); adicionar MCP reabriria essa superfície.
* Um servidor MCP exposto pela Cloudflare seria mais um serviço público a proteger; a
  exigência do projeto é não expor CLIs, sockets ou processos internos pelo subdomínio.
* Caso futuro razoável: um servidor MCP **somente local** (stdio) e **somente leitura** que
  ofereça ao Claude Code/Codex a ferramenta "avaliar expressão" com o motor matemático do
  projeto, para o modelo conferir contas. Requisitos: lista de permissões explícita
  (`--allowedTools` apenas dessa ferramenta), sem rede, sem escrita, limite de tempo,
  e testes mostrando que nenhuma outra ferramenta fica disponível.
