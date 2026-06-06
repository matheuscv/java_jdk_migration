import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeConfig, createDefaultPhases } from '../lib/config.js'
import { MigrationError } from '../lib/errors.js'
import { detectStack } from './stack-detector.js'
import type { StackDetectionResult } from './stack-detector.js'
import type { JdkMigrationConfig } from '../lib/config.js'
import type { BuildSystem } from '../types.js'

export type { StackDetectionResult }

export interface InstallResult {
  config: JdkMigrationConfig
  detectionResult: StackDetectionResult
  requiresHumanInput: boolean
  warnings: string[]
}

export async function install(
  projectPath: string,
  overrides?: Partial<Omit<JdkMigrationConfig, 'phases' | 'targetJdk'>>,
): Promise<InstallResult> {
  const detectionResult = detectStack(projectPath)
  const warnings: string[] = []

  if (detectionResult.buildSystem === 'unknown') {
    throw new MigrationError(
      'STACK_NOT_DETECTED',
      `Nenhum build system detectado em ${projectPath}. ` +
        'Certifique-se que pom.xml, build.gradle ou build.xml existe na raiz do projeto.',
    )
  }

  const sourceJdk = resolveSourceJdk(
    overrides?.sourceJdk ?? detectionResult.detectedJdk,
    warnings,
  )

  const stack =
    overrides?.stack ??
    (detectionResult.detectedStacks.length > 0 ? detectionResult.detectedStacks : ['rest'])

  const config: JdkMigrationConfig = {
    sourceJdk,
    targetJdk: '21',
    stack,
    buildSystem: overrides?.buildSystem ?? (detectionResult.buildSystem as BuildSystem),
    appServer: overrides?.appServer ?? null,
    multiModule: overrides?.multiModule ?? false,
    modulePaths: overrides?.modulePaths ?? [],
    ciSystem: overrides?.ciSystem ?? null,
    testCoverageThreshold: overrides?.testCoverageThreshold ?? 80,
    dryRunBeforeExecute: overrides?.dryRunBeforeExecute ?? true,
    reportMode: overrides?.reportMode ?? 'phase-gate',
    phases: createDefaultPhases(),
  }

  if (config.buildSystem === 'maven' && !config.mavenExecutable) {
    const detected = detectMavenExecutable()
    if (detected) config.mavenExecutable = detected
  }

  mkdirSync(join(projectPath, '.jdk-migration'), { recursive: true })
  writeConfig(projectPath, config)
  ensureGitignoreEntries(projectPath)

  const requiresHumanInput =
    detectionResult.confidence === 'low' || detectionResult.unresolved.length > 0

  return { config, detectionResult, requiresHumanInput, warnings }
}

// Garante que .gitignore exclui os arquivos de metadados da ferramenta
export function ensureGitignoreEntries(projectPath: string): void {
  const ENTRIES = ['.jdk-migration/', 'jdk-migration.config.json']
  const gitignorePath = join(projectPath, '.gitignore')
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : ''
  const toAdd = ENTRIES.filter(e => !existing.includes(e))
  if (toAdd.length === 0) return
  const newContent = existing.endsWith('\n') || existing === ''
    ? existing + toAdd.join('\n') + '\n'
    : existing + '\n' + toAdd.join('\n') + '\n'
  writeFileSync(gitignorePath, newContent, 'utf-8')
}

/**
 * Tenta localizar o executável Maven. Retorna o path absoluto se encontrado fora
 * do PATH padrão do processo, ou undefined se "mvn" já está acessível.
 */
function detectMavenExecutable(): string | undefined {
  // Se mvn já está no PATH do processo, não precisa de path absoluto
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(whichCmd, ['mvn'], { stdio: 'pipe' })
    return undefined // mvn encontrado no PATH — sem necessidade de override
  } catch {
    // mvn não está no PATH — tenta variáveis de ambiente comuns
  }

  const candidates: string[] = []

  for (const envVar of ['MAVEN_HOME', 'M2_HOME', 'MVN_HOME']) {
    const home = process.env[envVar]
    if (home) {
      const bin = join(home, 'bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn')
      if (existsSync(bin)) candidates.push(bin)
    }
  }

  // Fallback: varredura de locais comuns no Windows
  if (process.platform === 'win32') {
    const commonRoots = [
      'C:\\devtools\\softwares\\Apache\\maven',
      'C:\\Program Files\\Apache\\maven',
      'C:\\tools\\maven',
    ]
    for (const root of commonRoots) {
      if (!existsSync(root)) continue
      try {
        for (const entry of readdirSync(root)) {
          const bin = join(root, entry, 'bin', 'mvn.cmd')
          if (existsSync(bin)) { candidates.push(bin); break }
        }
      } catch { /* ignorar */ }
    }
  }

  return candidates[0]
}

function resolveSourceJdk(
  raw: string | null | undefined,
  warnings: string[],
): '6' | '8' {
  if (!raw) {
    warnings.push('Versão de JDK de origem não detectada — assumindo JDK 8.')
    return '8'
  }
  const normalized = raw.startsWith('1.') ? raw.slice(2) : raw
  if (normalized === '6') return '6'
  if (normalized === '8') return '8'
  // JDK 7 → trata como 8 (recipes JDK 8 cobrem JDK 7 também)
  if (parseInt(normalized, 10) <= 8) return '8'
  warnings.push(
    `JDK de origem detectado como ${raw} — fora do escopo suportado (6 ou 8). ` +
      'Forneça sourceJdk manualmente se necessário.',
  )
  return '8'
}
