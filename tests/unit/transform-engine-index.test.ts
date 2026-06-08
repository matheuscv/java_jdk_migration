/**
 * Testes unitários para transform-engine/index.ts — executePhaseTransform
 * Cobre os runners source-cleaner, jakarta-deps e eclipse-transformer
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/transform-engine/recipe-selector.js', () => ({
  selectRecipes: vi.fn(),
}))
vi.mock('../../src/transform-engine/build-updater.js', () => ({
  updateBuildVersion: vi.fn(),
}))
vi.mock('../../src/transform-engine/infrastructure-transformer.js', () => ({
  runInfrastructureTransform: vi.fn(),
}))
vi.mock('../../src/transform-engine/source-cleaner.js', () => ({
  runSourceCleaner: vi.fn(),
}))
vi.mock('../../src/transform-engine/jakarta-deps-injector.js', () => ({
  runJakartaDepsInjector: vi.fn(),
}))
vi.mock('../../src/transform-engine/openrewrite-runner.js', () => ({
  runRecipes: vi.fn(),
}))
vi.mock('../../src/transform-engine/sbm-runner.js', () => ({
  runSpringBootMigrator: vi.fn(),
}))

import { executePhaseTransform } from '../../src/transform-engine/index.js'
import { selectRecipes } from '../../src/transform-engine/recipe-selector.js'
import { runSourceCleaner } from '../../src/transform-engine/source-cleaner.js'
import { runJakartaDepsInjector } from '../../src/transform-engine/jakarta-deps-injector.js'
import { runRecipes } from '../../src/transform-engine/openrewrite-runner.js'
import { runSpringBootMigrator } from '../../src/transform-engine/sbm-runner.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['rest'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
    ...overrides,
  }
}

const MOCK_CLEAN_RESULT = {
  recipesApplied: ['source-clean'], filesModified: 1, filesAdded: 0, filesDeleted: 0,
  diffSummary: 'Source cleaned', fullDiff: '', warnings: [], detail: { cleaned: [] },
}

const MOCK_JAKARTA_RESULT = {
  recipesApplied: ['inject-jakarta'], filesModified: 2, filesAdded: 0, filesDeleted: 0,
  diffSummary: 'Jakarta deps injected', fullDiff: '', warnings: [], detail: { injected: [] },
}

const MOCK_RECIPES_RESULT = {
  recipesApplied: ['org.openrewrite.UpgradeToJava21'], filesModified: 5, filesAdded: 0, filesDeleted: 0,
  diffSummary: 'OpenRewrite applied', fullDiff: '', warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runSourceCleaner).mockResolvedValue(MOCK_CLEAN_RESULT)
  vi.mocked(runJakartaDepsInjector).mockResolvedValue(MOCK_JAKARTA_RESULT)
  vi.mocked(runRecipes).mockResolvedValue(MOCK_RECIPES_RESULT)
  vi.mocked(runSpringBootMigrator).mockResolvedValue({
    recipesApplied: ['upgrade-spring-boot-3.0'], filesModified: 3, filesAdded: 0, filesDeleted: 0,
    diffSummary: 'SBM applied', fullDiff: '', warnings: [],
  })
})

describe('executePhaseTransform — sem recipe sets (fase 0)', () => {
  it('retorna resultado vazio sem chamar runners', async () => {
    vi.mocked(selectRecipes).mockReturnValue([])
    const result = await executePhaseTransform(0, makeConfig(), '/tmp/project', false)
    expect(result.recipesApplied).toHaveLength(0)
    expect(result.filesModified).toBe(0)
    expect(result.diffSummary).toContain('nenhuma transformação')
  })
})

describe('executePhaseTransform — runner source-cleaner (fase 2)', () => {
  it('chama runSourceCleaner e inclui resultado', async () => {
    vi.mocked(selectRecipes).mockReturnValue([
      { runner: 'source-cleaner', recipes: ['source-clean'], extraDependencies: [] },
    ])
    const result = await executePhaseTransform(2, makeConfig(), '/tmp/project', false)
    expect(runSourceCleaner).toHaveBeenCalledWith('/tmp/project', false)
    expect(result.recipesApplied).toContain('source-clean')
    expect(result.filesModified).toBe(1)
  })

  it('chama runSourceCleaner com dryRun=true', async () => {
    vi.mocked(selectRecipes).mockReturnValue([
      { runner: 'source-cleaner', recipes: ['source-clean'], extraDependencies: [] },
    ])
    await executePhaseTransform(2, makeConfig(), '/tmp/project', true)
    expect(runSourceCleaner).toHaveBeenCalledWith('/tmp/project', true)
  })
})

describe('executePhaseTransform — runner jakarta-deps (fase 3)', () => {
  it('chama runJakartaDepsInjector e inclui resultado', async () => {
    vi.mocked(selectRecipes).mockReturnValue([
      { runner: 'jakarta-deps', recipes: ['inject-jakarta'], extraDependencies: [] },
    ])
    const result = await executePhaseTransform(3, makeConfig(), '/tmp/project', false)
    expect(runJakartaDepsInjector).toHaveBeenCalledWith('/tmp/project', false)
    expect(result.filesModified).toBe(2)
  })
})

describe('executePhaseTransform — runner sbm (fase 3)', () => {
  it('chama runSpringBootMigrator para cada recipe', async () => {
    vi.mocked(selectRecipes).mockReturnValue([
      { runner: 'sbm', recipes: ['upgrade-spring-boot-3.0'], extraDependencies: [] },
    ])
    const result = await executePhaseTransform(3, makeConfig(), '/tmp/project', false)
    expect(runSpringBootMigrator).toHaveBeenCalledWith('/tmp/project', 'upgrade-spring-boot-3.0', false)
    expect(result.recipesApplied).toContain('upgrade-spring-boot-3.0')
  })
})

describe('executePhaseTransform — runner eclipse-transformer (else branch)', () => {
  it('emite warning quando runner é eclipse-transformer (invocação por JAR)', async () => {
    vi.mocked(selectRecipes).mockReturnValue([
      { runner: 'eclipse-transformer', recipes: ['transform-jar'], extraDependencies: [] },
    ])
    const result = await executePhaseTransform(3, makeConfig(), '/tmp/project', false)
    expect(result.warnings.some(w => w.includes('Eclipse Transformer'))).toBe(true)
    expect(result.recipesApplied).toHaveLength(0)
  })
})

describe('executePhaseTransform — múltiplos runners', () => {
  it('agrega resultados de openrewrite + source-cleaner', async () => {
    vi.mocked(selectRecipes).mockReturnValue([
      { runner: 'openrewrite', recipes: ['org.openrewrite.UpgradeToJava21'], extraDependencies: [] },
      { runner: 'source-cleaner', recipes: ['source-clean'], extraDependencies: [] },
    ])
    const result = await executePhaseTransform(2, makeConfig(), '/tmp/project', false)
    expect(result.filesModified).toBe(6) // 5 (openrewrite) + 1 (source-cleaner)
    expect(result.recipesApplied).toContain('org.openrewrite.UpgradeToJava21')
    expect(result.recipesApplied).toContain('source-clean')
  })
})
