import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { createHttpServer } from '../../src/mcp-server/http-transport.js'

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('expected AddressInfo from ephemeral port bind')
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('createHttpServer — healthcheck', () => {
  it('GET /health returns 200 with status ok', async () => {
    const server = createHttpServer()
    const port = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ status: 'ok' })
    } finally {
      await closeServer(server)
    }
  })
})

describe('createHttpServer — autenticação Bearer', () => {
  it('rejeita POST /mcp sem Authorization quando authToken está configurado', async () => {
    const server = createHttpServer({ authToken: 'secret-token-123' })
    const port = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      })
      expect(res.status).toBe(401)
    } finally {
      await closeServer(server)
    }
  })

  it('rejeita POST /mcp com Bearer token incorreto', async () => {
    const server = createHttpServer({ authToken: 'secret-token-123' })
    const port = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-errado',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      })
      expect(res.status).toBe(401)
    } finally {
      await closeServer(server)
    }
  })

  it('quando authToken não é configurado, não exige Authorization', async () => {
    const server = createHttpServer({})
    const port = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
          id: 1,
        }),
      })
      expect(res.status).not.toBe(401)
    } finally {
      await closeServer(server)
    }
  })
})

describe('createHttpServer — roteamento', () => {
  it('retorna 404 para rotas desconhecidas', async () => {
    const server = createHttpServer()
    const port = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/nao-existe`)
      expect(res.status).toBe(404)
    } finally {
      await closeServer(server)
    }
  })
})

describe('createHttpServer — paridade com as tools registradas (handshake real)', () => {
  it('tools/list via HTTP retorna as mesmas 12 tools registradas em createMcpServer', async () => {
    const server = createHttpServer({ authToken: 'secret-token-123' })
    const port = await listenEphemeral(server)
    try {
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer secret-token-123',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
          id: 1,
        }),
      })
      expect(initRes.status).toBe(200)

      const listRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer secret-token-123',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 2 }),
      })
      expect(listRes.status).toBe(200)

      const contentType = listRes.headers.get('content-type') ?? ''
      const rawText = await listRes.text()
      const payload = contentType.includes('text/event-stream')
        ? JSON.parse(rawText.split('\n').find((line) => line.startsWith('data:'))!.slice('data:'.length).trim())
        : JSON.parse(rawText)

      const toolNames: string[] = payload.result.tools.map((t: { name: string }) => t.name)
      expect(toolNames).toContain('discover_project')
      expect(toolNames).toContain('build_migration_plan')
      expect(toolNames).toContain('execute_phase')
      expect(toolNames).toContain('get_phase_status')
      expect(toolNames).toContain('request_gate_approval')
      expect(toolNames).toContain('approve_gate')
      expect(toolNames).toContain('rollback_phase')
      expect(toolNames).toContain('generate_report')
      expect(toolNames).toContain('update_step_status')
      expect(toolNames).toContain('record_manual_phase')
      expect(toolNames).toContain('update_phase_costs')
      expect(toolNames).toContain('check_internal_dependencies')
      expect(toolNames.length).toBe(12)
    } finally {
      await closeServer(server)
    }
  })
})
