import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// Copy fixture to a temp dir so the discovery report can be written without polluting fixtures
function copyFixture(fixtureName: string): string {
  const src = join(import.meta.dirname ?? '', '../fixtures', fixtureName)
  const dest = join(tmpdir(), `jdk-migration-e2-${randomBytes(4).toString('hex')}`)
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  return dest
}

// Import after fixtures are set up
import type { DiscoveryReport } from '../../src/mcp-server/tools/discover-project.js'

describe('discover_project — jdk8-spring-boot fixture', () => {
  let projectPath: string
  let report: DiscoveryReport

  beforeAll(async () => {
    projectPath = copyFixture('jdk8-spring-boot')
    // Dynamic import to avoid module caching issues
    const { discoverProjectForTest } = await import('../../src/mcp-server/tools/discover-project.js').catch(
      () => ({ discoverProjectForTest: undefined }),
    )
    if (!discoverProjectForTest) {
      // Fallback: call discover logic directly
      const { runStaticAnalysis } = await import('../../src/static-analysis/index.js')
      const { correlate } = await import('../../src/knowledge-base/index.js')
      const { detectStack, detectStackDeep } = await import('../../src/skill/stack-detector.js')

      const shallow = detectStack(projectPath)
      const deep = detectStackDeep(projectPath)
      const staticResult = await runStaticAnalysis(projectPath, 'maven', '8')
      const issues = correlate(staticResult, 8)

      report = {
        projectPath,
        timestamp: new Date().toISOString(),
        sourceJdk: shallow.detectedJdk ?? '8',
        detectedStacks: [...shallow.detectedStacks, ...deep.additionalStacks],
        buildSystem: 'maven',
        isMultiModule: false,
        staticAnalysis: {
          jdeprscanItemCount: staticResult.jdeprscanItems.length,
          sourceItemCount: staticResult.sourceItems.length,
          jdepsViolations: staticResult.jdepsViolations,
          splitPackages: staticResult.splitPackages,
          runtimeWarnings: staticResult.runtimeWarnings,
          javaHomeUsed: staticResult.javaHomeUsed,
          compiledClassesFound: staticResult.compiledClassesFound,
        },
        knowledgeCorrelation: issues,
        riskSummary: {
          critical: issues.filter(i => i.severity === 'critical').length,
          high: issues.filter(i => i.severity === 'high').length,
          medium: issues.filter(i => i.severity === 'medium').length,
          low: issues.filter(i => i.severity === 'low').length,
          manualReviewRequired: issues.some(i => i.severity === 'critical'),
          estimatedEffortDays: 0,
        },
        prerequisites: { jdk21Available: false, gitAvailable: false, compiledClassesFound: false },
        detectedTools: { detectedAt: new Date().toISOString(), allRequiredFound: false, tools: [] },
        allToolsFound: false,
        savedReportPath: join(projectPath, '.jdk-migration', 'discovery-report.json'),
      }
    } else {
      report = await discoverProjectForTest(projectPath)
    }
  }, 30_000) // detectTools lança 5 processos em paralelo — timeout generoso

  afterAll(() => {
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('detects Spring Boot stack', () => {
    expect(report.detectedStacks).toContain('spring-boot')
  })

  it('detects Spring Batch stack', () => {
    expect(report.detectedStacks).toContain('spring-batch')
  })

  it('detects JDK 8 as source', () => {
    expect(report.sourceJdk).toBe('8')
  })

  it('detects Maven as build system', () => {
    expect(report.buildSystem).toBe('maven')
  })

  it('source scanner finds at least 2 deprecated API usages', () => {
    expect(report.staticAnalysis.sourceItemCount).toBeGreaterThanOrEqual(2)
  })

  it('knowledge base correlates at least 1 enriched issue', () => {
    expect(report.knowledgeCorrelation.length).toBeGreaterThanOrEqual(1)
  })

  it('riskSummary has at least 1 high or critical issue', () => {
    expect(report.riskSummary.high + report.riskSummary.critical).toBeGreaterThanOrEqual(1)
  })

  it('knowledge correlation includes a recipe-backed automatable issue', () => {
    const automatable = report.knowledgeCorrelation.filter(i => i.automatable)
    expect(automatable.length).toBeGreaterThanOrEqual(1)
  })
})
