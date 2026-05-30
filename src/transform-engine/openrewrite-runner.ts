import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../lib/process-runner.js'
import { OPENREWRITE_PLUGIN_COORDS } from './recipe-selector.js'

export interface OpenRewriteResult {
  recipesApplied: string[]
  filesModified: number
  filesAdded: number
  filesDeleted: number
  diffSummary: string
  fullDiff: string
  warnings: string[]
}

const OPENREWRITE_TIMEOUT_MS = 15 * 60_000  // 15 minutos

export async function runRecipes(
  projectPath: string,
  recipes: string[],
  buildSystem: 'maven' | 'gradle',
  dryRun: boolean,
  extraDependencies: string[] = [],
): Promise<OpenRewriteResult> {
  if (recipes.length === 0) {
    return empty(recipes)
  }

  if (buildSystem === 'gradle') {
    return runGradleRecipes(projectPath, recipes, dryRun)
  }

  return runMavenRecipes(projectPath, recipes, dryRun, extraDependencies)
}

async function runMavenRecipes(
  projectPath: string,
  recipes: string[],
  dryRun: boolean,
  extraDependencies: string[],
): Promise<OpenRewriteResult> {
  const goal = dryRun ? 'dryRun' : 'run'
  const args = [
    '-U',
    `${OPENREWRITE_PLUGIN_COORDS}:${goal}`,
    `-Drewrite.activeRecipes=${recipes.join(',')}`,
    '-Drewrite.exportDatatables=true',
    '-Dmaven.deploy.skip=true',
    '-B',
  ]

  // Injeta dependências extras necessárias para alguns recipes (ex: WebLogic)
  if (extraDependencies.length > 0) {
    args.push(`-Drewrite.rewriteDependencies=${extraDependencies.join(',')}`)
  }

  const result = await runProcess('mvn', args, {
    cwd: projectPath,
    timeoutMs: OPENREWRITE_TIMEOUT_MS,
  })

  if (result.timedOut) {
    return { ...empty(recipes), warnings: ['OpenRewrite excedeu o timeout de 15 minutos'] }
  }

  const warnings = parseMavenWarnings(result.stdout + result.stderr)

  if (dryRun) {
    const { patchCount, diff } = readDryRunPatches(projectPath, 'maven')
    return {
      recipesApplied: recipes,
      filesModified: 0,
      filesAdded: 0,
      filesDeleted: 0,
      diffSummary: `[dry-run] ${patchCount} arquivo(s) seriam modificados por: ${recipes.join(', ')}`,
      fullDiff: diff,
      warnings,
    }
  }

  const modifiedFiles = await countModifiedByGit(projectPath)
  const fullDiff = await getGitDiff(projectPath)

  return {
    recipesApplied: recipes,
    filesModified: modifiedFiles,
    filesAdded: 0,
    filesDeleted: 0,
    diffSummary: `${modifiedFiles} arquivo(s) modificados por: ${recipes.join(', ')}`,
    fullDiff,
    warnings,
  }
}

async function runGradleRecipes(
  projectPath: string,
  recipes: string[],
  dryRun: boolean,
): Promise<OpenRewriteResult> {
  // Verifica se o rewrite plugin já está no build.gradle
  const hasPlugin = checkGradleRewritePlugin(projectPath)
  if (!hasPlugin) {
    return {
      ...empty(recipes),
      warnings: [
        'OpenRewrite plugin não encontrado no build.gradle. ' +
          'Adicione "id \'org.openrewrite.rewrite\'" ao bloco plugins {} e reconfigure.',
      ],
    }
  }

  const task = dryRun ? 'rewriteDryRun' : 'rewriteRun'
  const args = [task, `-PactiveRecipes=${recipes.join(',')}`, '-q']

  const result = await runProcess(
    process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
    args,
    { cwd: projectPath, timeoutMs: OPENREWRITE_TIMEOUT_MS },
  )

  if (result.timedOut) {
    return { ...empty(recipes), warnings: ['OpenRewrite Gradle excedeu o timeout de 15 minutos'] }
  }

  const warnings = parseMavenWarnings(result.stdout + result.stderr)

  if (dryRun) {
    const { patchCount, diff } = readDryRunPatches(projectPath, 'gradle')
    return {
      recipesApplied: recipes,
      filesModified: 0, filesAdded: 0, filesDeleted: 0,
      diffSummary: `[dry-run] ${patchCount} arquivo(s) seriam modificados`,
      fullDiff: diff,
      warnings,
    }
  }

  const modifiedFiles = await countModifiedByGit(projectPath)
  return {
    recipesApplied: recipes,
    filesModified: modifiedFiles, filesAdded: 0, filesDeleted: 0,
    diffSummary: `${modifiedFiles} arquivo(s) modificados`,
    fullDiff: await getGitDiff(projectPath),
    warnings,
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Exported for unit testing
export function parseMavenWarnings(output: string): string[] {
  const warnings: string[] = []
  for (const line of output.split('\n')) {
    const t = line.trim()
    if (t.startsWith('[WARNING]')) warnings.push(t.replace('[WARNING]', '').trim())
    if (t.startsWith('[ERROR]') && !t.includes('BUILD FAILURE')) {
      warnings.push(t.replace('[ERROR]', 'ERROR:').trim())
    }
  }
  return warnings
}

// Exported for unit testing
export function parseModifiedFilesCount(output: string): number {
  // "Changes have been made to N source files"
  const m = output.match(/Changes (?:have been made|would be made) to (\d+) source file/)
  if (m) return parseInt(m[1], 10)
  // "[INFO] These recipes would make changes to N source files"
  const m2 = output.match(/make changes to (\d+) source file/)
  if (m2) return parseInt(m2[1], 10)
  return 0
}

function readDryRunPatches(
  projectPath: string,
  buildSystem: 'maven' | 'gradle',
): { patchCount: number; diff: string } {
  const patchDir = join(
    projectPath,
    buildSystem === 'gradle' ? 'build/rewrite' : 'target/rewrite',
  )
  if (!existsSync(patchDir)) return { patchCount: 0, diff: '' }

  const patches = readdirSync(patchDir).filter(f => f.endsWith('.patch') || f.endsWith('.diff'))
  const diff = patches
    .map(p => readFileSync(join(patchDir, p), 'utf-8'))
    .join('\n---\n')

  return { patchCount: patches.length, diff }
}

async function countModifiedByGit(projectPath: string): Promise<number> {
  const result = await runProcess('git', ['diff', '--name-only'], {
    cwd: projectPath,
    timeoutMs: 10_000,
  })
  if (result.exitCode !== 0) return 0
  return result.stdout.trim().split('\n').filter(Boolean).length
}

async function getGitDiff(projectPath: string): Promise<string> {
  const result = await runProcess('git', ['diff', '--stat'], {
    cwd: projectPath,
    timeoutMs: 10_000,
  })
  return result.exitCode === 0 ? result.stdout : ''
}

function checkGradleRewritePlugin(projectPath: string): boolean {
  for (const f of ['build.gradle', 'build.gradle.kts']) {
    const path = join(projectPath, f)
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8')
      return content.includes('org.openrewrite.rewrite')
    }
  }
  return false
}

function empty(recipes: string[]): OpenRewriteResult {
  return {
    recipesApplied: recipes,
    filesModified: 0, filesAdded: 0, filesDeleted: 0,
    diffSummary: 'Nenhuma alteração aplicada',
    fullDiff: '',
    warnings: [],
  }
}
