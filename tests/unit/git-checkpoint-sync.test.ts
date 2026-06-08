/**
 * Testes unitários para git-checkpoint.ts — syncMigrationBranch e createPullRequest
 * Usa mock de runProcess para testar os paths sem precisar de git real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/process-runner.js', () => ({
  runProcess: vi.fn(),
}))

import { syncMigrationBranch, createPullRequest } from '../../src/orchestrator/git-checkpoint.js'
import { runProcess } from '../../src/lib/process-runner.js'

const DIR = '/tmp/test-project'

function mockGit(responses: Array<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>) {
  let i = 0
  vi.mocked(runProcess).mockImplementation(async () => {
    const r = responses[i] ?? { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    i++
    return r
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── syncMigrationBranch ──────────────────────────────────────────────────────

describe('syncMigrationBranch — fast-forward bem-sucedido', () => {
  it('retorna synced=true quando merge ff-only funciona', async () => {
    mockGit([
      { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false },             // rev-parse HEAD (branch atual)
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },                   // checkout migrationBranch
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },                   // merge --ff-only
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },                   // checkout originalBranch (finally)
    ])

    const result = await syncMigrationBranch(DIR, 'migrate/main', 'jdk-migration/phase-3-20260601')
    expect(result.synced).toBe(true)
    expect(result.migrationBranch).toBe('migrate/main')
    expect(result.tipBranch).toBe('jdk-migration/phase-3-20260601')
  })

  it('faz merge direto quando já está na migrationBranch', async () => {
    mockGit([
      { exitCode: 0, stdout: 'migrate/main\n', stderr: '', timedOut: false },  // rev-parse HEAD = migrationBranch
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },                // merge --ff-only (direto)
    ])

    const result = await syncMigrationBranch(DIR, 'migrate/main', 'jdk-migration/phase-3-20260601')
    expect(result.synced).toBe(true)

    // Não deve ter chamado checkout (só rev-parse + merge)
    const calls = vi.mocked(runProcess).mock.calls
    expect(calls.some(c => c[1].includes('checkout'))).toBe(false)
  })
})

describe('syncMigrationBranch — merge falha', () => {
  it('retorna synced=false quando merge ff-only falha', async () => {
    mockGit([
      { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false },            // rev-parse
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },                  // checkout migrationBranch
      { exitCode: 1, stdout: '', stderr: 'Not possible to fast-forward', timedOut: false }, // merge fails
      { exitCode: 0, stdout: '', stderr: '', timedOut: false },                  // checkout originalBranch (finally)
    ])

    const result = await syncMigrationBranch(DIR, 'migrate/main', 'jdk-migration/phase-3')
    expect(result.synced).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.migrationBranch).toBe('migrate/main')
  })

  it('retorna synced=false quando rev-parse falha', async () => {
    mockGit([
      { exitCode: 1, stdout: '', stderr: 'not a git repo', timedOut: false }, // rev-parse falha
    ])

    const result = await syncMigrationBranch(DIR, 'migrate/main', 'tip')
    expect(result.synced).toBe(false)
    expect(result.error).toBeDefined()
  })
})

// ─── createPullRequest ────────────────────────────────────────────────────────

describe('createPullRequest', () => {
  const checkpoint = {
    branchName: 'jdk-migration/phase-1-20260601',
    baseBranch: 'main',
    baseCommit: 'abc123def456',
    phaseCommit: 'xyz789',
  }

  it('retorna null quando gh não está disponível', async () => {
    mockGit([
      { exitCode: 1, stdout: '', stderr: 'gh: command not found', timedOut: false }, // gh --version falha
    ])

    const result = await createPullRequest(DIR, 1, checkpoint, 'Fase 1 aplicada')
    expect(result).toBeNull()
  })

  it('retorna URL do PR quando gh cria PR com sucesso', async () => {
    mockGit([
      { exitCode: 0, stdout: 'gh version 2.46.0\n', stderr: '', timedOut: false }, // gh --version OK
      { exitCode: 0, stdout: 'https://github.com/org/repo/pull/42\n', stderr: '', timedOut: false }, // gh pr create
    ])

    const result = await createPullRequest(DIR, 1, checkpoint, 'Fase 1 aplicada')
    expect(result).toBe('https://github.com/org/repo/pull/42')
  })

  it('retorna null quando gh pr create falha', async () => {
    mockGit([
      { exitCode: 0, stdout: 'gh version 2.46.0\n', stderr: '', timedOut: false }, // gh --version OK
      { exitCode: 1, stdout: '', stderr: 'authentication failed', timedOut: false }, // gh pr create fails
    ])

    const result = await createPullRequest(DIR, 1, checkpoint, 'Fase 1 aplicada')
    expect(result).toBeNull()
  })

  it('inclui fase e branch no título do PR', async () => {
    mockGit([
      { exitCode: 0, stdout: 'gh version 2.46.0\n', stderr: '', timedOut: false },
      { exitCode: 0, stdout: 'https://github.com/org/repo/pull/43\n', stderr: '', timedOut: false },
    ])

    await createPullRequest(DIR, 2, checkpoint, 'Fase 2 concluída')

    const call = vi.mocked(runProcess).mock.calls[1]
    const args = call[1] as string[]
    const titleIdx = args.indexOf('--title')
    expect(args[titleIdx + 1]).toContain('fase 2')
  })
})
