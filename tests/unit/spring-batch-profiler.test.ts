import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { springBatchProfiler } from '../../src/profilers/spring-batch/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(__dirname, '../fixtures/jdk8-spring-boot')

function makeConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot', 'spring-batch'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

describe('springBatchProfiler.analyze — jdk8-spring-boot fixture', () => {
  it('detecta JobBuilderFactory como CRITICAL', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-job-builder-factory')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.file).toContain('BatchConfig')
  })

  it('JobBuilderFactory tem recipe de automação disponível', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-job-builder-factory')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('SpringBatch4To5Migration')
  })

  it('detecta StepBuilderFactory como CRITICAL', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-step-builder-factory')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
  })

  it('detecta @EnableBatchProcessing como HIGH', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-enable-annotation')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
  })

  it('cria ManualReviewItem para refatoração de JobBuilderFactory', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'batch-job-builder-manual')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('behavioral')
    expect(manual?.files.some(f => f.includes('BatchConfig'))).toBe(true)
  })

  it('stackType é spring-batch', () => {
    expect(springBatchProfiler.stackType).toBe('spring-batch')
  })

  it('prerequisiteCheck indica Spring Batch 4.x detectado', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === 'Spring Batch 4.x (precisa de migração)')
    expect(check?.passed).toBe(true)
  })
})

describe('springBatchProfiler.getRecipes', () => {
  it('retorna SpringBatch4To5Migration para fase 3 quando factory detectada', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    const recipes = springBatchProfiler.getRecipes(3, report)
    expect(recipes).toContain('org.openrewrite.java.spring.batch.SpringBatch4To5Migration')
  })

  it('retorna array vazio para fase 2', async () => {
    const report = await springBatchProfiler.analyze(FIXTURE, makeConfig())
    expect(springBatchProfiler.getRecipes(2, report)).toHaveLength(0)
  })

  it('retorna array vazio quando não há problemas Batch', async () => {
    // Relatório sem nenhum item de batch factory
    const emptyReport = {
      stackType: 'spring-batch' as const,
      riskItems: [],
      manualReviewItems: [],
      estimatedEffortDays: 0,
      prerequisiteChecks: [],
    }
    expect(springBatchProfiler.getRecipes(3, emptyReport)).toHaveLength(0)
  })
})
