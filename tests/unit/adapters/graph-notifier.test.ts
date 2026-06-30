import { describe, it, expect, vi, afterEach } from 'vitest'
import { createGraphNotifier, type GraphCredentials } from '../../../src/adapters/cloud/graph-notifier.js'
import { MigrationError } from '../../../src/lib/errors.js'

const CREDS: GraphCredentials = {
  tenantId: 'tenant-123',
  clientId: 'client-abc',
  clientSecret: 'super-secret',
  senderUserId: 'migracoes@empresa.com',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('GraphNotifier — fluxo de sucesso (Teams + e-mail)', () => {
  it('sendGatePin autentica, cria o chat do Teams, envia a mensagem e o e-mail — nesta ordem', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      const method = init?.method ?? 'GET'
      calls.push({ url: u, method })

      if (u.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ access_token: 'fake-graph-token' })
      }
      if (u.endsWith('/chats') && method === 'POST') {
        return jsonResponse({ id: 'chat-id-1' }, 201)
      }
      if (u.includes('/chats/chat-id-1/messages') && method === 'POST') {
        return jsonResponse({ id: 'msg-1' }, 201)
      }
      if (u.includes('/sendMail') && method === 'POST') {
        return new Response(null, { status: 202 })
      }
      throw new Error(`unexpected fetch call: ${method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const notifier = createGraphNotifier(CREDS)
    const result = await notifier.sendGatePin('aprovador@empresa.com', 4, '847291', '2026-06-30T23:59:59.000Z')

    expect(result).toBeUndefined()
    expect(calls.map((c) => c.url.includes('/oauth2/v2.0/token') ? 'token' : c.url.includes('/chats') && c.url.endsWith('/chats') ? 'chat' : c.url.includes('/messages') ? 'message' : c.url.includes('/sendMail') ? 'mail' : 'unknown'))
      .toEqual(['token', 'chat', 'message', 'mail'])
  })

  it('inclui o PIN apenas no corpo das requisições HTTP de saída, nunca no valor de retorno', async () => {
    let teamsBody = ''
    let mailBody = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 't' })
      if (u.endsWith('/chats')) return jsonResponse({ id: 'c1' }, 201)
      if (u.includes('/messages')) { teamsBody = String(init?.body); return jsonResponse({}, 201) }
      if (u.includes('/sendMail')) { mailBody = String(init?.body); return new Response(null, { status: 202 }) }
      throw new Error('unexpected call')
    }))

    const notifier = createGraphNotifier(CREDS)
    const result = await notifier.sendGatePin('aprovador@empresa.com', 4, '847291', '2026-06-30T23:59:59.000Z')

    expect(result).toBeUndefined() // a função em si nunca devolve o PIN
    expect(teamsBody).toContain('847291') // mas o PIN chegou de fato ao Teams...
    expect(mailBody).toContain('847291')  // ...e ao e-mail, via requisição HTTP de saída
  })
})

describe('GraphNotifier — falhas nunca vazam o PIN nas mensagens de erro', () => {
  it('falha de autenticação lança MigrationError sem o PIN na mensagem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid_client' }, 401)))

    const notifier = createGraphNotifier(CREDS)
    await expect(notifier.sendGatePin('aprovador@empresa.com', 4, '847291', '2026-06-30T23:59:59.000Z'))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(MigrationError)
        expect((err as MigrationError).code).toBe('GRAPH_NOTIFICATION_FAILED')
        expect((err as MigrationError).message).not.toContain('847291')
        return true
      })
  })

  it('falha ao criar o chat do Teams lança MigrationError sem o PIN na mensagem', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 't' })
      if (u.endsWith('/chats')) return jsonResponse({ error: 'Forbidden' }, 403)
      throw new Error('unexpected call')
    }))

    const notifier = createGraphNotifier(CREDS)
    await expect(notifier.sendGatePin('aprovador@empresa.com', 4, '847291', '2026-06-30T23:59:59.000Z'))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(MigrationError)
        expect((err as MigrationError).message).not.toContain('847291')
        return true
      })
  })

  it('falha ao enviar e-mail lança MigrationError sem o PIN na mensagem', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = url.toString()
      if (u.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 't' })
      if (u.endsWith('/chats')) return jsonResponse({ id: 'c1' }, 201)
      if (u.includes('/messages')) return jsonResponse({}, 201)
      if (u.includes('/sendMail')) return jsonResponse({ error: 'MailboxNotEnabledForRESTAPI' }, 503)
      throw new Error('unexpected call')
    }))

    const notifier = createGraphNotifier(CREDS)
    await expect(notifier.sendGatePin('aprovador@empresa.com', 4, '847291', '2026-06-30T23:59:59.000Z'))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(MigrationError)
        expect((err as MigrationError).message).not.toContain('847291')
        return true
      })
  })
})
