import type { Octokit } from '@octokit/rest'
import * as gitCheckpoint from '../../orchestrator/git-checkpoint.js'
import { runProcess } from '../../lib/process-runner.js'
import { MigrationError } from '../../lib/errors.js'
import type { GitGateway, GitCheckpoint } from '../../ports/git-gateway.js'
import type { PhaseNumber } from '../../types.js'

export interface GitHubApiGatewayOptions {
  owner: string
  repo: string
  octokit: Octokit
}

function ts(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

async function localGit(args: string[], cwd: string): Promise<string> {
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

/**
 * Implementação cloud de GitGateway: substitui as operações de metadado
 * (criação de branch, Pull Request) pela GitHub API via octokit — atômicas,
 * sem depender de working dir limpo no momento da chamada de API. Operações
 * que só fazem sentido sobre o clone local (status, commit local, sync de
 * branch) continuam delegadas ao git CLI (mesma lógica de LocalGitCli/
 * git-checkpoint.ts) — não há reimplementação dessas partes.
 */
export function createGitHubApiGateway(options: GitHubApiGatewayOptions): GitGateway {
  const { owner, repo, octokit } = options

  return {
    isWorkdirClean: gitCheckpoint.isWorkdirClean,
    commitPhaseChanges: gitCheckpoint.commitPhaseChanges,
    syncMigrationBranch: gitCheckpoint.syncMigrationBranch,

    async createPhaseBranch(projectPath: string, phase: PhaseNumber): Promise<GitCheckpoint> {
      if (!await gitCheckpoint.isWorkdirClean(projectPath)) {
        throw new MigrationError(
          'GIT_DIRTY_WORKDIR',
          'O working directory tem alterações não commitadas. ' +
            'Faça commit ou stash antes de executar uma fase.',
        )
      }

      const baseBranch = await localGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)
      const baseCommit = await localGit(['rev-parse', 'HEAD'], projectPath)
      const branchName = `jdk-migration/phase-${phase}-${ts()}`

      // Cria a branch no GitHub a partir do commit base — atômico, não depende
      // do working dir local. Idempotente: se já existir (nova tentativa após
      // falha parcial anterior), segue sem erro.
      try {
        await octokit.rest.git.createRef({
          owner, repo, ref: `refs/heads/${branchName}`, sha: baseCommit,
        })
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status
        if (status !== 422) {
          throw new MigrationError(
            'GIT_WORKSPACE_INIT_FAILED',
            `Falha ao criar branch ${branchName} via GitHub API: ${err instanceof Error ? err.message : String(err)}`,
            { err },
          )
        }
      }

      await localGit(['checkout', '-b', branchName], projectPath)

      return { branchName, baseBranch, baseCommit, phaseCommit: null }
    },

    async rollbackPhase(projectPath: string, checkpoint: GitCheckpoint): Promise<void> {
      // Volta o workdir local para a branch base. A branch de fase permanece
      // no GitHub como registro da tentativa falha — rollback NÃO apaga a
      // branch remota, preservando trilha de auditoria (mesma semântica do
      // modo local, ver git-checkpoint.ts).
      await gitCheckpoint.rollbackPhase(projectPath, checkpoint)
    },

    async createPullRequest(
      projectPath: string,
      phase: PhaseNumber,
      checkpoint: GitCheckpoint,
      summary: string,
    ): Promise<string | null> {
      const title = `chore(jdk-migration): fase ${phase} -- migracao JDK 8 para 21`
      const body = [
        `## Migracao JDK -- Fase ${phase}`,
        '',
        summary,
        '',
        `**Branch de fase:** \`${checkpoint.branchName}\``,
        `**Commit base:** \`${checkpoint.baseCommit}\``,
        '',
        '> Gerado automaticamente pelo jdk-migration MCP tool (versão cloud).',
      ].join('\n')

      try {
        const { data } = await octokit.rest.pulls.create({
          owner, repo, title, body,
          head: checkpoint.branchName,
          base: checkpoint.baseBranch,
          draft: true,
        })
        return data.html_url
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status
        if (status === 422) {
          // PR já existe para essa branch (nova tentativa) — busca e retorna a existente.
          try {
            const { data: existing } = await octokit.rest.pulls.list({
              owner, repo, head: `${owner}:${checkpoint.branchName}`, state: 'open',
            })
            if (existing.length > 0) return existing[0].html_url
          } catch {
            // segue para o retorno null abaixo
          }
        }
        // Mesma semântica de LocalGitCli: indisponibilidade da API não falha a fase.
        return null
      }
    },
  }
}
