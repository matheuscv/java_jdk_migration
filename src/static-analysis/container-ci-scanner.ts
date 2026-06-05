/**
 * Scanner de arquivos de infraestrutura: Dockerfile, docker-compose e CI pipelines.
 * Detecta referências a versões de JDK incompatíveis com o targetJdk da migração.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export type ContainerFindingSeverity = 'critical' | 'high' | 'medium' | 'info'

export interface ContainerFinding {
  /** Arquivo onde a referência foi encontrada (relativo à raiz do projeto) */
  file: string
  /** Tipo do arquivo */
  fileType: 'dockerfile' | 'docker-compose' | 'github-actions' | 'gitlab-ci' | 'jenkinsfile' | 'azure-pipelines' | 'travis' | 'circleci' | 'other-ci'
  /** Linha do arquivo */
  line: number
  /** Conteúdo da linha */
  content: string
  /** Versão JDK detectada nesta linha (ex: "8", "11") */
  detectedJdkVersion: string | null
  /** Imagem completa detectada (ex: "openjdk:8-jre-alpine") */
  detectedImage: string | null
  /** Descrição do problema */
  description: string
  /** Sugestão de correção */
  suggestion: string
  severity: ContainerFindingSeverity
  /** true = precisa de decisão humana (ex: imagem privada corporativa) */
  requiresHumanDecision: boolean
  /** Imagem substituta sugerida após consulta ao registry (preenchido pelo enricher) */
  suggestedReplacement?: string | null
  /** true = a sugestão veio de consulta ao registry corporativo */
  replacementFromRegistry?: boolean
}

export interface ContainerCiScanResult {
  findings: ContainerFinding[]
  filesScanned: string[]
  hasIncompatibleImages: boolean
  hasIncompatibleCiJdk: boolean
}

// ─── padrões de imagens base Java ─────────────────────────────────────────────

/** Extrai versão JDK de uma string de imagem Docker */
function extractJdkVersionFromImage(image: string): string | null {
  // Padrões: openjdk:8, openjdk:8-jre, eclipse-temurin:11.0.2, amazoncorretto:17, azul/zulu-openjdk:8
  // distroless/java11, gcr.io/distroless/java8-debian11
  const patterns = [
    /(?:^|[/:-])(?:java|jdk|jre)[_-]?(\d+)/i,
    /(?:openjdk|temurin|corretto|zulu|liberica|semeru|dragonwell|microsoft\/openjdk):(\d+)/i,
    /(?:adoptopenjdk|adoptjdk)[\/:_-](\d+)/i,
    /distroless\/java(\d+)/i,
    /java(\d+)-/i,
    /:(\d+)(?:-jre|-jdk|-alpine|-slim|-focal|-jammy|-bullseye|-buster)?(?:\s|$)/i,
  ]
  for (const re of patterns) {
    const m = image.match(re)
    if (m) return m[1]
  }
  return null
}

/** Detecta se a linha é uma instrução FROM do Dockerfile */
function parseDockerfileFrom(line: string): string | null {
  const m = line.trim().match(/^FROM\s+(\S+)/i)
  return m ? m[1] : null
}

/** Detecta se a linha tem um ENV com JAVA_HOME ou JAVA_VERSION apontando para versão antiga */
function parseDockerfileEnvJdk(line: string): string | null {
  const m = line.trim().match(/^ENV\s+(?:JAVA_HOME|JAVA_VERSION|JDK_VERSION|JAVA_MAJOR_VERSION)[= ]+[^\s]*?(\d+)/i)
  return m ? m[1] : null
}

// ─── scanners por tipo de arquivo ─────────────────────────────────────────────

function scanDockerfile(filePath: string, projectPath: string, targetJdk: string): ContainerFinding[] {
  const findings: ContainerFinding[] = []
  const relPath = relative(projectPath, filePath)
  const lines = readFileSync(filePath, 'utf-8').split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // FROM instruction
    const image = parseDockerfileFrom(line)
    if (image && image !== 'scratch' && !image.startsWith('--')) {
      const version = extractJdkVersionFromImage(image)
      const isJavaImage = /openjdk|temurin|corretto|zulu|liberica|semeru|dragonwell|adoptjdk|adoptopenjdk|distroless\/java|java[_-]?\d|jre[_-]?\d|jdk[_-]?\d/i.test(image)

      if (isJavaImage) {
        if (version && version !== targetJdk) {
          const isPrivate = image.includes('/') && !image.startsWith('eclipse') && !image.startsWith('azul') && !image.startsWith('amazoncorretto') && !image.includes('openjdk') && !image.includes('gcr.io/distroless')
          findings.push({
            file: relPath, fileType: 'dockerfile', line: lineNum, content: line.trim(),
            detectedJdkVersion: version, detectedImage: image,
            description: `Imagem base usa JDK ${version} — incompatível com target JDK ${targetJdk}.`,
            suggestion: isPrivate
              ? `Substitua '${image}' pela versão JDK ${targetJdk} equivalente no seu registry corporativo. Esta imagem parece ser privada — consulte o time de infraestrutura para obter a tag correta.`
              : `Substitua '${image}' por uma imagem JDK ${targetJdk}. Exemplos: 'eclipse-temurin:${targetJdk}-jre', 'amazoncorretto:${targetJdk}', 'azul/zulu-openjdk:${targetJdk}'.`,
            severity: 'critical',
            requiresHumanDecision: isPrivate,
          })
        } else if (!version) {
          findings.push({
            file: relPath, fileType: 'dockerfile', line: lineNum, content: line.trim(),
            detectedJdkVersion: null, detectedImage: image,
            description: `Imagem Java detectada mas versão JDK não pôde ser determinada automaticamente: '${image}'.`,
            suggestion: `Verifique se a tag '${image}' é compatível com JDK ${targetJdk}. Se não for, atualize a tag.`,
            severity: 'high',
            requiresHumanDecision: true,
          })
        }
      }
    }

    // ENV com JAVA_HOME/JAVA_VERSION
    const envVersion = parseDockerfileEnvJdk(line)
    if (envVersion && envVersion !== targetJdk) {
      findings.push({
        file: relPath, fileType: 'dockerfile', line: lineNum, content: line.trim(),
        detectedJdkVersion: envVersion, detectedImage: null,
        description: `Variável de ambiente define JDK ${envVersion} — deve ser atualizada para JDK ${targetJdk}.`,
        suggestion: `Atualize a variável para referenciar JDK ${targetJdk}.`,
        severity: 'high',
        requiresHumanDecision: false,
      })
    }
  }

  return findings
}

function scanDockerCompose(filePath: string, projectPath: string, targetJdk: string): ContainerFinding[] {
  const findings: ContainerFinding[] = []
  const relPath = relative(projectPath, filePath)
  const lines = readFileSync(filePath, 'utf-8').split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // image: openjdk:8 ou build: { args: { JDK_VERSION: 8 } }
    const imageMatch = line.match(/^\s*image:\s*(\S+)/i)
    if (imageMatch) {
      const image = imageMatch[1].replace(/['"]/g, '')
      const version = extractJdkVersionFromImage(image)
      const isJavaImage = /openjdk|temurin|corretto|zulu|liberica|java[_-]?\d/i.test(image)
      if (isJavaImage && version && version !== targetJdk) {
        findings.push({
          file: relPath, fileType: 'docker-compose', line: lineNum, content: line.trim(),
          detectedJdkVersion: version, detectedImage: image,
          description: `Serviço docker-compose usa imagem JDK ${version} — incompatível com target JDK ${targetJdk}.`,
          suggestion: `Atualize a imagem para JDK ${targetJdk}.`,
          severity: 'high',
          requiresHumanDecision: false,
        })
      }
    }

    // ARG/build-arg com versão JDK
    const argMatch = line.match(/(?:JAVA_VERSION|JDK_VERSION|JAVA_MAJOR)[:\s=]+['"]?(\d+)['"]?/i)
    if (argMatch && argMatch[1] !== targetJdk) {
      findings.push({
        file: relPath, fileType: 'docker-compose', line: lineNum, content: line.trim(),
        detectedJdkVersion: argMatch[1], detectedImage: null,
        description: `Build arg define JDK ${argMatch[1]} — deve ser atualizado para JDK ${targetJdk}.`,
        suggestion: `Atualize o valor para '${targetJdk}'.`,
        severity: 'medium',
        requiresHumanDecision: false,
      })
    }
  }

  return findings
}

function scanCiFile(
  filePath: string,
  projectPath: string,
  targetJdk: string,
  fileType: ContainerFinding['fileType'],
): ContainerFinding[] {
  const findings: ContainerFinding[] = []
  const relPath = relative(projectPath, filePath)
  const lines = readFileSync(filePath, 'utf-8').split('\n')

  // Padrões genéricos que aparecem em vários sistemas de CI
  const jdkPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /java[_-]?version[:\s'"]+([0-9.]+)/i,          label: 'java-version' },
    { re: /jdk[_-]?version[:\s'"]+([0-9.]+)/i,           label: 'jdk-version' },
    { re: /JAVA_VERSION[:\s='"]+([0-9.]+)/i,              label: 'JAVA_VERSION' },
    { re: /JDK_VERSION[:\s='"]+([0-9.]+)/i,               label: 'JDK_VERSION' },
    { re: /distribution[:\s'"]+[^#\n]*\n?.*java[_-]?version[:\s'"]+([0-9.]+)/i, label: 'setup-java' },
    { re: /image:\s*(?:openjdk|eclipse-temurin|amazoncorretto|azul)[:\s/]([0-9.]+)/i, label: 'CI image' },
    { re: /jdk:\s*openjdk(\d+)/i,                         label: 'Travis jdk' },
    { re: /java:\s*(\d+)/i,                               label: 'java version' },
  ]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Imagem Docker no CI (image: openjdk:8)
    const imageMatch = line.match(/^\s*image:\s*['"]?(\S+?)['"]?\s*(?:#.*)?$/)
    if (imageMatch) {
      const image = imageMatch[1]
      const version = extractJdkVersionFromImage(image)
      const isJava = /openjdk|temurin|corretto|zulu|liberica|java[_-]?\d/i.test(image)
      if (isJava && version && version !== targetJdk) {
        findings.push({
          file: relPath, fileType, line: lineNum, content: line.trim(),
          detectedJdkVersion: version, detectedImage: image,
          description: `Pipeline CI usa imagem JDK ${version} — incompatível com target JDK ${targetJdk}.`,
          suggestion: `Atualize a imagem para JDK ${targetJdk} (ex: 'eclipse-temurin:${targetJdk}').`,
          severity: 'high',
          requiresHumanDecision: false,
        })
        continue
      }
    }

    for (const { re, label } of jdkPatterns) {
      const m = line.match(re)
      if (m) {
        const version = m[1].replace(/^1\./, '')  // normaliza "1.8" → "8"
        const majorVersion = version.split('.')[0]
        if (majorVersion !== targetJdk) {
          findings.push({
            file: relPath, fileType, line: lineNum, content: line.trim(),
            detectedJdkVersion: majorVersion, detectedImage: null,
            description: `Pipeline CI define ${label}: ${version} — incompatível com target JDK ${targetJdk}.`,
            suggestion: `Atualize para JDK ${targetJdk}.`,
            severity: 'high',
            requiresHumanDecision: false,
          })
        }
        break
      }
    }
  }

  return findings
}

// ─── localização de arquivos ───────────────────────────────────────────────────

function findFiles(rootDir: string, matchers: Array<(name: string) => boolean>): string[] {
  const results: string[] = []
  const MAX_DEPTH = 5

  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }

    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules' || entry === 'target' || entry === 'build') continue
      const full = join(dir, entry)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        walk(full, depth + 1)
      } else if (matchers.some(fn => fn(entry))) {
        results.push(full)
      }
    }
  }

  walk(rootDir, 0)
  return results
}

// ─── ponto de entrada ─────────────────────────────────────────────────────────

export function scanContainersAndCi(
  projectPath: string,
  targetJdk: string,
): ContainerCiScanResult {
  const findings: ContainerFinding[] = []
  const filesScanned: string[] = []

  // Dockerfiles
  const dockerfiles = findFiles(projectPath, [
    name => name === 'Dockerfile' || /^Dockerfile\./i.test(name),
  ])
  for (const f of dockerfiles) {
    filesScanned.push(relative(projectPath, f))
    findings.push(...scanDockerfile(f, projectPath, targetJdk))
  }

  // docker-compose
  const composeFiles = findFiles(projectPath, [
    name => /^docker-compose[.-]?.*\.ya?ml$/i.test(name),
  ])
  for (const f of composeFiles) {
    filesScanned.push(relative(projectPath, f))
    findings.push(...scanDockerCompose(f, projectPath, targetJdk))
  }

  // GitHub Actions
  const ghWorkflowDir = join(projectPath, '.github', 'workflows')
  if (existsSync(ghWorkflowDir)) {
    const ghFiles = findFiles(ghWorkflowDir, [name => /\.ya?ml$/i.test(name)])
    for (const f of ghFiles) {
      filesScanned.push(relative(projectPath, f))
      findings.push(...scanCiFile(f, projectPath, targetJdk, 'github-actions'))
    }
  }

  // GitLab CI
  const gitlabFiles = findFiles(projectPath, [
    name => name === '.gitlab-ci.yml' || /^\.gitlab-ci.*\.ya?ml$/i.test(name),
  ])
  for (const f of gitlabFiles) {
    filesScanned.push(relative(projectPath, f))
    findings.push(...scanCiFile(f, projectPath, targetJdk, 'gitlab-ci'))
  }

  // Jenkinsfile
  const jenkinsFiles = findFiles(projectPath, [
    name => name === 'Jenkinsfile' || /^Jenkinsfile/i.test(name),
  ])
  for (const f of jenkinsFiles) {
    filesScanned.push(relative(projectPath, f))
    findings.push(...scanCiFile(f, projectPath, targetJdk, 'jenkinsfile'))
  }

  // Azure Pipelines
  const azureFiles = findFiles(projectPath, [
    name => /^azure-pipelines.*\.ya?ml$/i.test(name),
  ])
  for (const f of azureFiles) {
    filesScanned.push(relative(projectPath, f))
    findings.push(...scanCiFile(f, projectPath, targetJdk, 'azure-pipelines'))
  }

  // Travis CI
  const travisPath = join(projectPath, '.travis.yml')
  if (existsSync(travisPath)) {
    filesScanned.push('.travis.yml')
    findings.push(...scanCiFile(travisPath, projectPath, targetJdk, 'travis'))
  }

  // CircleCI
  const circlePath = join(projectPath, '.circleci', 'config.yml')
  if (existsSync(circlePath)) {
    filesScanned.push('.circleci/config.yml')
    findings.push(...scanCiFile(circlePath, projectPath, targetJdk, 'circleci'))
  }

  return {
    findings,
    filesScanned,
    hasIncompatibleImages: findings.some(f => f.fileType === 'dockerfile' || f.fileType === 'docker-compose'),
    hasIncompatibleCiJdk: findings.some(f => !['dockerfile', 'docker-compose'].includes(f.fileType)),
  }
}
