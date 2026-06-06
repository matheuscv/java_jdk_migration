import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { runProcess } from './process-runner.js'

export type ToolStatus = 'found' | 'not_found' | 'user_provided'

export interface DetectedTool {
  name: string
  /** Variável de ambiente ou mecanismo que levou à descoberta */
  source: string
  /** Caminho absoluto do executável ou diretório home */
  path: string
  /** Versão detectada (saída de --version) */
  version: string | null
  status: ToolStatus
  /** Se true, a fase não pode avançar sem esta ferramenta */
  required: boolean
  /** Mensagem para exibir ao usuário quando não encontrada */
  missingMessage?: string
}

export interface ToolDetectionResult {
  tools: DetectedTool[]
  /** true se todos os required tools foram encontrados */
  allRequiredFound: boolean
  /** Ferramentas obrigatórias ausentes — o agente deve perguntar ao usuário */
  missing: DetectedTool[]
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
}

/** Procura `binaryName` (e variantes .cmd/.exe no Windows) nos dirs do PATH */
function findInPath(binaryName: string, env: NodeJS.ProcessEnv): string | null {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of pathDirs(env)) {
    for (const ext of extensions) {
      const candidate = join(dir, binaryName + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Resolve um diretório home para o executável principal (ex: JAVA_HOME → java) */
function resolveHomeToExe(homeDir: string, relativeBin: string): string | null {
  const candidate = join(homeDir, relativeBin)
  const candidateExe = candidate + (process.platform === 'win32' ? '.exe' : '')
  if (existsSync(candidateExe)) return candidateExe
  if (existsSync(candidate)) return candidate
  return null
}

async function queryVersion(
  executablePath: string,
  versionArgs: string[],
  pattern: RegExp,
): Promise<string | null> {
  try {
    const result = await runProcess(executablePath, versionArgs, {
      cwd: process.cwd(),
      timeoutMs: 8_000,
    })
    const combined = result.stdout + result.stderr
    const match = combined.match(pattern)
    return match ? match[1] ?? match[0] : combined.split('\n')[0].trim() || null
  } catch {
    return null
  }
}

// ─── detectores individuais ──────────────────────────────────────────────────

async function detectJava(env: NodeJS.ProcessEnv, overrides: Record<string, string>): Promise<DetectedTool> {
  const name = 'Java (JDK)'
  const required = true

  // 1. Override explícito do usuário
  if (overrides['JAVA_HOME']) {
    const exe = resolveHomeToExe(overrides['JAVA_HOME'], 'bin/java')
    if (exe) {
      const version = await queryVersion(exe, ['-version'], /version "([^"]+)"/)
      return { name, source: 'override usuário', path: overrides['JAVA_HOME'], version, status: 'user_provided', required }
    }
  }

  // 2. Variável de ambiente JAVA_HOME
  const javaHome = env.JAVA_HOME
  if (javaHome && existsSync(javaHome)) {
    const exe = resolveHomeToExe(javaHome, 'bin/java')
    if (exe) {
      const version = await queryVersion(exe, ['-version'], /version "([^"]+)"/)
      return { name, source: 'JAVA_HOME', path: javaHome, version, status: 'found', required }
    }
  }

  // 3. PATH
  const javaInPath = findInPath('java', env)
  if (javaInPath) {
    const version = await queryVersion(javaInPath, ['-version'], /version "([^"]+)"/)
    return { name, source: 'PATH', path: javaInPath, version, status: 'found', required }
  }

  return {
    name, source: '—', path: '—', version: null, status: 'not_found', required,
    missingMessage:
      'Java não encontrado. Informe o JAVA_HOME (ex: C:\\Program Files\\Zulu\\zulu-21).',
  }
}

async function detectMaven(env: NodeJS.ProcessEnv, overrides: Record<string, string>): Promise<DetectedTool> {
  const name = 'Apache Maven'
  const required = true

  if (overrides['MAVEN_HOME'] || overrides['M2_HOME']) {
    const home = overrides['MAVEN_HOME'] ?? overrides['M2_HOME']!
    const exe = resolveHomeToExe(home, process.platform === 'win32' ? 'bin/mvn.cmd' : 'bin/mvn')
      ?? resolveHomeToExe(home, 'bin/mvn')
    if (exe) {
      const version = await queryVersion(exe, ['--version'], /Apache Maven ([\d.]+)/)
      return { name, source: 'override usuário', path: home, version, status: 'user_provided', required }
    }
  }

  for (const envVar of ['MAVEN_HOME', 'M2_HOME', 'MVN_HOME']) {
    const home = env[envVar]
    if (home && existsSync(home)) {
      const exe = resolveHomeToExe(home, process.platform === 'win32' ? 'bin/mvn.cmd' : 'bin/mvn')
        ?? resolveHomeToExe(home, 'bin/mvn')
      if (exe) {
        const version = await queryVersion(exe, ['--version'], /Apache Maven ([\d.]+)/)
        return { name, source: envVar, path: home, version, status: 'found', required }
      }
    }
  }

  const mvnInPath = findInPath('mvn', env)
  if (mvnInPath) {
    const version = await queryVersion(mvnInPath, ['--version'], /Apache Maven ([\d.]+)/)
    return { name, source: 'PATH', path: mvnInPath, version, status: 'found', required }
  }

  return {
    name, source: '—', path: '—', version: null, status: 'not_found', required,
    missingMessage:
      'Maven não encontrado. Informe o diretório de instalação do Maven ' +
      '(ex: C:\\devtools\\softwares\\Apache\\maven\\apache-maven-3.9.x).',
  }
}

async function detectGit(env: NodeJS.ProcessEnv, overrides: Record<string, string>): Promise<DetectedTool> {
  const name = 'Git'
  const required = true

  if (overrides['GIT_EXEC_PATH']) {
    const version = await queryVersion(overrides['GIT_EXEC_PATH'], ['--version'], /git version ([\d.]+)/)
    return { name, source: 'override usuário', path: overrides['GIT_EXEC_PATH'], version, status: 'user_provided', required }
  }

  const gitInPath = findInPath('git', env)
  if (gitInPath) {
    const version = await queryVersion(gitInPath, ['--version'], /git version ([\d.]+)/)
    return { name, source: 'PATH', path: gitInPath, version, status: 'found', required }
  }

  return {
    name, source: '—', path: '—', version: null, status: 'not_found', required,
    missingMessage: 'Git não encontrado. Informe o caminho do executável git.',
  }
}

async function detectGradle(env: NodeJS.ProcessEnv, overrides: Record<string, string>): Promise<DetectedTool> {
  const name = 'Gradle'
  const required = false

  if (overrides['GRADLE_HOME']) {
    const exe = resolveHomeToExe(overrides['GRADLE_HOME'], process.platform === 'win32' ? 'bin/gradle.bat' : 'bin/gradle')
      ?? resolveHomeToExe(overrides['GRADLE_HOME'], 'bin/gradle')
    if (exe) {
      const version = await queryVersion(exe, ['--version'], /Gradle ([\d.]+)/)
      return { name, source: 'override usuário', path: overrides['GRADLE_HOME'], version, status: 'user_provided', required }
    }
  }

  const gradleHome = env.GRADLE_HOME
  if (gradleHome && existsSync(gradleHome)) {
    const exe = resolveHomeToExe(gradleHome, process.platform === 'win32' ? 'bin/gradle.bat' : 'bin/gradle')
      ?? resolveHomeToExe(gradleHome, 'bin/gradle')
    if (exe) {
      const version = await queryVersion(exe, ['--version'], /Gradle ([\d.]+)/)
      return { name, source: 'GRADLE_HOME', path: gradleHome, version, status: 'found', required }
    }
  }

  const gradleInPath = findInPath('gradle', env)
  if (gradleInPath) {
    const version = await queryVersion(gradleInPath, ['--version'], /Gradle ([\d.]+)/)
    return { name, source: 'PATH', path: gradleInPath, version, status: 'found', required }
  }

  return { name, source: '—', path: '—', version: null, status: 'not_found', required }
}

async function detectJavaTarget(env: NodeJS.ProcessEnv): Promise<DetectedTool> {
  const name = 'Java 21 (target)'
  const required = true

  // Procura um JDK 21 explicitamente — pode ser diferente do java padrão
  for (const candidate of [
    env.JAVA_HOME_21,
    env.JDK_21,
    // Caminhos comuns de instaladores (Zulu, Temurin, Oracle)
    'C:\\Program Files\\Zulu\\zulu-21',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
    'C:\\Program Files\\Java\\jdk-21',
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/usr/lib/jvm/temurin-21',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
  ].filter(Boolean)) {
    if (!candidate || !existsSync(candidate!)) continue
    const exe = resolveHomeToExe(candidate!, 'bin/java')
    if (!exe) continue
    const version = await queryVersion(exe, ['-version'], /version "([^"]+)"/)
    if (version && version.startsWith('21')) {
      return { name, source: candidate!, path: candidate!, version, status: 'found', required }
    }
  }

  // Verifica se o java padrão já é 21
  const javaInPath = findInPath('java', env)
  if (javaInPath) {
    const version = await queryVersion(javaInPath, ['-version'], /version "([^"]+)"/)
    if (version && version.startsWith('21')) {
      return { name, source: 'PATH (java padrão)', path: javaInPath, version, status: 'found', required }
    }
  }

  return {
    name, source: '—', path: '—', version: null, status: 'not_found', required,
    missingMessage:
      'JDK 21 não encontrado. Informe o diretório de instalação do JDK 21 ' +
      '(ex: C:\\Program Files\\Zulu\\zulu-21 ou /usr/lib/jvm/java-21-openjdk-amd64).',
  }
}

// ─── ponto de entrada ─────────────────────────────────────────────────────────

/**
 * Detecta todas as ferramentas necessárias para a migração.
 * @param overrides  Caminhos informados pelo usuário para substituir auto-detecção.
 *                   Ex: { JAVA_HOME: 'C:\\zulu-21', MAVEN_HOME: 'C:\\maven' }
 */
export async function detectTools(
  overrides: Record<string, string> = {},
): Promise<ToolDetectionResult> {
  const env = process.env

  const tools = await Promise.all([
    detectJava(env, overrides),
    detectJavaTarget(env),
    detectMaven(env, overrides),
    detectGit(env, overrides),
    detectGradle(env, overrides),
  ])

  const missing = tools.filter(t => t.required && t.status === 'not_found')

  return {
    tools,
    allRequiredFound: missing.length === 0,
    missing,
  }
}

/** Monta a mensagem de erro estruturada para o agente perguntar ao usuário */
export function buildMissingToolsMessage(missing: DetectedTool[]): string {
  const lines = [
    '⚠️  Algumas ferramentas obrigatórias não foram encontradas automaticamente.',
    'Por favor, informe os caminhos a seguir para prosseguir com a migração:',
    '',
  ]
  for (const t of missing) {
    lines.push(`• ${t.name}: ${t.missingMessage ?? 'Informe o caminho de instalação.'}`)
  }
  lines.push('')
  lines.push(
    'Após informar, chame novamente discover_project passando os caminhos no campo toolOverrides.',
  )
  return lines.join('\n')
}

/** Extrai o path do JDK da aplicação-alvo (source JDK) a partir do resultado de detecção */
export function extractSourceJdkHome(result: ToolDetectionResult): string | null {
  const entry = result.tools.find(t => t.name === 'Java (JDK)' && t.status !== 'not_found')
  if (!entry || entry.path === '—') return null
  return entry.path
}

/** Extrai o path do JDK 21 (target JDK) a partir do resultado de detecção */
export function extractTargetJdkHome(result: ToolDetectionResult): string | null {
  const entry = result.tools.find(t => t.name === 'Java 21 (target)' && t.status !== 'not_found')
  if (!entry || entry.path === '—') return null
  return entry.path
}

/** Serializa para o formato que será gravado no config / discovery-report */
export function serializeTools(result: ToolDetectionResult): SerializedTools {
  return {
    detectedAt: new Date().toISOString(),
    allRequiredFound: result.allRequiredFound,
    tools: result.tools.map(t => ({
      name: t.name,
      source: t.source,
      path: t.path,
      version: t.version,
      status: t.status,
      required: t.required,
    })),
    sourceJdkHome: extractSourceJdkHome(result),
    targetJdkHome: extractTargetJdkHome(result),
  }
}

export interface SerializedTools {
  detectedAt: string
  allRequiredFound: boolean
  tools: Omit<DetectedTool, 'missingMessage'>[]
  /**
   * Atalho para o path do JDK atual da aplicação (entry "Java (JDK)").
   * null quando não detectado.
   */
  sourceJdkHome: string | null
  /**
   * Atalho para o path do JDK 21 (entry "Java 21 (target)").
   * null quando não detectado.
   */
  targetJdkHome: string | null
}
