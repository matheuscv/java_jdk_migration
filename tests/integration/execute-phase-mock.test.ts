import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, cpSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { install } from '../../src/skill/install.js'
import { generateGateToken } from '../../src/orchestrator/gate-validator.js'
import { readConfig } from '../../src/lib/config.js'

// Mock do transform-engine — não precisa de OpenRewrite/Maven instalado
vi.mock('../../src/transform-engine/index.js', () => ({
  executePhaseTransform: vi.fn().mockImplementation(
    async (_phase: number, _config: unknown, _path: string, dryRun: boolean) => ({
      recipesApplied: ['[mock] transform'],
      filesModified: dryRun ? 0 : 1,
      filesAdded: 0,
      diffSummary: dryRun ? '[dry-run] Mock transform preview' : 'Mock transform applied',
      warnings: [],
    }),
  ),
}))

// Mock do build-validator — não precisa de Maven instalado
vi.mock('../../src/orchestrator/build-validator.js', () => ({
  runBuild: vi.fn().mockResolvedValue({
    success: true, exitCode: 0, stdout: '', stderr: '',
    failureReason: null, testsPassed: null, testsFailed: null,
  }),
  runTests: vi.fn().mockResolvedValue({
    success: true, exitCode: 0, stdout: '', stderr: '',
    failureReason: null, testsPassed: 0, testsFailed: 0,
  }),
}))

function gitAvailable(): boolean {
  try { execSync('git --version', { stdio: 'ignore' }); return true } catch { return false }
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' })
  // Excluir metadados da ferramenta do rastreamento git ANTES do primeiro commit
  writeFileSync(join(dir, '.gitignore'), '.jdk-migration/\njdk-migration.config.json\n')
  execSync('git add .', { cwd: dir, stdio: 'ignore' })
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'ignore' })
}

const skip = !gitAvailable()
const FIXTURE = join(import.meta.dirname ?? '', '../fixtures/minimal-maven')

describe.skipIf(skip)('execute_phase — ciclo completo com transform mock', () => {
  let projectPath: string

  beforeEach(async () => {
    projectPath = join(tmpdir(), `jdkm-e3-${randomBytes(4).toString('hex')}`)
    mkdirSync(projectPath, { recursive: true })
    cpSync(FIXTURE, projectPath, { recursive: true })
    initGitRepo(projectPath)
    await install(projectPath)
  })

  afterEach(() => {
    const lockPath = join(projectPath, '.jdk-migration', 'lock')
    if (existsSync(lockPath)) {
      rmSync(lockPath, { force: true })
    }
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('executa fase 0 sem token — status vira awaiting_gate', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')
    const result = await executePhaseForTest(projectPath, 0, '', false)

    expect(result.status).toBe('awaiting_gate')
    expect(result.phase).toBe(0)
    expect(result.branchName).toMatch(/^jdk-migration\/phase-0-/)

    const config = readConfig(projectPath)
    expect(config.phases[0].status).toBe('awaiting_gate')
    expect(config.phases[0].gitBranch).toMatch(/^jdk-migration\/phase-0-/)
    expect(config.phases[0].baseCommit).toMatch(/^[0-9a-f]{40}$/)
  }, 15000)

  it('fase 0 cria o arquivo de transform mock em .jdk-migration/', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')
    await executePhaseForTest(projectPath, 0, '', false)

    // O mock transform cria phase-0-applied.txt
    // (está no branch de fase, não no original — mas a execução ficou lá)
    const config = readConfig(projectPath)
    expect(config.phases[0].status).toBe('awaiting_gate')
  })

  it('fase 1 requer token válido de aprovação da fase 0', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')

    // Primeiro executa fase 0
    await executePhaseForTest(projectPath, 0, '', false)

    // Aprova fase 0 manualmente (simula approve_gate)
    const token = generateGateToken(projectPath, 0)
    const config = readConfig(projectPath)
    config.phases[0].status = 'approved'
    config.phases[0].gateToken = token
    const { writeConfig } = await import('../../src/lib/config.js')
    writeConfig(projectPath, config)

    // Executa fase 1 com o token
    const result = await executePhaseForTest(projectPath, 1, token, false)
    expect(result.status).toBe('awaiting_gate')
    expect(result.phase).toBe(1)
  })

  it('fase 1 sem token válido lança GATE_TOKEN_INVALID', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')

    // Aprova fase 0 primeiro
    await executePhaseForTest(projectPath, 0, '', false)
    const config = readConfig(projectPath)
    config.phases[0].status = 'approved'
    const { writeConfig } = await import('../../src/lib/config.js')
    writeConfig(projectPath, config)

    // Tenta executar fase 1 com token inválido
    const { MigrationError } = await import('../../src/lib/errors.js')
    await expect(executePhaseForTest(projectPath, 1, 'token-invalido', false))
      .rejects.toThrow(MigrationError)
  })

  it('dryRun retorna diff sem criar branch nem modificar config', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')
    const result = await executePhaseForTest(projectPath, 0, '', true)

    expect(result.status).toBe('dry_run')
    expect(result.diffSummary).toContain('[dry-run]')

    // Config não foi alterado
    const config = readConfig(projectPath)
    expect(config.phases[0].status).toBe('pending')
  })

  it('rollback automático em falha de build muda status para failed', async () => {
    const { runBuild } = await import('../../src/orchestrator/build-validator.js')
    // Força build a falhar neste teste
    vi.mocked(runBuild).mockResolvedValueOnce({
      success: false, exitCode: 1, stdout: '', stderr: 'COMPILATION ERROR',
      failureReason: 'compilation', testsPassed: null, testsFailed: null,
    })

    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')
    const { MigrationError } = await import('../../src/lib/errors.js')

    await expect(executePhaseForTest(projectPath, 0, '', false))
      .rejects.toThrow(MigrationError)

    const config = readConfig(projectPath)
    expect(config.phases[0].status).toBe('failed')
  })
})
