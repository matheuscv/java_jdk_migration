/**
 * Testes unitários para infrastructure-transformer.ts
 * Cobre E1.1 (Docker/CI), E1.2 (JVM flags), E1.3 (K8s), E1.4 (Maven profiles)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runInfrastructureTransform } from '../../src/transform-engine/infrastructure-transformer.js'

function tempDir(): string {
  const dir = join(tmpdir(), `infra-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function write(base: string, rel: string, content: string): void {
  const parts = rel.split('/')
  if (parts.length > 1) mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(base, rel), content, 'utf-8')
}

function read(base: string, rel: string): string {
  return readFileSync(join(base, rel), 'utf-8')
}

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── E1.1 — Docker images ────────────────────────────────────────────────────

describe('E1.1 — updateDockerImages', () => {
  it('atualiza FROM openjdk:8-jre para eclipse-temurin:21-jre-jammy', async () => {
    write(dir, 'Dockerfile', 'FROM openjdk:8-jre\nCMD ["java","-jar","app.jar"]\n')
    const result = await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'Dockerfile')
    expect(content).toContain('eclipse-temurin')
    expect(content).toContain('21')
    expect(content).not.toContain('openjdk:8')
    expect(result.detail.dockerfilesUpdated.length).toBeGreaterThan(0)
  })

  it('atualiza FROM openjdk:11 para eclipse-temurin:21', async () => {
    write(dir, 'Dockerfile', 'FROM openjdk:11-jdk\nCMD ["java"]\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'Dockerfile')
    expect(content).toContain('21')
    expect(content).not.toContain('openjdk:11')
  })

  it('atualiza FROM amazoncorretto:8', async () => {
    write(dir, 'Dockerfile', 'FROM amazoncorretto:8\nCMD ["java"]\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'Dockerfile')
    expect(content).toContain('amazoncorretto')
    expect(content).toContain('21')
  })

  it('não altera Dockerfile que já usa :21', async () => {
    const original = 'FROM eclipse-temurin:21-jre\nCMD ["java","-jar","app.jar"]\n'
    write(dir, 'Dockerfile', original)
    const result = await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'Dockerfile')
    expect(content).toBe(original)
  })

  it('dryRun não modifica o arquivo', async () => {
    const original = 'FROM openjdk:8-jre\nCMD ["java"]\n'
    write(dir, 'Dockerfile', original)
    const result = await runInfrastructureTransform(dir, '21', true)
    const content = read(dir, 'Dockerfile')
    expect(content).toBe(original)
    expect(result.filesModified).toBe(0)
  })

  it('atualiza image: em docker-compose.yml', async () => {
    write(dir, 'docker-compose.yml',
      'services:\n  app:\n    image: openjdk:8-jre\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'docker-compose.yml')
    expect(content).toContain('21')
    expect(content).not.toContain('openjdk:8')
  })

  it('atualiza múltiplos estágios no mesmo Dockerfile (multi-stage)', async () => {
    write(dir, 'Dockerfile',
      'FROM openjdk:8 AS builder\nRUN mvn package\nFROM openjdk:8-jre\nCMD ["java"]\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'Dockerfile')
    expect(content).not.toContain('openjdk:8')
  })
})

// ─── E1.1 — CI java-version ──────────────────────────────────────────────────

describe('E1.1 — updateCiJavaVersion', () => {
  it('atualiza java-version: "8" para "21" no GitHub Actions', async () => {
    write(dir, '.github/workflows/ci.yml',
      'steps:\n  - uses: actions/setup-java@v4\n    with:\n      java-version: "8"\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.github/workflows/ci.yml')
    expect(content).toContain('java-version: "21"')
    expect(content).not.toContain('"8"')
  })

  it('atualiza java-version: 11 sem aspas', async () => {
    write(dir, '.github/workflows/ci.yml',
      'with:\n  java-version: 11\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.github/workflows/ci.yml')
    expect(content).toContain('java-version: 21')
  })

  it('atualiza JAVA_VERSION: 8 em CI', async () => {
    write(dir, '.gitlab-ci.yml',
      'variables:\n  JAVA_VERSION: "8"\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.gitlab-ci.yml')
    expect(content).toContain('JAVA_VERSION: "21"')
  })

  it('não altera se java-version já é 21', async () => {
    const original = 'with:\n  java-version: 21\n'
    write(dir, '.github/workflows/ci.yml', original)
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.github/workflows/ci.yml')
    expect(content).toBe(original)
  })

  it('registra ciFilesUpdated no detail', async () => {
    write(dir, '.github/workflows/ci.yml',
      'with:\n  java-version: 8\n')
    const result = await runInfrastructureTransform(dir, '21', false)
    expect(result.detail.ciFilesUpdated.length).toBeGreaterThan(0)
  })
})

// ─── E1.2 — JVM flags obsoletas ──────────────────────────────────────────────

describe('E1.2 — cleanFlagsInText', () => {
  it('remove -XX:MaxPermSize do .mvn/jvm.config', async () => {
    write(dir, '.mvn/jvm.config', '-XX:MaxPermSize=256m -Xmx512m\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.mvn/jvm.config')
    expect(content).not.toContain('MaxPermSize')
    expect(content).toContain('-Xmx512m')
  })

  it('remove -XX:+UseConcMarkSweepGC do jvm.config', async () => {
    write(dir, '.mvn/jvm.config', '-XX:+UseConcMarkSweepGC -Xmx1g\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.mvn/jvm.config')
    expect(content).not.toContain('ConcMarkSweepGC')
    expect(content).toContain('-Xmx1g')
  })

  it('remove -XX:PermSize do jvm.config', async () => {
    write(dir, '.mvn/jvm.config', '-XX:PermSize=128m -Xmx512m\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.mvn/jvm.config')
    expect(content).not.toContain('PermSize')
  })

  it('substitui -XX:+PrintGCDetails por -Xlog:gc*', async () => {
    write(dir, '.mvn/jvm.config', '-XX:+PrintGCDetails -Xmx512m\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.mvn/jvm.config')
    expect(content).toContain('-Xlog:gc*')
    expect(content).not.toContain('PrintGCDetails')
  })

  it('remove -Djava.security.manager=allow do jvm.config', async () => {
    write(dir, '.mvn/jvm.config', '-Djava.security.manager=allow -Xmx256m\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, '.mvn/jvm.config')
    expect(content).not.toContain('java.security.manager')
  })

  it('registra mvnJvmConfigCleaned quando flags foram removidas', async () => {
    write(dir, '.mvn/jvm.config', '-XX:MaxPermSize=256m\n')
    const result = await runInfrastructureTransform(dir, '21', false)
    expect(result.detail.mvnJvmConfigCleaned).toBe(true)
  })
})

// ─── E1.3 — K8s/Helm manifests ───────────────────────────────────────────────

describe('E1.3 — K8s/Helm manifests', () => {
  it('atualiza imagem JDK em deployment.yaml do diretório k8s/', async () => {
    write(dir, 'k8s/deployment.yaml',
      'containers:\n- name: app\n  image: openjdk:8-jre\n')
    const result = await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'k8s/deployment.yaml')
    expect(content).not.toContain('openjdk:8')
    expect(result.detail.k8sFilesUpdated.length).toBeGreaterThan(0)
  })

  it('atualiza manifests em diretório kubernetes/', async () => {
    write(dir, 'kubernetes/deploy.yaml',
      'image: amazoncorretto:8\n')
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'kubernetes/deploy.yaml')
    expect(content).not.toContain('amazoncorretto:8')
    expect(content).toContain('21')
  })

  it('registra Helm templates como humanConfirmationNeeded (contêm {{ }})', async () => {
    write(dir, 'helm/templates/deployment.yaml',
      'image: {{ .Values.image.repository }}:{{ .Values.image.tag }}\n')
    const result = await runInfrastructureTransform(dir, '21', false)
    // Arquivo com template não deve ser editado automaticamente
    const content = read(dir, 'helm/templates/deployment.yaml')
    expect(content).toContain('{{ .Values')
    // Deve ter sido registrado como humanConfirmationNeeded
    expect(result.detail.humanConfirmationNeeded.length).toBeGreaterThan(0)
  })

  it('não altera manifests K8s que já usam JDK 21', async () => {
    const original = 'image: eclipse-temurin:21-jre\n'
    write(dir, 'k8s/deployment.yaml', original)
    await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'k8s/deployment.yaml')
    expect(content).toBe(original)
  })
})

// ─── E1.4 — Maven profiles ───────────────────────────────────────────────────

describe('E1.4 — Maven profile neutralization', () => {
  it('neutraliza profile com ativação por JDK 1.8 E maven.compiler.source', async () => {
    write(dir, 'pom.xml', `<project>
  <profiles>
    <profile>
      <id>jdk8-compat</id>
      <activation><jdk>1.8</jdk></activation>
      <properties><maven.compiler.source>1.8</maven.compiler.source></properties>
    </profile>
  </profiles>
</project>`)
    const result = await runInfrastructureTransform(dir, '21', false)
    const content = read(dir, 'pom.xml')
    expect(content).not.toContain('<jdk>1.8</jdk>')
    expect(result.detail.mavenProfilesNeutralized).toBeGreaterThan(0)
  })

  it('neutraliza profile com ativação [1.6,1.9) E maven.compiler.release', async () => {
    write(dir, 'pom.xml', `<project>
  <profiles>
    <profile>
      <id>legacy</id>
      <activation><jdk>[1.6,1.9)</jdk></activation>
      <properties><maven.compiler.release>8</maven.compiler.release></properties>
    </profile>
  </profiles>
</project>`)
    const result = await runInfrastructureTransform(dir, '21', false)
    expect(result.detail.mavenProfilesNeutralized).toBeGreaterThan(0)
  })

  it('não altera profiles sem ativação por JDK', async () => {
    const original = `<project>
  <profiles>
    <profile>
      <id>prod</id>
      <activation><activeByDefault>true</activeByDefault></activation>
    </profile>
  </profiles>
</project>`
    write(dir, 'pom.xml', original)
    const result = await runInfrastructureTransform(dir, '21', false)
    expect(result.detail.mavenProfilesNeutralized).toBe(0)
  })
})

// ─── resultado geral ──────────────────────────────────────────────────────────

describe('runInfrastructureTransform — resultado geral', () => {
  it('retorna recipesApplied quando há mudanças', async () => {
    write(dir, 'Dockerfile', 'FROM openjdk:8-jre\nCMD ["java"]\n')
    const result = await runInfrastructureTransform(dir, '21', false)
    expect(result.recipesApplied.length).toBeGreaterThan(0)
  })

  it('retorna diffSummary vazio quando não há mudanças', async () => {
    const result = await runInfrastructureTransform(dir, '21', false)
    // Projeto vazio — nenhuma mudança
    expect(result.filesModified).toBe(0)
  })

  it('dryRun retorna filesModified=0 mesmo com mudanças pendentes', async () => {
    write(dir, 'Dockerfile', 'FROM openjdk:8-jre\nCMD ["java"]\n')
    write(dir, '.mvn/jvm.config', '-XX:MaxPermSize=256m\n')
    const result = await runInfrastructureTransform(dir, '21', true)
    expect(result.filesModified).toBe(0)
    // Mas o diff deve indicar o que seria mudado
    expect(result.diffSummary.length).toBeGreaterThan(0)
  })

  it('detail tem todas as propriedades esperadas', async () => {
    const result = await runInfrastructureTransform(dir, '21', false)
    expect(result.detail).toHaveProperty('dockerfilesUpdated')
    expect(result.detail).toHaveProperty('ciFilesUpdated')
    expect(result.detail).toHaveProperty('k8sFilesUpdated')
    expect(result.detail).toHaveProperty('scriptsUpdated')
    expect(result.detail).toHaveProperty('mvnJvmConfigCleaned')
    expect(result.detail).toHaveProperty('mavenProfilesNeutralized')
    expect(result.detail).toHaveProperty('humanConfirmationNeeded')
  })
})
