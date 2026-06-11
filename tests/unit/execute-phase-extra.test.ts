/**
 * Testes unitários adicionais para src/mcp-server/tools/execute-phase.ts
 * Cobre: lock file existente, PHASE_OUT_OF_ORDER, GATE_TOKEN_INVALID,
 * dryRun path, retry após fase failed, e o wrapper registerExecutePhase.
 *
 * Mocks necessários: transform-engine, build-validator, git-checkpoint
 * para não depender de Maven/Git instalados.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// ─── Mocks de dependências pesadas ────────────────────────────────────────────

vi.mock('../../src/transform-engine/index.js', () => ({
  executePhaseTransform: vi.fn().mockImplementation(
    async (_phase: number, _config: unknown, _path: string, dryRun: boolean) => ({
      recipesApplied: ['[mock] recipe'],
      filesModified: dryRun ? 0 : 2,
      filesAdded: 0,
      diffSummary: dryRun ? '[dry-run] preview' : 'applied',
      warnings: [],
    }),
  ),
}))

vi.mock('../../src/orchestrator/build-validator.js', () => ({
  runBuild: vi.fn().mockResolvedValue({
    success: true, exitCode: 0, stdout: '', stderr: '',
    failureReason: null, testsPassed: null, testsFailed: null,
  }),
  runTests: vi.fn().mockResolvedValue({
    success: true, exitCode: 0, stdout: '', stderr: '',
    failureReason: null, testsPassed: 0, testsFailed: 0,
  }),
  runSourceBuild: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../src/orchestrator/git-checkpoint.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/orchestrator/git-checkpoint.js')>('../../src/orchestrator/git-checkpoint.js')
  return {
    ...actual,
    isWorkdirClean: vi.fn().mockResolvedValue(true),
    createPhaseBranch: vi.fn().mockResolvedValue({
      branchName: 'jdk-migration/phase-0-test',
      baseBranch: 'main',
      baseCommit: 'abc1234',
    }),
    commitPhaseChanges: vi.fn().mockResolvedValue('def5678'),
    rollbackPhase: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue(null),
    syncMigrationBranch: vi.fn().mockResolvedValue({ synced: false, migrationBranch: null, tipBranch: null, error: 'mock' }),
  }
})

vi.mock('../../src/static-analysis/migration-audit.js', () => ({
  runMigrationAudit: vi.fn().mockResolvedValue({
    projectPath: '/tmp', targetJdk: '21', timestamp: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    allOk: true,
    criteria: [],
    summary: { ok: 25, warning: 0, fail: 0, passed: 25, warned: 0, failed: 0, total: 25 },
  }),
}))

// ─── Imports após mocks ───────────────────────────────────────────────────────

import { registerExecutePhase, executePhaseForTest } from '../../src/mcp-server/tools/execute-phase.js'
import { writeConfig, createDefaultPhases } from '../../src/lib/config.js'
import { generateGateToken } from '../../src/orchestrator/gate-validator.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

function createMockServer() {
  const handlers: Record<string, ToolHandler> = {}
  const server = {
    registerTool: vi.fn((name: string, _schema: unknown, handler: ToolHandler) => {
      handlers[name] = handler
    }),
  }
  return { server, handlers }
}

function tempDir(): string {
  const d = join(tmpdir(), `ep-extra-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function makeConfig(overrides: Partial<JdkMigrationConfig> = {}): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21',
    stack: ['rest'], buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: false, reportMode: 'phase-gate',
    phases: createDefaultPhases(),
    ...overrides,
  }
}

function jsonText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

let dir: string
let handlers: Record<string, ToolHandler>

beforeEach(() => {
  dir = tempDir()
  const { server, handlers: h } = createMockServer()
  registerExecutePhase(server as never)
  handlers = h
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('execute_phase — registra tool no servidor', () => {
  it('registra o tool execute_phase', () => {
    expect(handlers['execute_phase']).toBeDefined()
  })
})

describe('execute_phase — lock file existente', () => {
  it('retorna LOCK_FILE_EXISTS quando lock já existe', async () => {
    writeConfig(dir, makeConfig())
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })
    writeFileSync(join(migDir, 'lock'), JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }))

    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 0, gateToken: '', dryRun: false })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('LOCK_FILE_EXISTS')
  })
})

describe('execute_phase — PHASE_OUT_OF_ORDER', () => {
  it('retorna PHASE_OUT_OF_ORDER quando fase 0 já foi executada (status approved)', async () => {
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        0: { ...createDefaultPhases()[0], status: 'approved' as const },
      },
    }
    writeConfig(dir, cfg as never)

    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 0, gateToken: '', dryRun: false })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('PHASE_OUT_OF_ORDER')
    expect(String(body.message)).toContain('Fase 0')
  })

  it('retorna PHASE_OUT_OF_ORDER quando fase 1 não tem fase 0 aprovada', async () => {
    writeConfig(dir, makeConfig())  // fase 0 = pending

    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 1, gateToken: '', dryRun: false })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('PHASE_OUT_OF_ORDER')
    expect(String(body.message)).toContain('fase 0')
  })
})

describe('execute_phase — GATE_TOKEN_INVALID', () => {
  it('retorna GATE_TOKEN_INVALID para fase 1 com token vazio', async () => {
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        0: { ...createDefaultPhases()[0], status: 'approved' as const, gateToken: generateGateToken(dir, 0) },
      },
    }
    writeConfig(dir, cfg as never)

    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 1, gateToken: '', dryRun: false })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('GATE_TOKEN_INVALID')
  })

  it('retorna GATE_TOKEN_INVALID para fase 1 com token incorreto', async () => {
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        0: { ...createDefaultPhases()[0], status: 'approved' as const, gateToken: generateGateToken(dir, 0) },
      },
    }
    writeConfig(dir, cfg as never)

    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 1, gateToken: 'token-invalido', dryRun: false })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('GATE_TOKEN_INVALID')
  })
})

describe('execute_phase — dryRun', () => {
  it('retorna status dry_run sem modificar arquivos', async () => {
    writeConfig(dir, makeConfig())

    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 0, gateToken: '', dryRun: true })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('dry_run')
    expect(body.phase).toBe(0)
    expect(body.diffSummary).toBeDefined()
    expect(body.recipesWouldApply).toBeDefined()
    expect(body.message).toContain('dryRun')
  })

  it('lock file é removido após dryRun', async () => {
    writeConfig(dir, makeConfig())
    await handlers['execute_phase']({ projectPath: dir, phaseNumber: 0, gateToken: '', dryRun: true })
    const lockPath = join(dir, '.jdk-migration', 'lock')
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('execute_phase — retry após fase failed', () => {
  it('fase 0 em status failed é resetada para pending e pode ser reexecutada', async () => {
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        0: { ...createDefaultPhases()[0], status: 'failed' as const },
      },
    }
    writeConfig(dir, cfg as never)

    // dryRun para não depender de Git
    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 0, gateToken: '', dryRun: true })
    const body = jsonText(result) as Record<string, unknown>
    // Fase failed é resetada para pending, então dryRun funciona
    expect(body.status).toBe('dry_run')
  })
})

describe('execute_phase — MigrationError é capturado no handler', () => {
  it('retorna JSON de erro em vez de lançar quando ocorre MigrationError', async () => {
    writeConfig(dir, makeConfig())

    // Simula PHASE_OUT_OF_ORDER que é um MigrationError
    const result = await handlers['execute_phase']({ projectPath: dir, phaseNumber: 3, gateToken: '', dryRun: false })
    const body = jsonText(result) as Record<string, unknown>
    // Deve retornar um objeto com error, não lançar
    expect(body.error).toBeDefined()
    expect(typeof body.message).toBe('string')
  })
})

describe('executePhaseForTest — exportação direta', () => {
  it('está disponível como exportação nomeada', () => {
    expect(typeof executePhaseForTest).toBe('function')
  })

  it('lança LOCK_FILE_EXISTS quando lock existe', async () => {
    writeConfig(dir, makeConfig())
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })
    writeFileSync(join(migDir, 'lock'), '{}')

    await expect(executePhaseForTest(dir, 0, '', false)).rejects.toMatchObject({
      code: 'LOCK_FILE_EXISTS',
    })
  })
})
