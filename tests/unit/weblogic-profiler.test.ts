import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { weblogicProfiler } from '../../src/profilers/weblogic/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['weblogic'],
    buildSystem: 'maven', appServer: 'weblogic', multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

function makeTempProject(files: Record<string, string>): string {
  const dir = join(tmpdir(), `wl-prof-${randomBytes(4).toString('hex')}`)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

describe('weblogicProfiler — stackType', () => {
  it('stackType é weblogic', () => {
    expect(weblogicProfiler.stackType).toBe('weblogic')
  })
})

describe('weblogicProfiler — import weblogic.* (CRÍTICO, automação disponível)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta import weblogic.* como critical com recipe Oracle', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/WlService.java': `
        import weblogic.jndi.Environment;
        import weblogic.jdbc.extensions.PooledConnection;
        public class WlService {}
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-proprietary-api')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('UpgradeWebLogic14To21')
  })

  it('cria ManualReviewItem com orientações por API', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/WlService.java': 'import weblogic.management.MBeanHome;',
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'wl-proprietary-api-review')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('semantic')
    expect(manual?.suggestedApproach).toContain('weblogic.jdbc')
    expect(manual?.suggestedApproach).toContain('weblogic.jms')
  })
})

describe('weblogicProfiler — weblogic.jdbc.extensions (CRÍTICO, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta weblogic.jdbc.extensions como critical sem recipe', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Repo.java': `
        import weblogic.jdbc.extensions.PooledConnection;
        public class Repo { PooledConnection conn; }
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-jdbc-extensions')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
    expect(risk?.recipe).toBeNull()
  })
})

describe('weblogicProfiler — protocolo T3:// (CRÍTICO)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta t3:// como critical sem automação', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/JndiLocator.java': `
        public class JndiLocator {
          static final String URL = "t3://localhost:7001";
        }
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-t3-protocol')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('cria ManualReviewItem de redesenho para T3', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/JndiLocator.java': 'String url = "t3://server:7001";',
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'wl-t3-redesign')
    expect(manual).toBeDefined()
    expect(manual?.suggestedApproach).toContain('REST')
  })
})

describe('weblogicProfiler — weblogic.xml (alto, automação disponível)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta weblogic.xml como high com recipe Oracle', async () => {
    dir = makeTempProject({
      'src/main/webapp/WEB-INF/weblogic.xml': `
        <weblogic-web-app xmlns="http://xmlns.oracle.com/weblogic/weblogic-web-app">
          <context-root>/myapp</context-root>
        </weblogic-web-app>
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-descriptor-weblogic-xml')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)

    const check = report.prerequisiteChecks.find(c => c.name === 'weblogic.xml detectado')
    expect(check?.passed).toBe(true)
  })
})

describe('weblogicProfiler — weblogic-application.xml (alto)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta weblogic-application.xml como high com recipe', async () => {
    dir = makeTempProject({
      'src/main/application/META-INF/weblogic-application.xml': `
        <weblogic-application xmlns="http://xmlns.oracle.com/weblogic/weblogic-application">
        </weblogic-application>
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-descriptor-application-xml')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
  })
})

describe('weblogicProfiler — weblogic-ejb-jar.xml', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta weblogic-ejb-jar.xml e cria ManualReviewItem de revisão', async () => {
    dir = makeTempProject({
      'src/main/resources/META-INF/weblogic-ejb-jar.xml': `
        <weblogic-ejb-jar xmlns="http://xmlns.oracle.com/weblogic/weblogic-ejb-jar">
          <weblogic-enterprise-bean>
            <ejb-name>OrderBean</ejb-name>
            <jndi-name>ejb/Order</jndi-name>
          </weblogic-enterprise-bean>
        </weblogic-ejb-jar>
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-descriptor-ejb-jar')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')

    const manual = report.manualReviewItems.find(m => m.id === 'wl-ejb-jar-review')
    expect(manual).toBeDefined()
    expect(manual?.suggestedApproach).toContain('JNDI')
  })
})

describe('weblogicProfiler — weblogic.jms (alto, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta weblogic.jms.* como high', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Sender.java': `
        import weblogic.jms.common.SessionImpl;
        public class Sender {}
      `,
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'wl-jms-proprietary')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
  })
})

describe('weblogicProfiler.getRecipes', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('retorna recipe Oracle para fase 3 quando weblogic.xml detectado', async () => {
    dir = makeTempProject({
      'src/main/webapp/WEB-INF/weblogic.xml': '<weblogic-web-app/>',
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    const recipes = weblogicProfiler.getRecipes(3, report)
    expect(recipes).toContain('com.oracle.weblogic.rewrite.UpgradeWebLogic14To21')
  })

  it('retorna array vazio para fase != 3', async () => {
    dir = makeTempProject({
      'src/main/webapp/WEB-INF/weblogic.xml': '<weblogic-web-app/>',
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    expect(weblogicProfiler.getRecipes(1, report)).toHaveLength(0)
  })

  it('retorna array vazio quando não há itens automatizáveis', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/JndiLocator.java': 'String url = "t3://server:7001";',
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    expect(weblogicProfiler.getRecipes(3, report)).toHaveLength(0)
  })
})

describe('weblogicProfiler — projeto sem WebLogic', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('não detecta riscos em projeto limpo', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Plain.java': 'public class Plain {}',
    })
    const report = await weblogicProfiler.analyze(dir, makeConfig())
    expect(report.riskItems).toHaveLength(0)
    expect(report.manualReviewItems).toHaveLength(0)
  })
})
