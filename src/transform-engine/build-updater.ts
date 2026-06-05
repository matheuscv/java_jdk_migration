import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TransformResult } from './index.js'

// Atualiza a versão do compilador Java em pom.xml e build.gradle(s).
// Usado na Fase 1 (Build Infrastructure) — mais confiável que OpenRewrite
// para esta tarefa específica porque não depende de download de plugins.
export async function updateBuildVersion(
  projectPath: string,
  targetJdk: string,
  dryRun: boolean,
): Promise<TransformResult> {
  const modified: string[] = []
  const diffs: string[] = []

  // Maven
  const pomPath = join(projectPath, 'pom.xml')
  if (existsSync(pomPath)) {
    const original = readFileSync(pomPath, 'utf-8')
    const updated = updateMavenVersion(original, targetJdk)
    if (updated !== original) {
      modified.push('pom.xml')
      diffs.push(buildDiff('pom.xml', original, updated))
      if (!dryRun) writeFileSync(pomPath, updated, 'utf-8')
    }
  }

  // Gradle (aceita .kts e .groovy)
  for (const filename of ['build.gradle.kts', 'build.gradle']) {
    const path = join(projectPath, filename)
    if (existsSync(path)) {
      const original = readFileSync(path, 'utf-8')
      const updated = updateGradleVersion(original, targetJdk)
      if (updated !== original) {
        modified.push(filename)
        diffs.push(buildDiff(filename, original, updated))
        if (!dryRun) writeFileSync(path, updated, 'utf-8')
      }
      break  // processa apenas um dos dois formatos Gradle
    }
  }

  // Oracle JDBC: ojdbc8 → ojdbc11 (Maven)
  if (existsSync(pomPath)) {
    const original = readFileSync(pomPath, 'utf-8')
    const updated = updateOjdbc(original)
    if (updated !== original) {
      if (!modified.includes('pom.xml')) modified.push('pom.xml')
      diffs.push(buildDiff('pom.xml (ojdbc8→ojdbc11)', original, updated))
      if (!dryRun) writeFileSync(pomPath, updated, 'utf-8')
    }
  }

  const recipesApplied = [`update-compiler-target-${targetJdk}`]
  const ojdbcFixed = diffs.some(d => d.includes('ojdbc'))
  if (ojdbcFixed) recipesApplied.push('update-ojdbc8-to-ojdbc11')

  const prefix = dryRun ? '[dry-run] ' : ''
  const summary = modified.length === 0
    ? `${prefix}Nenhuma alteração necessária — alvo já é JDK ${targetJdk}`
    : `${prefix}JDK target atualizado para ${targetJdk} em: ${modified.join(', ')}`

  return {
    recipesApplied,
    filesModified: dryRun ? 0 : modified.length,
    filesAdded: 0,
    diffSummary: summary,
    warnings: [],
  }
}

export function updateMavenVersion(pom: string, targetJdk: string): string {
  let result = pom
  // Propriedades de versão: <java.version>1.8</java.version> → <java.version>21</java.version>
  result = result.replace(
    /<java\.version>[\d.]+<\/java\.version>/g,
    `<java.version>${targetJdk}</java.version>`,
  )
  // <maven.compiler.source>1.8</maven.compiler.source>
  result = result.replace(
    /<maven\.compiler\.source>[\d.]+<\/maven\.compiler\.source>/g,
    `<maven.compiler.source>${targetJdk}</maven.compiler.source>`,
  )
  // <maven.compiler.target>1.8</maven.compiler.target>
  result = result.replace(
    /<maven\.compiler\.target>[\d.]+<\/maven\.compiler\.target>/g,
    `<maven.compiler.target>${targetJdk}</maven.compiler.target>`,
  )
  // <release>8</release> dentro do compiler plugin
  result = result.replace(
    /(<maven\.compiler\.release>)[\d.]+(<\/maven\.compiler\.release>)/g,
    `$1${targetJdk}$2`,
  )
  return result
}

export function updateGradleVersion(gradle: string, targetJdk: string): string {
  let result = gradle
  // sourceCompatibility = 'X' | JavaVersion.VERSION_1_8 | JavaVersion.VERSION_8 | 8
  result = result.replace(
    /sourceCompatibility\s*=\s*(?:['"][\d.]+['"]|JavaVersion\.VERSION_\w+|\d+)/g,
    `sourceCompatibility = JavaVersion.VERSION_${targetJdk}`,
  )
  // targetCompatibility (mesma lógica)
  result = result.replace(
    /targetCompatibility\s*=\s*(?:['"][\d.]+['"]|JavaVersion\.VERSION_\w+|\d+)/g,
    `targetCompatibility = JavaVersion.VERSION_${targetJdk}`,
  )
  // java { toolchain { languageVersion = JavaLanguageVersion.of(8) } }
  result = result.replace(
    /JavaLanguageVersion\.of\(\d+\)/g,
    `JavaLanguageVersion.of(${targetJdk})`,
  )
  return result
}

/**
 * Substitui ojdbc8 por ojdbc11 no pom.xml.
 * Apenas o artifactId muda — groupId (com.oracle.database.jdbc) e versao permanecem.
 * A API JDBC e identica, nenhuma alteracao de codigo Java necessaria.
 */
export function updateOjdbc(pom: string): string {
  return pom.replace(/<artifactId>ojdbc8<\/artifactId>/g, '<artifactId>ojdbc11</artifactId>')
}

// Gera diff mínimo (linhas removidas/adicionadas) para o diffSummary
function buildDiff(filename: string, original: string, updated: string): string {
  const origLines = original.split('\n')
  const updLines = updated.split('\n')
  const changed: string[] = [`--- ${filename}`, `+++ ${filename}`]
  for (let i = 0; i < Math.max(origLines.length, updLines.length); i++) {
    const o = origLines[i]
    const u = updLines[i]
    if (o !== u) {
      if (o !== undefined) changed.push(`- ${o}`)
      if (u !== undefined) changed.push(`+ ${u}`)
    }
  }
  return changed.join('\n')
}
