#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer, createCloudMcpServer, type CloudServerOptions } from './create-server.js'
import { createHttpServer } from './http-transport.js'
import { createGitHubAppOctokit, createGitHubPatOctokit } from '../adapters/cloud/github-app-auth.js'
import { createGitHubApiGateway } from '../adapters/cloud/github-api-gateway.js'
import { createGraphNotifier } from '../adapters/cloud/graph-notifier.js'

/**
 * Seleção de transporte por variável de ambiente:
 *  - MCP_TRANSPORT=stdio (padrão) — modo local atual, inalterado
 *  - MCP_TRANSPORT=http           — modo remoto (Render), exige MCP_AUTH_TOKEN em produção
 *
 * Variáveis de ambiente para modo HTTP (todas configuradas no Render):
 *   MCP_AUTH_TOKEN          — Bearer token para autenticação do endpoint /mcp
 *   PORT                    — porta HTTP (default 3000; Render injeta automaticamente)
 *   GITHUB_APP_ID           — ID do GitHub App (ex: "123456")
 *   GITHUB_APP_PRIVATE_KEY  — PEM completo da private key do GitHub App
 *   GITHUB_APP_INSTALLATION_ID — ID da instalação do App no repo-alvo
 *   GITHUB_OWNER            — dono do repositório-alvo (ex: "acme")
 *   GITHUB_REPO             — nome do repositório-alvo (ex: "billing-service")
 *   GRAPH_TENANT_ID         — Tenant ID do Azure AD / Entra ID
 *   GRAPH_CLIENT_ID         — Client ID do app registrado no Azure AD
 *   GRAPH_CLIENT_SECRET     — Client secret do app Azure AD
 *   GRAPH_SENDER_USER_ID    — UPN da caixa remetente (ex: "migracoes@empresa.com")
 */
const transportMode = process.env.MCP_TRANSPORT ?? 'stdio'

if (transportMode === 'http') {
  const port = Number(process.env.PORT ?? 3000)
  const authToken = process.env.MCP_AUTH_TOKEN
  if (!authToken) {
    console.error('[jdk-migration] AVISO: MCP_AUTH_TOKEN não definido — endpoint /mcp ficará sem autenticação.')
  }

  const cloudOpts: CloudServerOptions = {}

  // ── GitHub App (octokit — usado pelas gate tools cloud para PRs e comentários) ──
  // GitWorkspaceStorage + GitHubApiGateway para execute_phase requerem construção
  // por sessão de migração (repoUrl e branch são dinâmicos por chamada), o que exige
  // refatoração adicional do execute-phase.ts para injeção por requisição.
  // Por ora, execute_phase usa LocalFsStorage + LocalGitCli sobre o workspace clonado
  // (comportamento correto quando o projectPath aponta para o clone efêmero em /tmp).
  const ghAppId = process.env['GITHUB_APP_ID']
  const ghPrivateKey = process.env['GITHUB_APP_PRIVATE_KEY']
  const ghInstallationId = process.env['GITHUB_APP_INSTALLATION_ID']
  const ghPat = process.env['GITHUB_PAT']
  const ghOwner = process.env['GITHUB_OWNER']
  const ghRepo = process.env['GITHUB_REPO']

  if (ghAppId && ghPrivateKey && ghInstallationId && ghOwner && ghRepo) {
    // Produção: GitHub App (Cielo ou org corporativa)
    const octokit = createGitHubAppOctokit({
      appId: ghAppId,
      privateKey: ghPrivateKey.replace(/\\n/g, '\n'),
      installationId: ghInstallationId,
    })
    void createGitHubApiGateway({ owner: ghOwner, repo: ghRepo, octokit })
    console.error(`[jdk-migration] GitHub App configurado: owner=${ghOwner} repo=${ghRepo}`)
  } else if (ghPat && ghOwner && ghRepo) {
    // Fallback: PAT pessoal (teste/POC — nunca usar em produção corporativa)
    const octokit = createGitHubPatOctokit(ghPat)
    void createGitHubApiGateway({ owner: ghOwner, repo: ghRepo, octokit })
    console.error(`[jdk-migration] GitHub PAT configurado (modo teste): owner=${ghOwner} repo=${ghRepo}`)
  } else {
    console.error('[jdk-migration] INFO: env vars do GitHub não configuradas — git CLI local será usado.')
  }

  // ── Microsoft Graph (GraphNotifier) ───────────────────────────────────────
  const graphTenantId = process.env['GRAPH_TENANT_ID']
  const graphClientId = process.env['GRAPH_CLIENT_ID']
  const graphClientSecret = process.env['GRAPH_CLIENT_SECRET']
  const graphSenderUserId = process.env['GRAPH_SENDER_USER_ID']

  if (graphTenantId && graphClientId && graphClientSecret && graphSenderUserId) {
    cloudOpts.graphNotifier = createGraphNotifier({
      tenantId: graphTenantId,
      clientId: graphClientId,
      clientSecret: graphClientSecret,
      senderUserId: graphSenderUserId,
    })
    console.error('[jdk-migration] Microsoft Graph configurado — PINs serão enviados via Teams + e-mail.')
  } else {
    console.error('[jdk-migration] AVISO: env vars do Microsoft Graph ausentes — PINs armazenados mas NÃO enviados por Teams/e-mail.')
  }

  // GATE_BYPASS=true: auto-aprova gates sem PIN (POC sem Microsoft Graph configurado).
  // Remover esta env var no Render quando o Azure AD estiver disponível.
  const gateBypass = process.env['GATE_BYPASS'] === 'true'
  if (gateBypass) {
    console.error('[jdk-migration] ⚠️  GATE_BYPASS ativo — gates serão auto-aprovados SEM PIN. Remover em produção real.')
  }
  cloudOpts.gateBypass = gateBypass

  const httpServer = createHttpServer({ authToken, serverFactory: () => createCloudMcpServer(cloudOpts) })
  httpServer.listen(port, () => {
    console.error(`[jdk-migration] MCP server (HTTP) ouvindo na porta ${port}`)
  })
} else {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
