import { describe, it, expect } from 'vitest'
import { selectRecipes } from '../../src/transform-engine/recipe-selector.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
    ...overrides,
  }
}

describe('selectRecipes — fase 0', () => {
  it('returns no recipe sets for phase 0', () => {
    expect(selectRecipes(0, makeConfig())).toHaveLength(0)
  })
})

describe('selectRecipes — fase 1 (build infrastructure)', () => {
  it('returns build-updater runner', () => {
    const sets = selectRecipes(1, makeConfig())
    expect(sets).toHaveLength(1)
    expect(sets[0].runner).toBe('build-updater')
  })

  it('includes update-compiler-target-21 recipe', () => {
    const sets = selectRecipes(1, makeConfig())
    expect(sets[0].recipes).toContain('update-compiler-target-21')
  })

  it('returns build-updater regardless of stack', () => {
    const sets = selectRecipes(1, makeConfig({ stack: ['ejb'] }))
    expect(sets[0].runner).toBe('build-updater')
  })
})

describe('selectRecipes — fase 2 (language migration)', () => {
  it('returns UpgradeToJava21 for JDK 8 source', () => {
    const sets = selectRecipes(2, makeConfig({ sourceJdk: '8' }))
    expect(sets).toHaveLength(1)
    expect(sets[0].runner).toBe('openrewrite')
    expect(sets[0].recipes).toContain('org.openrewrite.java.migrate.UpgradeToJava21')
  })

  it('returns staged recipes for JDK 6 source (Java8toJava11 first)', () => {
    const sets = selectRecipes(2, makeConfig({ sourceJdk: '6' }))
    expect(sets[0].runner).toBe('openrewrite')
    expect(sets[0].recipes[0]).toBe('org.openrewrite.java.migrate.Java8toJava11')
    expect(sets[0].recipes).toContain('org.openrewrite.java.migrate.UpgradeToJava21')
  })

  it('JDK 6 path includes more recipes than JDK 8 path', () => {
    const sets6 = selectRecipes(2, makeConfig({ sourceJdk: '6' }))
    const sets8 = selectRecipes(2, makeConfig({ sourceJdk: '8' }))
    expect(sets6[0].recipes.length).toBeGreaterThan(sets8[0].recipes.length)
  })
})

describe('selectRecipes — fase 3 (Jakarta + frameworks)', () => {
  it('includes jakarta recipe when stack has spring-boot', () => {
    const sets = selectRecipes(3, makeConfig({ stack: ['spring-boot'] }))
    const jakartaSet = sets.find(s => s.recipes.some(r => r.includes('Jakarta')))
    expect(jakartaSet).toBeDefined()
  })

  it('includes sbm runner for spring-boot', () => {
    const sets = selectRecipes(3, makeConfig({ stack: ['spring-boot'] }))
    const sbmSet = sets.find(s => s.runner === 'sbm')
    expect(sbmSet).toBeDefined()
    expect(sbmSet?.recipes).toContain('upgrade-spring-boot-3.0')
  })

  it('includes spring-batch recipe when stack has spring-batch', () => {
    const sets = selectRecipes(3, makeConfig({ stack: ['spring-boot', 'spring-batch'] }))
    const batchSet = sets.find(s => s.recipes.some(r => r.includes('SpringBatch')))
    expect(batchSet).toBeDefined()
  })

  it('includes WebLogic recipe when appServer is weblogic', () => {
    const sets = selectRecipes(3, makeConfig({ stack: ['rest'], appServer: 'weblogic' }))
    const wlSet = sets.find(s => s.recipes.some(r => r.includes('WebLogic')))
    expect(wlSet).toBeDefined()
    // WebLogic requer dependência extra (oracle/rewrite-recipes)
    expect(wlSet?.extraDependencies.length).toBeGreaterThan(0)
  })

  it('includes jakarta recipe for ejb stack', () => {
    const sets = selectRecipes(3, makeConfig({ stack: ['ejb'] }))
    const jakartaSet = sets.find(s => s.recipes.some(r => r.includes('Javax')))
    expect(jakartaSet).toBeDefined()
  })

  it('returns no recipes for jsf stack without additional stacks', () => {
    // JSF sem spring-boot/ejb ainda deve ter a recipe jakarta
    const sets = selectRecipes(3, makeConfig({ stack: ['jsf'] }))
    const jakartaSet = sets.find(s => s.recipes.some(r => r.includes('Jakarta')))
    expect(jakartaSet).toBeDefined()
  })
})

describe('selectRecipes — fases 4 e 5', () => {
  it('returns no recipes for phase 4 (semantic review)', () => {
    expect(selectRecipes(4, makeConfig())).toHaveLength(0)
  })

  it('returns no recipes for phase 5 (final validation)', () => {
    expect(selectRecipes(5, makeConfig())).toHaveLength(0)
  })
})
