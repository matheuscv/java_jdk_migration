import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, configExists } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { detectStack, detectStackDeep } from '../../skill/stack-detector.js'
import { runStaticAnalysis } from '../../static-analysis/index.js'
import { correlate, getEntriesForJdk } from '../../knowledge-base/index.js'
import type { StackType, RiskSeverity } from '../../types.js'
import type { EnrichedIssue } from '../../knowledge-base/index.js'
import type { StaticAnalysisResult } from '../../static-analysis/index.js'

export interface DiscoveryReport {
  projectPath: string
  timestamp: string
  sourceJdk: string
  detectedStacks: StackType[]
  buildSystem: string
  isMultiModule: boolean
  staticAnalysis: {
    jdeprscanItemCount: number
    sourceItemCount: number
    jdepsViolations: string[]
    splitPackages: string[]
    runtimeWarnings: string[]
    javaHomeUsed: string | null
    compiledClassesFound: boolean
  }
  knowledgeCorrelation: EnrichedIssue[]
  riskSummary: {
    critical: number
    high: number
    medium: number
    low: number
    manualReviewRequired: boolean
    estimatedEffortDays: number
  }
  prerequisites: {
    jdk21Available: boolean
    gitAvailable: boolean
    compiledClassesFound: boolean
  }
  savedReportPath: string
}

export function registerDiscoverProject(server: McpServer): void {
  server.registerTool(
    'discover_project',
    {
      title: 'Discover Project',
      description:
        'Escaneia a aplicação Java sem alterá-la. Identifica build system, stack, ' +
        'versão de JDK atual, dependências e pontos de incompatibilidade com JDK 21. ' +
        'Deve ser o primeiro comando executado — nenhuma fase avança sem um relatório de descoberta.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java a ser analisado'),
      },
    },
    async ({ projectPath }) => {
      try {
        const report = await discoverProject(projectPath)
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        }
      } catch (err) {
        if (err instanceof MigrationError) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
            }],
          }
        }
        throw err
      }
    },
  )
}

export { discoverProject as discoverProjectForTest }

async function discoverProject(projectPath: string): Promise<DiscoveryReport> {
  // 1. Determine stack and JDK from config (if exists) or auto-detect
  let sourceJdk: string
  let detectedStacks: StackType[]
  let buildSystem: string
  let isMultiModule = false

  if (configExists(projectPath)) {
    const config = readConfig(projectPath)
    sourceJdk = config.sourceJdk
    detectedStacks = [...config.stack]
    buildSystem = config.buildSystem
    isMultiModule = config.multiModule
  } else {
    const shallow = detectStack(projectPath)
    if (shallow.buildSystem === 'unknown') {
      throw new MigrationError(
        'STACK_NOT_DETECTED',
        `Nenhum build system detectado em ${projectPath}. ` +
          'Execute a Skill de instalação ou forneça um pom.xml/build.gradle.',
      )
    }
    sourceJdk = shallow.detectedJdk ?? '8'
    detectedStacks = [...shallow.detectedStacks]
    buildSystem = shallow.buildSystem
  }

  // 2. Deep stack detection — merge additional stacks found in source/XML
  const deep = detectStackDeep(projectPath)
  for (const s of deep.additionalStacks) {
    if (!detectedStacks.includes(s)) detectedStacks.push(s)
  }
  if (deep.hasWebInf && detectedStacks.length === 0) detectedStacks.push('rest')

  // 3. Static analysis (source scan always; jdeprscan only if compiled classes found)
  const staticResult: StaticAnalysisResult = await runStaticAnalysis(
    projectPath,
    buildSystem as 'maven' | 'gradle' | 'ant',
    sourceJdk as '6' | '8',
  )

  // 4. Correlate findings with knowledge base
  const enrichedIssues = correlate(staticResult, Number(sourceJdk))

  // 5. Compute risk summary
  const riskSummary = computeRiskSummary(enrichedIssues, detectedStacks)

  // 6. Check prerequisites
  const prerequisites = {
    jdk21Available: staticResult.javaHomeUsed !== null,
    gitAvailable: await checkGitAvailable(projectPath),
    compiledClassesFound: staticResult.compiledClassesFound,
  }

  // 7. Persist report
  const reportDir = join(projectPath, '.jdk-migration')
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, 'discovery-report.json')
  const timestamp = staticResult.analysisTimestamp

  const report: DiscoveryReport = {
    projectPath,
    timestamp,
    sourceJdk,
    detectedStacks,
    buildSystem,
    isMultiModule,
    staticAnalysis: {
      jdeprscanItemCount: staticResult.jdeprscanItems.length,
      sourceItemCount: staticResult.sourceItems.length,
      jdepsViolations: staticResult.jdepsViolations,
      splitPackages: staticResult.splitPackages,
      runtimeWarnings: staticResult.runtimeWarnings,
      javaHomeUsed: staticResult.javaHomeUsed,
      compiledClassesFound: staticResult.compiledClassesFound,
    },
    knowledgeCorrelation: enrichedIssues,
    riskSummary,
    prerequisites,
    savedReportPath: reportPath,
  }

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')
  return report
}

function computeRiskSummary(
  issues: EnrichedIssue[],
  stacks: StackType[],
): DiscoveryReport['riskSummary'] {
  const counts: Record<RiskSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const issue of issues) counts[issue.severity]++

  const hasCriticalStacks = stacks.some(s => s === 'ejb' || s === 'jsf')
  const manualReviewRequired = counts.critical > 0 || hasCriticalStacks

  // Rough estimate: critical=5d, high=2d, medium=0.5d, low=0.1d per issue
  const estimatedEffortDays = Math.ceil(
    counts.critical * 5 + counts.high * 2 + counts.medium * 0.5 + counts.low * 0.1,
  )

  return { ...counts, manualReviewRequired, estimatedEffortDays }
}

async function checkGitAvailable(projectPath: string): Promise<boolean> {
  const { runProcess } = await import('../../lib/process-runner.js')
  const result = await runProcess('git', ['rev-parse', '--git-dir'], {
    cwd: projectPath,
    timeoutMs: 5_000,
  })
  return result.exitCode === 0
}
