# Provedores de IA no servidor doméstico

Todos implementam `AIProvider` (`backend/src/providers/types.ts`) e aparecem no painel em
**Aplicativos de IA** com: estado (pronto / não instalado / não autenticado / não configurado /
desativado / erro), forma de autenticação, cobrança (assinatura / API / manual / nenhuma),
capacidades detectadas (texto, imagem, saída estruturada, cancelamento), modelo, botões
*Testar* e *Atualizar*. O proprietário escolhe quais aparecem no terminal (menu *Assistente*)
e qual é o padrão.

| Id | Provedor | Como funciona | Imagens | Cobrança | Padrão |
|---|---|---|---|---|---|
| `mock` | MockProvider | respostas determinísticas locais para testes | sim | nenhuma | ligado; é o provedor preferido inicial (troque no painel) |
| `manual` | Manual | pergunta/imagem vão para a fila do painel; o dono usa o app oficial e cola a resposta | sim | manual | ligado |
| `claude_code` | Claude Code CLI | executa o binário oficial `claude -p` | não (headless sem imagem documentada) | API ou assinatura | **desligado** até confirmação |
| `codex_cli` | Codex CLI | executa o binário oficial `codex exec` | se a versão instalada tiver `--image` | assinatura ChatGPT | **desligado** até confirmação |
| `anthropic_api` | API Anthropic (SDK oficial `@anthropic-ai/sdk`) | Messages API, saída estruturada, `claude-opus-5-5` por padrão | sim | API (Console) | "não configurado" até cadastrar a chave |
| `openai_api` | API OpenAI (SDK oficial `openai`) | Responses API com saída estruturada; **modelo escolhido pelo dono** a partir de `models.list()` | sim | API | "não configurado" até chave + modelo |
| `siwc` | "Sign in with ChatGPT" | **indisponível**: exige `client_id` aprovado pela OpenAI e documentação que não pôde ser verificada; nenhum fluxo foi inventado | — | — | indisponível |

## A solução para o Claude (pedido do proprietário)

1. **Caminho inequivocamente permitido:** `claude_code` com autenticação **api_key** (chave do
   Console cadastrada no painel, cifrada com AES-256-GCM, passada ao processo apenas por
   variável de ambiente) **ou** o provedor `anthropic_api`.
2. **Assinatura pessoal (Pro/Max):** modo **subscription**, permitido apenas porque é o
   próprio dono, no próprio servidor, usando o binário oficial sem modificação, para as
   próprias perguntas. Fica desligado por padrão e exige confirmação explícita no painel de
   que o dono leu os termos e limites do plano. O servidor **nunca** lê, copia, exporta ou
   encaminha `~/.claude` ou tokens; o login é feito pelo dono, no console, como o usuário de
   serviço (`sudo -u terminalmat -H claude` → `/login`).
3. Não é oferecido a outras pessoas, não contorna limites, não troca automaticamente para
   outro provedor faturável e não automatiza claude.ai.

Execução segura (`cliRunner.ts`): `spawn` sem shell, argumentos em vetor (nada concatenado),
prompt por **stdin**, diretório temporário privado (0700) apagado ao final, ambiente mínimo
(`HOME` do usuário de serviço, `PATH`, idioma; chave só quando o modo é api_key), tempo
limite, encerramento do grupo de processos, limites de saída, redação de segredos em erros.
Capacidades lidas do `--help` da versão instalada; se não houver forma de **desligar as
ferramentas** (`--tools ""` ou `--disallowedTools "*"`) a execução é recusada. Flags usadas
quando existem: `--output-format json`, `--json-schema`, `--permission-mode dontAsk`,
`--restricted`, `--no-session-persistence`, `--max-turns 3`, `--model`.

Codex: `codex exec --sandbox read-only --skip-git-repo-check --output-last-message <f>
--output-schema <f> [--model m] [--image f] -`; recusa se a versão não tiver `--sandbox`.
Status de login por `codex login status`; *logout* pelo painel chama `codex logout`.

## Verificação das respostas

Todo provedor responde no formato estruturado `ModelSolution` (Zod). O servidor reavalia
`check.expression` com o motor matemático local (mesmo do terminal) e marca
`verification.state` = confere / diverge / não verificável; o terminal exibe a origem
(`[IA]`, `[SERVIDOR]`, `[LOCAL]`) e a fonte (provedor/modelo).

## Falhas e reserva

Erros classificados (não instalado, não autenticado, limite/créditos, tempo esgotado, saída
inválida, recusa). Reserva para outro provedor só se o dono configurar uma política
explícita; nunca para um provedor faturável sem autorização e nunca depois que a
requisição foi entregue ao primeiro provedor.

## O que foi e não foi testado

* Testado de ponta a ponta: Mock, Manual, montagem de argumentos e tratamento de saída dos
  CLIs com **binários falsos** (scripts que imitam `claude`/`codex`), SDKs com clientes falsos.
* **Não testado com contas reais:** nenhuma chamada real ao Claude Code, Codex, API Anthropic
  ou API OpenAI foi feita (não há credenciais neste ambiente). Aceitar `login` num CLI não
  prova que a integração por assinatura funciona: valide com *Testar* no painel.
