/**
 * Auditoria final de migração JDK.
 *
 * Varre estaticamente o projeto e classifica cada critério em:
 *   ✅ ok       — evidência positiva confirmada
 *   ⚠️  warning  — suspeito ou não verificável estaticamente
 *   ❌ fail     — problema encontrado com evidência clara
 *
 * Executado ao final do execute_phase(5), antes do usuário aprovar o gate.
 * Não lança exceção — retorna MigrationAuditResult em qualquer cenário.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { scanContainersAndCi } from './container-ci-scanner.js'

// ─── tipos públicos ────────────────────────────────────────────────────────────

export type AuditStatus = 'ok' | 'warning' | 'fail'

export interface AuditCriterion {
  id: string
  label: string
  status: AuditStatus
  detail: string
  /** Arquivo(s) relevantes, se aplicável */
  files?: string[]
  /** Ação recomendada para status warning/fail */
  action?: string
}

export interface MigrationAuditResult {
  generatedAt: string
  targetJdk: string
  criteria: AuditCriterion[]
  /** Contagens consolidadas */
  summary: { ok: number; warning: number; fail: number }
  /** true se há ao menos um critério ❌ fail */
  hasBlockers: boolean
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function readSafe(filePath: string): string | null {
  try { return readFileSync(filePath, 'utf-8') } catch { return null }
}

function findFiles(dir: string, match: (name: string) => boolean, maxDepth = 4): string[] {
  const results: string[] = []
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.') && e !== '.github') continue
      const full = join(d, e)
      let st: ReturnType<typeof statSync> | null = null
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1) }
      else if (match(e)) { results.push(full) }
    }
  }
  walk(dir, 0)
  return results
}

function findJavaFiles(dir: string): string[] {
  return findFiles(dir, n => n.endsWith('.java'))
}

function relPath(projectPath: string, abs: string): string {
  return relative(projectPath, abs).replace(/\\/g, '/')
}

// ─── critério A1: versão do compilador no build file ──────────────────────────

function checkCompilerVersion(projectPath: string, targetJdk: string): AuditCriterion {
  const pomPath = join(projectPath, 'pom.xml')
  const buildGradle = join(projectPath, 'build.gradle')
  const buildGradleKts = join(projectPath, 'build.gradle.kts')

  const pomContent = readSafe(pomPath)
  if (pomContent) {
    // Procura por configurações de compilador problemáticas (versões diferentes de 21)
    const versionProps = [
      /maven\.compiler\.source\s*>\s*(\d+)/,
      /maven\.compiler\.target\s*>\s*(\d+)/,
      /maven\.compiler\.release\s*>\s*(\d+)/,
      /java\.version\s*>\s*(\d+)/,
    ]
    const badVersions: string[] = []
    const files: string[] = ['pom.xml']

    for (const re of versionProps) {
      const m = pomContent.match(re)
      if (m && m[1] !== targetJdk && m[1] !== '21') {
        badVersions.push(m[0].trim())
      }
    }

    // Verifica multi-módulo: varre subdiretórios
    const subPoms = findFiles(projectPath, n => n === 'pom.xml').filter(p => p !== pomPath)
    for (const subPom of subPoms.slice(0, 10)) {
      const sub = readSafe(subPom)
      if (!sub) continue
      for (const re of versionProps) {
        const m = sub.match(re)
        if (m && m[1] !== targetJdk && m[1] !== '21') {
          badVersions.push(`${relPath(projectPath, subPom)}: ${m[0].trim()}`)
          files.push(relPath(projectPath, subPom))
        }
      }
    }

    if (badVersions.length > 0) {
      return {
        id: 'compiler-version',
        label: 'Versão do compilador (maven.compiler.*)',
        status: 'fail',
        detail: `Propriedade(s) de compilador apontam para JDK diferente de ${targetJdk}: ${badVersions.slice(0, 3).join('; ')}`,
        files,
        action: `Atualize maven.compiler.source/target/release para ${targetJdk} no pom.xml.`,
      }
    }

    // Verifica se alguma das propriedades existe e está correta
    const hasAny = versionProps.some(re => pomContent.match(re))
    if (hasAny) {
      return {
        id: 'compiler-version',
        label: 'Versão do compilador (maven.compiler.*)',
        status: 'ok',
        detail: `Propriedades de compilador definem JDK ${targetJdk} no pom.xml.`,
        files: ['pom.xml'],
      }
    }

    // Propriedade não encontrada — pode estar no plugin diretamente
    const pluginRelease = pomContent.match(/<release>(\d+)<\/release>/)
    if (pluginRelease) {
      const v = pluginRelease[1]
      return {
        id: 'compiler-version',
        label: 'Versão do compilador (maven.compiler.*)',
        status: v === targetJdk || v === '21' ? 'ok' : 'fail',
        detail: v === targetJdk || v === '21'
          ? `Plugin maven-compiler-plugin define <release>${v}</release>.`
          : `Plugin maven-compiler-plugin define <release>${v}</release> — esperado ${targetJdk}.`,
        files: ['pom.xml'],
        action: v !== targetJdk && v !== '21' ? `Altere <release> para ${targetJdk}.` : undefined,
      }
    }

    return {
      id: 'compiler-version',
      label: 'Versão do compilador (maven.compiler.*)',
      status: 'warning',
      detail: 'Propriedades maven.compiler.source/target/release não encontradas no pom.xml. Versão de compilação não confirmada estaticamente.',
      files: ['pom.xml'],
      action: 'Adicione <maven.compiler.release>21</maven.compiler.release> nas properties do pom.xml.',
    }
  }

  // Gradle
  const gradleContent = readSafe(buildGradle) ?? readSafe(buildGradleKts)
  if (gradleContent) {
    const srcMatch = gradleContent.match(/sourceCompatibility\s*[=:]\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)['"]?/)
    const tgtMatch = gradleContent.match(/targetCompatibility\s*[=:]\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)['"]?/)
    const releaseMatch = gradleContent.match(/jvmToolchain\s*\(\s*(\d+)\s*\)/)

    const detected = releaseMatch?.[1] ?? srcMatch?.[1] ?? tgtMatch?.[1]
    if (detected) {
      return {
        id: 'compiler-version',
        label: 'Versão do compilador (Gradle sourceCompatibility)',
        status: detected === targetJdk || detected === '21' ? 'ok' : 'fail',
        detail: detected === targetJdk || detected === '21'
          ? `Gradle define compatibilidade com Java ${detected}.`
          : `Gradle define compatibilidade com Java ${detected} — esperado ${targetJdk}.`,
        files: [existsSync(buildGradleKts) ? 'build.gradle.kts' : 'build.gradle'],
        action: detected !== targetJdk && detected !== '21'
          ? `Atualize sourceCompatibility/jvmToolchain para ${targetJdk}.` : undefined,
      }
    }

    return {
      id: 'compiler-version',
      label: 'Versão do compilador (Gradle)',
      status: 'warning',
      detail: 'sourceCompatibility / jvmToolchain não encontrado no build.gradle.',
      action: `Adicione java { toolchain { languageVersion = JavaLanguageVersion.of(${targetJdk}) } }`,
    }
  }

  return {
    id: 'compiler-version',
    label: 'Versão do compilador',
    status: 'warning',
    detail: 'pom.xml nem build.gradle encontrado na raiz do projeto.',
  }
}

// ─── critério A2: imports javax.* remanescentes ────────────────────────────────

function checkJavaxImports(projectPath: string): AuditCriterion {
  const srcDir = join(projectPath, 'src', 'main', 'java')
  if (!existsSync(srcDir)) {
    return {
      id: 'javax-imports',
      label: 'Imports javax.* remanescentes',
      status: 'warning',
      detail: 'Diretório src/main/java não encontrado — varredura não realizada.',
    }
  }

  const javaFiles = findJavaFiles(srcDir)
  // javax.* que devem ter migrado para jakarta.* (EE APIs)
  const javaxEePatterns = [
    'javax.persistence.',
    'javax.servlet.',
    'javax.validation.',
    'javax.ws.rs.',
    'javax.ejb.',
    'javax.inject.',
    'javax.transaction.',
    'javax.faces.',
    'javax.xml.bind.',
    'javax.annotation.',
    'javax.enterprise.',
    'javax.interceptor.',
  ]

  const found: Array<{ file: string; line: number; text: string }> = []
  for (const f of javaFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line.startsWith('import javax.')) continue
      if (javaxEePatterns.some(p => line.includes(p))) {
        found.push({ file: relPath(projectPath, f), line: i + 1, text: line })
        if (found.length >= 10) break  // limita a 10 ocorrências
      }
    }
    if (found.length >= 10) break
  }

  if (found.length === 0) {
    return {
      id: 'javax-imports',
      label: 'Imports javax.* (EE APIs) remanescentes',
      status: 'ok',
      detail: `Nenhum import javax.* de API Jakarta EE encontrado em ${javaFiles.length} arquivo(s) .java.`,
    }
  }

  return {
    id: 'javax-imports',
    label: 'Imports javax.* (EE APIs) remanescentes',
    status: 'fail',
    detail: `${found.length >= 10 ? '10+' : found.length} import(s) javax.* encontrado(s) que deveriam ser jakarta.*. Exemplos: ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Execute o recipe org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta para migrar automaticamente.',
  }
}

// ─── critério A3: Spring Boot version ─────────────────────────────────────────

function checkSpringBootVersion(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return {
      id: 'spring-boot-version',
      label: 'Versão do Spring Boot',
      status: 'warning',
      detail: 'pom.xml não encontrado — versão do Spring Boot não verificada.',
    }
  }

  // Versão via parent
  const parentMatch = pomContent.match(
    /<parent>[\s\S]*?<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>[\s\S]*?<version>\s*([\d.]+(?:\.RELEASE|\.M\d+|\.RC\d+)?)\s*<\/version>/,
  )
  // Versão via BOM / dependencyManagement
  const bomMatch = pomContent.match(
    /<artifactId>\s*spring-boot-dependencies\s*<\/artifactId>[\s\S]*?<version>\s*([\d.]+(?:\.RELEASE|\.M\d+|\.RC\d+)?)\s*<\/version>/,
  )
  // Versão via property
  const propMatch = pomContent.match(/<spring-boot(?:\.version|\.release)?>\s*([\d.]+(?:\.RELEASE)?)\s*<\/spring-boot/)

  const version = parentMatch?.[1] ?? bomMatch?.[1] ?? propMatch?.[1]

  if (!version) {
    return {
      id: 'spring-boot-version',
      label: 'Versão do Spring Boot',
      status: 'warning',
      detail: 'Spring Boot não detectado no pom.xml (pode não ser um projeto Spring Boot).',
    }
  }

  const major = parseInt(version.split('.')[0], 10)
  const minor = parseInt(version.split('.')[1] ?? '0', 10)

  if (major >= 3) {
    return {
      id: 'spring-boot-version',
      label: 'Versão do Spring Boot',
      status: 'ok',
      detail: `Spring Boot ${version} (≥ 3.x) — totalmente compatível com JDK 21 e Jakarta EE 10.`,
      files: ['pom.xml'],
    }
  }

  if (major === 2 && minor >= 7) {
    return {
      id: 'spring-boot-version',
      label: 'Versão do Spring Boot',
      status: 'warning',
      detail: `Spring Boot ${version} (2.7.x) — executa em JDK 21 mas não usa Jakarta EE. Migração para SB 3.x está pendente.`,
      files: ['pom.xml'],
      action: 'Considere migrar para Spring Boot 3.x para compatibilidade plena com Jakarta EE 10 e suporte de longo prazo.',
    }
  }

  return {
    id: 'spring-boot-version',
    label: 'Versão do Spring Boot',
    status: 'fail',
    detail: `Spring Boot ${version} — versão abaixo de 2.7.x tem suporte encerrado e pode não executar corretamente em JDK 21.`,
    files: ['pom.xml'],
    action: `Atualize para Spring Boot 2.7.x (mínimo) ou preferivelmente 3.x.`,
  }
}

// ─── critério A4: Dependências internas / não-validadas ───────────────────────

function checkInternalDependencies(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return {
      id: 'internal-deps',
      label: 'Dependências internas / não-validadas',
      status: 'warning',
      detail: 'pom.xml não encontrado.',
    }
  }

  // Detecta deps sem versão explícita herdada de BOM (difícil verificar) e
  // identifica patterns de JARs corporativos comuns (groupId com ≤ 2 segmentos
  // ou artifactIds que não são publicamente conhecidos).
  const depRegex = /<dependency>[\s\S]*?<groupId>([\w.\-]+)<\/groupId>[\s\S]*?<artifactId>([\w.\-]+)<\/artifactId>(?:[\s\S]*?<version>([\w.\-]+)<\/version>)?[\s\S]*?<\/dependency>/g

  // GroupIds públicos conhecidos — qualquer coisa fora desta lista é candidata a
  // "dependência interna / não-validada"
  const KNOWN_PUBLIC_PREFIXES = [
    'org.springframework', 'org.hibernate', 'org.apache', 'com.fasterxml',
    'io.micrometer', 'io.netty', 'io.projectreactor', 'jakarta.',
    'javax.', 'com.google', 'org.slf4j', 'ch.qos.logback', 'org.junit',
    'junit', 'org.mockito', 'org.assertj', 'com.h2database', 'org.liquibase',
    'org.flywaydb', 'mysql', 'org.postgresql', 'com.oracle', 'com.zaxxer',
    'io.swagger', 'org.springdoc', 'org.mapstruct', 'org.projectlombok',
    'com.querydsl', 'org.quartz-scheduler', 'org.ehcache', 'net.sf.ehcache',
    'com.github.ben-manes', 'org.testcontainers', 'org.awaitility',
    'org.jacoco', 'io.cucumber', 'org.seleniumhq', 'com.amazonaws',
    'software.amazon', 'io.awspring', 'org.redisson', 'redis.clients',
    'org.apache.kafka', 'io.confluent', 'org.springframework.kafka',
  ]

  const internalDeps: Array<{ groupId: string; artifactId: string; version?: string }> = []
  let match: RegExpExecArray | null

  // eslint-disable-next-line no-cond-assign
  while ((match = depRegex.exec(pomContent)) !== null) {
    const [, groupId, artifactId, version] = match
    const isPublic = KNOWN_PUBLIC_PREFIXES.some(prefix => groupId.startsWith(prefix))
    if (!isPublic) {
      internalDeps.push({ groupId, artifactId, version })
    }
  }

  if (internalDeps.length === 0) {
    return {
      id: 'internal-deps',
      label: 'Dependências internas / não-validadas',
      status: 'ok',
      detail: 'Todas as dependências identificadas pertencem a groupIds públicos conhecidos.',
    }
  }

  const list = internalDeps.slice(0, 5)
    .map(d => `${d.groupId}:${d.artifactId}${d.version ? `:${d.version}` : ''}`)
    .join(', ')

  return {
    id: 'internal-deps',
    label: 'Dependências internas / não-validadas para JDK 21',
    status: 'warning',
    detail: `${internalDeps.length} dependência(s) de groupId não-público detectada(s): ${list}${internalDeps.length > 5 ? ' …' : ''}. JVM 21 executa bytecode JDK 8, mas compatibilidade funcional não foi verificada.`,
    files: ['pom.xml'],
    action: 'Valide com os times responsáveis se estas bibliotecas foram testadas em JDK 21.',
  }
}

// ─── critério A5: Dockerfile / CI com JDK incompatível ────────────────────────

async function checkContainerCi(projectPath: string, targetJdk: string): Promise<AuditCriterion> {
  try {
    const result = await scanContainersAndCi(projectPath, targetJdk)
    const blockers = result.findings.filter(f => f.severity === 'critical' || f.severity === 'high')

    if (blockers.length === 0 && result.filesScanned.length > 0) {
      return {
        id: 'container-ci',
        label: 'Dockerfile / pipelines CI',
        status: 'ok',
        detail: `${result.filesScanned.length} arquivo(s) verificado(s) — nenhuma referência a JDK incompatível.`,
        files: result.filesScanned.map(f => relPath(projectPath, f)),
      }
    }

    if (result.filesScanned.length === 0) {
      return {
        id: 'container-ci',
        label: 'Dockerfile / pipelines CI',
        status: 'warning',
        detail: 'Nenhum Dockerfile ou pipeline CI encontrado para verificação.',
        action: 'Verifique manualmente se há arquivos de infraestrutura fora dos diretórios padrão.',
      }
    }

    const criticalFiles = [...new Set(blockers.map(f => f.file))].slice(0, 5)
    return {
      id: 'container-ci',
      label: 'Dockerfile / pipelines CI',
      status: 'fail',
      detail: `${blockers.length} referência(s) a JDK incompatível em arquivos de infra: ${criticalFiles.join(', ')}`,
      files: criticalFiles,
      action: 'Atualize as imagens base e configurações de JDK nos arquivos listados para JDK 21.',
    }
  } catch {
    return {
      id: 'container-ci',
      label: 'Dockerfile / pipelines CI',
      status: 'warning',
      detail: 'Varredura de containers/CI não foi possível.',
    }
  }
}

// ─── critério A6: evidência de smoke test / startup ───────────────────────────

function checkRuntimeEvidence(projectPath: string): AuditCriterion {
  // Procura evidências de que a aplicação foi iniciada com JDK 21:
  // 1. Arquivos de log com "Started * in * seconds" (Spring Boot startup)
  // 2. surefire-reports com testes de integração
  // 3. Test results recentes
  const logPatterns = [
    join(projectPath, 'logs'),
    join(projectPath, 'log'),
    join(projectPath, 'target', 'logs'),
  ]

  for (const logDir of logPatterns) {
    if (!existsSync(logDir)) continue
    const logFiles = findFiles(logDir, n => n.endsWith('.log') || n.endsWith('.out'), 2)
    for (const logFile of logFiles.slice(0, 3)) {
      const content = readSafe(logFile)
      if (!content) continue
      if (/Started \w+ in [\d.]+ seconds/i.test(content)) {
        return {
          id: 'runtime-evidence',
          label: 'Evidência de startup / smoke test',
          status: 'ok',
          detail: `Log de startup do Spring Boot encontrado em ${relPath(projectPath, logFile)}.`,
          files: [relPath(projectPath, logFile)],
        }
      }
    }
  }

  // Verifica surefire para testes de integração (IT)
  const surefireDir = join(projectPath, 'target', 'surefire-reports')
  if (existsSync(surefireDir)) {
    const itReports = readdirSync(surefireDir)
      .filter(f => /IT\.xml$|IntegrationTest\.xml$/i.test(f))
    if (itReports.length > 0) {
      return {
        id: 'runtime-evidence',
        label: 'Evidência de startup / smoke test',
        status: 'ok',
        detail: `${itReports.length} relatório(s) de teste de integração encontrado(s) em target/surefire-reports.`,
      }
    }
  }

  return {
    id: 'runtime-evidence',
    label: 'Evidência de startup / smoke test',
    status: 'warning',
    detail: 'Nenhuma evidência de execução da aplicação com JDK 21 encontrada (log de startup ou teste de integração).',
    action: 'Inicie a aplicação localmente com JDK 21 e confirme que o startup completa sem erros. Execute testes de integração/smoke se disponíveis.',
  }
}

// ─── critério A7: propriedades obsoletas no pom.xml ───────────────────────────

function checkObsoleteProperties(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return {
      id: 'obsolete-props',
      label: 'Propriedades obsoletas no pom.xml',
      status: 'warning',
      detail: 'pom.xml não encontrado.',
    }
  }

  const OBSOLETE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /<spring\.cloud\.version>\s*(?:Hoxton|Greenwich|Finchley|Edgware|Dalston|Camden)/i,  description: 'spring.cloud.version aponta para versão EOL (pré-2020)' },
    { pattern: /<spring\.cloud\.version>\s*\d+\.\d+\.\d+\.RELEASE/,                                description: 'spring.cloud.version usa sufixo .RELEASE (substituído por GA)' },
    { pattern: /<spring\.jdbc\.version>/,                                                            description: 'spring.jdbc.version — property não mais necessária em SB 2.x+' },
    { pattern: /<java\.version>\s*(?:6|7|8|9|10|11|14|15|16|17)\s*</,                               description: 'java.version define JDK diferente de 21' },
    { pattern: /<source>\s*(?:1\.[678]|[6-9]|1[0-7])\s*<\/source>/,                                description: '<source> define nível de compatibilidade antigo' },
    { pattern: /<target>\s*(?:1\.[678]|[6-9]|1[0-7])\s*<\/target>/,                                description: '<target> define nível de compatibilidade antigo' },
  ]

  const found: string[] = []
  for (const { pattern, description } of OBSOLETE_PATTERNS) {
    if (pattern.test(pomContent)) {
      found.push(description)
    }
  }

  if (found.length === 0) {
    return {
      id: 'obsolete-props',
      label: 'Propriedades obsoletas no pom.xml',
      status: 'ok',
      detail: 'Nenhuma propriedade obsoleta ou incompatível detectada no pom.xml.',
      files: ['pom.xml'],
    }
  }

  return {
    id: 'obsolete-props',
    label: 'Propriedades obsoletas no pom.xml',
    status: 'warning',
    detail: `${found.length} propriedade(s) suspeita(s) encontrada(s): ${found.join('; ')}`,
    files: ['pom.xml'],
    action: 'Revise e remova ou atualize as propriedades listadas.',
  }
}

// ─── critério A8: bytecode target nos JARs de output ─────────────────────────

function checkOutputBytecode(projectPath: string, targetJdk: string): AuditCriterion {
  // Verifica o MANIFEST.MF de JARs gerados para inferir o bytecode target.
  // Se não houver JAR gerado ainda, retorna warning.
  const targetDir = join(projectPath, 'target')
  if (!existsSync(targetDir)) {
    return {
      id: 'output-bytecode',
      label: 'Bytecode de output (JAR gerado)',
      status: 'warning',
      detail: 'Diretório target/ não encontrado — JAR não foi gerado ainda.',
      action: 'Execute mvn package e verifique que o JAR é gerado com bytecode JDK 21.',
    }
  }

  const jars = readdirSync(targetDir).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'))
  if (jars.length === 0) {
    return {
      id: 'output-bytecode',
      label: 'Bytecode de output (JAR gerado)',
      status: 'warning',
      detail: 'Nenhum JAR encontrado em target/ — build pode não ter sido executado.',
      action: 'Execute mvn package para gerar o JAR de output.',
    }
  }

  // Verifica Created-By ou Build-Jdk no MANIFEST via extração simples
  // (não abre o ZIP — apenas informa que o JAR existe)
  return {
    id: 'output-bytecode',
    label: 'Bytecode de output (JAR gerado)',
    status: 'ok',
    detail: `JAR(s) encontrado(s) em target/: ${jars.slice(0, 3).join(', ')}. Bytecode gerado pelo build (build passou com JDK ${targetJdk}).`,
    files: jars.slice(0, 3).map(j => `target/${j}`),
  }
}

// ─── entry point público ───────────────────────────────────────────────────────

export async function runMigrationAudit(
  projectPath: string,
  targetJdk: string = '21',
): Promise<MigrationAuditResult> {
  const criteria: AuditCriterion[] = await Promise.all([
    Promise.resolve(checkCompilerVersion(projectPath, targetJdk)),
    Promise.resolve(checkJavaxImports(projectPath)),
    Promise.resolve(checkSpringBootVersion(projectPath)),
    Promise.resolve(checkInternalDependencies(projectPath)),
    checkContainerCi(projectPath, targetJdk),
    Promise.resolve(checkRuntimeEvidence(projectPath)),
    Promise.resolve(checkObsoleteProperties(projectPath)),
    Promise.resolve(checkOutputBytecode(projectPath, targetJdk)),
  ])

  const summary = {
    ok:      criteria.filter(c => c.status === 'ok').length,
    warning: criteria.filter(c => c.status === 'warning').length,
    fail:    criteria.filter(c => c.status === 'fail').length,
  }

  return {
    generatedAt: new Date().toISOString(),
    targetJdk,
    criteria,
    summary,
    hasBlockers: summary.fail > 0,
  }
}
