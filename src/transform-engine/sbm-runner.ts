import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../lib/process-runner.js'
import { runRecipes } from './openrewrite-runner.js'
import type { OpenRewriteResult } from './openrewrite-runner.js'

const SBM_VERSION = '0.16.0'
const SBM_TIMEOUT_MS = 20 * 60_000  // 20 minutos

// Recipe OpenRewrite usado como fallback quando SBM não está disponível
const SBM_FALLBACK_RECIPE = 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_2'

// Localiza o JAR do Spring Boot Migrator:
// 1. Verifica se 'sbm' está no PATH
// 2. Verifica .jdk-migration/tools/sbm.jar
// 3. Tenta baixar via Maven se disponível
export async function findOrDownloadSbm(projectPath: string): Promise<string | null> {
  // 1. sbm no PATH
  const pathCheck = await runProcess('sbm', ['--version'], { cwd: projectPath, timeoutMs: 5_000 })
  if (pathCheck.exitCode === 0) return 'sbm'

  // 2. JAR local
  const localJar = join(projectPath, '.jdk-migration', 'tools', 'sbm.jar')
  if (existsSync(localJar)) return localJar

  // 3. Download via Maven
  const toolsDir = join(projectPath, '.jdk-migration', 'tools')
  const downloadResult = await runProcess('mvn', [
    'dependency:copy',
    `-Dartifact=org.springframework.sbm:spring-boot-migrator:${SBM_VERSION}:jar`,
    `-DoutputDirectory=${toolsDir}`,
    '-q',
  ], { cwd: projectPath, timeoutMs: 5 * 60_000 })

  if (downloadResult.exitCode === 0 && existsSync(localJar)) return localJar

  return null
}

export async function runSpringBootMigrator(
  projectPath: string,
  recipe: string,
  dryRun: boolean,
  buildSystem: 'maven' | 'gradle' = 'maven',
): Promise<OpenRewriteResult> {
  const sbm = await findOrDownloadSbm(projectPath)

  if (!sbm) {
    // SBM não disponível — usar OpenRewrite como fallback
    return runSbmFallback(projectPath, dryRun, buildSystem)
  }

  const args = sbm === 'sbm'
    ? ['apply', '--recipe', recipe, '--project-root', projectPath]
    : ['-jar', sbm, 'apply', '--recipe', recipe, '--project-root', projectPath]

  const cmd = sbm === 'sbm' ? 'sbm' : 'java'

  if (dryRun) {
    return {
      recipesApplied: [recipe],
      filesModified: 0, filesAdded: 0, filesDeleted: 0,
      diffSummary: `[dry-run] Spring Boot Migrator: recipe '${recipe}' seria aplicado`,
      fullDiff: '',
      warnings: ['SBM não suporta dry-run nativo — este é um preview estimado'],
    }
  }

  const result = await runProcess(cmd, args, { cwd: projectPath, timeoutMs: SBM_TIMEOUT_MS })

  if (result.timedOut) {
    return {
      recipesApplied: [recipe],
      filesModified: 0, filesAdded: 0, filesDeleted: 0,
      diffSummary: 'SBM excedeu o timeout de 20 minutos',
      fullDiff: '',
      warnings: ['Spring Boot Migrator timed out'],
    }
  }

  if (result.exitCode !== 0) {
    // SBM executou mas falhou — tentar fallback OpenRewrite
    return runSbmFallback(projectPath, dryRun, buildSystem, [
      `Spring Boot Migrator falhou (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`,
      'Usando OpenRewrite como fallback automático.',
    ])
  }

  return {
    recipesApplied: [recipe],
    filesModified: 1,
    filesAdded: 0, filesDeleted: 0,
    diffSummary: `Spring Boot Migrator aplicou recipe '${recipe}' com sucesso`,
    fullDiff: '',
    warnings: [],
  }
}

// ─── Fallback: OpenRewrite UpgradeSpringBoot_3_2 ─────────────────────────────

async function runSbmFallback(
  projectPath: string,
  dryRun: boolean,
  buildSystem: 'maven' | 'gradle',
  prependWarnings: string[] = [],
): Promise<OpenRewriteResult> {
  const fallbackWarning =
    `Spring Boot Migrator (sbm) não está disponível ou falhou. ` +
    `Usando fallback: OpenRewrite recipe '${SBM_FALLBACK_RECIPE}'. ` +
    `Para maior cobertura instale o SBM em .jdk-migration/tools/sbm.jar (versão recomendada: ${SBM_VERSION}).`

  const fallbackResult = await runRecipes(
    projectPath,
    [SBM_FALLBACK_RECIPE],
    buildSystem,
    dryRun,
  )

  return {
    ...fallbackResult,
    recipesApplied: [SBM_FALLBACK_RECIPE],
    diffSummary: `[fallback-openrewrite] ${fallbackResult.diffSummary}`,
    warnings: [...prependWarnings, fallbackWarning, ...fallbackResult.warnings],
  }
}
