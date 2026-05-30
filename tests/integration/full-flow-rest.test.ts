import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { install } from '../../src/skill/install.js'
import { generateGateToken } from '../../src/orchestrator/gate-validator.js'
import { readConfig, writeConfig, createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'
import { selectRecipes } from '../../src/transform-engine/recipe-selector.js'
import { updateBuildVersion } from '../../src/transform-engine/build-updater.js'

// Mocks: OpenRewrite/SBM não precisam estar instalados para o fluxo de orquestração
vi.mock('../../src/transform-engine/openrewrite-runner.js', () => ({
  runRecipes: vi.fn().mockImplementation(
    async (_path: string, recipes: string[], _buildSystem: string, dryRun: boolean) => ({
      recipesApplied: recipes,
      filesModified: dryRun ? 0 : 2,
      filesAdded: 0,
      filesDeleted: 0,
      diffSummary: dryRun
        ? `[dry-run] ${recipes.join(', ')} — 2 arquivo(s) seriam modificados`
        : `[mock-openrewrite] Applied: ${recipes.join(', ')}`,
      fullDiff: '',
      warnings: [],
    }),
  ),
  parseMavenWarnings: vi.fn().mockReturnValue([]),
  parseModifiedFilesCount: vi.fn().mockReturnValue(2),
  OPENREWRITE_PLUGIN_COORDS: 'org.openrewrite.maven:rewrite-maven-plugin:5.38.0',
}))

vi.mock('../../src/transform-engine/sbm-runner.js', () => ({
  runSpringBootMigrator: vi.fn().mockImplementation(
    async (_path: string, recipe: string) => ({
      recipesApplied: [recipe],
      filesModified: 1,
      filesAdded: 0,
      filesDeleted: 0,
      diffSummary: `[mock-sbm] Applied: ${recipe}`,
      fullDiff: '',
      warnings: [],
    }),
  ),
  findOrDownloadSbm: vi.fn().mockResolvedValue('sbm'),
}))

vi.mock('../../src/orchestrator/build-validator.js', () => ({
  runBuild: vi.fn().mockResolvedValue({
    success: true, exitCode: 0, stdout: '', stderr: '',
    failureReason: null, testsPassed: null, testsFailed: null,
  }),
  runTests: vi.fn().mockResolvedValue({
    success: true, exitCode: 0, stdout: '', stderr: '',
    failureReason: null, testsPassed: 3, testsFailed: 0,
  }),
}))

function gitAvailable(): boolean {
  try { execSync('git --version', { stdio: 'ignore' }); return true } catch { return false }
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, '.gitignore'), '.jdk-migration/\njdk-migration.config.json\n')
  execSync('git add .', { cwd: dir, stdio: 'ignore' })
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'ignore' })
}

const FIXTURE = join(import.meta.dirname ?? '', '../fixtures/rest-microservice')
const skip = !gitAvailable()

function makeRestConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['rest'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
    ...overrides,
  }
}

// ─── Testes de receitas (sem git, sem Maven) ───────────────────────────────

describe('recipe-selector — rest-microservice stack', () => {
  it('phase 1: selects build-updater for rest stack', () => {
    const sets = selectRecipes(1, makeRestConfig())
    expect(sets[0].runner).toBe('build-updater')
  })

  it('phase 2: selects UpgradeToJava21 for JDK 8 source', () => {
    const sets = selectRecipes(2, makeRestConfig())
    expect(sets[0].recipes).toContain('org.openrewrite.java.migrate.UpgradeToJava21')
  })

  it('phase 3: selects jakarta recipe for rest stack', () => {
    const sets = selectRecipes(3, makeRestConfig())
    const jakartaSet = sets.find(s => s.recipes.some(r => r.includes('Jakarta') || r.includes('jakarta')))
    expect(jakartaSet).toBeDefined()
  })
})

// ─── Build updater na fixture (sem git) ───────────────────────────────────

describe('Phase 1: updateBuildVersion na fixture rest-microservice', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `jdkm-flow-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    cpSync(FIXTURE, dir, { recursive: true })
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('atualiza java.version de 1.8 para 21 no pom.xml', async () => {
    const result = await updateBuildVersion(dir, '21', false)
    expect(result.filesModified).toBe(1)
    const pom = readFileSync(join(dir, 'pom.xml'), 'utf-8')
    expect(pom).toContain('<java.version>21</java.version>')
    expect(pom).not.toContain('<java.version>1.8</java.version>')
  })

  it('dryRun mostra diff sem modificar o arquivo', async () => {
    const result = await updateBuildVersion(dir, '21', true)
    expect(result.filesModified).toBe(0)
    const pom = readFileSync(join(dir, 'pom.xml'), 'utf-8')
    expect(pom).toContain('<java.version>1.8</java.version>')  // unchanged
  })

  it('diffSummary explica a mudança', async () => {
    const result = await updateBuildVersion(dir, '21', false)
    expect(result.diffSummary).toMatch(/21/)
    expect(result.diffSummary).toMatch(/pom\.xml/)
  })
})

// ─── Ciclo completo fases 0–3 (git + mocked OpenRewrite) ─────────────────

describe.skipIf(skip)('Ciclo completo fases 0–3 — rest-microservice', () => {
  let projectPath: string

  beforeEach(async () => {
    projectPath = join(tmpdir(), `jdkm-full-${randomBytes(4).toString('hex')}`)
    mkdirSync(projectPath, { recursive: true })
    cpSync(FIXTURE, projectPath, { recursive: true })
    initGitRepo(projectPath)
    await install(projectPath)
  })

  afterEach(() => { rmSync(projectPath, { recursive: true, force: true }) })

  it('fase 0 executa sem token e vai para awaiting_gate', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')
    const result = await executePhaseForTest(projectPath, 0, '', false)
    expect(result.status).toBe('awaiting_gate')
    expect(result.phase).toBe(0)
    const config = readConfig(projectPath)
    expect(config.phases[0].status).toBe('awaiting_gate')
  })

  it('fase 1 (build-updater) atualiza pom.xml e vai para awaiting_gate', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')

    // Aprova fase 0
    const { runBuild } = await import('../../src/orchestrator/build-validator.js')
    await executePhaseForTest(projectPath, 0, '', false)
    const token0 = generateGateToken(projectPath, 0)
    const config = readConfig(projectPath)
    config.phases[0] = { ...config.phases[0], status: 'approved', gateToken: token0 }
    writeConfig(projectPath, config)

    // Executa fase 1
    const result = await executePhaseForTest(projectPath, 1, token0, false)
    expect(result.status).toBe('awaiting_gate')
    expect(result.phase).toBe(1)
    expect(result.recipesApplied).toContain('update-compiler-target-21')
  })

  it('dryRun na fase 2 retorna recipes sem criar branch', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')

    // Setup: fase 0 e 1 completas para chegar na fase 2
    await executePhaseForTest(projectPath, 0, '', false)
    const token0 = generateGateToken(projectPath, 0)
    const config = readConfig(projectPath)
    config.phases[0] = { ...config.phases[0], status: 'approved', gateToken: token0 }
    config.phases[1].status = 'approved'
    config.phases[1].gateToken = generateGateToken(projectPath, 1)
    writeConfig(projectPath, config)

    const token1 = config.phases[1].gateToken!
    const dryResult = await executePhaseForTest(projectPath, 2, token1, true)

    expect(dryResult.status).toBe('dry_run')
    expect(dryResult.diffSummary).toContain('[dry-run]')

    // Config não foi alterado pelo dryRun — fase 2 permanece pending (nunca foi executada)
    const afterConfig = readConfig(projectPath)
    expect(afterConfig.phases[2].status).toBe('pending')
  })

  it('ciclo completo 0→1→2 com token chain válido', async () => {
    const { executePhaseForTest } = await import('../../src/mcp-server/tools/execute-phase.js')

    // Fase 0
    await executePhaseForTest(projectPath, 0, '', false)
    const t0 = generateGateToken(projectPath, 0)
    const c0 = readConfig(projectPath)
    c0.phases[0] = { ...c0.phases[0], status: 'approved', gateToken: t0 }
    writeConfig(projectPath, c0)

    // Fase 1
    const r1 = await executePhaseForTest(projectPath, 1, t0, false)
    expect(r1.status).toBe('awaiting_gate')
    const t1 = generateGateToken(projectPath, 1)
    const c1 = readConfig(projectPath)
    c1.phases[1] = { ...c1.phases[1], status: 'approved', gateToken: t1 }
    writeConfig(projectPath, c1)

    // Fase 2
    const r2 = await executePhaseForTest(projectPath, 2, t1, false)
    expect(r2.status).toBe('awaiting_gate')
    expect(r2.recipesApplied).toContain('org.openrewrite.java.migrate.UpgradeToJava21')

    // Verifica chain: todas as fases executadas corretamente
    const finalConfig = readConfig(projectPath)
    expect(finalConfig.phases[0].status).toBe('approved')
    expect(finalConfig.phases[1].status).toBe('approved')
    expect(finalConfig.phases[2].status).toBe('awaiting_gate')
  })
})
