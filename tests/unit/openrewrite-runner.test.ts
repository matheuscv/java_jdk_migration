/**
 * Testes para openrewrite-runner.ts
 * Cobre parseMavenWarnings, parseModifiedFilesCount, e runRecipes com mock de runProcess
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

vi.mock('../../src/lib/process-runner.js', () => ({
  runProcess: vi.fn(),
}))

import { parseMavenWarnings, parseModifiedFilesCount, runRecipes } from '../../src/transform-engine/openrewrite-runner.js'
import { runProcess } from '../../src/lib/process-runner.js'

function tempDir(): string {
  const d = join(tmpdir(), `or-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

let dir: string
beforeEach(() => {
  dir = tempDir()
  vi.clearAllMocks()
  // Default: git status returns 0 modified, git diff returns empty
  vi.mocked(runProcess).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── parseMavenWarnings ───────────────────────────────────────────────────────

describe('parseMavenWarnings', () => {
  it('extracts [WARNING] lines', () => {
    const output = [
      '[INFO] Building project',
      '[WARNING] Some deprecation warning',
      '[WARNING] Another warning',
      '[INFO] BUILD SUCCESS',
    ].join('\n')
    const warnings = parseMavenWarnings(output)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('Some deprecation warning')
    expect(warnings[1]).toContain('Another warning')
  })

  it('extracts [ERROR] lines that are not BUILD FAILURE', () => {
    const output = [
      '[ERROR] Recipe application error: ...',
      '[ERROR] BUILD FAILURE',
    ].join('\n')
    const warnings = parseMavenWarnings(output)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Recipe application error')
  })

  it('returns empty array for clean output', () => {
    const output = '[INFO] BUILD SUCCESS\n[INFO] Total time: 2.5 s'
    expect(parseMavenWarnings(output)).toHaveLength(0)
  })

  it('returns empty array for empty string', () => {
    expect(parseMavenWarnings('')).toHaveLength(0)
  })
})

// ─── parseModifiedFilesCount ──────────────────────────────────────────────────

describe('parseModifiedFilesCount', () => {
  it('parses "Changes have been made to N source files"', () => {
    const output = '[INFO] Changes have been made to 3 source files.'
    expect(parseModifiedFilesCount(output)).toBe(3)
  })

  it('parses "Changes would be made to N source files" (dryRun format)', () => {
    const output = '[INFO] Changes would be made to 5 source files.'
    expect(parseModifiedFilesCount(output)).toBe(5)
  })

  it('parses "make changes to N source files" format', () => {
    const output = '[INFO] These recipes would make changes to 2 source files:'
    expect(parseModifiedFilesCount(output)).toBe(2)
  })

  it('returns 0 when no count found', () => {
    expect(parseModifiedFilesCount('[INFO] BUILD SUCCESS')).toBe(0)
    expect(parseModifiedFilesCount('')).toBe(0)
  })

  it('handles singular "source file"', () => {
    const output = '[INFO] Changes have been made to 1 source file.'
    expect(parseModifiedFilesCount(output)).toBe(1)
  })
})

// ─── runRecipes — empty recipes list ─────────────────────────────────────────

describe('runRecipes — lista de recipes vazia', () => {
  it('retorna resultado vazio sem chamar runProcess', async () => {
    const result = await runRecipes(dir, [], 'maven', false)
    expect(result.recipesApplied).toHaveLength(0)
    expect(result.filesModified).toBe(0)
    expect(runProcess).not.toHaveBeenCalled()
  })
})

// ─── runRecipes — maven, execução normal ─────────────────────────────────────

describe('runRecipes — maven, execução normal', () => {
  it('chama mvn com o goal correto e recipes', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[INFO] BUILD SUCCESS', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'M src/main/java/App.java', stderr: '', timedOut: false }) // git status
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'diff --git...', stderr: '', timedOut: false }) // git diff

    const result = await runRecipes(dir, ['org.openrewrite.java.UpgradeToJava21'], 'maven', false)
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining([
      expect.stringContaining('rewrite-maven-plugin'),
      '-Drewrite.activeRecipes=org.openrewrite.java.UpgradeToJava21',
    ]), expect.any(Object))
    expect(result.recipesApplied).toContain('org.openrewrite.java.UpgradeToJava21')
  })

  it('retorna warnings quando há [WARNING] no output', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '[WARNING] Recipe error: some issue\n[INFO] BUILD SUCCESS',
        stderr: '',
        timedOut: false,
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false })

    const result = await runRecipes(dir, ['some.Recipe'], 'maven', false)
    expect(result.warnings.some(w => w.includes('Recipe error'))).toBe(true)
  })

  it('retorna timeout warning quando runProcess times out', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1, stdout: '', stderr: '', timedOut: true,
    })

    const result = await runRecipes(dir, ['some.Recipe'], 'maven', false)
    expect(result.warnings.some(w => w.includes('timeout'))).toBe(true)
    expect(result.filesModified).toBe(0)
  })
})

// ─── runRecipes — maven dryRun ────────────────────────────────────────────────

describe('runRecipes — maven dryRun', () => {
  it('usa goal "dryRun" em vez de "run"', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '[INFO] BUILD SUCCESS', stderr: '', timedOut: false,
    })

    const result = await runRecipes(dir, ['some.Recipe'], 'maven', true)
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining([
      expect.stringContaining('dryRun'),
    ]), expect.any(Object))
    expect(result.diffSummary).toContain('[dry-run]')
    expect(result.filesModified).toBe(0)
  })
})

// ─── runRecipes — gradle ──────────────────────────────────────────────────────

describe('runRecipes — gradle sem plugin', () => {
  it('retorna warning quando rewrite plugin não está no build.gradle', async () => {
    // Sem build.gradle — não tem plugin
    const result = await runRecipes(dir, ['some.Recipe'], 'gradle', false)
    expect(result.warnings.some(w => w.includes('OpenRewrite plugin'))).toBe(true)
  })
})

describe('runRecipes — gradle com plugin', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'build.gradle'), `
plugins {
  id 'org.openrewrite.rewrite' version '6.0.0'
}
`)
  })

  it('chama gradlew com rewriteRun task', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) // gradle
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) // git status
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) // git diff

    await runRecipes(dir, ['some.Recipe'], 'gradle', false)
    expect(runProcess).toHaveBeenCalledWith(
      expect.stringContaining('gradlew'),
      expect.arrayContaining(['rewriteRun']),
      expect.any(Object),
    )
  })

  it('usa rewriteDryRun quando dryRun=true', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })

    await runRecipes(dir, ['some.Recipe'], 'gradle', true)
    expect(runProcess).toHaveBeenCalledWith(
      expect.stringContaining('gradlew'),
      expect.arrayContaining(['rewriteDryRun']),
      expect.any(Object),
    )
  })

  it('retorna timeout warning para gradle que excede tempo', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1, stdout: '', stderr: '', timedOut: true,
    })

    const result = await runRecipes(dir, ['some.Recipe'], 'gradle', false)
    expect(result.warnings.some(w => w.includes('timeout'))).toBe(true)
  })
})

// ─── runRecipes — extraDependencies ──────────────────────────────────────────

describe('runRecipes — extraDependencies', () => {
  it('passa -Drewrite.rewriteDependencies quando fornecido', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false })

    await runRecipes(dir, ['some.Recipe'], 'maven', false, ['com.oracle:rewrite-weblogic:1.0'])
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining([
      '-Drewrite.rewriteDependencies=com.oracle:rewrite-weblogic:1.0',
    ]), expect.any(Object))
  })
})
