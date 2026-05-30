import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  isWorkdirClean,
  createPhaseBranch,
  commitPhaseChanges,
  rollbackPhase,
} from '../../src/orchestrator/git-checkpoint.js'

// Verifica se git está disponível
function gitAvailable(): boolean {
  try { execSync('git --version', { stdio: 'ignore' }); return true } catch { return false }
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' })
  // Commit inicial obrigatório para que HEAD exista
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add .', { cwd: dir, stdio: 'ignore' })
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'ignore' })
}

function currentBranch(dir: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim()
}

const skip = !gitAvailable()

describe.skipIf(skip)('isWorkdirClean', () => {
  let dir: string
  beforeEach(() => { dir = join(tmpdir(), `jdkm-${randomBytes(4).toString('hex')}`); initRepo(dir) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns true on a clean repo', async () => {
    expect(await isWorkdirClean(dir)).toBe(true)
  })

  it('returns false when there are untracked files', async () => {
    writeFileSync(join(dir, 'new.txt'), 'hello')
    expect(await isWorkdirClean(dir)).toBe(false)
  })

  it('returns false when there are staged changes', async () => {
    writeFileSync(join(dir, 'README.md'), 'changed')
    execSync('git add .', { cwd: dir, stdio: 'ignore' })
    expect(await isWorkdirClean(dir)).toBe(false)
  })
})

describe.skipIf(skip)('createPhaseBranch', () => {
  let dir: string
  beforeEach(() => { dir = join(tmpdir(), `jdkm-${randomBytes(4).toString('hex')}`); initRepo(dir) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates a branch named jdk-migration/phase-N-...', async () => {
    const checkpoint = await createPhaseBranch(dir, 1)
    expect(checkpoint.branchName).toMatch(/^jdk-migration\/phase-1-/)
    expect(currentBranch(dir)).toBe(checkpoint.branchName)
  })

  it('records baseBranch and baseCommit', async () => {
    const checkpoint = await createPhaseBranch(dir, 0)
    expect(checkpoint.baseBranch).toBeTruthy()
    expect(checkpoint.baseCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('fails if workdir is dirty', async () => {
    writeFileSync(join(dir, 'dirty.txt'), 'oops')
    await expect(createPhaseBranch(dir, 0)).rejects.toThrow()
  })
})

describe.skipIf(skip)('commitPhaseChanges + rollbackPhase', () => {
  let dir: string
  beforeEach(() => { dir = join(tmpdir(), `jdkm-${randomBytes(4).toString('hex')}`); initRepo(dir) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('commits new files and rollback restores original branch', async () => {
    const originalBranch = currentBranch(dir)
    const checkpoint = await createPhaseBranch(dir, 0)

    // Adicionar arquivo no branch de fase
    mkdirSync(join(dir, '.jdk-migration'), { recursive: true })
    writeFileSync(join(dir, '.jdk-migration', 'phase-0-applied.txt'), 'mock transform')
    const commit = await commitPhaseChanges(dir, 0, 'mock-recipe')

    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(currentBranch(dir)).toBe(checkpoint.branchName)

    // Rollback
    await rollbackPhase(dir, checkpoint)
    expect(currentBranch(dir)).toBe(originalBranch)

    // O arquivo de fase não existe no branch original
    expect(existsSync(join(dir, '.jdk-migration', 'phase-0-applied.txt'))).toBe(false)
  })

  it('allows empty commit when no files changed', async () => {
    await createPhaseBranch(dir, 2)
    // Nenhuma modificação — commit vazio deve funcionar
    const commit = await commitPhaseChanges(dir, 2, 'empty-phase')
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
  })
})
