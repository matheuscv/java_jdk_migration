import { runProcess } from '../lib/process-runner.js'
import { MigrationError } from '../lib/errors.js'
import type { PhaseNumber } from '../types.js'

export interface GitCheckpoint {
  branchName: string   // jdk-migration/phase-N-YYYYMMDD-HHmmss
  baseBranch: string   // branch de onde partimos
  baseCommit: string   // commit HEAD antes da branch de fase
  phaseCommit: string | null
}

function ts(): string {
  // Remove todos os separadores incluindo o ponto dos milissegundos
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30_000 })
  if (result.exitCode !== 0) {
    throw new MigrationError(
      'GIT_DIRTY_WORKDIR',
      `git ${args[0]} falhou: ${result.stderr.trim()}`,
      { args, stderr: result.stderr },
    )
  }
  return result.stdout.trim()
}

export async function isWorkdirClean(projectPath: string): Promise<boolean> {
  const result = await runProcess('git', ['status', '--porcelain'], {
    cwd: projectPath,
    timeoutMs: 10_000,
  })
  return result.exitCode === 0 && result.stdout.trim() === ''
}

export async function createPhaseBranch(
  projectPath: string,
  phase: PhaseNumber,
): Promise<GitCheckpoint> {
  if (!await isWorkdirClean(projectPath)) {
    throw new MigrationError(
      'GIT_DIRTY_WORKDIR',
      'O working directory tem alterações não commitadas. ' +
        'Faça commit ou stash antes de executar uma fase.',
    )
  }

  const baseBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)
  const baseCommit = await git(['rev-parse', 'HEAD'], projectPath)
  const branchName = `jdk-migration/phase-${phase}-${ts()}`

  await git(['checkout', '-b', branchName], projectPath)

  return { branchName, baseBranch, baseCommit, phaseCommit: null }
}

export async function commitPhaseChanges(
  projectPath: string,
  phase: PhaseNumber,
  message: string,
): Promise<string> {
  await git(['add', '-A'], projectPath)

  const status = await runProcess('git', ['status', '--porcelain'], {
    cwd: projectPath, timeoutMs: 10_000,
  })
  if (status.stdout.trim() === '') {
    // Nada para commitar — cria commit vazio para registrar a fase
    await git(
      ['commit', '--allow-empty', '-m', `chore(jdk-migration): fase ${phase} — ${message}`],
      projectPath,
    )
  } else {
    await git(
      ['commit', '-m', `chore(jdk-migration): fase ${phase} — ${message}`],
      projectPath,
    )
  }

  return git(['rev-parse', 'HEAD'], projectPath)
}

export async function rollbackPhase(
  projectPath: string,
  checkpoint: GitCheckpoint,
): Promise<void> {
  // Volta para a branch original — o working dir reverte automaticamente
  await git(['checkout', checkpoint.baseBranch], projectPath)
  // A branch de fase permanece como registro da tentativa falha
}

export async function createPullRequest(
  projectPath: string,
  phase: PhaseNumber,
  checkpoint: GitCheckpoint,
  summary: string,
): Promise<string | null> {
  const ghCheck = await runProcess('gh', ['--version'], { cwd: projectPath, timeoutMs: 5_000 })
  if (ghCheck.exitCode !== 0) return null  // gh não disponível — não falha

  const title = `chore(jdk-migration): fase ${phase} — migração JDK 8→21`
  const body = [
    `## Migração JDK — Fase ${phase}`,
    '',
    summary,
    '',
    `**Branch de fase:** \`${checkpoint.branchName}\``,
    `**Commit base:** \`${checkpoint.baseCommit}\``,
    '',
    '> Gerado automaticamente pelo jdk-migration MCP tool.',
  ].join('\n')

  const result = await runProcess(
    'gh',
    ['pr', 'create', '--title', title, '--body', body, '--head', checkpoint.branchName],
    { cwd: projectPath, timeoutMs: 30_000 },
  )

  return result.exitCode === 0 ? result.stdout.trim() : null
}
