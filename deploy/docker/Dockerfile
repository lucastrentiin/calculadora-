# Imagem do servidor domestico (alternativa ao systemd).
# Limite importante: os aplicativos CLI (Codex/Claude Code) e seus logins NAO estao na imagem.
# Em container use MockProvider, entrada manual ou as APIs oficiais (chave cadastrada no painel).
FROM node:22-bookworm-slim
ENV NODE_ENV=production MT_PROFILE=production MT_DATA_DIR=/data SERVER_LOCAL_HOST=0.0.0.0 SERVER_LOCAL_PORT=8787
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY backend/src backend/src
COPY backend/tsconfig.json backend/
COPY dashboard dashboard
COPY simulator/js/core simulator/js/core
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin terminalmat && mkdir -p /data && chown terminalmat /data && chmod 0700 /data
USER terminalmat
VOLUME ["/data"]
EXPOSE 8787
WORKDIR /app/backend
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
