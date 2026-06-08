/**
 * Testes unitários para sbm-runner.ts
 * Testa findOrDownloadSbm e runSpringBootMigrator com mocks de runProcess e runRecipes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

vi.mock('../../src/lib/process-runner.js', () => ({
  runProcess: vi.fn(),
}))

vi.mock('../../src/transform-engine/openrewrite-runner.js', () => ({
  runRecipes: vi.fn(),
}))

import { findOrDownloadSbm, runSpringBootMigrator } from '../../src/transform-engine/sbm-runner.js'
import { runProcess } from '../../src/lib/process-runner.js'
import { runRecipes } from '../../src/transform-engine/openrewrite-runner.js'

function tempDir(): string {
  const d = join(tmpdir(), `sbm-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

const FALLBACK_RESULT = {
  recipesApplied: ['org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_2'],
  filesModified: 1, filesAdded: 0, filesDeleted: 0,
  diffSummary: 'OpenRewrite aplicado', fullDiff: '', warnings: [],
}

let dir: string
beforeEach(() => {
  dir = tempDir()
  vi.clearAllMocks()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── findOrDownloadSbm ────────────────────────────────────────────────────────

describe('findOrDownloadSbm', () => {
  it('retorna "sbm" quando sbm está no PATH', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 0, stdout: 'sbm 0.16.0', stderr: '', timedOut: false })
    const result = await findOrDownloadSbm(dir)
    expect(result).toBe('sbm')
    expect(runProcess).toHaveBeenCalledWith('sbm', ['--version'], expect.any(Object))
  })

  it('retorna caminho do JAR local quando sbm não está no PATH mas sbm.jar existe', async () => {
    // sbm --version falha
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false })
    // Cria o JAR local
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(join(toolsDir, 'sbm.jar'), 'fake sbm jar')

    const result = await findOrDownloadSbm(dir)
    expect(result).toBe(join(toolsDir, 'sbm.jar'))
  })

  it('tenta download via mvn quando nem PATH nem JAR local estão disponíveis', async () => {
    // sbm --version falha
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false })
      // mvn download falha
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'mvn fail', timedOut: false })

    const result = await findOrDownloadSbm(dir)
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining(['dependency:copy']), expect.any(Object))
    expect(result).toBeNull()
  })

  it('retorna caminho do JAR quando download mvn succeeds', async () => {
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    const jarPath = join(toolsDir, 'sbm.jar')

    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false }) // sbm --version
      .mockImplementationOnce(async () => {
        writeFileSync(jarPath, 'downloaded sbm jar')
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      })

    const result = await findOrDownloadSbm(dir)
    expect(result).toBe(jarPath)
  })
})

// ─── runSpringBootMigrator ────────────────────────────────────────────────────

describe('runSpringBootMigrator — sbm não disponível (usa fallback OpenRewrite)', () => {
  beforeEach(() => {
    // sbm não disponível em nenhum lugar
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '', timedOut: false })
    vi.mocked(runRecipes).mockResolvedValue(FALLBACK_RESULT)
  })

  it('usa fallback OpenRewrite quando sbm não encontrado', async () => {
    const result = await runSpringBootMigrator(dir, 'some.Recipe', false)
    expect(runRecipes).toHaveBeenCalledWith(dir, ['org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_2'], 'maven', false)
    expect(result.diffSummary).toContain('[fallback-openrewrite]')
    expect(result.warnings.some(w => w.includes('Spring Boot Migrator (sbm) não está disponível'))).toBe(true)
  })

  it('inclui warning sobre fallback quando sbm não encontrado', async () => {
    const result = await runSpringBootMigrator(dir, 'some.Recipe', false)
    expect(result.warnings.some(w => w.includes('.jdk-migration/tools/sbm.jar'))).toBe(true)
  })
})

describe('runSpringBootMigrator — sbm no PATH, dryRun=true', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 0, stdout: 'sbm 0.16.0', stderr: '', timedOut: false })
  })

  it('retorna dry-run sem chamar runProcess para a recipe', async () => {
    const result = await runSpringBootMigrator(dir, 'my.Recipe', true)
    expect(result.filesModified).toBe(0)
    expect(result.diffSummary).toContain('[dry-run]')
    expect(result.recipesApplied).toContain('my.Recipe')
    expect(result.warnings).toContain('SBM não suporta dry-run nativo — este é um preview estimado')
  })
})

describe('runSpringBootMigrator — sbm no PATH, execução bem-sucedida', () => {
  beforeEach(() => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'sbm 0.16.0', stderr: '', timedOut: false }) // sbm --version
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Recipe applied', stderr: '', timedOut: false }) // sbm apply
  })

  it('retorna sucesso quando sbm aplica a recipe', async () => {
    const result = await runSpringBootMigrator(dir, 'org.springframework.sbm.TestRecipe', false)
    expect(result.recipesApplied).toContain('org.springframework.sbm.TestRecipe')
    expect(result.filesModified).toBe(1)
    expect(result.warnings).toHaveLength(0)
    expect(result.diffSummary).toContain('Spring Boot Migrator aplicou recipe')
  })
})

describe('runSpringBootMigrator — sbm no PATH, timeout', () => {
  beforeEach(() => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'sbm 0.16.0', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: true })
  })

  it('retorna warning de timeout quando sbm demora mais de 20 minutos', async () => {
    const result = await runSpringBootMigrator(dir, 'my.Recipe', false)
    expect(result.warnings).toContain('Spring Boot Migrator timed out')
    expect(result.diffSummary).toContain('timeout')
  })
})

describe('runSpringBootMigrator — sbm falha com exitCode !== 0 (usa fallback)', () => {
  beforeEach(() => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'sbm 0.16.0', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'Recipe failed', timedOut: false })
    vi.mocked(runRecipes).mockResolvedValue(FALLBACK_RESULT)
  })

  it('usa fallback OpenRewrite quando sbm falha', async () => {
    const result = await runSpringBootMigrator(dir, 'my.Recipe', false)
    expect(runRecipes).toHaveBeenCalled()
    expect(result.warnings.some(w => w.includes('Spring Boot Migrator falhou'))).toBe(true)
  })
})

describe('runSpringBootMigrator — sbm jar local', () => {
  beforeEach(() => {
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(join(toolsDir, 'sbm.jar'), 'fake sbm jar')

    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false }) // sbm --version falha
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false }) // java -jar sbm.jar
  })

  it('usa java -jar sbm.jar quando sbm jar está em .jdk-migration/tools/', async () => {
    const result = await runSpringBootMigrator(dir, 'my.Recipe', false)
    expect(runProcess).toHaveBeenCalledWith(
      'java',
      expect.arrayContaining(['-jar', expect.stringContaining('sbm.jar'), 'apply', '--recipe', 'my.Recipe']),
      expect.any(Object),
    )
    expect(result.filesModified).toBe(1)
  })
})
