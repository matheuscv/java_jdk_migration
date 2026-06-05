import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdirpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { scanContainersAndCi } from '../../src/static-analysis/container-ci-scanner.js'

function tempDir(): string {
  const dir = join(tmpdir(), `cci-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function write(base: string, relPath: string, content: string): void {
  const full = join(base, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf-8')
}

describe('scanContainersAndCi — Dockerfile', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta FROM openjdk:8 como incompatível com target 21', () => {
    write(dir, 'Dockerfile', 'FROM openjdk:8-jre-alpine\nRUN echo ok\n')
    const result = scanContainersAndCi(dir, '21')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].detectedJdkVersion).toBe('8')
    expect(result.findings[0].severity).toBe('critical')
    expect(result.findings[0].fileType).toBe('dockerfile')
    expect(result.hasIncompatibleImages).toBe(true)
  })

  it('não reporta FROM openjdk:21 (já correto)', () => {
    write(dir, 'Dockerfile', 'FROM eclipse-temurin:21-jre\nRUN echo ok\n')
    const result = scanContainersAndCi(dir, '21')
    expect(result.findings.filter(f => f.fileType === 'dockerfile')).toHaveLength(0)
  })

  it('detecta FROM scratch como não-Java (sem finding)', () => {
    write(dir, 'Dockerfile', 'FROM scratch\nADD app /app\n')
    const result = scanContainersAndCi(dir, '21')
    expect(result.findings).toHaveLength(0)
  })

  it('detecta imagem privada corporativa com requiresHumanDecision=true', () => {
    write(dir, 'Dockerfile', 'FROM registry.corp.com/infra/jre-java-8:0.0.3\nRUN echo ok\n')
    const result = scanContainersAndCi(dir, '21')
    const f = result.findings.find(x => x.fileType === 'dockerfile')
    expect(f).toBeDefined()
    expect(f!.requiresHumanDecision).toBe(true)
    expect(f!.detectedJdkVersion).toBe('8')
  })

  it('detecta ENV JAVA_HOME com JDK antigo', () => {
    write(dir, 'Dockerfile', 'FROM eclipse-temurin:21\nENV JAVA_HOME=/usr/lib/jvm/java-8-openjdk\n')
    const result = scanContainersAndCi(dir, '21')
    const envFinding = result.findings.find(f => f.content.includes('JAVA_HOME'))
    expect(envFinding).toBeDefined()
    expect(envFinding!.detectedJdkVersion).toBe('8')
  })

  it('registra o arquivo no filesScanned', () => {
    write(dir, 'Dockerfile', 'FROM openjdk:11\n')
    const result = scanContainersAndCi(dir, '21')
    expect(result.filesScanned).toContain('Dockerfile')
  })
})

describe('scanContainersAndCi — GitHub Actions', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta java-version: 8 no workflow', () => {
    write(dir, '.github/workflows/ci.yml', [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/setup-java@v3',
      '        with:',
      '          java-version: \'8\'',
      '          distribution: zulu',
    ].join('\n'))
    const result = scanContainersAndCi(dir, '21')
    expect(result.hasIncompatibleCiJdk).toBe(true)
    const f = result.findings.find(x => x.fileType === 'github-actions')
    expect(f).toBeDefined()
    expect(f!.detectedJdkVersion).toBe('8')
  })

  it('não reporta java-version: 21 (já correto)', () => {
    write(dir, '.github/workflows/ci.yml', [
      'steps:',
      '  - uses: actions/setup-java@v3',
      '    with:',
      '      java-version: \'21\'',
    ].join('\n'))
    const result = scanContainersAndCi(dir, '21')
    expect(result.findings.filter(f => f.fileType === 'github-actions')).toHaveLength(0)
  })
})

describe('scanContainersAndCi — GitLab CI', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta image: openjdk:8 no .gitlab-ci.yml', () => {
    write(dir, '.gitlab-ci.yml', [
      'image: openjdk:8',
      'build:',
      '  script: mvn package',
    ].join('\n'))
    const result = scanContainersAndCi(dir, '21')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings[0].detectedJdkVersion).toBe('8')
  })
})

describe('scanContainersAndCi — sem arquivos de infraestrutura', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('retorna estrutura vazia quando não há arquivos CI/Docker', () => {
    write(dir, 'pom.xml', '<project></project>')
    const result = scanContainersAndCi(dir, '21')
    expect(result.findings).toHaveLength(0)
    expect(result.filesScanned).toHaveLength(0)
    expect(result.hasIncompatibleImages).toBe(false)
    expect(result.hasIncompatibleCiJdk).toBe(false)
  })
})
