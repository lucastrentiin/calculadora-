# Windows (opcional, não testado em Windows real)

O servidor é Node.js puro (sem dependências nativas: `node:sqlite`, `node:crypto`), então
roda em Windows 10/11 com **Node.js 22.13+**. Esta configuração **não foi executada em
Windows** durante o desenvolvimento; o alvo validado é Linux.

1. Instale Node.js 22 LTS (instalador oficial) e o `cloudflared` para Windows.
2. Crie uma conta local **sem privilégios de administrador** (ex.: `terminalmat`).
3. Copie o projeto para `C:\terminal-matematico` e, como `terminalmat`:
   ```powershell
   cd C:\terminal-matematico\backend
   npm ci --omit=dev --ignore-scripts
   $env:MT_PROFILE="production"; $env:MT_DATA_DIR="C:\ProgramData\terminal-matematico"
   node --disable-warning=ExperimentalWarning src\cli\admin.ts create SEU_USUARIO
   ```
4. Serviço: use o Agendador de Tarefas ("Ao iniciar o sistema", executar como `terminalmat`,
   "Executar estando o usuário conectado ou não") com
   `node --disable-warning=ExperimentalWarning C:\terminal-matematico\backend\src\server.ts`
   e as variáveis de `deploy/env/production.env.example` definidas para essa conta.
5. Restrinja `C:\ProgramData\terminal-matematico` (ACL) apenas a `terminalmat`.
6. Os aplicativos CLI (Codex/Claude Code), se usados, devem ser instalados e autenticados
   **na conta `terminalmat`**, nunca como Administrador.

Diferenças conhecidas: permissões POSIX (`0600`/`umask`) não se aplicam — a proteção do
`master.key` depende da ACL da pasta; o encerramento por grupo de processos dos CLIs usa
`taskkill /T` não implementado (o adaptador encerra apenas o processo principal no Windows).
