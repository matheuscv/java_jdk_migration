import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createDefaultPhases } from '../../src/lib/config.js'
import { getProfilersForStacks } from '../../src/orchestrator/profiler-registry.js'
import { ejbProfiler } from '../../src/profilers/ejb/index.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(__dirname, '../fixtures/jdk8-ejb')

function makeConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['ejb'],
    buildSystem: 'maven', appServer: 'jboss', multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

describe('discover — fixture jdk8-ejb', () => {
  it('profiler-registry retorna ejbProfiler + jakartaProfiler para stack ejb', () => {
    const profilers = getProfilersForStacks(['ejb'])
    const types = profilers.map(p => p.stackType)
    expect(types).toContain('ejb')
    expect(types).toContain('jakarta')  // jakarta é transversal para ejb
  })

  it('ejbProfiler detecta @Stateful em CartBean.java como critical', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-stateful')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.file).toContain('CartBean')
  })

  it('ejbProfiler detecta @Remove em CartBean.java', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-remove-annotation')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
  })

  it('ejbProfiler detecta SessionContext em CartBean.java como critical', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-session-context')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('ejbProfiler detecta @Stateless em OrderService.java como medium', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-stateless')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('medium')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('JavaxEjbMigrationToJakartaEjb')
  })

  it('ejbProfiler detecta @MessageDriven em NotificationMDB.java como high', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-mdb')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
  })

  it('ejbProfiler detecta ejb-jar.xml como medium', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'ejb-jar-xml')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('medium')
    expect(risk?.automationAvailable).toBe(true)
  })

  it('ejbProfiler prerequisiteCheck indica @Stateful detectado', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === '@Stateful beans identificados')
    expect(check?.passed).toBe(true)
    expect(check?.message).toContain('revisão manual obrigatória')
  })

  it('ejbProfiler cria ManualReviewItems para @Stateful e SessionContext', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const ids = report.manualReviewItems.map(m => m.id)
    expect(ids).toContain('ejb-stateful-redesign')
    expect(ids).toContain('ejb-session-context-manual')
  })

  it('estimatedEffortDays > 0 dado o nível de complexidade do fixture', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    expect(report.estimatedEffortDays).toBeGreaterThan(0)
  })

  it('getRecipes fase 3 retorna recipe Jakarta EJB (Stateless automatizável)', async () => {
    const report = await ejbProfiler.analyze(FIXTURE, makeConfig())
    const recipes = ejbProfiler.getRecipes(3, report)
    expect(recipes).toContain('org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb')
  })
})
