/**
 * infrastructure-transformer.ts
 *
 * Responsável pelas transformações de Fase 1 em arquivos de infraestrutura:
 *
 *  E1.1 — Atualiza imagens JDK em Dockerfiles, docker-compose, CI/CD pipelines
 *  E1.2 — Remove / substitui flags JVM obsoletas em scripts, .mvn/jvm.config, docker-compose
 *  E1.3 — Atualiza imagens JDK em manifests Kubernetes / Helm YAML
 *  E1.4 — Neutraliza Maven profiles com ativação automática por versão de JDK antigo
 *
 * Regras gerais:
 *  - dryRun=true: calcula diff mas não grava nada em disco
 *  - Nunca quebra um arquivo que não consegue parsear (best-effort, registra warning)
 *  - Grava diff mínimo (linhas -/+) no diffSummary para rastreabilidade
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TransformResult } from './index.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

function readSafe(p: string): string | null {
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

function writeSafe(p: string, content: string, dryRun: boolean): void {
  if (!dryRun) writeFileSync(p, content, 'utf-8')
}

function relPath(projectPath: string, abs: string): string {
  return relative(projectPath, abs).replace(/\\/g, '/')
}

function findFiles(
  dir: string,
  match: (name: string) => boolean,
  maxDepth = 4,
): string[] {
  const results: string[] = []
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git' || e === 'target') continue
      const full = join(d, e)
      let st: ReturnType<typeof statSync> | null = null
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (match(e)) results.push(full)
    }
  }
  walk(dir, 0)
  return results
}

function minimalDiff(filename: string, original: string, updated: string): string {
  const orig = original.split('\n')
  const upd  = updated.split('\n')
  const lines = [`--- ${filename}`, `+++ ${filename}`]
  for (let i = 0; i < Math.max(orig.length, upd.length); i++) {
    if (orig[i] !== upd[i]) {
      if (orig[i] !== undefined) lines.push(`- ${orig[i]}`)
      if (upd[i]  !== undefined) lines.push(`+ ${upd[i]}`)
    }
  }
  return lines.join('\n')
}

// ─── E1.2 — flags JVM obsoletas ───────────────────────────────────────────────

/** Flags completamente removidas no JDK 9–21 — devem ser deletadas. */
const REMOVE_FLAGS = [
  '-XX:+UseConcMarkSweepGC',
  '-XX:+UseParNewGC',
  '-XX:MaxPermSize',        // captura -XX:MaxPermSize=NNN também (regex abaixo)
  '-XX:PermSize',
  '-XX:+PrintGCDateStamps',
  '-XX:+PrintHeapAtGC',
  '-XX:+AggressiveOpts',
  '-XX:+UseStringCache',
  '-XX:+OptimizeStringConcat',
  '-Djava.security.manager=allow',
  '-Djava.security.manager=default',
  // Estes são silenciosamente ignorados — melhor remover explicitamente
  '-Djava.endorsed.dirs',
  '-Djava.ext.dirs',
]

/** Flags substituídas por equivalente moderno. */
const REPLACE_FLAGS: Array<{ from: RegExp; to: string }> = [
  { from: /-XX:\+PrintGCDetails/g, to: '-Xlog:gc*' },
]

/**
 * Limpa uma linha de flags JVM (ex: valor de JAVA_OPTS, argLine do surefire, etc.).
 * Retorna a linha limpa ou null se não mudou nada.
 */
function cleanJvmFlagLine(line: string): string {
  let result = line
  for (const flag of REMOVE_FLAGS) {
    // Captura a flag com possível valor (ex: -XX:MaxPermSize=256m) e espaços adjacentes
    const escaped = flag.replace(/[+()]/g, c => `\\${c}`)
    result = result.replace(new RegExp(`\\s*${escaped}[^\\s"']*`, 'g'), '')
  }
  for (const { from, to } of REPLACE_FLAGS) {
    result = result.replace(from, to)
  }
  // Remove tokens de flags de runFinalizersOnExit que apareçam em scripts
  result = result.replace(/\s*-Djava\.rmi\.server\.useLocalHostname[^\s"']*/g, '')
  return result
}

/**
 * Limpa flags JVM obsoletas de arquivos de texto (scripts, .env, docker-compose env values).
 * Opera linha a linha — preserva estrutura do arquivo.
 */
function cleanFlagsInText(content: string): string {
  return content.split('\n').map(line => {
    // Só processa linhas que parecem conter flags JVM
    if (!/-XX:|java\.endorsed|java\.ext|java\.security\.manager|runFinalizersOnExit/.test(line)) return line
    return cleanJvmFlagLine(line)
  }).join('\n')
}

// ─── E1.1 — imagens Docker ────────────────────────────────────────────────────

/**
 * Mapa de imagens base por distribuição.
 * Chave: prefixo detectado. Valor: imagem JDK 21 correspondente.
 */
const IMAGE_MAP: Record<string, string> = {
  'openjdk':            'eclipse-temurin',   // openjdk não tem imagens JDK 21 oficiais → temurin
  'eclipse-temurin':   'eclipse-temurin',
  'amazoncorretto':    'amazoncorretto',
  'liberica':          'bellsoft/liberica-openjdk-debian',
  'sapmachine':        'sapmachine/jdk',
  'ibmjava':           'ibm-semeru-runtimes', // IBM OpenJ9 → Semeru
  'microsoft/openjdk': 'mcr.microsoft.com/openjdk/jdk',
}

/**
 * Retorna o sufixo de variante preservável (ex: -jre, -alpine, -slim, -jammy).
 * Remove apenas a parte que identifica versão de JDK (8, 11, 17, etc.).
 */
function resolveDockerTag(distro: string, oldVersion: string, suffix: string, targetJdk: string): string {
  // Constrói nova tag: <target_jdk><suffix_sem_versao>
  // Remove segmentos que são apenas números de versão do JDK do suffix
  const cleanSuffix = suffix
    .replace(new RegExp(`^-${oldVersion}\\b`), '')  // ex: -8-jre → -jre
    .replace(/^-jdk\d*/, '')                          // -jdk8 → ''
  const base = IMAGE_MAP[distro] ?? distro
  // Adiciona sufixo padrão mínimo se suffix ficar vazio
  const tag = cleanSuffix ? `${targetJdk}${cleanSuffix}` : `${targetJdk}-jre-jammy`
  return `${base}:${tag}`
}

/**
 * Substitui imagens JDK antigas em conteúdo de Dockerfile ou docker-compose.
 */
function updateDockerImages(content: string, targetJdk: string): string {
  // Padrão: FROM <distro>:<version><suffix> [AS <stage>]
  // Cobre Dockerfile e docker-compose (image: openjdk:8)
  const IMAGE_RE = /\b(FROM|image:)\s+(openjdk|eclipse-temurin|amazoncorretto|liberica|sapmachine|ibmjava|microsoft\/openjdk):(\d+)([-\w.]*)/gi

  return content.replace(IMAGE_RE, (match, keyword, distro, version, suffix) => {
    if (version === targetJdk || version === '21') return match  // já correto
    const distroLower = distro.toLowerCase()
    const newImage = resolveDockerTag(distroLower, version, suffix, targetJdk)
    return `${keyword} ${newImage}`
  })
}

/**
 * Substitui java-version em GitHub Actions / GitLab CI / Azure Pipelines.
 */
function updateCiJavaVersion(content: string, targetJdk: string): string {
  let result = content
  // GitHub Actions: java-version: '8' | java-version: 8 | java-version: "11"
  result = result.replace(
    /(\bjava-version\s*:\s*['"]?)(\d+)(['"]?)/g,
    (m, pre, version, post) => {
      if (version === targetJdk || version === '21') return m
      return `${pre}${targetJdk}${post}`
    },
  )
  // Variáveis de ambiente JAVA_VERSION / JDK_VERSION
  result = result.replace(
    /((?:JAVA|JDK)_VERSION\s*[:=]\s*['"]?)(\d+)(['"]?)/g,
    (m, pre, version, post) => {
      if (version === targetJdk || version === '21') return m
      return `${pre}${targetJdk}${post}`
    },
  )
  return result
}

// ─── E1.3 — manifests Kubernetes / Helm ───────────────────────────────────────

const K8S_DIRS = ['k8s', 'kubernetes', 'manifests', 'deploy', 'helm', 'charts', 'infra', 'infrastructure']

function updateK8sImages(content: string, targetJdk: string): string {
  // image: openjdk:8  /  image: eclipse-temurin:11-jre  /  JAVA_VERSION: "8"
  return updateDockerImages(content, targetJdk)
    .replace(
      /((?:JAVA|JDK)_VERSION\s*[:=]\s*['"]?)(\d+)(['"]?)/g,
      (m, pre, version, post) => {
        if (version === targetJdk || version === '21') return m
        return `${pre}${targetJdk}${post}`
      },
    )
}

// ─── E1.4 — Maven profiles com ativação por JDK antigo ───────────────────────

/**
 * Remove o elemento <jdk>...</jdk> de dentro de blocos <activation>
 * em profiles que sobrescrevem propriedades de compilador.
 * Mantém o profile inteiro — apenas desativa a ativação automática por JDK.
 */
function neutralizeMavenJdkProfiles(content: string): string {
  // Regex: dentro de <activation>...</activation> que contenha <jdk>, remove a tag <jdk>
  // Só atua se o profile também contiver maven.compiler.* ou java.version
  const PROFILE_RE = /<profile>([\s\S]*?)<\/profile>/g
  return content.replace(PROFILE_RE, (profileBlock) => {
    if (!/<activation>[\s\S]*?<jdk>/.test(profileBlock)) return profileBlock
    const COMPILER_RE = /maven\.compiler\.(source|target|release)|<java\.version>/
    if (!COMPILER_RE.test(profileBlock)) return profileBlock
    // Remove a tag <jdk>...</jdk> e espaços/newlines adjacentes
    const neutralized = profileBlock.replace(/\s*<jdk>[^<]*<\/jdk>\s*/g, '\n        ')
    // Adiciona comentário sinalizando a neutralização
    return neutralized.replace(
      /<activation>/,
      '<activation><!-- jdk-migration: ativação por JDK removida — use JAVA_HOME ou toolchain -->',
    )
  })
}

// ─── entry point público ──────────────────────────────────────────────────────

export interface InfraTransformDetail {
  dockerfilesUpdated:   string[]
  ciFilesUpdated:       string[]
  k8sFilesUpdated:      string[]
  scriptsUpdated:       string[]
  mvnJvmConfigCleaned: boolean
  mavenProfilesNeutralized: number
  /** Itens que precisam de confirmação humana no Gate 1 */
  humanConfirmationNeeded: Array<{ id: string; file: string; reason: string }>
}

export async function runInfrastructureTransform(
  projectPath: string,
  targetJdk: string,
  dryRun: boolean,
): Promise<TransformResult & { detail: InfraTransformDetail }> {
  const detail: InfraTransformDetail = {
    dockerfilesUpdated: [],
    ciFilesUpdated: [],
    k8sFilesUpdated: [],
    scriptsUpdated: [],
    mvnJvmConfigCleaned: false,
    mavenProfilesNeutralized: 0,
    humanConfirmationNeeded: [],
  }

  const diffs: string[] = []
  const warnings: string[] = []
  const recipesApplied: string[] = []
  let totalModified = 0

  // ── E1.1: Dockerfiles ──────────────────────────────────────────────────────
  const dockerfiles = findFiles(
    projectPath,
    n => /^Dockerfile/.test(n) || n === 'docker-compose.yml' || n === 'docker-compose.yaml',
    4,
  )
  for (const f of dockerfiles) {
    const original = readSafe(f)
    if (!original) continue
    // Imagem com Helm template ({{...}}) — não alterar, pede confirmação humana
    if (/\{\{/.test(original)) {
      const rel = relPath(projectPath, f)
      detail.humanConfirmationNeeded.push({
        id: 'dockerfile-helm-template',
        file: rel,
        reason: 'Contém templates Helm ({{ }}) — imagem JDK não pode ser atualizada automaticamente. Atualize manualmente.',
      })
      continue
    }
    let updated = updateDockerImages(original, targetJdk)
    updated = cleanFlagsInText(updated)
    if (updated !== original) {
      const rel = relPath(projectPath, f)
      diffs.push(minimalDiff(rel, original, updated))
      writeSafe(f, updated, dryRun)
      detail.dockerfilesUpdated.push(rel)
      totalModified++
    }
  }
  if (detail.dockerfilesUpdated.length > 0) recipesApplied.push('update-dockerfile-jdk-images')

  // ── E1.1: CI/CD pipelines ──────────────────────────────────────────────────
  const ciFiles = [
    ...findFiles(join(projectPath, '.github', 'workflows'), n => n.endsWith('.yml') || n.endsWith('.yaml'), 3),
    ...findFiles(join(projectPath, '.gitlab-ci'), n => n.endsWith('.yml') || n.endsWith('.yaml'), 2),
    ...['azure-pipelines.yml', 'azure-pipelines.yaml', '.gitlab-ci.yml', 'Jenkinsfile'].map(n => join(projectPath, n)),
  ].filter(existsSync)

  for (const f of ciFiles) {
    const original = readSafe(f)
    if (!original) continue
    const updated = updateCiJavaVersion(original, targetJdk)
    if (updated !== original) {
      const rel = relPath(projectPath, f)
      diffs.push(minimalDiff(rel, original, updated))
      writeSafe(f, updated, dryRun)
      detail.ciFilesUpdated.push(rel)
      totalModified++
    }
  }
  if (detail.ciFilesUpdated.length > 0) recipesApplied.push('update-ci-java-version')

  // ── E1.2: .mvn/jvm.config ──────────────────────────────────────────────────
  const jvmConfigPath = join(projectPath, '.mvn', 'jvm.config')
  if (existsSync(jvmConfigPath)) {
    const original = readSafe(jvmConfigPath)
    if (original) {
      const updated = cleanFlagsInText(original)
      if (updated !== original) {
        diffs.push(minimalDiff('.mvn/jvm.config', original, updated))
        writeSafe(jvmConfigPath, updated, dryRun)
        detail.mvnJvmConfigCleaned = true
        totalModified++
        recipesApplied.push('clean-jvm-config-flags')
      }
    }
  }

  // ── E1.2: scripts de startup ────────────────────────────────────────────────
  const scriptFiles = findFiles(
    projectPath,
    n => n.endsWith('.sh') || n.endsWith('.bat') || n.endsWith('.cmd') || n.endsWith('.env') || n === '.env',
    3,
  )
  for (const f of scriptFiles) {
    const original = readSafe(f)
    if (!original) continue
    if (!/-XX:|java\.endorsed|java\.ext|java\.security\.manager|runFinalizersOnExit/.test(original)) continue
    const updated = cleanFlagsInText(original)
    if (updated !== original) {
      const rel = relPath(projectPath, f)
      diffs.push(minimalDiff(rel, original, updated))
      writeSafe(f, updated, dryRun)
      detail.scriptsUpdated.push(rel)
      totalModified++
    }
  }
  if (detail.scriptsUpdated.length > 0) recipesApplied.push('clean-jvm-flags-in-scripts')

  // ── E1.3: Kubernetes / Helm ────────────────────────────────────────────────
  for (const dir of K8S_DIRS) {
    const fullDir = join(projectPath, dir)
    if (!existsSync(fullDir)) continue
    const yamlFiles = findFiles(fullDir, n => n.endsWith('.yaml') || n.endsWith('.yml'), 6)
    for (const f of yamlFiles) {
      const original = readSafe(f)
      if (!original) continue
      // Helm template com {{ }} — não alterar automaticamente
      if (/\{\{/.test(original) && /image\s*:/.test(original)) {
        const rel = relPath(projectPath, f)
        detail.humanConfirmationNeeded.push({
          id: 'helm-template-image',
          file: rel,
          reason: 'Helm template com imagem parametrizada — verifique o values.yaml e atualize a variável de imagem JDK manualmente.',
        })
        continue
      }
      const updated = updateK8sImages(original, targetJdk)
      if (updated !== original) {
        const rel = relPath(projectPath, f)
        diffs.push(minimalDiff(rel, original, updated))
        writeSafe(f, updated, dryRun)
        detail.k8sFilesUpdated.push(rel)
        totalModified++
      }
    }
  }
  if (detail.k8sFilesUpdated.length > 0) recipesApplied.push('update-k8s-jdk-images')

  // ── E1.4: Maven profiles ────────────────────────────────────────────────────
  const pomFiles = findFiles(projectPath, n => n === 'pom.xml', 4)
  for (const f of pomFiles) {
    const original = readSafe(f)
    if (!original) continue
    const updated = neutralizeMavenJdkProfiles(original)
    if (updated !== original) {
      const rel = relPath(projectPath, f)
      // Conta profiles neutralizados
      const matchCount = (original.match(/<jdk>/g) ?? []).length
      detail.mavenProfilesNeutralized += matchCount
      diffs.push(minimalDiff(rel, original, updated))
      writeSafe(f, updated, dryRun)
      totalModified++
    }
  }
  if (detail.mavenProfilesNeutralized > 0) {
    recipesApplied.push(`neutralize-maven-jdk-profiles (${detail.mavenProfilesNeutralized} profile(s))`)
    warnings.push(
      `${detail.mavenProfilesNeutralized} Maven profile(s) com ativação por versão de JDK foram neutralizados. ` +
      `Confirme no Gate 1 se o conteúdo desses profiles ainda é necessário.`,
    )
  }

  // ── Itens para confirmação humana ──────────────────────────────────────────
  if (detail.humanConfirmationNeeded.length > 0) {
    warnings.push(
      `${detail.humanConfirmationNeeded.length} arquivo(s) com templates Helm ou conteúdo não-editável automaticamente — ` +
      `confirmação humana solicitada no Gate 1.`,
    )
  }

  const prefix = dryRun ? '[dry-run] ' : ''
  const parts: string[] = []
  if (detail.dockerfilesUpdated.length > 0) parts.push(`Dockerfiles/CI: ${detail.dockerfilesUpdated.length + detail.ciFilesUpdated.length} arquivo(s)`)
  if (detail.k8sFilesUpdated.length > 0) parts.push(`K8s/Helm: ${detail.k8sFilesUpdated.length} arquivo(s)`)
  if (detail.scriptsUpdated.length > 0) parts.push(`Scripts: ${detail.scriptsUpdated.length} arquivo(s)`)
  if (detail.mvnJvmConfigCleaned) parts.push(`.mvn/jvm.config limpo`)
  if (detail.mavenProfilesNeutralized > 0) parts.push(`${detail.mavenProfilesNeutralized} profile(s) Maven neutralizado(s)`)

  const diffSummary = parts.length > 0
    ? `${prefix}Infraestrutura atualizada — ${parts.join('; ')}\n${diffs.join('\n')}`
    : `${prefix}Nenhuma alteração de infraestrutura necessária`

  return {
    recipesApplied,
    filesModified: dryRun ? 0 : totalModified,
    filesAdded: 0,
    diffSummary,
    warnings,
    detail,
  }
}
