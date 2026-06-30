import * as gitCheckpoint from '../../orchestrator/git-checkpoint.js'
import type { GitGateway } from '../../ports/git-gateway.js'

/**
 * Implementação local de GitGateway: delega integralmente para as funções já
 * existentes em src/orchestrator/git-checkpoint.ts (git CLI local). Nenhuma
 * lógica é duplicada aqui — este adapter só adapta a forma de chamada (objeto
 * em vez de funções soltas) para satisfazer a porta GitGateway.
 *
 * GitHubApiGateway (M3) implementa a mesma porta usando a GitHub API.
 */
export function createLocalGitCli(): GitGateway {
  return {
    isWorkdirClean: gitCheckpoint.isWorkdirClean,
    createPhaseBranch: gitCheckpoint.createPhaseBranch,
    commitPhaseChanges: gitCheckpoint.commitPhaseChanges,
    rollbackPhase: gitCheckpoint.rollbackPhase,
    syncMigrationBranch: gitCheckpoint.syncMigrationBranch,
    createPullRequest: gitCheckpoint.createPullRequest,
  }
}
