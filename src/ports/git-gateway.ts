import type { PhaseNumber } from '../types.js'

export interface GitCheckpoint {
  branchName: string
  baseBranch: string
  baseCommit: string
  phaseCommit: string | null
}

export interface SyncMigrationBranchResult {
  synced: boolean
  migrationBranch: string | null
  tipBranch: string | null
  error?: string
}

/**
 * Porta de operações Git por trás da orquestração de fases.
 *
 * LocalGitCli (M0) delega para o git CLI local (src/orchestrator/git-checkpoint.ts),
 * comportamento idêntico ao atual. GitHubApiGateway (M3) substitui as operações
 * de metadado (branch, PR, rollback) pela GitHub API via octokit, mantendo git
 * CLI apenas onde há árvore de trabalho real (push do resultado das transformações).
 */
export interface GitGateway {
  isWorkdirClean(projectPath: string): Promise<boolean>
  createPhaseBranch(projectPath: string, phase: PhaseNumber): Promise<GitCheckpoint>
  commitPhaseChanges(projectPath: string, phase: PhaseNumber, message: string): Promise<string>
  rollbackPhase(projectPath: string, checkpoint: GitCheckpoint): Promise<void>
  syncMigrationBranch(
    projectPath: string,
    migrationBranch: string,
    tipBranch: string,
  ): Promise<SyncMigrationBranchResult>
  createPullRequest(
    projectPath: string,
    phase: PhaseNumber,
    checkpoint: GitCheckpoint,
    summary: string,
  ): Promise<string | null>
}
