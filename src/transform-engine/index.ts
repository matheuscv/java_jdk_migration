import type { PhaseNumber } from '../types.js'
import type { JdkMigrationConfig } from '../lib/config.js'
import { selectRecipes } from './recipe-selector.js'
import { updateBuildVersion } from './build-updater.js'
import { runRecipes } from './openrewrite-runner.js'
import { runSpringBootMigrator } from './sbm-runner.js'
import { runInfrastructureTransform } from './infrastructure-transformer.js'
import { runSourceCleaner } from './source-cleaner.js'

export interface TransformResult {
  recipesApplied: string[]
  filesModified: number
  filesAdded: number
  diffSummary: string
  warnings: string[]
  /** Detalhes extras de runners específicos (infra-transformer, source-cleaner) */
  runnerDetails?: Record<string, unknown>
}

export async function executePhaseTransform(
  phase: PhaseNumber,
  config: JdkMigrationConfig,
  projectPath: string,
  dryRun: boolean,
): Promise<TransformResult> {
  const recipeSets = selectRecipes(phase, config)

  // Fases sem transformação automática (0, 4, 5)
  if (recipeSets.length === 0) {
    return {
      recipesApplied: [],
      filesModified: 0,
      filesAdded: 0,
      diffSummary: `Fase ${phase}: nenhuma transformação automática — revisão humana necessária`,
      warnings: [],
    }
  }

  const allRecipes: string[] = []
  let totalModified = 0
  const allDiffs: string[] = []
  const allWarnings: string[] = []
  const runnerDetails: Record<string, unknown> = {}

  for (const set of recipeSets) {
    let result: TransformResult & { fullDiff?: string }

    if (set.runner === 'build-updater') {
      result = await updateBuildVersion(projectPath, config.targetJdk, dryRun)
    } else if (set.runner === 'infrastructure-transformer') {
      const infraResult = await runInfrastructureTransform(projectPath, config.targetJdk, dryRun)
      runnerDetails['infrastructure-transformer'] = infraResult.detail
      result = infraResult
    } else if (set.runner === 'source-cleaner') {
      const cleanResult = await runSourceCleaner(projectPath, dryRun)
      runnerDetails['source-cleaner'] = cleanResult.detail
      result = cleanResult
    } else if (set.runner === 'openrewrite') {
      const or = await runRecipes(
        projectPath,
        set.recipes,
        config.buildSystem as 'maven' | 'gradle',
        dryRun,
        set.extraDependencies,
      )
      result = { ...or, filesAdded: or.filesAdded ?? 0 }
    } else if (set.runner === 'sbm') {
      for (const recipe of set.recipes) {
        const sbmResult = await runSpringBootMigrator(projectPath, recipe, dryRun)
        allRecipes.push(...sbmResult.recipesApplied)
        totalModified += sbmResult.filesModified
        if (sbmResult.diffSummary) allDiffs.push(sbmResult.diffSummary)
        allWarnings.push(...sbmResult.warnings)
      }
      continue
    } else {
      // eclipse-transformer: por JAR, não por fase global — sinalizar para revisão
      allWarnings.push(
        `Eclipse Transformer requer invocação por JAR individual. ` +
          `Identifique os JARs com needsEclipseTransformer: true no relatório de descoberta.`,
      )
      continue
    }

    allRecipes.push(...result.recipesApplied)
    totalModified += result.filesModified
    if (result.diffSummary) allDiffs.push(result.diffSummary)
    allWarnings.push(...result.warnings)
  }

  return {
    recipesApplied: allRecipes,
    filesModified: totalModified,
    filesAdded: 0,
    diffSummary: allDiffs.join('\n'),
    warnings: allWarnings,
    ...(Object.keys(runnerDetails).length > 0 ? { runnerDetails } : {}),
  }
}
