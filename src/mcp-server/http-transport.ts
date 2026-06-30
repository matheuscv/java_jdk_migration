import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './create-server.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface HttpTransportOptions {
  /**
   * Token Bearer exigido no header Authorization de POST /mcp.
   * Quando ausente/undefined, a autenticação é desabilitada (uso local/dev only —
   * em produção (Render) MCP_AUTH_TOKEN deve estar sempre configurado).
   */
  authToken?: string
  /**
   * Fábrica de McpServer por requisição (stateless). Default: createMcpServer() (modo local).
   * index.ts injeta createCloudMcpServer() quando MCP_TRANSPORT=http para ativar os
   * adapters cloud (gate sem PIN no retorno, CloudSecretStore, etc.).
   */
  serverFactory?: () => McpServer
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function isAuthorized(req: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true
  return req.headers.authorization === `Bearer ${authToken}`
}

/**
 * Cria o listener de requisições HTTP do MCP server (sem dar bind em porta) —
 * separado de createHttpServer() para permitir teste direto da lógica de
 * roteamento/auth sem abrir socket de rede.
 *
 * Modo stateless: uma McpServer + StreamableHTTPServerTransport novos por
 * requisição POST /mcp (sessionIdGenerator: undefined), seguindo o padrão
 * oficial do SDK para servidores sem estado de sessão entre chamadas.
 */
export function createHttpRequestListener(
  options: HttpTransportOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, { status: 'ok' })
      return
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      if (!isAuthorized(req, options.authToken)) {
        writeJson(res, 401, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'unauthorized' },
          id: null,
        })
        return
      }

      try {
        const server = (options.serverFactory ?? createMcpServer)()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

        res.on('close', () => {
          void transport.close()
          void server.close()
        })

        await server.connect(transport)
        await transport.handleRequest(req, res)
      } catch (err) {
        if (!res.headersSent) {
          writeJson(res, 500, {
            jsonrpc: '2.0',
            error: { code: -32603, message: err instanceof Error ? err.message : 'internal_error' },
            id: null,
          })
        }
      }
      return
    }

    writeJson(res, 404, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'not_found' },
      id: null,
    })
  }
}

/**
 * Cria o http.Server pronto para .listen(). Variáveis de ambiente lidas pelo
 * chamador (index.ts) — esta função recebe apenas as opções já resolvidas.
 */
export function createHttpServer(options: HttpTransportOptions = {}): Server {
  return createServer(createHttpRequestListener(options))
}
