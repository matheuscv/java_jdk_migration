import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { StackType, PhaseNumber, PhaseStatus, BuildSystem, AppServer, CiSystem } from '../types.js'
import { MigrationError } from './errors.js'
import type { SerializedTools } from './tool-detector.js'

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

export interface MigrationStep {
  id: string              // e.g. "step-1"
  num: number             // 1, 2, 3...
  owner: 'claude' | 'you'
  phase: 'A' | 'B' | 'C' | 'D'
  task: string
  status: 'done' | 'pending' | 'skipped'
  commit?: string         // short git hash
  note?: string           // context / decision taken
  completedAt?: string    // ISO 8601
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
  /** Granular step progress within the active phase — persisted by update_step_status tool. */
  steps?: MigrationStep[]
  /**
   * Controls when audit reports are auto-generated.
   * 'phase-gate'      → report gerado ao término de cada Fase e Gate (padrão).
   * 'phase-gate-step' → report gerado também ao término de cada Step individual.
   */
  reportMode?: 'phase-gate' | 'phase-gate-step'
  /** Ferramentas detectadas durante a Fase 0 (discover_project). */
  detectedTools?: SerializedTools
  /**
   * Caminho completo para o executável Maven (ex: "C:\\apache-maven\\bin\\mvn").
   * Quando ausente, usa "mvn" do PATH do processo MCP.
   * Populado automaticamente pela Skill de instalação se Maven não estiver no PATH global.
   */
  mavenExecutable?: string
  /**
   * Caminho completo para o executável Gradle.
   * Quando ausente, usa "gradle" do PATH do processo MCP.
   */
  gradleExecutable?: string
  /**
   * Diretório home do JDK da aplicação-alvo (JDK 6 ou 8).
   * Usado pela Fase 0 para compilar o projeto com o JDK original antes do jdeprscan.
   * Fallback: variável de ambiente SOURCE_JAVA_HOME do processo MCP.
   * Ex: "C:\\Program Files\\Zulu\\zulu-8"
   */
  sourceJdkHome?: string
  /**
   * Diretório home do JDK 21 (target da migração).
   * Usado pelas fases 1–5 para compilar e validar com o JDK destino.
   * Fallback: variável de ambiente JAVA_HOME do processo MCP.
   * Ex: "C:\\Program Files\\Zulu\\zulu-21"
   */
  targetJdkHome?: string
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

// ─── PIN store (aprovação humana) ─────────────────────────────────────────────
// Arquivo separado do config principal — não é retornado por nenhuma MCP tool,
// ficando fora do alcance do agente de IA.

const PIN_STORE_FILENAME = '.gate-pins.json'

export interface PinEntry {
  pin: string
  expiresAt: string  // ISO 8601
  phaseNumber: number
}

export type PinStore = Partial<Record<number, PinEntry>>

export function readPinStore(projectPath: string): PinStore {
  const p = join(projectPath, '.jdk-migration', PIN_STORE_FILENAME)
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) as PinStore } catch { return {} }
}

export function writePinStore(projectPath: string, store: PinStore): void {
  const dir = join(projectPath, '.jdk-migration')
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }) }
  writeFileSync(join(dir, PIN_STORE_FILENAME), JSON.stringify(store, null, 2), 'utf-8')
}

export function deletePinEntry(projectPath: string, phase: number): void {
  const store = readPinStore(projectPath)
  delete store[phase]
  writePinStore(projectPath, store)
}
