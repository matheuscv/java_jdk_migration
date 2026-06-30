# syntax=docker/dockerfile:1

# ── JDK 8 stage (fonte para COPY — sem curl, sem URL frágil) ─────────────────
FROM eclipse-temurin:8-jdk-jammy AS jdk8

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts evita que o hook prepare→npm run build→tsc execute antes
# de src/ e tsconfig.json serem copiados para a imagem.
RUN npm ci --ignore-scripts
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

# JDK 8 — copiado diretamente da imagem oficial (sem curl, sem URL frágil).
COPY --from=jdk8 /opt/java/openjdk /opt/jdk8
ENV SOURCE_JAVA_HOME=/opt/jdk8

WORKDIR /app
COPY package*.json ./
# --ignore-scripts: no runtime stage não há tsconfig/src, então prepare→tsc falharia.
RUN npm ci --omit=dev --ignore-scripts
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
