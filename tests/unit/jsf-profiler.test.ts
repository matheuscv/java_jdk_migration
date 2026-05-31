import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { jsfProfiler } from '../../src/profilers/jsf/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['jsf'],
    buildSystem: 'maven', appServer: 'jboss', multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

function makeTempProject(files: Record<string, string>): string {
  const dir = join(tmpdir(), `jsf-prof-${randomBytes(4).toString('hex')}`)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

describe('jsfProfiler — stackType', () => {
  it('stackType é jsf', () => {
    expect(jsfProfiler.stackType).toBe('jsf')
  })
})

describe('jsfProfiler — javax.faces namespace (alto, automação disponível)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta javax.faces como high com recipe OpenRewrite', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/IndexBean.java': `
        import javax.faces.bean.ManagedBean;
        import javax.faces.context.FacesContext;
        public class IndexBean {}
      `,
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'jsf-javax-namespace')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('JavaxFacesMigrationToJakartaFaces')
  })
})

describe('jsfProfiler — @ManagedBean (alto, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @ManagedBean como high sem recipe', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/CartBean.java': `
        import javax.faces.bean.ManagedBean;
        @ManagedBean public class CartBean {}
      `,
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'jsf-managed-bean')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
    expect(risk?.recipe).toBeNull()
  })

  it('cria ManualReviewItem com categoria semantic para @ManagedBean', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/CartBean.java': '@ManagedBean public class CartBean {}',
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'jsf-managed-bean-cdi')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('semantic')
    expect(manual?.files.some(f => f.includes('CartBean'))).toBe(true)
    expect(manual?.suggestedApproach).toContain('@Named')
  })
})

describe('jsfProfiler — @ManagedProperty (alto, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @ManagedProperty como high', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/OrderBean.java': `
        import javax.faces.bean.ManagedProperty;
        @ManagedProperty(value="#{userService}") private UserService svc;
      `,
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'jsf-managed-property')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
  })
})

describe('jsfProfiler — PrimeFaces version', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta PrimeFaces < 13 como high e cria ManualReviewItem de upgrade', async () => {
    dir = makeTempProject({
      'pom.xml': `
        <project>
          <dependencies>
            <dependency>
              <groupId>org.primefaces</groupId>
              <artifactId>primefaces</artifactId>
              <version>8.0</version>
            </dependency>
          </dependencies>
        </project>
      `,
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'jsf-primefaces-version')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
    expect(risk?.title).toContain('8.0')

    const manual = report.manualReviewItems.find(m => m.id === 'jsf-primefaces-upgrade')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('ui')
  })

  it('não detecta problema quando PrimeFaces >= 13', async () => {
    dir = makeTempProject({
      'pom.xml': `
        <project>
          <dependencies>
            <dependency>
              <artifactId>primefaces</artifactId>
              <version>13.0.0</version>
            </dependency>
          </dependencies>
        </project>
      `,
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    expect(report.riskItems.find(r => r.id === 'jsf-primefaces-version')).toBeUndefined()
  })

  it('prerequisiteCheck PrimeFaces detectado quando presente no pom', async () => {
    dir = makeTempProject({
      'pom.xml': '<project><dependencies><dependency><artifactId>primefaces</artifactId><version>8.0</version></dependency></dependencies></project>',
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === 'PrimeFaces detectado')
    expect(check?.passed).toBe(true)
    expect(check?.message).toContain('8.0')
  })
})

describe('jsfProfiler — faces-config.xml', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta faces-config.xml como medium com recipe disponível', async () => {
    dir = makeTempProject({
      'src/main/webapp/WEB-INF/faces-config.xml': `
        <faces-config xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="2.3">
        </faces-config>
      `,
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'jsf-faces-config')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('medium')
    expect(risk?.automationAvailable).toBe(true)

    const check = report.prerequisiteChecks.find(c => c.name === 'faces-config.xml detectado')
    expect(check?.passed).toBe(true)
  })
})

describe('jsfProfiler — XHTML templates', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('cria ManualReviewItem de revisão visual quando XHTML encontrado', async () => {
    dir = makeTempProject({
      'src/main/webapp/index.xhtml': '<html xmlns:h="http://java.sun.com/jsf/html"><h:body/></html>',
      'src/main/webapp/cart.xhtml': '<html><h:body/></html>',
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'jsf-xhtml-review')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('ui')
    expect(manual?.title).toContain('2')
  })
})

describe('jsfProfiler.getRecipes', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('retorna recipe Faces para fase 3 quando javax.faces detectado', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Bean.java': 'import javax.faces.context.FacesContext;',
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    const recipes = jsfProfiler.getRecipes(3, report)
    expect(recipes).toContain('org.openrewrite.java.migrate.jakarta.JavaxFacesMigrationToJakartaFaces')
  })

  it('retorna array vazio para fase != 3', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Bean.java': 'import javax.faces.context.FacesContext;',
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    expect(jsfProfiler.getRecipes(2, report)).toHaveLength(0)
  })
})

describe('jsfProfiler — projeto sem JSF', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('não detecta riscos em projeto limpo', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Plain.java': 'public class Plain {}',
    })
    const report = await jsfProfiler.analyze(dir, makeConfig())
    expect(report.riskItems).toHaveLength(0)
    expect(report.manualReviewItems).toHaveLength(0)
  })
})
