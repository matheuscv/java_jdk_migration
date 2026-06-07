/**
 * Auditoria final de migração JDK — 25 critérios (A1-A8, C1-C12, D1-D5).
 *
 * Classifica cada critério em:
 *   ✅ ok       — evidência positiva confirmada
 *   ⚠️  warning  — suspeito ou não verificável estaticamente
 *   ❌ fail     — problema encontrado com evidência clara
 *
 * allOk: true  → todos os 25 critérios ok  → banner verde AUDITORIA APROVADA
 * allOk: false → qualquer warning ou fail  → banner vermelho ISSUES DETECTADOS
 *
 * Executado ao final do execute_phase(5), antes do usuário aprovar o gate.
 * Não lança exceção — retorna MigrationAuditResult em qualquer cenário.
 *
 * Grupos de critérios:
 *   A1–A8   — critérios originais (build, javax, Spring Boot, CI, runtime, artefatos)
 *   C1–C12  — critérios avançados (bytecode real, internos JDK, flags, processadores)
 *   D1–D5   — critérios de fechamento (APIs removidas JDK9-21, bytecode-manipulation libs, plugins Maven, k8s/Helm)
 *
 * Cobertura de fontes: src/main/java + src/test/java (todos os critérios que varrem .java)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { scanContainersAndCi } from './container-ci-scanner.js'

// ─── tipos públicos ────────────────────────────────────────────────────────────

export type AuditStatus = 'ok' | 'warning' | 'fail'

export interface AuditCriterion {
  id: string
  label: string
  status: AuditStatus
  detail: string
  files?: string[]
  action?: string
}

export interface MigrationAuditResult {
  generatedAt: string
  targetJdk: string
  criteria: AuditCriterion[]
  summary: { ok: number; warning: number; fail: number }
  /** true se há ao menos um critério ❌ fail */
  hasBlockers: boolean
  /** true se TODOS os critérios são ✅ ok — AUDITORIA APROVADA */
  allOk: boolean
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function readSafe(filePath: string): string | null {
  try { return readFileSync(filePath, 'utf-8') } catch { return null }
}

function readBufSafe(filePath: string): Buffer | null {
  try { return readFileSync(filePath) } catch { return null }
}

function findFiles(dir: string, match: (name: string) => boolean, maxDepth = 4): string[] {
  const results: string[] = []
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      if (e.startsWith('.') && e !== '.github' && e !== '.mvn') continue
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

/** Retorna .java de um único diretório (recursivo). */
function findJavaFiles(dir: string): string[] {
  return findFiles(dir, n => n.endsWith('.java'))
}

/**
 * Retorna .java varrendo src/main/java + src/test/java do projeto.
 * Usado nos critérios que precisam de cobertura total (main + testes).
 */
function findAllJavaFiles(projectPath: string): string[] {
  const mainDir = join(projectPath, 'src', 'main', 'java')
  const testDir = join(projectPath, 'src', 'test', 'java')
  return [
    ...(existsSync(mainDir) ? findJavaFiles(mainDir) : []),
    ...(existsSync(testDir) ? findJavaFiles(testDir) : []),
  ]
}

function relPath(projectPath: string, abs: string): string {
  return relative(projectPath, abs).replace(/\\/g, '/')
}

/** Lê MANIFEST.MF de dentro de um JAR (ZIP) sem dependências externas. */
function readManifestFromJar(jarPath: string): string | null {
  try {
    const buf = readBufSafe(jarPath)
    if (!buf || buf.length < 22) return null

    // Localiza End of Central Directory (EOCD): assinatura 0x06054b50
    let eocdPos = -1
    const searchStart = Math.max(0, buf.length - 65536 - 22)
    for (let i = buf.length - 22; i >= searchStart; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break }
    }
    if (eocdPos < 0) return null

    const cdEntries = buf.readUInt16LE(eocdPos + 8)
    const cdOffset  = buf.readUInt32LE(eocdPos + 16)

    // Percorre o diretório central
    let pos = cdOffset
    for (let i = 0; i < cdEntries && pos + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) break  // assinatura entrada central

      const compMethod  = buf.readUInt16LE(pos + 10)
      const compSize    = buf.readUInt32LE(pos + 20)
      const fnLen       = buf.readUInt16LE(pos + 28)
      const extraLen    = buf.readUInt16LE(pos + 30)
      const commentLen  = buf.readUInt16LE(pos + 32)
      const localOffset = buf.readUInt32LE(pos + 42)

      const nameEnd = pos + 46 + fnLen
      if (nameEnd > buf.length) break
      const name = buf.subarray(pos + 46, nameEnd).toString('utf-8')

      if (name === 'META-INF/MANIFEST.MF') {
        if (localOffset + 30 > buf.length) return null
        const localFnLen    = buf.readUInt16LE(localOffset + 26)
        const localExtraLen = buf.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localFnLen + localExtraLen
        if (dataStart + compSize > buf.length) return null
        const compData = buf.subarray(dataStart, dataStart + compSize)
        if (compMethod === 0) return compData.toString('utf-8')           // stored
        if (compMethod === 8) return inflateRawSync(compData).toString('utf-8')  // deflated
        return null
      }

      pos += 46 + fnLen + extraLen + commentLen
    }
    return null
  } catch { return null }
}

/** Lê a versão major do bytecode de um arquivo .class (primeiros 8 bytes). */
function readClassMajorVersion(classPath: string): number | null {
  try {
    const buf = readBufSafe(classPath)
    if (!buf || buf.length < 8) return null
    // Magic: CA FE BA BE
    if (buf[0] !== 0xCA || buf[1] !== 0xFE || buf[2] !== 0xBA || buf[3] !== 0xBE) return null
    return buf.readUInt16BE(6)  // major version em big-endian
  } catch { return null }
}

/** major version → JDK version string */
function majorToJdk(major: number): string {
  if (major < 45) return `<JDK 1 (major ${major})`
  if (major <= 48) return `JDK ${major - 44}`  // 45=1, 48=4
  return `JDK ${major - 44}`  // 49=5, 52=8, 55=11, 61=17, 65=21
}

// ─── A1 — versão do compilador ────────────────────────────────────────────────

function checkCompilerVersion(projectPath: string, targetJdk: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (pomContent) {
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
      if (m && m[1] !== targetJdk && m[1] !== '21') badVersions.push(m[0].trim())
    }
    const subPoms = findFiles(projectPath, n => n === 'pom.xml')
      .filter(p => p !== join(projectPath, 'pom.xml'))
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
      return { id: 'compiler-version', label: 'Versão do compilador (maven.compiler.*)', status: 'fail',
        detail: `Propriedade(s) apontam para JDK diferente de ${targetJdk}: ${badVersions.slice(0, 3).join('; ')}`,
        files, action: `Atualize maven.compiler.source/target/release para ${targetJdk}.` }
    }
    const hasAny = versionProps.some(re => pomContent.match(re))
    if (hasAny) {
      return { id: 'compiler-version', label: 'Versão do compilador (maven.compiler.*)', status: 'ok',
        detail: `Propriedades de compilador definem JDK ${targetJdk}.`, files: ['pom.xml'] }
    }
    const pluginRelease = pomContent.match(/<release>(\d+)<\/release>/)
    if (pluginRelease) {
      const v = pluginRelease[1]
      const ok = v === targetJdk || v === '21'
      return { id: 'compiler-version', label: 'Versão do compilador (maven-compiler-plugin)',
        status: ok ? 'ok' : 'fail',
        detail: ok ? `Plugin maven-compiler-plugin define <release>${v}</release>.`
          : `Plugin define <release>${v}</release> — esperado ${targetJdk}.`,
        files: ['pom.xml'], action: ok ? undefined : `Altere <release> para ${targetJdk}.` }
    }
    return { id: 'compiler-version', label: 'Versão do compilador (maven.compiler.*)', status: 'warning',
      detail: 'Propriedades maven.compiler.* não encontradas — versão de compilação não confirmada.',
      files: ['pom.xml'], action: `Adicione <maven.compiler.release>${targetJdk}</maven.compiler.release> nas properties.` }
  }
  const gradleContent = readSafe(join(projectPath, 'build.gradle')) ?? readSafe(join(projectPath, 'build.gradle.kts'))
  if (gradleContent) {
    const detected = (gradleContent.match(/jvmToolchain\s*\(\s*(\d+)\s*\)/)
      ?? gradleContent.match(/sourceCompatibility\s*[=:]\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/))?.[1]
    if (detected) {
      const ok = detected === targetJdk || detected === '21'
      return { id: 'compiler-version', label: 'Versão do compilador (Gradle)', status: ok ? 'ok' : 'fail',
        detail: ok ? `Gradle define Java ${detected}.` : `Gradle define Java ${detected} — esperado ${targetJdk}.`,
        action: ok ? undefined : `Atualize sourceCompatibility/jvmToolchain para ${targetJdk}.` }
    }
  }
  return { id: 'compiler-version', label: 'Versão do compilador', status: 'warning',
    detail: 'Build file não encontrado ou versão não detectada.' }
}

// ─── A2 — imports javax.* (EE APIs) ──────────────────────────────────────────

function checkJavaxImports(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'javax-imports', label: 'Imports javax.* (EE APIs) remanescentes', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  // Inclui as 4 famílias removidas no JDK 11 (JEP 320):
  //   javax.xml.soap (SAAJ), javax.xml.ws (JAX-WS), javax.jws (anotações JAX-WS),
  //   javax.activation (JAF / DataHandler) — comuns em integrações SOAP legadas JDK 8
  const javaxEePatterns = [
    'javax.persistence.', 'javax.servlet.', 'javax.validation.',
    'javax.ws.rs.', 'javax.ejb.', 'javax.inject.', 'javax.transaction.',
    'javax.faces.', 'javax.xml.bind.', 'javax.annotation.', 'javax.enterprise.',
    'javax.interceptor.',
    // removidas no JDK 11 (JEP 320) — frequentes em apps SOAP/web-services legados
    'javax.xml.soap.', 'javax.xml.ws.', 'javax.jws.', 'javax.activation.',
  ]
  const found: { file: string; line: number }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line.startsWith('import javax.')) continue
      if (javaxEePatterns.some(p => line.includes(p))) {
        found.push({ file: relPath(projectPath, f), line: i + 1 })
        if (found.length >= 10) break
      }
    }
    if (found.length >= 10) break
  }
  if (found.length === 0) {
    return { id: 'javax-imports', label: 'Imports javax.* (EE APIs) remanescentes', status: 'ok',
      detail: 'Nenhum import javax.* de API Jakarta EE encontrado.' }
  }
  return { id: 'javax-imports', label: 'Imports javax.* (EE APIs) remanescentes', status: 'fail',
    detail: `${found.length >= 10 ? '10+' : found.length} import(s) encontrado(s): ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Execute o recipe org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta.' }
}

// ─── A3 — Spring Boot version ──────────────────────────────────────────────────

function checkSpringBootVersion(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return { id: 'spring-boot-version', label: 'Versão do Spring Boot', status: 'warning',
      detail: 'pom.xml não encontrado.' }
  }
  const version = (pomContent.match(/<parent>[\s\S]*?<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>[\s\S]*?<version>\s*([\d.]+[^<]*)\s*<\/version>/)
    ?? pomContent.match(/<artifactId>\s*spring-boot-dependencies\s*<\/artifactId>[\s\S]*?<version>\s*([\d.]+[^<]*)\s*<\/version>/)
    ?? pomContent.match(/<spring-boot[^>]*>\s*([\d.]+[^<]*)\s*<\/spring-boot/))?.[1]
  if (!version) {
    return { id: 'spring-boot-version', label: 'Versão do Spring Boot', status: 'warning',
      detail: 'Spring Boot não detectado no pom.xml.' }
  }
  const major = parseInt(version.split('.')[0], 10)
  const minor = parseInt(version.split('.')[1] ?? '0', 10)
  if (major >= 3) {
    return { id: 'spring-boot-version', label: 'Versão do Spring Boot', status: 'ok',
      detail: `Spring Boot ${version} (≥ 3.x) — totalmente compatível com JDK 21 e Jakarta EE 10.`, files: ['pom.xml'] }
  }
  if (major === 2 && minor >= 7) {
    return { id: 'spring-boot-version', label: 'Versão do Spring Boot', status: 'warning',
      detail: `Spring Boot ${version} (2.7.x) — executa em JDK 21 mas não usa Jakarta EE. Migração para SB 3.x pendente.`,
      files: ['pom.xml'], action: 'Considere migrar para Spring Boot 3.x para compatibilidade plena.' }
  }
  return { id: 'spring-boot-version', label: 'Versão do Spring Boot', status: 'fail',
    detail: `Spring Boot ${version} — abaixo de 2.7.x, suporte encerrado, pode não executar em JDK 21.`,
    files: ['pom.xml'], action: 'Atualize para Spring Boot 2.7.x (mínimo) ou 3.x.' }
}

// ─── A4 — dependências internas ───────────────────────────────────────────────

function checkInternalDependencies(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return { id: 'internal-deps', label: 'Dependências internas / não-validadas', status: 'warning',
      detail: 'pom.xml não encontrado.' }
  }
  const KNOWN_PUBLIC = ['org.springframework', 'org.hibernate', 'org.apache', 'com.fasterxml',
    'io.micrometer', 'io.netty', 'io.projectreactor', 'jakarta.', 'javax.', 'com.google',
    'org.slf4j', 'ch.qos.logback', 'org.junit', 'junit', 'org.mockito', 'org.assertj',
    'com.h2database', 'org.liquibase', 'org.flywaydb', 'mysql', 'org.postgresql',
    'com.oracle', 'com.zaxxer', 'io.swagger', 'org.springdoc', 'org.mapstruct',
    'org.projectlombok', 'com.querydsl', 'org.quartz-scheduler', 'org.ehcache',
    'net.sf.ehcache', 'com.github.ben-manes', 'org.testcontainers', 'org.awaitility',
    'org.jacoco', 'io.cucumber', 'org.seleniumhq', 'com.amazonaws', 'software.amazon',
    'io.awspring', 'org.redisson', 'redis.clients', 'org.apache.kafka', 'io.confluent',
    'org.springframework.kafka']
  const depRegex = /<dependency>[\s\S]*?<groupId>([\w.\-]+)<\/groupId>[\s\S]*?<artifactId>([\w.\-]+)<\/artifactId>(?:[\s\S]*?<version>([\w.\-]+)<\/version>)?[\s\S]*?<\/dependency>/g
  const internal: Array<{ groupId: string; artifactId: string; version?: string }> = []
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = depRegex.exec(pomContent)) !== null) {
    const [, groupId, artifactId, version] = m
    if (!KNOWN_PUBLIC.some(p => groupId.startsWith(p))) internal.push({ groupId, artifactId, version })
  }
  if (internal.length === 0) {
    return { id: 'internal-deps', label: 'Dependências internas / não-validadas', status: 'ok',
      detail: 'Todas as dependências pertencem a groupIds públicos conhecidos.' }
  }
  const list = internal.slice(0, 5).map(d => `${d.groupId}:${d.artifactId}${d.version ? `:${d.version}` : ''}`).join(', ')
  return { id: 'internal-deps', label: 'Dependências internas / não-validadas para JDK 21', status: 'warning',
    detail: `${internal.length} dependência(s) de groupId não-público: ${list}${internal.length > 5 ? ' …' : ''}. JVM 21 executa bytecode JDK 8, mas compatibilidade funcional não verificada.`,
    files: ['pom.xml'], action: 'Valide com os times responsáveis se estas libs foram testadas em JDK 21.' }
}

// ─── A5 — Dockerfile / CI ────────────────────────────────────────────────────

async function checkContainerCi(projectPath: string, targetJdk: string): Promise<AuditCriterion> {
  try {
    const result = await scanContainersAndCi(projectPath, targetJdk)
    const blockers = result.findings.filter(f => f.severity === 'critical' || f.severity === 'high')
    if (blockers.length === 0 && result.filesScanned.length > 0) {
      return { id: 'container-ci', label: 'Dockerfile / pipelines CI', status: 'ok',
        detail: `${result.filesScanned.length} arquivo(s) verificado(s) — nenhuma referência a JDK incompatível.`,
        files: result.filesScanned.map(f => relPath(projectPath, f)) }
    }
    if (result.filesScanned.length === 0) {
      return { id: 'container-ci', label: 'Dockerfile / pipelines CI', status: 'warning',
        detail: 'Nenhum Dockerfile ou pipeline CI encontrado.',
        action: 'Verifique manualmente arquivos de infraestrutura fora dos diretórios padrão.' }
    }
    const criticalFiles = [...new Set(blockers.map(f => f.file))].slice(0, 5)
    return { id: 'container-ci', label: 'Dockerfile / pipelines CI', status: 'fail',
      detail: `${blockers.length} referência(s) a JDK incompatível: ${criticalFiles.join(', ')}`,
      files: criticalFiles, action: 'Atualize as imagens base e configurações de JDK para JDK 21.' }
  } catch {
    return { id: 'container-ci', label: 'Dockerfile / pipelines CI', status: 'warning',
      detail: 'Varredura de containers/CI não foi possível.' }
  }
}

// ─── A6 — evidência de runtime ────────────────────────────────────────────────

function checkRuntimeEvidence(projectPath: string): AuditCriterion {
  for (const logDir of [join(projectPath, 'logs'), join(projectPath, 'log'), join(projectPath, 'target', 'logs')]) {
    if (!existsSync(logDir)) continue
    for (const logFile of findFiles(logDir, n => n.endsWith('.log') || n.endsWith('.out'), 2).slice(0, 3)) {
      const content = readSafe(logFile)
      if (content && /Started \w+ in [\d.]+ seconds/i.test(content)) {
        return { id: 'runtime-evidence', label: 'Evidência de startup / smoke test', status: 'ok',
          detail: `Log de startup encontrado em ${relPath(projectPath, logFile)}.`,
          files: [relPath(projectPath, logFile)] }
      }
    }
  }
  const surefireDir = join(projectPath, 'target', 'surefire-reports')
  if (existsSync(surefireDir)) {
    const itReports = readdirSync(surefireDir).filter(f => /IT\.xml$|IntegrationTest\.xml$/i.test(f))
    if (itReports.length > 0) {
      return { id: 'runtime-evidence', label: 'Evidência de startup / smoke test', status: 'ok',
        detail: `${itReports.length} relatório(s) de teste de integração em target/surefire-reports.` }
    }
  }
  return { id: 'runtime-evidence', label: 'Evidência de startup / smoke test', status: 'warning',
    detail: 'Nenhuma evidência de execução da aplicação com JDK 21 encontrada.',
    action: 'Inicie a aplicação com JDK 21 e confirme que o startup completa sem erros.' }
}

// ─── A7 — propriedades obsoletas ─────────────────────────────────────────────

function checkObsoleteProperties(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return { id: 'obsolete-props', label: 'Propriedades obsoletas no pom.xml', status: 'warning',
      detail: 'pom.xml não encontrado.' }
  }
  const OBSOLETE: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /<spring\.cloud\.version>\s*(?:Hoxton|Greenwich|Finchley|Edgware|Dalston|Camden)/i,
      description: 'spring.cloud.version aponta para release EOL (pré-2020)' },
    { pattern: /<spring\.cloud\.version>\s*\d+\.\d+\.\d+\.RELEASE/,
      description: 'spring.cloud.version usa sufixo .RELEASE (substituído por GA)' },
    { pattern: /<spring\.jdbc\.version>/,
      description: 'spring.jdbc.version — property não mais necessária em SB 2.x+' },
    { pattern: /<java\.version>\s*(?:6|7|8|9|10|11|14|15|16|17)\s*</,
      description: 'java.version define JDK diferente de 21' },
    { pattern: /<source>\s*(?:1\.[678]|[6-9]|1[0-7])\s*<\/source>/,
      description: '<source> define nível de compatibilidade antigo' },
    { pattern: /<target>\s*(?:1\.[678]|[6-9]|1[0-7])\s*<\/target>/,
      description: '<target> define nível de compatibilidade antigo' },
  ]
  const found = OBSOLETE.filter(o => o.pattern.test(pomContent)).map(o => o.description)
  if (found.length === 0) {
    return { id: 'obsolete-props', label: 'Propriedades obsoletas no pom.xml', status: 'ok',
      detail: 'Nenhuma propriedade obsoleta detectada.', files: ['pom.xml'] }
  }
  return { id: 'obsolete-props', label: 'Propriedades obsoletas no pom.xml', status: 'warning',
    detail: `${found.length} propriedade(s) suspeita(s): ${found.join('; ')}`,
    files: ['pom.xml'], action: 'Revise e remova ou atualize as propriedades listadas.' }
}

// ─── A8 — bytecode do JAR de output (MANIFEST.MF) ────────────────────────────

function checkOutputBytecode(projectPath: string, targetJdk: string): AuditCriterion {
  const targetDir = join(projectPath, 'target')
  if (!existsSync(targetDir)) {
    return { id: 'output-bytecode', label: 'JAR de output — Build-Jdk no MANIFEST.MF', status: 'warning',
      detail: 'Diretório target/ não encontrado — JAR não foi gerado.',
      action: 'Execute mvn package e verifique o JAR.' }
  }
  const jars = readdirSync(targetDir)
    .filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'))
  if (jars.length === 0) {
    return { id: 'output-bytecode', label: 'JAR de output — Build-Jdk no MANIFEST.MF', status: 'warning',
      detail: 'Nenhum JAR em target/ — build pode não ter sido executado.',
      action: 'Execute mvn package.' }
  }
  // Tenta ler MANIFEST.MF de dentro do primeiro JAR
  const jarPath = join(targetDir, jars[0])
  const manifest = readManifestFromJar(jarPath)
  if (manifest) {
    const buildJdk = manifest.match(/Build-Jdk(?:-Spec)?:\s*([\d.]+)/i)?.[1]
    const createdBy = manifest.match(/Created-By:\s*(.+)/i)?.[1]?.trim()
    if (buildJdk) {
      const majorDetected = parseInt(buildJdk.split('.')[0], 10)
      const targetMajor = parseInt(targetJdk, 10)
      const ok = majorDetected === targetMajor || buildJdk === targetJdk
      return { id: 'output-bytecode', label: 'JAR de output — Build-Jdk no MANIFEST.MF',
        status: ok ? 'ok' : 'fail',
        detail: ok
          ? `MANIFEST.MF confirma Build-Jdk: ${buildJdk} em ${jars[0]}.`
          : `MANIFEST.MF indica Build-Jdk: ${buildJdk} — esperado JDK ${targetJdk}. O JAR pode não ter sido recompilado.`,
        files: [`target/${jars[0]}`],
        action: ok ? undefined : `Recompile com JDK ${targetJdk}: mvn clean package.` }
    }
    if (createdBy) {
      return { id: 'output-bytecode', label: 'JAR de output — Build-Jdk no MANIFEST.MF', status: 'warning',
        detail: `MANIFEST.MF presente em ${jars[0]} mas sem atributo Build-Jdk. Created-By: ${createdBy}.`,
        files: [`target/${jars[0]}`] }
    }
  }
  return { id: 'output-bytecode', label: 'JAR de output — Build-Jdk no MANIFEST.MF', status: 'warning',
    detail: `JAR encontrado (${jars[0]}) mas MANIFEST.MF não pôde ser lido — bytecode não confirmado.`,
    files: [`target/${jars[0]}`], action: 'Verifique manualmente: jar tf target/' + jars[0] + ' META-INF/MANIFEST.MF' }
}

// ─── C1 — versão real do bytecode nas .class files ───────────────────────────

function checkActualBytecodeVersion(projectPath: string, targetJdk: string): AuditCriterion {
  const classesDir = join(projectPath, 'target', 'classes')
  if (!existsSync(classesDir)) {
    // Tenta multi-módulo
    const subDirs = existsSync(join(projectPath, 'target'))
      ? [] : findFiles(projectPath, n => n === 'classes', 3).filter(p => p.includes('target'))
    if (subDirs.length === 0) {
      return { id: 'actual-bytecode', label: 'Versão real do bytecode (.class files)', status: 'warning',
        detail: 'target/classes não encontrado — classes não compiladas.',
        action: 'Execute mvn compile para gerar as classes.' }
    }
  }

  const targetMajor = parseInt(targetJdk, 10) + 44  // JDK 21 → major 65
  const classFiles = findFiles(classesDir, n => n.endsWith('.class'), 6)

  if (classFiles.length === 0) {
    return { id: 'actual-bytecode', label: 'Versão real do bytecode (.class files)', status: 'warning',
      detail: 'Nenhum arquivo .class encontrado em target/classes.',
      action: 'Execute mvn compile.' }
  }

  const checked: Array<{ file: string; major: number }> = []
  const wrong: Array<{ file: string; major: number }> = []

  // Verifica amostra (primeiros 50 + últimos 10 para multi-módulo)
  const sample = classFiles.length > 60
    ? [...classFiles.slice(0, 50), ...classFiles.slice(-10)]
    : classFiles

  for (const cf of sample) {
    const major = readClassMajorVersion(cf)
    if (major === null) continue
    checked.push({ file: relPath(projectPath, cf), major })
    if (major !== targetMajor) wrong.push({ file: relPath(projectPath, cf), major })
  }

  if (checked.length === 0) {
    return { id: 'actual-bytecode', label: 'Versão real do bytecode (.class files)', status: 'warning',
      detail: 'Não foi possível ler a versão do bytecode dos arquivos .class.' }
  }

  if (wrong.length === 0) {
    return { id: 'actual-bytecode', label: 'Versão real do bytecode (.class files)', status: 'ok',
      detail: `${checked.length} arquivo(s) .class verificado(s) — todos com bytecode JDK ${targetJdk} (major ${targetMajor}).` }
  }

  const examples = wrong.slice(0, 3).map(w => `${w.file} (${majorToJdk(w.major)})`)
  return { id: 'actual-bytecode', label: 'Versão real do bytecode (.class files)', status: 'fail',
    detail: `${wrong.length} arquivo(s) com bytecode de versão diferente de JDK ${targetJdk}: ${examples.join(', ')}`,
    files: wrong.slice(0, 3).map(w => w.file),
    action: `Execute mvn clean compile com JDK ${targetJdk} para recompilar todos os módulos.` }
}

// ─── C2 — imports sun.* / com.sun.* internos ─────────────────────────────────

function checkSunInternalImports(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'sun-internal-imports', label: 'Imports de API interna sun.* / com.sun.*', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  // Exclusões legítimas: com.sun.mail (Jakarta Mail), com.sun.xml.bind (JAXB RI)
  const ALLOWED_PREFIXES = ['com.sun.mail.', 'com.sun.xml.bind.', 'com.sun.xml.messaging.']
  const found: { file: string; line: number; text: string }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line.startsWith('import sun.') && !line.startsWith('import com.sun.')) continue
      if (ALLOWED_PREFIXES.some(p => line.includes(p))) continue
      found.push({ file: relPath(projectPath, f), line: i + 1, text: line })
      if (found.length >= 10) break
    }
    if (found.length >= 10) break
  }
  if (found.length === 0) {
    return { id: 'sun-internal-imports', label: 'Imports de API interna sun.* / com.sun.*', status: 'ok',
      detail: 'Nenhum import de API interna JDK detectado.' }
  }
  return { id: 'sun-internal-imports', label: 'Imports de API interna sun.* / com.sun.*', status: 'fail',
    detail: `${found.length >= 10 ? '10+' : found.length} import(s) de API interna encontrado(s): ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}. O módulo system do JDK 9+ bloqueia esses acessos em runtime.`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Substitua por APIs públicas equivalentes do JDK 21 ou adicione a dependência pública correspondente.' }
}

// ─── C3 — uso de SecurityManager ─────────────────────────────────────────────

function checkSecurityManagerUsage(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'security-manager', label: 'Uso de SecurityManager (removido JDK 17+)', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  const patterns = [
    /System\.setSecurityManager\s*\(/,
    /extends\s+SecurityManager\b/,
    /new\s+SecurityManager\s*\(/,
    /SecurityManager\s+\w+\s*=/,
  ]
  const found: { file: string; line: number }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some(p => p.test(lines[i]))) {
        found.push({ file: relPath(projectPath, f), line: i + 1 })
        if (found.length >= 5) break
      }
    }
    if (found.length >= 5) break
  }
  if (found.length === 0) {
    return { id: 'security-manager', label: 'Uso de SecurityManager (removido JDK 17+)', status: 'ok',
      detail: 'Nenhum uso de SecurityManager detectado nos fontes.' }
  }
  return { id: 'security-manager', label: 'Uso de SecurityManager (removido JDK 17+)', status: 'fail',
    detail: `${found.length} ocorrência(s) de SecurityManager: ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}. Lança UnsupportedOperationException em JDK 17+.`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Remova ou substitua o uso de SecurityManager. Consulte JEP 411 para alternativas.' }
}

// ─── C4 — flags JVM removidas ─────────────────────────────────────────────────

function checkRemovedJvmFlags(projectPath: string): AuditCriterion {
  const REMOVED_FLAGS = [
    { flag: '-XX:+UseConcMarkSweepGC',  note: 'CMS GC removido no JDK 14' },
    { flag: '-XX:+UseParNewGC',          note: 'removido no JDK 10' },
    { flag: '-XX:MaxPermSize',           note: 'PermGen removido no JDK 8' },
    { flag: '-XX:PermSize',              note: 'PermGen removido no JDK 8' },
    { flag: '-XX:+PrintGCDetails',       note: 'removido no JDK 15 — use -Xlog:gc' },
    { flag: '-XX:+PrintGCDateStamps',    note: 'removido no JDK 9 — use -Xlog:gc' },
    { flag: '-XX:+PrintHeapAtGC',        note: 'removido no JDK 9' },
    { flag: '-XX:+AggressiveOpts',       note: 'removido no JDK 11' },
    { flag: '-Djava.security.manager=allow', note: 'SecurityManager removido no JDK 17' },
  ]

  // Arquivos onde flags JVM costumam aparecer
  const targets: string[] = [
    join(projectPath, '.mvn', 'jvm.config'),
    join(projectPath, 'pom.xml'),
    ...findFiles(projectPath, n => n.endsWith('.sh') || n.endsWith('.bat') || n.endsWith('.cmd'), 3),
    ...findFiles(projectPath, n => /^Dockerfile/.test(n), 3),
    ...findFiles(projectPath, n => n === 'docker-compose.yml' || n === 'docker-compose.yaml', 3),
  ]

  const hits: Array<{ file: string; flag: string; note: string }> = []
  for (const t of targets) {
    const content = readSafe(t)
    if (!content) continue
    const rel = relPath(projectPath, t)
    for (const { flag, note } of REMOVED_FLAGS) {
      if (content.includes(flag)) hits.push({ file: rel, flag, note })
    }
  }

  if (hits.length === 0) {
    return { id: 'removed-jvm-flags', label: 'Flags JVM removidas em scripts/configs', status: 'ok',
      detail: 'Nenhuma flag JVM removida detectada em Dockerfiles, scripts ou pom.xml.' }
  }
  return { id: 'removed-jvm-flags', label: 'Flags JVM removidas em scripts/configs', status: 'fail',
    detail: `${hits.length} flag(s) JVM inválida(s) para JDK 21: ${hits.slice(0, 3).map(h => `'${h.flag}' em ${h.file} (${h.note})`).join('; ')}`,
    files: [...new Set(hits.map(h => h.file))].slice(0, 5),
    action: 'Remova ou substitua as flags listadas. Use -Xlog:gc* em lugar dos flags de GC antigos.' }
}

// ─── C5 — uso de Nashorn ─────────────────────────────────────────────────────

function checkNashornUsage(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'nashorn', label: 'Uso de Nashorn / engine JavaScript (removido JDK 15)', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  const patterns = [
    /getEngineByName\s*\(\s*["']nashorn["']\s*\)/,
    /getEngineByName\s*\(\s*["']js["']\s*\)/,
    /getEngineByName\s*\(\s*["']javascript["']\s*\)/i,
    /import\s+jdk\.nashorn\./,
    /import\s+sun\.org\.mozilla\.javascript\./,
  ]
  const found: { file: string; line: number }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some(p => p.test(lines[i]))) {
        found.push({ file: relPath(projectPath, f), line: i + 1 })
        if (found.length >= 5) break
      }
    }
    if (found.length >= 5) break
  }
  if (found.length === 0) {
    return { id: 'nashorn', label: 'Uso de Nashorn / engine JavaScript (removido JDK 15)', status: 'ok',
      detail: 'Nenhum uso de Nashorn ou ScriptEngine JS detectado.' }
  }
  return { id: 'nashorn', label: 'Uso de Nashorn / engine JavaScript (removido JDK 15)', status: 'fail',
    detail: `${found.length} ocorrência(s) de ScriptEngine JS/Nashorn: ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}. Retorna null silenciosamente em JDK 21.`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Adicione a dependência org.openjdk.nashorn:nashorn-core ou substitua por GraalVM JS.' }
}

// ─── C6 — presença de --add-opens / --add-exports ────────────────────────────

function checkAddOpensPresence(projectPath: string): AuditCriterion {
  const targets: string[] = [
    join(projectPath, '.mvn', 'jvm.config'),
    join(projectPath, 'pom.xml'),
    ...findFiles(projectPath, n => n.endsWith('.sh') || n.endsWith('.bat'), 3),
    ...findFiles(projectPath, n => /^Dockerfile/.test(n), 3),
  ]
  const hits: Array<{ file: string; snippet: string }> = []
  for (const t of targets) {
    const content = readSafe(t)
    if (!content) continue
    const lines = content.split('\n')
    for (const line of lines) {
      if (/--add-opens|--add-exports|--add-reads/.test(line)) {
        hits.push({ file: relPath(projectPath, t), snippet: line.trim().slice(0, 80) })
        break  // um hit por arquivo basta
      }
    }
  }
  if (hits.length === 0) {
    return { id: 'add-opens', label: 'Flags --add-opens / --add-exports', status: 'ok',
      detail: 'Nenhuma flag --add-opens ou --add-exports encontrada — acesso a módulos internos não necessário.' }
  }
  return { id: 'add-opens', label: 'Flags --add-opens / --add-exports', status: 'warning',
    detail: `${hits.length} arquivo(s) com --add-opens/--add-exports: ${hits.slice(0, 3).map(h => h.file).join(', ')}. Indica dependência de acesso a módulos internos do JDK.`,
    files: hits.slice(0, 5).map(h => h.file),
    action: 'Avalie se o acesso ao módulo interno é realmente necessário e se há alternativa pública no JDK 21.' }
}

// ─── C7 — versões de annotation processors ───────────────────────────────────

function checkAnnotationProcessorVersions(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return { id: 'annotation-processors', label: 'Versões de annotation processors', status: 'warning',
      detail: 'pom.xml não encontrado.' }
  }
  // Matriz de compatibilidade mínima com JDK 21
  const MATRIX: Array<{ artifactId: string; name: string; minVersion: string; compare: (v: string) => boolean }> = [
    { artifactId: 'lombok', name: 'Lombok', minVersion: '1.18.26',
      compare: v => {
        const parts = v.split('.').map(Number)
        if (parts[0] > 1) return true
        if (parts[0] < 1) return false
        if ((parts[1] ?? 0) > 18) return true
        if ((parts[1] ?? 0) < 18) return false
        return (parts[2] ?? 0) >= 26
      } },
    { artifactId: 'mapstruct', name: 'MapStruct', minVersion: '1.5.3.Final',
      compare: v => {
        const parts = v.replace(/[^0-9.]/g, '.').split('.').map(Number)
        if ((parts[0] ?? 0) > 1) return true
        if ((parts[1] ?? 0) > 5) return true
        if ((parts[1] ?? 0) === 5 && (parts[2] ?? 0) >= 3) return true
        return false
      } },
    { artifactId: 'mapstruct-processor', name: 'MapStruct Processor', minVersion: '1.5.3.Final',
      compare: v => {
        const parts = v.replace(/[^0-9.]/g, '.').split('.').map(Number)
        if ((parts[0] ?? 0) > 1) return true
        if ((parts[1] ?? 0) > 5) return true
        if ((parts[1] ?? 0) === 5 && (parts[2] ?? 0) >= 3) return true
        return false
      } },
  ]
  const issues: string[] = []
  const ok: string[] = []
  for (const proc of MATRIX) {
    const vMatch = pomContent.match(
      new RegExp(`<artifactId>\\s*${proc.artifactId}\\s*</artifactId>[\\s\\S]*?<version>\\s*([\\d.]+[^<]*)\\s*</version>`)
    )
    if (!vMatch) continue
    const version = vMatch[1].trim()
    if (proc.compare(version)) {
      ok.push(`${proc.name} ${version}`)
    } else {
      issues.push(`${proc.name} ${version} < ${proc.minVersion}`)
    }
  }
  if (issues.length === 0 && ok.length === 0) {
    return { id: 'annotation-processors', label: 'Versões de annotation processors (Lombok/MapStruct)', status: 'ok',
      detail: 'Lombok e MapStruct não detectados ou sem versão explícita — nada a verificar.' }
  }
  if (issues.length === 0) {
    return { id: 'annotation-processors', label: 'Versões de annotation processors (Lombok/MapStruct)', status: 'ok',
      detail: `Todos os annotation processors compatíveis com JDK 21: ${ok.join(', ')}.`, files: ['pom.xml'] }
  }
  return { id: 'annotation-processors', label: 'Versões de annotation processors (Lombok/MapStruct)', status: 'fail',
    detail: `Versão(ões) incompatível(is) com JDK 21: ${issues.join('; ')}.`,
    files: ['pom.xml'],
    action: `Atualize: Lombok → 1.18.26+, MapStruct → 1.5.3.Final+.` }
}

// ─── C8 — finalize() overrides ───────────────────────────────────────────────

function checkFinalizeOverrides(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'finalize-override', label: 'Overrides de finalize() (deprecado para remoção)', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  const pattern = /(?:protected|public)\s+void\s+finalize\s*\(\s*\)/
  const found: { file: string; line: number }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        found.push({ file: relPath(projectPath, f), line: i + 1 })
        break
      }
    }
    if (found.length >= 10) break
  }
  if (found.length === 0) {
    return { id: 'finalize-override', label: 'Overrides de finalize() (deprecado para remoção)', status: 'ok',
      detail: 'Nenhum override de finalize() detectado.' }
  }
  return { id: 'finalize-override', label: 'Overrides de finalize() (deprecado para remoção)', status: 'warning',
    detail: `${found.length} override(s) de finalize() detectado(s): ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}. Deprecado desde JDK 9, comportamento de GC alterado no JDK 21.`,
    files: found.slice(0, 5).map(f => f.file),
    action: 'Substitua por java.lang.ref.Cleaner (JDK 9+) ou try-with-resources.' }
}

// ─── C9 — .mvn/jvm.config ────────────────────────────────────────────────────

function checkMvnJvmConfig(projectPath: string): AuditCriterion {
  const configPath = join(projectPath, '.mvn', 'jvm.config')
  if (!existsSync(configPath)) {
    return { id: 'mvn-jvm-config', label: '.mvn/jvm.config — flags JVM do Maven', status: 'ok',
      detail: 'Arquivo .mvn/jvm.config não existe — sem flags JVM customizadas para Maven.' }
  }
  const content = readSafe(configPath) ?? ''
  const REMOVED = ['-XX:+UseConcMarkSweepGC', '-XX:+UseParNewGC', '-XX:MaxPermSize',
    '-XX:PermSize', '-XX:+PrintGCDetails', '-XX:+AggressiveOpts']
  const bad = REMOVED.filter(f => content.includes(f))

  if (content.trim().length === 0) {
    return { id: 'mvn-jvm-config', label: '.mvn/jvm.config — flags JVM do Maven', status: 'ok',
      detail: '.mvn/jvm.config existe mas está vazio.', files: ['.mvn/jvm.config'] }
  }
  if (bad.length > 0) {
    return { id: 'mvn-jvm-config', label: '.mvn/jvm.config — flags JVM do Maven', status: 'fail',
      detail: `Flags removidas no JDK 21 encontradas em .mvn/jvm.config: ${bad.join(', ')}`,
      files: ['.mvn/jvm.config'],
      action: 'Remova as flags listadas. Consulte JEP 380/396 para substituições.' }
  }
  if (/--add-opens|--add-exports/.test(content)) {
    return { id: 'mvn-jvm-config', label: '.mvn/jvm.config — flags JVM do Maven', status: 'warning',
      detail: '.mvn/jvm.config contém --add-opens/--add-exports — indica dependência de módulos internos do JDK.',
      files: ['.mvn/jvm.config'],
      action: 'Avalie se estas flags ainda são necessárias em JDK 21.' }
  }
  return { id: 'mvn-jvm-config', label: '.mvn/jvm.config — flags JVM do Maven', status: 'ok',
    detail: `.mvn/jvm.config presente sem flags incompatíveis com JDK 21.`, files: ['.mvn/jvm.config'] }
}

// ─── C10 — risco de serialização ─────────────────────────────────────────────

function checkSerializationRisk(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'serialization-risk', label: 'Serializable sem serialVersionUID explícito', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  const implementsSerializable = /implements\s+(?:[\w,\s]*\s+)?Serializable\b/
  const hasSerialVersionUID = /static\s+final\s+long\s+serialVersionUID\s*=/

  const risky: string[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    if (implementsSerializable.test(content) && !hasSerialVersionUID.test(content)) {
      risky.push(relPath(projectPath, f))
      if (risky.length >= 10) break
    }
  }
  if (risky.length === 0) {
    return { id: 'serialization-risk', label: 'Serializable sem serialVersionUID explícito', status: 'ok',
      detail: 'Todas as classes Serializable têm serialVersionUID declarado explicitamente.' }
  }
  return { id: 'serialization-risk', label: 'Serializable sem serialVersionUID explícito', status: 'warning',
    detail: `${risky.length} classe(s) Serializable sem serialVersionUID: ${risky.slice(0, 3).join(', ')}${risky.length > 3 ? ' …' : ''}. Recompilar com JDK diferente pode gerar UID diferente, quebrando desserialização de dados persistidos.`,
    files: risky.slice(0, 5),
    action: 'Adicione `private static final long serialVersionUID = 1L;` em cada classe Serializable.' }
}

// ─── C11 — uso de javax.script.* ─────────────────────────────────────────────

function checkJavaxScriptUsage(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'javax-script', label: 'Uso de javax.script.* (ScriptEngine)', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  const patterns = [
    /import\s+javax\.script\./,
    /ScriptEngineManager\s*\(/,
    /ScriptEngine\b/,
  ]
  const found: { file: string; line: number }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some(p => p.test(lines[i]))) {
        found.push({ file: relPath(projectPath, f), line: i + 1 })
        if (found.length >= 5) break
      }
    }
    if (found.length >= 5) break
  }
  if (found.length === 0) {
    return { id: 'javax-script', label: 'Uso de javax.script.* (ScriptEngine)', status: 'ok',
      detail: 'Nenhum uso de javax.script.ScriptEngine detectado.' }
  }
  return { id: 'javax-script', label: 'Uso de javax.script.* (ScriptEngine)', status: 'warning',
    detail: `${found.length} uso(s) de ScriptEngine: ${found.slice(0, 3).map(f => `${f.file}:${f.line}`).join(', ')}. Nashorn e Rhino foram removidos — apenas GraalVM JS e engines externas funcionam em JDK 21.`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Verifique qual engine é usada em runtime. Se for Nashorn/Rhino, adicione nashorn-core ou GraalVM JS.' }
}

// ─── C12 — uso de finalize no JDK APIs (Object.finalize via reflexão) ────────
// Bônus: verifica também Object.finalize() chamado via reflexão

function checkReflectiveInternalAccess(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)
  if (allFiles.length === 0) {
    return { id: 'reflective-internal', label: 'Acesso reflexivo a APIs internas do JDK', status: 'warning',
      detail: 'Nenhum arquivo .java encontrado em src/main/java ou src/test/java.' }
  }
  const patterns = [
    /Class\.forName\s*\(\s*["']sun\./,
    /Class\.forName\s*\(\s*["']com\.sun\./,
    /getDeclaredField\s*\(\s*["'][a-z]/,   // acesso a campos privados
    /setAccessible\s*\(\s*true\s*\)/,
  ]
  const found: { file: string; line: number; text: string }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      // setAccessible(true) é comum — só conta se há context de acesso a internos
      if (patterns[3].test(lines[i])) {
        const context = lines.slice(Math.max(0, i - 5), i + 1).join(' ')
        if (!/(sun|com\.sun|internal)/.test(context)) continue
      }
      if (patterns.some(p => p.test(lines[i]))) {
        found.push({ file: relPath(projectPath, f), line: i + 1, text: lines[i].trim().slice(0, 80) })
        if (found.length >= 5) break
      }
    }
    if (found.length >= 5) break
  }
  if (found.length === 0) {
    return { id: 'reflective-internal', label: 'Acesso reflexivo a APIs internas do JDK', status: 'ok',
      detail: 'Nenhum acesso reflexivo suspeito a APIs internas detectado.' }
  }
  return { id: 'reflective-internal', label: 'Acesso reflexivo a APIs internas do JDK', status: 'warning',
    detail: `${found.length} padrão(ões) de acesso reflexivo a internos: ${found.slice(0, 2).map(f => `${f.file}:${f.line}`).join(', ')}. O módulo system do JDK 9+ bloqueia esses acessos sem --add-opens.`,
    files: [...new Set(found.map(f => f.file))].slice(0, 5),
    action: 'Revise os acessos reflexivos. Se necessários, adicione --add-opens ou substitua pela API pública.' }
}

// ─── D1 — APIs removidas no JDK 9–21 ─────────────────────────────────────────
// Thread.stop/destroy/countStackFrames (JDK 21), Applet API (JDK 17),
// RMI Activation (JDK 17), java.endorsed.dirs / java.ext.dirs (JDK 9),
// System/Runtime.runFinalizersOnExit (JDK 11), java.lang.Compiler (JDK 9)

function checkRemovedApis(projectPath: string): AuditCriterion {
  const allFiles = findAllJavaFiles(projectPath)

  // Padrões em código-fonte Java
  const SOURCE_PATTERNS: Array<{ re: RegExp; note: string }> = [
    { re: /\bthread\.stop\s*\(\s*\)/i,                  note: 'Thread.stop() — lança UnsupportedOperationException no JDK 21 (JEP 214)' },
    { re: /\.stop\s*\(\s*new\s+\w*Error/,               note: 'Thread.stop(Throwable) — removido no JDK 21' },
    { re: /\.destroy\s*\(\s*\)/,                        note: 'Thread.destroy() — removido no JDK 21' },
    { re: /\.countStackFrames\s*\(\s*\)/,               note: 'Thread.countStackFrames() — removido no JDK 21' },
    { re: /import\s+java\.applet\./,                    note: 'java.applet.* — API Applet removida no JDK 17 (JEP 398)' },
    { re: /import\s+java\.rmi\.activation\./,           note: 'java.rmi.activation.* — RMI Activation removido no JDK 17 (JEP 407)' },
    { re: /import\s+javax\.security\.auth\.Policy\b/,   note: 'javax.security.auth.Policy — removido com SecurityManager (JDK 17)' },
    // removidos no JDK 11
    { re: /System\.runFinalizersOnExit\s*\(/,           note: 'System.runFinalizersOnExit() — removido no JDK 11 (era deprecated desde JDK 1.1)' },
    { re: /Runtime\.runFinalizersOnExit\s*\(/,          note: 'Runtime.runFinalizersOnExit() — removido no JDK 11' },
    { re: /getRuntime\s*\(\s*\)\.runFinalizersOnExit/,  note: 'Runtime.getRuntime().runFinalizersOnExit() — removido no JDK 11' },
    // removido no JDK 9
    { re: /import\s+java\.lang\.Compiler\b/,            note: 'java.lang.Compiler — removido no JDK 9 (JEP 289); classe era no-op desde JDK 1.3' },
    { re: /java\.lang\.Compiler\s*\./,                  note: 'java.lang.Compiler — removido no JDK 9' },
  ]

  // Padrões em arquivos de configuração / startup
  const CONFIG_PATTERNS: Array<{ re: RegExp; note: string }> = [
    { re: /java\.endorsed\.dirs/,  note: 'java.endorsed.dirs — mecanismo removido no JDK 9; silenciosamente ignorado no JDK 21' },
    { re: /java\.ext\.dirs/,       note: 'java.ext.dirs — mecanismo de extensão removido no JDK 9; silenciosamente ignorado no JDK 21' },
    { re: /runFinalizersOnExit/,   note: 'runFinalizersOnExit — removido no JDK 11; se presente em script de startup é ignorado ou causa erro' },
  ]

  const foundSrc: { file: string; line: number; note: string }[] = []
  for (const f of allFiles) {
    const content = readSafe(f)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const { re, note } of SOURCE_PATTERNS) {
        if (re.test(lines[i])) {
          foundSrc.push({ file: relPath(projectPath, f), line: i + 1, note })
          break
        }
      }
      if (foundSrc.length >= 10) break
    }
    if (foundSrc.length >= 10) break
  }

  // Varredura em scripts e configs
  const configTargets = [
    join(projectPath, '.mvn', 'jvm.config'),
    ...findFiles(projectPath, n => n.endsWith('.sh') || n.endsWith('.bat') || n.endsWith('.cmd') || n.endsWith('.env'), 3),
    ...findFiles(projectPath, n => /^Dockerfile/.test(n), 3),
    ...findFiles(projectPath, n => n === 'docker-compose.yml' || n === 'docker-compose.yaml', 3),
    ...findFiles(projectPath, n => n === 'application.properties' || n === 'application.yml' || n === 'application.yaml', 3),
  ]
  const foundConfig: { file: string; note: string }[] = []
  for (const t of configTargets) {
    const content = readSafe(t)
    if (!content) continue
    for (const { re, note } of CONFIG_PATTERNS) {
      if (re.test(content)) foundConfig.push({ file: relPath(projectPath, t), note })
    }
  }

  if (foundSrc.length === 0 && foundConfig.length === 0) {
    return { id: 'removed-apis', label: 'APIs removidas no JDK 17–21 (Thread.stop, Applet, RMI Activation)', status: 'ok',
      detail: 'Nenhum uso de APIs removidas no JDK 17–21 detectado em fontes ou configs.' }
  }

  const allHits = [
    ...foundSrc.map(h => `${h.file}:${h.line} — ${h.note}`),
    ...foundConfig.map(h => `${h.file} — ${h.note}`),
  ]
  return { id: 'removed-apis', label: 'APIs removidas no JDK 17–21 (Thread.stop, Applet, RMI Activation)', status: 'fail',
    detail: `${allHits.length} uso(s) de API removida: ${allHits.slice(0, 3).join('; ')}`,
    files: [...new Set([...foundSrc.map(h => h.file), ...foundConfig.map(h => h.file)])].slice(0, 5),
    action: 'Substitua Thread.stop() por interrupt()+isInterrupted(), remova Applet/RMI Activation e elimine java.endorsed.dirs das configs.' }
}

// ─── D2 — versões de bibliotecas de manipulação de bytecode ──────────────────
// ASM, cglib, Byte Buddy — versões antigas não conseguem ler/gerar bytecode JDK 21 (major 65)

function checkBytecodeManipulationLibs(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return { id: 'bytecode-manip-libs', label: 'Libs de manipulação de bytecode (ASM/cglib/Byte Buddy)', status: 'warning',
      detail: 'pom.xml não encontrado.' }
  }

  // Versões mínimas validadas para JDK 21 (major 65)
  interface LibSpec { artifactId: string; name: string; minMajor: number; minMinor: number; minPatch: number; minDisplay: string }
  const LIBS: LibSpec[] = [
    { artifactId: 'asm',           name: 'ASM',        minMajor: 9, minMinor: 0, minPatch: 0, minDisplay: '9.0' },
    { artifactId: 'asm-commons',   name: 'ASM Commons', minMajor: 9, minMinor: 0, minPatch: 0, minDisplay: '9.0' },
    { artifactId: 'asm-tree',      name: 'ASM Tree',   minMajor: 9, minMinor: 0, minPatch: 0, minDisplay: '9.0' },
    { artifactId: 'cglib',         name: 'cglib',      minMajor: 3, minMinor: 3, minPatch: 0, minDisplay: '3.3.0' },
    { artifactId: 'cglib-nodep',   name: 'cglib-nodep', minMajor: 3, minMinor: 3, minPatch: 0, minDisplay: '3.3.0' },
    { artifactId: 'byte-buddy',    name: 'Byte Buddy', minMajor: 1, minMinor: 14, minPatch: 0, minDisplay: '1.14.0' },
    { artifactId: 'byte-buddy-agent', name: 'Byte Buddy Agent', minMajor: 1, minMinor: 14, minPatch: 0, minDisplay: '1.14.0' },
    { artifactId: 'javassist',     name: 'Javassist',  minMajor: 3, minMinor: 29, minPatch: 0, minDisplay: '3.29.0' },
  ]

  function versionOk(vStr: string, lib: LibSpec): boolean {
    const parts = vStr.replace(/[^0-9.]/g, '.').split('.').map(Number)
    const [maj = 0, min = 0, pat = 0] = parts
    if (maj > lib.minMajor) return true
    if (maj < lib.minMajor) return false
    if (min > lib.minMinor) return true
    if (min < lib.minMinor) return false
    return pat >= lib.minPatch
  }

  const issues: string[] = []
  const ok: string[] = []
  for (const lib of LIBS) {
    const match = pomContent.match(
      new RegExp(`<artifactId>\\s*${lib.artifactId}\\s*</artifactId>[\\s\\S]{0,200}?<version>\\s*([\\d.]+[^<]*)\\s*</version>`)
    )
    if (!match) continue
    const version = match[1].trim()
    if (versionOk(version, lib)) {
      ok.push(`${lib.name} ${version}`)
    } else {
      issues.push(`${lib.name} ${version} < ${lib.minDisplay}`)
    }
  }

  if (issues.length === 0 && ok.length === 0) {
    return { id: 'bytecode-manip-libs', label: 'Libs de manipulação de bytecode (ASM/cglib/Byte Buddy)', status: 'ok',
      detail: 'ASM, cglib, Byte Buddy e Javassist não declarados diretamente no pom.xml — versões são transitivas de frameworks como Spring/Hibernate/Mockito. Se os testes passam com JDK 21, as versões transitivas estão adequadas.' }
  }
  if (issues.length === 0) {
    return { id: 'bytecode-manip-libs', label: 'Libs de manipulação de bytecode (ASM/cglib/Byte Buddy)', status: 'ok',
      detail: `Todas as libs de bytecode declaradas são compatíveis com JDK 21: ${ok.join(', ')}.`, files: ['pom.xml'] }
  }
  return { id: 'bytecode-manip-libs', label: 'Libs de manipulação de bytecode (ASM/cglib/Byte Buddy)', status: 'fail',
    detail: `Versão(ões) incompatível(is) com bytecode JDK 21 (major 65): ${issues.join('; ')}. Ao criar proxies/mocks em runtime, a JVM pode lançar IllegalArgumentException ou ClassFormatError.`,
    files: ['pom.xml'],
    action: `Atualize: ASM → 9.x, cglib → 3.3.0+, Byte Buddy → 1.14+, Javassist → 3.29+. Em projetos Spring Boot 3.x estas dependências já vêm atualizadas via BOM.` }
}

// ─── D3 — versões de plugins Maven críticos ────────────────────────────────────
// maven-compiler-plugin e maven-surefire-plugin — versões antigas falham com JDK 21

function checkMavenPluginVersions(projectPath: string): AuditCriterion {
  const pomContent = readSafe(join(projectPath, 'pom.xml'))
  if (!pomContent) {
    return { id: 'maven-plugin-versions', label: 'Versões de plugins Maven (compiler/surefire)', status: 'warning',
      detail: 'pom.xml não encontrado.' }
  }

  // maven-compiler-plugin < 3.6.0 não suporta --release; < 3.11 tem issues com JDK 21
  // maven-surefire-plugin < 2.22.0 não suporta JUnit 5 / JDK 9+ módulos corretamente
  // maven-failsafe-plugin — mesmo threshold que surefire
  interface PluginSpec { artifactId: string; name: string; minDisplay: string; compare: (v: string) => boolean }
  const PLUGINS: PluginSpec[] = [
    { artifactId: 'maven-compiler-plugin', name: 'maven-compiler-plugin', minDisplay: '3.11.0',
      compare: v => {
        const p = v.split('.').map(Number)
        if ((p[0] ?? 0) > 3) return true
        if ((p[0] ?? 0) < 3) return false
        return (p[1] ?? 0) >= 11
      } },
    { artifactId: 'maven-surefire-plugin', name: 'maven-surefire-plugin', minDisplay: '2.22.0',
      compare: v => {
        const p = v.split('.').map(Number)
        if ((p[0] ?? 0) > 2) return true
        if ((p[0] ?? 0) < 2) return false
        if ((p[1] ?? 0) > 22) return true
        if ((p[1] ?? 0) < 22) return false
        return (p[2] ?? 0) >= 0
      } },
    { artifactId: 'maven-failsafe-plugin', name: 'maven-failsafe-plugin', minDisplay: '2.22.0',
      compare: v => {
        const p = v.split('.').map(Number)
        if ((p[0] ?? 0) > 2) return true
        if ((p[0] ?? 0) < 2) return false
        return (p[1] ?? 0) >= 22
      } },
  ]

  // Maven Wrapper
  const wrapperPath = join(projectPath, '.mvn', 'wrapper', 'maven-wrapper.properties')
  const wrapperContent = readSafe(wrapperPath)
  const wrapperVersion = wrapperContent?.match(/distributionUrl[\s\S]*?apache-maven-([\d.]+)-/)?.[1]

  const issues: string[] = []
  const ok: string[] = []

  for (const plugin of PLUGINS) {
    // Busca dentro de <build><plugins> — aceita com ou sem groupId declarado
    const match = pomContent.match(
      new RegExp(`<artifactId>\\s*${plugin.artifactId}\\s*</artifactId>[\\s\\S]{0,300}?<version>\\s*([\\d.]+[^<]*)\\s*</version>`)
    )
    if (!match) continue  // não declarado explicitamente → usa versão default do Maven (aceitável com BOM)
    const version = match[1].trim()
    if (plugin.compare(version)) {
      ok.push(`${plugin.name} ${version}`)
    } else {
      issues.push(`${plugin.name} ${version} (mínimo: ${plugin.minDisplay})`)
    }
  }

  // Verifica Maven Wrapper < 3.2
  let wrapperIssue: string | null = null
  if (wrapperVersion) {
    const p = wrapperVersion.split('.').map(Number)
    const tooOld = (p[0] ?? 0) < 3 || ((p[0] ?? 0) === 3 && (p[1] ?? 0) < 2)
    if (tooOld) wrapperIssue = `Maven Wrapper ${wrapperVersion} (recomendado 3.2+)`
    else ok.push(`Maven Wrapper ${wrapperVersion}`)
  }

  if (issues.length === 0 && !wrapperIssue && ok.length === 0) {
    return { id: 'maven-plugin-versions', label: 'Versões de plugins Maven (compiler/surefire/wrapper)', status: 'ok',
      detail: 'maven-compiler-plugin e maven-surefire-plugin não declarados explicitamente — versão gerenciada pelo parent BOM do Spring Boot 3.x ou Maven default.' }
  }
  if (issues.length === 0 && !wrapperIssue) {
    return { id: 'maven-plugin-versions', label: 'Versões de plugins Maven (compiler/surefire/wrapper)', status: 'ok',
      detail: `Plugins Maven declarados são compatíveis com JDK 21: ${ok.join(', ')}.`, files: ['pom.xml'] }
  }

  const allIssues = [...issues, ...(wrapperIssue ? [wrapperIssue] : [])]
  return { id: 'maven-plugin-versions', label: 'Versões de plugins Maven (compiler/surefire/wrapper)', status: 'fail',
    detail: `Plugin(s) incompatível(is) com JDK 21: ${allIssues.join('; ')}.`,
    files: ['pom.xml', ...(wrapperIssue ? ['.mvn/wrapper/maven-wrapper.properties'] : [])],
    action: 'Atualize: maven-compiler-plugin → 3.11.0+, maven-surefire-plugin → 2.22.0+, Maven Wrapper → 3.2+.' }
}

// ─── D4 — Maven profiles com ativação automática por versão de JDK ──────────

function checkMavenJdkProfiles(projectPath: string): AuditCriterion {
  const pomFiles = findFiles(projectPath, n => n === 'pom.xml', 4)
  if (pomFiles.length === 0) {
    return { id: 'maven-jdk-profiles', label: 'Maven profiles com override de JDK', status: 'warning',
      detail: 'Nenhum pom.xml encontrado.' }
  }

  // Detecta profiles que ativam por JDK (<jdk>1.8</jdk>) e sobrescrevem propriedades de compilador
  const PROFILE_JDK_RE = /<profile>[\s\S]*?<activation>[\s\S]*?<jdk>([\s\S]*?)<\/jdk>[\s\S]*?<\/activation>([\s\S]*?)<\/profile>/g
  const COMPILER_PROP_RE = /maven\.compiler\.(source|target|release)|java\.version\s*>/

  const suspects: Array<{ file: string; jdk: string }> = []
  for (const pomFile of pomFiles) {
    const content = readSafe(pomFile)
    if (!content) continue
    const rel = relPath(projectPath, pomFile)
    let m: RegExpExecArray | null
    // eslint-disable-next-line no-cond-assign
    while ((m = PROFILE_JDK_RE.exec(content)) !== null) {
      const jdkActivation = m[1].trim()
      const profileBody = m[2]
      if (COMPILER_PROP_RE.test(profileBody)) {
        suspects.push({ file: rel, jdk: jdkActivation })
      }
    }
  }

  if (suspects.length === 0) {
    return { id: 'maven-jdk-profiles', label: 'Maven profiles com override de JDK', status: 'ok',
      detail: 'Nenhum profile com ativação automática por versão de JDK e override de compilador detectado.' }
  }

  return { id: 'maven-jdk-profiles', label: 'Maven profiles com override de JDK', status: 'warning',
    detail: `${suspects.length} profile(s) com ativação automática por JDK e override de propriedades de compilador: ${suspects.map(s => `${s.file} (ativa quando JDK=${s.jdk})`).join('; ')}. Se estes profiles ativarem em CI/CD, podem sobrescrever a versão de compilador definida para JDK 21.`,
    files: suspects.map(s => s.file).slice(0, 5),
    action: 'Revise os profiles listados. Desative ou remova profiles de JDK antigo que sobreponham maven.compiler.source/target/release.' }
}

// ─── D5 — Kubernetes / Helm / manifests k8s com referência a JDK antigo ─────
// Escaneia deployment.yaml, StatefulSet, CronJob, Helm templates e valores
// procurando por imagens base com JDK diferente de 21.

function checkKubernetesManifests(projectPath: string, targetJdk: string): AuditCriterion {
  // Diretórios convencionais de infra k8s / Helm
  const K8S_DIRS = ['k8s', 'kubernetes', 'manifests', 'deploy', 'helm', 'charts', 'infra', 'infrastructure', '.github/workflows']
  const scannedDirs = K8S_DIRS.map(d => join(projectPath, d)).filter(existsSync)

  if (scannedDirs.length === 0) {
    return { id: 'k8s-manifests', label: 'Kubernetes/Helm — imagens JDK em manifests', status: 'ok',
      detail: 'Nenhum diretório k8s/helm/manifests encontrado — sem manifests de infraestrutura para verificar.' }
  }

  // Imagens base comuns com JDK antigo — detecta tag numérica e sufixos como -jre, -jdk
  // Não flageia imagens que já referem explicitamente "21" ou "temurin-21" etc.
  const OLD_JDK_IMAGE_RE = /(?:eclipse-temurin|openjdk|amazoncorretto|liberica|microsoft\/openjdk|ibmjava|sapmachine):([\d]+)(?:-[^\s"']*)?/g
  const ENV_JDK_RE = /(?:JAVA_VERSION|JDK_VERSION|JAVA_HOME)[=:\s]+['"]?(\d+)/g

  const hits: Array<{ file: string; snippet: string; jdkVersion: string }> = []

  for (const dir of scannedDirs) {
    const yamlFiles = findFiles(dir, n => n.endsWith('.yaml') || n.endsWith('.yml'), 6)
    for (const f of yamlFiles) {
      const content = readSafe(f)
      if (!content) continue
      const rel = relPath(projectPath, f)

      // Reset lastIndex para cada arquivo
      OLD_JDK_IMAGE_RE.lastIndex = 0
      ENV_JDK_RE.lastIndex = 0

      let m: RegExpExecArray | null
      // eslint-disable-next-line no-cond-assign
      while ((m = OLD_JDK_IMAGE_RE.exec(content)) !== null) {
        const version = m[1]
        if (version !== targetJdk && version !== '21') {
          hits.push({ file: rel, snippet: m[0], jdkVersion: version })
        }
      }
      // eslint-disable-next-line no-cond-assign
      while ((m = ENV_JDK_RE.exec(content)) !== null) {
        const version = m[1]
        if (version !== targetJdk && version !== '21') {
          hits.push({ file: rel, snippet: m[0], jdkVersion: version })
        }
      }

      if (hits.length >= 10) break
    }
    if (hits.length >= 10) break
  }

  const filesScanned = scannedDirs.flatMap(d =>
    findFiles(d, n => n.endsWith('.yaml') || n.endsWith('.yml'), 6)
  ).length

  if (hits.length === 0) {
    return { id: 'k8s-manifests', label: 'Kubernetes/Helm — imagens JDK em manifests', status: 'ok',
      detail: `${filesScanned} arquivo(s) YAML de infra verificado(s) — nenhuma imagem ou variável com JDK diferente de ${targetJdk}.`,
      files: scannedDirs.map(d => relPath(projectPath, d)) }
  }

  const uniqueFiles = [...new Set(hits.map(h => h.file))]
  return { id: 'k8s-manifests', label: 'Kubernetes/Helm — imagens JDK em manifests', status: 'fail',
    detail: `${hits.length} referência(s) a JDK diferente de ${targetJdk} em manifests k8s/Helm: ${hits.slice(0, 3).map(h => `'${h.snippet}' em ${h.file}`).join('; ')}`,
    files: uniqueFiles.slice(0, 5),
    action: `Atualize as imagens e variáveis de ambiente para JDK ${targetJdk} (ex: eclipse-temurin:${targetJdk}-jre).` }
}

// ─── entry point público ───────────────────────────────────────────────────────

export async function runMigrationAudit(
  projectPath: string,
  targetJdk: string = '21',
): Promise<MigrationAuditResult> {
  const criteria: AuditCriterion[] = await Promise.all([
    // Critérios A1–A8 — build, namespace, Spring Boot, CI/CD, runtime, artefatos
    Promise.resolve(checkCompilerVersion(projectPath, targetJdk)),
    Promise.resolve(checkJavaxImports(projectPath)),
    Promise.resolve(checkSpringBootVersion(projectPath)),
    Promise.resolve(checkInternalDependencies(projectPath)),
    checkContainerCi(projectPath, targetJdk),
    Promise.resolve(checkRuntimeEvidence(projectPath)),
    Promise.resolve(checkObsoleteProperties(projectPath)),
    Promise.resolve(checkOutputBytecode(projectPath, targetJdk)),
    // Critérios C1–C12 — bytecode real, APIs internas, flags, processadores (main+test)
    Promise.resolve(checkActualBytecodeVersion(projectPath, targetJdk)),
    Promise.resolve(checkSunInternalImports(projectPath)),
    Promise.resolve(checkSecurityManagerUsage(projectPath)),
    Promise.resolve(checkRemovedJvmFlags(projectPath)),
    Promise.resolve(checkNashornUsage(projectPath)),
    Promise.resolve(checkAddOpensPresence(projectPath)),
    Promise.resolve(checkAnnotationProcessorVersions(projectPath)),
    Promise.resolve(checkFinalizeOverrides(projectPath)),
    Promise.resolve(checkMvnJvmConfig(projectPath)),
    Promise.resolve(checkSerializationRisk(projectPath)),
    Promise.resolve(checkJavaxScriptUsage(projectPath)),
    Promise.resolve(checkReflectiveInternalAccess(projectPath)),
    // Critérios D1–D5 — fechamento: APIs removidas JDK9-21, bytecode-manip libs, plugins Maven, profiles, k8s/Helm
    Promise.resolve(checkRemovedApis(projectPath)),
    Promise.resolve(checkBytecodeManipulationLibs(projectPath)),
    Promise.resolve(checkMavenPluginVersions(projectPath)),
    Promise.resolve(checkMavenJdkProfiles(projectPath)),
    Promise.resolve(checkKubernetesManifests(projectPath, targetJdk)),
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
    allOk: summary.ok === criteria.length,  // true só se TODOS forem ✅
  }
}
