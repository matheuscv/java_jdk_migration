import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { StackType, PhaseNumber, PhaseStatus, BuildSystem, AppServer, CiSystem } from '../types.js'
import { MigrationError } from './errors.js'

export interface PhaseState {
  status: PhaseStatus
  gateToken: string | null
  approvedBy: string | null
  approvedAt: string | null  // ISO 8601
  executedAt: string | null  // ISO 8601
  gitBranch: string | null   // phase branch: jdk-migration/phase-N-ts
  gitCommit: string | null   // commit after phase transform
  baseBranch: string | null  // branch to return to on rollback
  baseCommit: string | null  // HEAD before phase branch was created
  prUrl: string | null
}

export interface ArtifactRegistry {
  /** Registry type. Use 'none' to disable internal dependency checks. */
  type: 'nexus3' | 'artifactory' | 'none'
  /** Base URL of the registry, e.g. "https://nexus-release-corp.ccorp.local" */
  url: string
  /**
   * Group ID prefixes that belong to this organisation's internal artifacts.
   * Used to filter which dependencies to check for SB3-compatible versions.
   * Example: ["com.mycompany", "com.mycompany.platform"]
   */
  internalGroupIds: string[]
}

export interface JdkMigrationConfig {
  sourceJdk: '6' | '8'
  targetJdk: '21'
  stack: StackType[]
  buildSystem: BuildSystem
  appServer: AppServer
  multiModule: boolean
  modulePaths: string[]
  ciSystem: CiSystem
  testCoverageThreshold: number
  dryRunBeforeExecute: boolean
  phases: Record<PhaseNumber, PhaseState>
  /** Optional: internal artifact registry for checking dep compatibility before migration. */
  artifactRegistry?: ArtifactRegistry
}

const CONFIG_FILENAME = 'jdk-migration.config.json'

const DEFAULT_PHASE_STATE: PhaseState = {
  status: 'pending',
  gateToken: null,
  approvedBy: null,
  approvedAt: null,
  executedAt: null,
  gitBranch: null,
  gitCommit: null,
  baseBranch: null,
  baseCommit: null,
  prUrl: null,
}

export function createDefaultPhases(): Record<PhaseNumber, PhaseState> {
  return {
    0: { ...DEFAULT_PHASE_STATE },
    1: { ...DEFAULT_PHASE_STATE },
    2: { ...DEFAULT_PHASE_STATE },
    3: { ...DEFAULT_PHASE_STATE },
    4: { ...DEFAULT_PHASE_STATE },
    5: { ...DEFAULT_PHASE_STATE },
  }
}

export function configExists(projectPath: string): boolean {
  return existsSync(join(projectPath, CONFIG_FILENAME))
}

export function readConfig(projectPath: string): JdkMigrationConfig {
  const configPath = join(projectPath, CONFIG_FILENAME)
  if (!existsSync(configPath)) {
    throw new MigrationError(
      'CONFIG_NOT_FOUND',
      `Arquivo ${CONFIG_FILENAME} não encontrado em ${projectPath}. Execute a Skill de instalação primeiro.`,
      { configPath },
    )
  }
  const raw = readFileSync(configPath, 'utf-8')
  return JSON.parse(raw) as JdkMigrationConfig
}

export function writeConfig(projectPath: string, config: JdkMigrationConfig): void {
  const configPath = join(projectPath, CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}
