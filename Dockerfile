# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# JDK 21 (eclipse-temurin) é a base — alvo da migração e runtime do MCP server.
FROM eclipse-temurin:21-jdk-jammy AS runtime

# Node.js (servidor MCP) + Maven + Git, necessários para discovery/transform/gates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg git maven \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# JDK 8 — usado pela Fase 0 (jdeprscan/jdeps) para compilar a aplicação-alvo
# com o JDK de origem antes da análise estática. Variável separada de JAVA_HOME
# (que permanece no JDK 21, runtime do próprio MCP server).
RUN mkdir -p /opt/jdk8 \
    && curl -fsSL -o /tmp/jdk8.tar.gz \
        "https://github.com/adoptium/temurin8-binaries/releases/latest/download/OpenJDK8U-jdk_x64_linux_hotspot.tar.gz" \
    && tar -xzf /tmp/jdk8.tar.gz -C /opt/jdk8 --strip-components=1 \
    && rm /tmp/jdk8.tar.gz
ENV SOURCE_JAVA_HOME=/opt/jdk8

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
COPY config/ config/

# Workspace efêmero para clones do GitWorkspaceStorage (M2) — fora de qualquer
# diretório versionado da própria imagem.
RUN mkdir -p /tmp/workspaces

ENV MCP_TRANSPORT=http
ENV PORT=3000
EXPOSE 3000

# MCP_AUTH_TOKEN, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GRAPH_TENANT_ID,
# GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER_USER_ID — configurados
# como variáveis de ambiente no Render (Settings → Environment), nunca aqui.

CMD ["node", "dist/mcp-server/index.js"]
