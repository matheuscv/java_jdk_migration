import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../lib/process-runner.js'
import type { OpenRewriteResult } from './openrewrite-runner.js'

const SBM_VERSION = '0.16.0'
const SBM_TIMEOUT_MS = 20 * 60_000  // 20 minutos

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
): Promise<OpenRewriteResult> {
  const sbm = await findOrDownloadSbm(projectPath)

  if (!sbm) {
    return {
      recipesApplied: [recipe],
      filesModified: 0, filesAdded: 0, filesDeleted: 0,
      diffSummary: 'Spring Boot Migrator não encontrado',
      fullDiff: '',
      warnings: [
        `Spring Boot Migrator (sbm) não está disponível. ` +
          `Instale manualmente ou coloque sbm.jar em .jdk-migration/tools/. ` +
          `Versão recomendada: ${SBM_VERSION}`,
      ],
    }
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

  return {
    recipesApplied: [recipe],
    filesModified: result.exitCode === 0 ? 1 : 0,
    filesAdded: 0, filesDeleted: 0,
    diffSummary: result.exitCode === 0
      ? `Spring Boot Migrator aplicou recipe '${recipe}' com sucesso`
      : `Spring Boot Migrator falhou: ${result.stderr.slice(0, 200)}`,
    fullDiff: '',
    warnings: result.exitCode !== 0 ? [result.stderr.slice(0, 500)] : [],
  }
}
