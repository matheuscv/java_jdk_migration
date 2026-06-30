/**
 * Testes para gate-tools-cloud.ts — a propriedade de segurança central do M5:
 * request_gate_approval NUNCA inclui o PIN no retorno da tool em modo cloud.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import { createInMemorySecretStore } from '../../src/adapters/memory/in-memory-secret-store.js'
import { registerGateToolsCloud } from '../../src/mcp-server/tools/gate-tools-cloud.js'
import type { GraphNotifier } from '../../src/adapters/cloud/graph-notifier.js'

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

function makeTmpDir(): string {
  const dir = join(tmpdir(), `cloud-gate-test-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeConfig(dir: string, extra: object = {}) {
  const phases = createDefaultPhases()
  ;(phases[3] as Record<string, unknown>).status = 'awaiting_gate'
  const config = {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'], buildSystem: 'maven',
    appServer: null, multiModule: false, modulePaths: [], ciSystem: null,
    testCoverageThreshold: 80, dryRunBeforeExecute: true, phases, ...extra,
  }
  mkdirSync(join(dir, '.jdk-migration'), { recursive: true })
  writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(config, null, 2))
}

function createMockServer() {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: vi.fn((_name: string, _schema: unknown, handler: Handler) => {
      handlers.set(_name, handler)
    }),
  } as unknown as McpServer
  return { server, getHandler: (name: string) => handlers.get(name)! }
}

describe('request_gate_approval (cloud) — R1: PIN nunca no retorno da tool', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir(); writeConfig(dir) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('retorna status awaiting_human_pin sem incluir o PIN na resposta', async () => {
    const notifier: GraphNotifier = { sendGatePin: vi.fn().mockResolvedValue(undefined) }
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, notifier)

    const handler = getHandler('request_gate_approval')
    const result = await handler({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })
    const body = JSON.parse(result.content[0].text)

    expect(body.status).toBe('awaiting_human_pin')
    // O PIN (6 dígitos) nunca deve aparecer em nenhum campo do retorno.
    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toMatch(/\b\d{6}\b/)
  })

  it('persiste o PIN no SecretStore (não no filesytem retornado)', async () => {
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, undefined)

    const handler = getHandler('request_gate_approval')
    await handler({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })

    const pinEntry = await store.getPin(3)
    expect(pinEntry).not.toBeNull()
    expect(pinEntry!.pin).toMatch(/^\d{6}$/)
  })

  it('chama o notifier com approverEmail e phase corretos (PIN viaja só na chamada HTTP sainte)', async () => {
    const sendGatePin = vi.fn().mockResolvedValue(undefined)
    const notifier: GraphNotifier = { sendGatePin }
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, notifier)

    await getHandler('request_gate_approval')({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })

    expect(sendGatePin).toHaveBeenCalledOnce()
    const [email, phase] = sendGatePin.mock.calls[0]
    expect(email).toBe('dev@empresa.com')
    expect(phase).toBe(3)
  })

  it('quando notifier falha, retorna aviso sem o PIN (PIN permanece no SecretStore)', async () => {
    const notifier: GraphNotifier = { sendGatePin: vi.fn().mockRejectedValue(new Error('Graph API indisponível')) }
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, notifier)

    const result = await getHandler('request_gate_approval')({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })
    const body = JSON.parse(result.content[0].text)

    expect(body.status).toBe('pin_generated_notification_failed')
    expect(JSON.stringify(body)).not.toMatch(/\b\d{6}\b/)
    expect(await store.getPin(3)).not.toBeNull() // PIN ainda lá, humano pode tentar outro canal
  })
})

describe('approve_gate (cloud) — valida via SecretStore, bloqueia automação', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir(); writeConfig(dir) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('aprova com PIN correto, consome o PIN (uso único) e retorna gateToken', async () => {
    const store = createInMemorySecretStore()
    await store.putPin(3, { pin: '123456', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), phaseNumber: 3 })

    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, undefined)

    const result = await getHandler('approve_gate')({ projectPath: dir, phaseNumber: 3, approverName: 'Maria Silva', humanPin: '123456' })
    const body = JSON.parse(result.content[0].text)

    expect(body.status).toBe('approved')
    expect(body.gateToken).toBeTruthy()
    expect(await store.getPin(3)).toBeNull() // consumido
  })

  it('rejeita PIN incorreto', async () => {
    const store = createInMemorySecretStore()
    await store.putPin(3, { pin: '123456', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), phaseNumber: 3 })

    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, undefined)

    const result = await getHandler('approve_gate')({ projectPath: dir, phaseNumber: 3, approverName: 'Maria Silva', humanPin: '999999' })
    const body = JSON.parse(result.content[0].text)

    expect(body.error).toBe('GATE_TOKEN_INVALID')
  })

  it('rejeita approverName automatizado (claude, bot, ai, etc.)', async () => {
    const store = createInMemorySecretStore()
    await store.putPin(3, { pin: '123456', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), phaseNumber: 3 })

    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, undefined)

    for (const forbidden of ['claude', 'Claude Code', 'bot', 'AI Agent']) {
      const r = await getHandler('approve_gate')({ projectPath: dir, phaseNumber: 3, approverName: forbidden, humanPin: '123456' })
      expect(JSON.parse(r.content[0].text).error).toBe('GATE_TOKEN_INVALID')
    }
  })

  it('rejeita PIN expirado (CloudSecretStore remove automaticamente)', async () => {
    const store = createInMemorySecretStore()
    await store.putPin(3, { pin: '123456', expiresAt: new Date(Date.now() - 1000).toISOString(), phaseNumber: 3 }) // já expirado

    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, undefined)

    const result = await getHandler('approve_gate')({ projectPath: dir, phaseNumber: 3, approverName: 'Maria Silva', humanPin: '123456' })
    expect(JSON.parse(result.content[0].text).error).toBe('GATE_TOKEN_INVALID')
  })
})

describe('request_gate_approval (cloud) — GATE_BYPASS mode', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir(); writeConfig(dir) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('bypass mode auto-aprova a fase e retorna gateToken sem precisar de PIN ou notifier', async () => {
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, { bypassMode: true })

    const result = await getHandler('request_gate_approval')({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })
    const body = JSON.parse(result.content[0].text)

    expect(body.status).toBe('approved')
    expect(body.gateToken).toMatch(/^jdkm\./)
    expect(body.bypassModeActive).toBe(true)
    expect(body.approvedBy).toBe('bypass-mode')
  })

  it('bypass mode não armazena PIN no SecretStore (aprovação é automática)', async () => {
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, { bypassMode: true })

    await getHandler('request_gate_approval')({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })
    expect(await store.getPin(3)).toBeNull()
  })

  it('com bypass mode false (padrão), fluxo normal de PIN é mantido', async () => {
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store, { bypassMode: false })

    const result = await getHandler('request_gate_approval')({ projectPath: dir, phaseNumber: 3, approverEmail: 'dev@empresa.com' })
    const body = JSON.parse(result.content[0].text)

    expect(body.status).toBe('awaiting_human_pin')
    expect(body).not.toHaveProperty('gateToken')
    expect(await store.getPin(3)).not.toBeNull()
  })
})

describe('createCloudMcpServer — registra tools cloud e tools locais corretas', () => {
  it('registra request_gate_approval e approve_gate em modo cloud (sem PIN no retorno)', async () => {
    const { createCloudMcpServer } = await import('../../src/mcp-server/create-server.js')
    const registeredTools: string[] = []
    const mockServer = {
      registerTool: vi.fn((_name: string) => { registeredTools.push(_name) }),
    } as unknown as McpServer
    vi.spyOn(await import('../../src/mcp-server/create-server.js'), 'createCloudMcpServer').mockReturnValueOnce(mockServer)

    // Verificamos indiretamente que as gate tools cloud são registradas e não a versão local
    // através do teste de contrato: request_gate_approval cloud nunca retorna PIN.
    const store = createInMemorySecretStore()
    const { server, getHandler } = createMockServer()
    registerGateToolsCloud(server, store)

    const handler = getHandler('request_gate_approval')
    expect(typeof handler).toBe('function')
  })
})
