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

// ─── helpers de versão ───────────────────────────────────────────────────────

/** Extrai o major version de uma string "1.8.0_392", "8.0.392", "21.0.1", etc. */
function parseMajorVersion(version: string): number | null {
  // "1.8.0_..." → major 8;  "21.0.1" → major 21
  const m = version.match(/^(\d+)\.(\d+)/)
  if (!m) return null
  const first = parseInt(m[1], 10)
  return first === 1 ? parseInt(m[2], 10) : first
}

/** Retorna true se a versão pertence ao JDK 21 */
function isJdk21Version(version: string): boolean {
  const major = parseMajorVersion(version)
  return major === 21
}

// ─── detectores individuais ──────────────────────────────────────────────────

/**
 * Detecta o JDK do projeto-alvo (source JDK — sempre JDK 6 ou 8).
 *
 * Estratégia (nunca usa JAVA_HOME para evitar confusão com o JDK 21 do processo MCP):
 * 1. Override explícito do usuário via SOURCE_JAVA_HOME ou JAVA_HOME_<major>
 * 2. Variáveis de ambiente dedicadas: SOURCE_JAVA_HOME, JAVA_HOME_8, JDK_8, JAVA_HOME_6, JDK_6
 * 3. Varredura de paths comuns de instaladores por major version
 * 4. not_found → solicita ao usuário
 *
 * NUNCA retorna um JDK 21 como source — se um candidato for versão 21, é ignorado.
 */
async function detectSourceJdk(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  sourceJdkMajor: 6 | 8,
): Promise<DetectedTool> {
  const name = 'Java (JDK)'
  const required = true

  const validate = async (
    home: string,
    source: string,
    status: ToolStatus,
  ): Promise<DetectedTool | null> => {
    const exe = resolveHomeToExe(home, 'bin/java')
    if (!exe) return null
    const version = await queryVersion(exe, ['-version'], /version "([^"]+)"/)
    if (!version) return null
    const major = parseMajorVersion(version)
    if (major === 21) return null  // nunca aceitar JDK 21 como source
    if (major !== sourceJdkMajor) return null  // versão não coincide com o projeto
    return { name, source, path: home, version, status, required }
  }

  // 1. Override explícito do usuário (SOURCE_JAVA_HOME tem precedência)
  for (const key of ['SOURCE_JAVA_HOME', `JAVA_HOME_${sourceJdkMajor}`, 'JAVA_HOME']) {
    const override = overrides[key]
    if (override) {
      const result = await validate(override, `override usuário (${key})`, 'user_provided')
      if (result) return result
    }
  }

  // 2. Variáveis de ambiente dedicadas ao source JDK (nunca JAVA_HOME — pode ser JDK 21)
  const sourceEnvVars = [
    `SOURCE_JAVA_HOME`,
    `JAVA_HOME_${sourceJdkMajor}`,
    `JDK_${sourceJdkMajor}`,
    ...(sourceJdkMajor === 8 ? ['JAVA_HOME_1_8', 'JDK_1_8'] : ['JAVA_HOME_1_6', 'JDK_1_6']),
  ]
  for (const envVar of sourceEnvVars) {
    const home = env[envVar]
    if (home && existsSync(home)) {
      const result = await validate(home, envVar, 'found')
      if (result) return result
    }
  }

  // 3. Varredura de paths comuns de instaladores
  const commonPaths = sourceJdkMajor === 8
    ? [
        // Windows — Zulu
        'C:\\Program Files\\Zulu\\zulu-8',
        'C:\\Program Files\\Zulu\\zulu-8.x',
        // Windows — Eclipse Temurin / Adoptium
        'C:\\Program Files\\Eclipse Adoptium\\jdk-8',
        'C:\\Program Files\\Eclipse Adoptium\\jdk-8.0',
        // Windows — Oracle / generic
        'C:\\Program Files\\Java\\jdk1.8.0',
        'C:\\Program Files\\Java\\jdk-8',
        // macOS — Homebrew / Temurin
        '/Library/Java/JavaVirtualMachines/temurin-8.jdk/Contents/Home',
        '/Library/Java/JavaVirtualMachines/zulu-8.jdk/Contents/Home',
        // Linux
        '/usr/lib/jvm/java-8-openjdk-amd64',
        '/usr/lib/jvm/temurin-8',
        '/usr/lib/jvm/zulu-8',
      ]
    : [
        // JDK 6 — instaladores comuns (muito legado)
        'C:\\Program Files\\Zulu\\zulu-6',
        'C:\\Program Files\\Java\\jdk1.6.0',
        '/usr/lib/jvm/java-6-openjdk-amd64',
        '/usr/lib/jvm/zulu-6',
      ]

  for (const candidate of commonPaths) {
    if (!existsSync(candidate)) continue
    const result = await validate(candidate, candidate, 'found')
    if (result) return result
  }

  // 4. Não encontrado — pede ao usuário
  return {
    name,
    source: '—',
    path: '—',
    version: null,
    status: 'not_found',
    required,
    missingMessage:
      `JDK ${sourceJdkMajor} não encontrado automaticamente. ` +
      `O projeto-alvo usa JDK ${sourceJdkMajor} — informe o path de instalação via toolOverrides. ` +
      `Chave: "SOURCE_JAVA_HOME". ` +
      `Exemplo: { "SOURCE_JAVA_HOME": "C:\\\\Program Files\\\\Zulu\\\\zulu-${sourceJdkMajor}" }`,
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

/**
 * Detecta o JDK 21 (target JDK — sempre e somente JDK 21).
 * Se um candidato for encontrado mas não for versão 21, é ignorado com aviso no status.
 */
async function detectJavaTarget(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Promise<DetectedTool> {
  const name = 'Java 21 (target)'
  const required = true

  const validate = async (
    home: string,
    source: string,
    status: ToolStatus,
  ): Promise<DetectedTool | null> => {
    const exe = resolveHomeToExe(home, 'bin/java')
    if (!exe) return null
    const version = await queryVersion(exe, ['-version'], /version "([^"]+)"/)
    if (!version) return null
    if (!isJdk21Version(version)) return null  // nunca aceitar versão != 21 como target
    return { name, source, path: home, version, status, required }
  }

  // 1. Override explícito do usuário
  for (const key of ['JAVA_HOME_21', 'JDK_21', 'JAVA_HOME']) {
    const override = overrides[key]
    if (override) {
      const result = await validate(override, `override usuário (${key})`, 'user_provided')
      if (result) return result
    }
  }

  // 2. Variáveis de ambiente dedicadas ao JDK 21
  for (const envVar of ['JAVA_HOME_21', 'JDK_21', 'JAVA_HOME']) {
    const home = env[envVar]
    if (home && existsSync(home)) {
      const result = await validate(home, envVar, 'found')
      if (result) return result
    }
  }

  // 3. Paths comuns de instaladores (Zulu, Temurin, Oracle, Microsoft)
  const commonPaths = [
    'C:\\Program Files\\Zulu\\zulu-21',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
    'C:\\Program Files\\Java\\jdk-21',
    'C:\\Program Files\\Microsoft\\jdk-21',
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/usr/lib/jvm/temurin-21',
    '/usr/lib/jvm/zulu-21',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home',
  ]
  for (const candidate of commonPaths) {
    if (!existsSync(candidate)) continue
    const result = await validate(candidate, candidate, 'found')
    if (result) return result
  }

  // 4. PATH — só aceita se for versão 21
  const javaInPath = findInPath('java', env)
  if (javaInPath) {
    const result = await validate(javaInPath, 'PATH', 'found')
    if (result) return result
  }

  return {
    name, source: '—', path: '—', version: null, status: 'not_found', required,
    missingMessage:
      'JDK 21 não encontrado. Informe o diretório de instalação do JDK 21 ' +
      'via toolOverrides com a chave "JAVA_HOME_21". ' +
      'Exemplo: { "JAVA_HOME_21": "C:\\\\Program Files\\\\Zulu\\\\zulu-21" }',
  }
}

// ─── ponto de entrada ─────────────────────────────────────────────────────────

/**
 * Detecta todas as ferramentas necessárias para a migração.
 *
 * @param overrides     Caminhos informados pelo usuário para substituir auto-detecção.
 *                      Chaves aceitas: SOURCE_JAVA_HOME, JAVA_HOME_8, JAVA_HOME_6,
 *                      JAVA_HOME_21, JDK_21, MAVEN_HOME, M2_HOME, GRADLE_HOME, GIT_EXEC_PATH.
 * @param sourceJdkMajor  Major version do JDK do projeto-alvo (6 ou 8).
 *                        Usado para buscar especificamente aquela versão na máquina.
 *                        Default: 8.
 */
export async function detectTools(
  overrides: Record<string, string> = {},
  sourceJdkMajor: 6 | 8 = 8,
): Promise<ToolDetectionResult> {
  const env = process.env

  const tools = await Promise.all([
    detectSourceJdk(env, overrides, sourceJdkMajor),
    detectJavaTarget(env, overrides),
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
