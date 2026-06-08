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
    expect(risk?.recipe).toContain('UpgradeSpringBoot_3_')
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

describe('springBootProfiler — @ComponentScan com basePackages', () => {
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
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
</project>`)
    writeFileSync(join(dir, 'src/main/java/com/example/Application.java'), `
package com.example;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

@ComponentScan(basePackages = {"com.example", "br.com.cielo.star"})
@SpringBootApplication
public class Application {
    public static void main(String[] args) { SpringApplication.run(Application.class, args); }
}`)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @ComponentScan com basePackages como risco HIGH', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    const risk = report.riskItems.find(r => r.id === 'sb3-componentscan-broad')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('cria ManualReviewItem behavioral para cobrir exception handlers', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    const manual = report.manualReviewItems.find(m => m.id === 'sb3-componentscan-restrict-handlers')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('behavioral')
    expect(manual?.suggestedApproach).toContain('@ExceptionHandler')
    expect(manual?.files.some(f => f.includes('Application'))).toBe(true)
  })
})

describe('springBootProfiler — @SpringBootApplication com scanBasePackages', () => {
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
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
</project>`)
    writeFileSync(join(dir, 'src/main/java/com/example/Application.java'), `
package com.example;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(scanBasePackages = {"com.example", "br.com.third.party"})
public class Application {
    public static void main(String[] args) { SpringApplication.run(Application.class, args); }
}`)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta scanBasePackages em @SpringBootApplication como risco HIGH', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    const risk = report.riskItems.find(r => r.id === 'sb3-componentscan-broad')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
  })
})

describe('springBootProfiler — sem @ComponentScan amplo', () => {
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
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
</project>`)
    writeFileSync(join(dir, 'src/main/java/com/example/Application.java'), `
package com.example;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) { SpringApplication.run(Application.class, args); }
}`)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('não detecta risco quando @ComponentScan não tem basePackages', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-componentscan-broad')).toBeUndefined()
    expect(report.manualReviewItems.find(m => m.id === 'sb3-componentscan-restrict-handlers')).toBeUndefined()
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

// ─── Kitchen-sink: triggers all uncovered risk paths in one shot ──────────────

describe('springBootProfiler — kitchen-sink pom com todos os riscos', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `sb-ks-${randomBytes(4).toString('hex')}`)
    const src = join(dir, 'src/main/java/com/example')
    mkdirSync(src, { recursive: true })
    mkdirSync(join(dir, 'src/main/resources'), { recursive: true })

    writeFileSync(join(dir, 'pom.xml'), [
      '<project>',
      '  <parent>',
      '    <artifactId>spring-boot-starter-parent</artifactId>',
      '    <version>2.7.18</version>',
      '  </parent>',
      '  <properties>',
      '    <java.version>1.8</java.version>',
      '    <feign.version>10.12</feign.version>',
      '    <httpClient.version>4.5.14</httpClient.version>',
      '  </properties>',
      '  <dependencies>',
      '    <dependency><artifactId>springfox-swagger2</artifactId></dependency>',
      '    <dependency><artifactId>feign-core</artifactId></dependency>',
      '    <dependency><artifactId>jersey-hk2</artifactId></dependency>',
      '    <dependency>',
      '      <artifactId>jaxb-runtime</artifactId>',
      '      <version>2.3.8</version>',
      '    </dependency>',
      '    <dependency><artifactId>logback-jackson</artifactId></dependency>',
      '    <dependency><artifactId>spring-boot-starter-actuator</artifactId></dependency>',
      '    <dependency><artifactId>ojdbc8</artifactId></dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n'))

    writeFileSync(join(src, 'AppController.java'), [
      'package com.example;',
      'import org.springframework.http.MediaType;',
      'import org.springframework.security.config.annotation.authentication.builders.AuthenticationManagerBuilder;',
      'import javax.security.auth.Subject;',
      'import org.junit.Test;',
      'import org.junit.Assert;',
      'public class AppController {',
      '  static String CONTENT_TYPE = MediaType.APPLICATION_JSON_UTF8_VALUE;',
      '  void configure(AuthenticationManagerBuilder auth) {}',
      '  @Test public void testSomething() { Assert.assertTrue(true); }',
      '}',
    ].join('\n'))

    writeFileSync(join(dir, 'src/main/resources/application.properties'), [
      'management.endpoints.web.exposure.include=*',
      'management.metrics.export.prometheus.enabled=true',
      'spring.datasource.initialization-mode=always',
      'spring.security.oauth2.resourceserver.jwt.issuer-uri=https://auth.example.com',
    ].join('\n'))
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta APPLICATION_JSON_UTF8_VALUE como critical', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-utf8-mediatype-removed')).toBeDefined()
  })

  it('detecta springfox como bloqueador crítico e cria manualItem', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-springfox-blocker')).toBeDefined()
    expect(report.manualReviewItems.find(m => m.id === 'sb3-springfox-migration')).toBeDefined()
  })

  it('detecta feign < 11 como medium', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-feign-options-api-break')).toBeDefined()
  })

  it('detecta httpclient 4.x como medium', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-httpclient4-explicit')).toBeDefined()
  })

  it('detecta jersey2 como high e cria manualItem', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-jersey2-namespace')).toBeDefined()
    expect(report.manualReviewItems.find(m => m.id === 'sb3-jersey2-decision')).toBeDefined()
  })

  it('detecta jaxb-runtime 2.x como high', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-jaxb-runtime-version')).toBeDefined()
  })

  it('detecta logback-contrib como low', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-logback-contrib-outdated')).toBeDefined()
  })

  it('detecta prometheus actuator props renomeadas', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb3-actuator-props-renamed')).toBeDefined()
  })

  it('detecta AuthenticationManagerBuilder como manualItem', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.manualReviewItems.find(m => m.id === 'sb-auth-manager-builder')).toBeDefined()
  })

  it('detecta oauth2 properties como medium', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb-oauth2-properties')).toBeDefined()
  })

  it('detecta actuator security como manualItem', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.manualReviewItems.find(m => m.id === 'sb-actuator-security')).toBeDefined()
  })

  it('detecta datasource initialization-mode legado como medium', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb-datasource-legacy')).toBeDefined()
  })

  it('detecta JUnit 4 como medium e cria manualItem', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'sb-junit4')).toBeDefined()
    expect(report.manualReviewItems.find(m => m.id === 'sb3-junit4-strategy')).toBeDefined()
  })

  it('detecta ojdbc8 como high', async () => {
    const report = await springBootProfiler.analyze(dir, makeConfig(dir))
    expect(report.riskItems.find(r => r.id === 'oracle-ojdbc8-jdk21')).toBeDefined()
  })
})

// ─── getRecipes — fase 3 com todos os riscos ──────────────────────────────────

describe('springBootProfiler.getRecipes — fase 3', () => {
  it('retorna recipes para javax.security, datasource, actuator, junit4 quando presentes', () => {
    const fakeReport = {
      stackType: 'spring-boot' as const,
      riskItems: [
        { id: 'sb-javax-security', severity: 'high' as const, title: '', description: '', file: '', line: null, automationAvailable: true, recipe: null },
        { id: 'sb-datasource-legacy', severity: 'medium' as const, title: '', description: '', file: '', line: null, automationAvailable: true, recipe: null },
        { id: 'sb3-actuator-props-renamed', severity: 'low' as const, title: '', description: '', file: '', line: null, automationAvailable: true, recipe: null },
        { id: 'sb-junit4', severity: 'medium' as const, title: '', description: '', file: '', line: null, automationAvailable: true, recipe: null },
      ],
      manualReviewItems: [],
    }
    const recipes = springBootProfiler.getRecipes(3, fakeReport)
    expect(recipes).toContain('org.openrewrite.java.migrate.jakarta.JavaxSecurityMigrationToJakartaSecurity')
    expect(recipes).toContain('org.openrewrite.java.spring.boot2.SpringBootProperties_2_5')
    expect(recipes).toContain('org.openrewrite.java.spring.boot3.ActuatorEndpointSanitization')
    expect(recipes).toContain('org.openrewrite.java.testing.junit5.JUnit4to5Migration')
  })

  it('retorna lista vazia para fase diferente de 3', () => {
    const recipes = springBootProfiler.getRecipes(0, { stackType: 'spring-boot', riskItems: [], manualReviewItems: [] })
    expect(recipes).toHaveLength(0)
  })
})
