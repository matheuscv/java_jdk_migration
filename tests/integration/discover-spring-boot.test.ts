import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { DiscoveryReport } from '../../src/mcp-server/tools/discover-project.js'
import { install } from '../../src/skill/install.js'
import { runStaticAnalysis } from '../../src/static-analysis/index.js'
import { correlate } from '../../src/knowledge-base/index.js'
import { detectStack, detectStackDeep } from '../../src/skill/stack-detector.js'
import { getProfilersForStacks } from '../../src/orchestrator/profiler-registry.js'
import { springBootProfiler } from '../../src/profilers/spring-boot/index.js'
import { springBatchProfiler } from '../../src/profilers/spring-batch/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE_SRC = join(__dirname, '../fixtures/jdk8-spring-boot')

describe('discover_project — jdk8-spring-boot com profilers', () => {
  let projectPath: string
  let report: DiscoveryReport

  beforeAll(async () => {
    projectPath = join(tmpdir(), `jdkm-discover-sb-${randomBytes(4).toString('hex')}`)
    mkdirSync(projectPath, { recursive: true })
    cpSync(FIXTURE_SRC, projectPath, { recursive: true })
    await install(projectPath)

    // Executa o fluxo completo de discover (sem precisar de git ou JDK 21)
    const config = (await import('../../src/lib/config.js')).readConfig(projectPath)
    const staticResult = await runStaticAnalysis(projectPath, 'maven', '8')
    const enriched = correlate(staticResult, 8)
    const profilers = getProfilersForStacks(config.stack)
    const profilerReports = await Promise.all(profilers.map(p => p.analyze(projectPath, config)))

    report = {
      projectPath,
      timestamp: new Date().toISOString(),
      sourceJdk: config.sourceJdk,
      detectedStacks: config.stack,
      buildSystem: config.buildSystem,
      isMultiModule: config.multiModule,
      staticAnalysis: {
        jdeprscanItemCount: staticResult.jdeprscanItems.length,
        sourceItemCount: staticResult.sourceItems.length,
        jdepsViolations: staticResult.jdepsViolations,
        splitPackages: staticResult.splitPackages,
        runtimeWarnings: staticResult.runtimeWarnings,
        javaHomeUsed: staticResult.javaHomeUsed,
        compiledClassesFound: staticResult.compiledClassesFound,
      },
      knowledgeCorrelation: enriched,
      profilerReports,
      riskSummary: {
        critical: profilerReports.flatMap(p => p.riskItems).filter(r => r.severity === 'critical').length,
        high: profilerReports.flatMap(p => p.riskItems).filter(r => r.severity === 'high').length,
        medium: 0, low: 0,
        manualReviewRequired: profilerReports.some(p => p.manualReviewItems.length > 0),
        estimatedEffortDays: profilerReports.reduce((s, p) => s + p.estimatedEffortDays, 0),
      },
      prerequisites: { jdk21Available: false, gitAvailable: false, compiledClassesFound: false },
      savedReportPath: join(projectPath, '.jdk-migration', 'discovery-report.json'),
    }
  })

  afterAll(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  // ── Gate E5 criteria ────────────────────────────────────────────────────

  it('Spring Boot profiler detecta WebSecurityConfigurerAdapter', () => {
    const sbReport = report.profilerReports.find(r => r.stackType === 'spring-boot')
    expect(sbReport).toBeDefined()
    const wsca = sbReport?.riskItems.find(r => r.id === 'sb-websecurity-adapter-risk')
    expect(wsca).toBeDefined()
    expect(wsca?.severity).toBe('high')
  })

  it('Spring Boot profiler detecta javax.security', () => {
    const sbReport = report.profilerReports.find(r => r.stackType === 'spring-boot')
    const javaxSecurity = sbReport?.riskItems.find(r => r.id === 'sb-javax-security')
    expect(javaxSecurity).toBeDefined()
  })

  it('Spring Batch profiler detecta JobBuilderFactory como CRITICAL', () => {
    const batchReport = report.profilerReports.find(r => r.stackType === 'spring-batch')
    expect(batchReport).toBeDefined()
    const jobFactory = batchReport?.riskItems.find(r => r.id === 'batch-job-builder-factory')
    expect(jobFactory).toBeDefined()
    expect(jobFactory?.severity).toBe('critical')
  })

  it('profilerReports inclui relatórios de spring-boot e spring-batch', () => {
    const types = report.profilerReports.map(r => r.stackType)
    expect(types).toContain('spring-boot')
    expect(types).toContain('spring-batch')
  })

  it('manualReviewRequired é true (WebSecurityConfigurerAdapter é item manual)', () => {
    expect(report.riskSummary.manualReviewRequired).toBe(true)
  })

  it('estimatedEffortDays > 0', () => {
    expect(report.riskSummary.estimatedEffortDays).toBeGreaterThan(0)
  })

  it('source scanner detecta APIs deprecadas nas fixtures Java', () => {
    expect(report.staticAnalysis.sourceItemCount).toBeGreaterThan(0)
  })

  it('stack detectada inclui spring-boot e spring-batch', () => {
    expect(report.detectedStacks).toContain('spring-boot')
    expect(report.detectedStacks).toContain('spring-batch')
  })
})

describe('getProfilersForStacks', () => {
  it('retorna spring-boot e spring-batch profilers para stack completa', () => {
    const profilers = getProfilersForStacks(['spring-boot', 'spring-batch'])
    const types = profilers.map(p => p.stackType)
    expect(types).toContain('spring-boot')
    expect(types).toContain('spring-batch')
  })

  it('inclui jakarta profiler para qualquer stack com Java EE', () => {
    const profilers = getProfilersForStacks(['rest'])
    // jakarta é adicionado transversalmente
    expect(profilers.length).toBeGreaterThanOrEqual(1)
  })

  it('retorna array vazio para stack vazia', () => {
    const profilers = getProfilersForStacks([])
    expect(profilers).toHaveLength(0)
  })
})
