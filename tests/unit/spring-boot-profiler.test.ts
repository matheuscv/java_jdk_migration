import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { springBootProfiler } from '../../src/profilers/spring-boot/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(__dirname, '../fixtures/jdk8-spring-boot')

function makeConfig(projectPath: string): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot', 'spring-batch'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

describe('springBootProfiler.analyze — jdk8-spring-boot fixture', () => {
  it('detecta WebSecurityConfigurerAdapter como risco HIGH', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const risk = report.riskItems.find(r => r.id === 'sb-websecurity-adapter-risk')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('cria ManualReviewItem de segurança para WebSecurityConfigurerAdapter', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const manual = report.manualReviewItems.find(m => m.id === 'sb-websecurity-adapter')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('security')
    expect(manual?.files.some(f => f.includes('SecurityConfig'))).toBe(true)
  })

  it('detecta import javax.security como HIGH com recipe disponível', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const risk = report.riskItems.find(r => r.id === 'sb-javax-security')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
    // recipe contém 'Security' e 'jakarta'
    expect(risk?.recipe).toContain('Security')
    expect(risk?.recipe).toContain('jakarta')
  })

  it('detecta JUnit 4 como medium com recipe disponível', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const risk = report.riskItems.find(r => r.id === 'sb-junit4')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('medium')
    expect(risk?.recipe).toContain('JUnit4to5')
  })

  it('detecta versão Spring Boot 2.x para upgrade', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const risk = report.riskItems.find(r => r.id === 'sb-version-upgrade')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('UpgradeSpringBoot_3_0')
  })

  it('prerequisiteCheck indica Spring Boot versão detectada', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const check = report.prerequisiteChecks.find(c => c.name === 'Spring Boot versão detectada')
    expect(check?.passed).toBe(true)
    expect(check?.message).toContain('2.7')
  })

  it('stackType é spring-boot', () => {
    expect(springBootProfiler.stackType).toBe('spring-boot')
  })
})

describe('springBootProfiler.getRecipes — fase 3', () => {
  it('retorna recipe javax.security quando risco detectado', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    const recipes = springBootProfiler.getRecipes(3, report)
    expect(recipes.some(r => r.includes('security') || r.includes('Security'))).toBe(true)
  })

  it('retorna array vazio para fase 2', async () => {
    const report = await springBootProfiler.analyze(FIXTURE, makeConfig(FIXTURE))
    expect(springBootProfiler.getRecipes(2, report)).toHaveLength(0)
  })
})

describe('springBootProfiler — projeto sem Security', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `sb-prof-${randomBytes(4).toString('hex')}`)
    mkdirSync(join(dir, 'src/main/java/com/example'), { recursive: true })
    writeFileSync(join(dir, 'pom.xml'), `
<project>
  <parent>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>2.7.18</version>
  </parent>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
</project>`)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('não detecta WebSecurityConfigurerAdapter quando ausente', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb-websecurity-adapter-risk')).toBeUndefined()
    expect(report.manualReviewItems.find(m => m.id === 'sb-websecurity-adapter')).toBeUndefined()
  })
})
