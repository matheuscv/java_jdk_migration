import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { ejbProfiler } from '../../src/profilers/ejb/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['ejb'],
    buildSystem: 'maven', appServer: 'jboss', multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

function makeTempProject(files: Record<string, string>): string {
  const dir = join(tmpdir(), `ejb-prof-${randomBytes(4).toString('hex')}`)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

describe('ejbProfiler — stackType', () => {
  it('stackType é ejb', () => {
    expect(ejbProfiler.stackType).toBe('ejb')
  })
})

describe('ejbProfiler — @Stateful (CRÍTICO, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @Stateful como critical e automationAvailable: false', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/CartBean.java': `
        import javax.ejb.Stateful;
        @Stateful
        public class CartBean { private List<String> items = new ArrayList<>(); }
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-stateful')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
    expect(risk?.recipe).toBeNull()
  })

  it('cria ManualReviewItem para redesenho de @Stateful', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/CartBean.java': '@Stateful public class CartBean {}',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'ejb-stateful-redesign')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('semantic')
    expect(manual?.files.some(f => f.includes('CartBean'))).toBe(true)
  })
})

describe('ejbProfiler — SessionContext (CRÍTICO, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta SessionContext como critical', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/OrderBean.java': `
        import javax.ejb.SessionContext;
        public class OrderBean {
          @Resource private SessionContext ctx;
          public void cancel() { ctx.setRollbackOnly(); }
        }
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-session-context')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('cria ManualReviewItem para substituição de SessionContext', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/OrderBean.java': 'SessionContext ctx;',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'ejb-session-context-manual')
    expect(manual).toBeDefined()
    expect(manual?.suggestedApproach).toContain('getUserPrincipal')
  })
})

describe('ejbProfiler — @Stateless (médio, automação disponível)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @Stateless como medium com recipe EJB Jakarta', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/OrderService.java': `
        import javax.ejb.Stateless;
        @Stateless public class OrderService {}
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-stateless')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('medium')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('JavaxEjbMigrationToJakartaEjb')
  })
})

describe('ejbProfiler — @Remote (CRÍTICO, sem automação)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @Remote como critical', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/OrderRemote.java': `
        import javax.ejb.Remote;
        @Remote public interface OrderRemote { void place(); }
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-remote')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('cria ManualReviewItem de redesenho para @Remote', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/OrderRemote.java': '@Remote public interface OrderRemote {}',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'ejb-remote-redesign')
    expect(manual).toBeDefined()
    expect(manual?.suggestedApproach).toContain('REST')
  })
})

describe('ejbProfiler — UserTransaction (CRÍTICO)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta UserTransaction como critical sem automação', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/TxBean.java': `
        import javax.transaction.UserTransaction;
        public class TxBean {
          @Resource UserTransaction ut;
          public void run() { ut.begin(); }
        }
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-user-transaction')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
  })
})

describe('ejbProfiler — @MessageDriven (alto, automação disponível)', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta @MessageDriven como high com recipe e ManualReviewItem de broker', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/NotifMDB.java': `
        import javax.ejb.MessageDriven;
        @MessageDriven(activationConfig = {})
        public class NotifMDB implements MessageListener {}
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-mdb')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)

    const manual = report.manualReviewItems.find(m => m.id === 'ejb-mdb-broker')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('behavioral')
  })
})

describe('ejbProfiler — JNDI lookup manual', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta InitialContext().lookup como high sem automação', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Locator.java': `
        public class Locator {
          Object find() throws Exception {
            return new InitialContext().lookup("java:comp/env/ejb/Order");
          }
        }
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-jndi-lookup')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
  })
})

describe('ejbProfiler — ejb-jar.xml', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detecta ejb-jar.xml como medium com recipe disponível', async () => {
    dir = makeTempProject({
      'src/main/resources/META-INF/ejb-jar.xml': `
        <ejb-jar xmlns="http://java.sun.com/xml/ns/javaee">
          <enterprise-beans></enterprise-beans>
        </ejb-jar>
      `,
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-jar-xml')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('medium')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('JavaxEjbMigrationToJakartaEjb')
  })
})

describe('ejbProfiler.getRecipes', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('retorna recipe EJB para fase 3 quando @Stateless detectado', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Svc.java': '@Stateless public class Svc {}',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    const recipes = ejbProfiler.getRecipes(3, report)
    expect(recipes).toContain('org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb')
  })

  it('retorna array vazio para fase 3 sem itens automatizáveis', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/StatefulOnly.java': '@Stateful public class StatefulOnly {}',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    expect(ejbProfiler.getRecipes(3, report)).toHaveLength(0)
  })

  it('retorna array vazio para fase != 3', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Svc.java': '@Stateless public class Svc {}',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    expect(ejbProfiler.getRecipes(2, report)).toHaveLength(0)
  })
})

describe('ejbProfiler — projeto sem EJB', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('não detecta riscos em projeto sem anotações EJB', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Plain.java': 'public class Plain { void hello() {} }',
    })
    const report = await ejbProfiler.analyze(dir, makeConfig())
    expect(report.riskItems).toHaveLength(0)
    expect(report.manualReviewItems).toHaveLength(0)
  })
})
