#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer, createCloudMcpServer } from './create-server.js'
import { createHttpServer } from './http-transport.js'

/**
 * Seleção de transporte por variável de ambiente:
 *  - MCP_TRANSPORT=stdio (padrão) — modo local atual, inalterado
 *  - MCP_TRANSPORT=http           — modo remoto (Render), exige MCP_AUTH_TOKEN em produção
 */
const transportMode = process.env.MCP_TRANSPORT ?? 'stdio'

if (transportMode === 'http') {
  const port = Number(process.env.PORT ?? 3000)
  const authToken = process.env.MCP_AUTH_TOKEN
  if (!authToken) {
    console.error('[jdk-migration] AVISO: MCP_AUTH_TOKEN não definido — endpoint /mcp ficará sem autenticação.')
  }
  // Modo cloud: request_gate_approval nunca devolve o PIN; approve_gate valida
  // contra CloudSecretStore. GraphNotifier configurado via env vars (M4).
  // GitWorkspaceStorage + GitHubApiGateway são injetados aqui quando disponíveis
  // (env vars GITHUB_APP_ID etc. configuradas no Render).
  const httpServer = createHttpServer({ authToken, serverFactory: () => createCloudMcpServer() })
  httpServer.listen(port, () => {
    console.error(`[jdk-migration] MCP server (HTTP) ouvindo na porta ${port}`)
  })
} else {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
