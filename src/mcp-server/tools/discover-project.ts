import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig, configExists, createDefaultPhases } from '../../lib/config.js'
import { ensureGitignoreEntries } from '../../skill/install.js'
import { MigrationError } from '../../lib/errors.js'
import { detectStack, detectStackDeep } from '../../skill/stack-detector.js'
import { runStaticAnalysis } from '../../static-analysis/index.js'
import { correlate, getEntriesForJdk } from '../../knowledge-base/index.js'
import { getProfilersForStacks } from '../../orchestrator/profiler-registry.js'
import { detectTools, buildMissingToolsMessage, serializeTools } from '../../lib/tool-detector.js'
import type { ProfilerReport } from '../../profilers/types.js'
import type { StackType, RiskSeverity } from '../../types.js'
import type { EnrichedIssue } from '../../knowledge-base/index.js'
import type { StaticAnalysisResult, ContainerCiScanResult } from '../../static-analysis/index.js'
import type { SerializedTools } from '../../lib/tool-detector.js'

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
  /** Findings de Dockerfile, docker-compose e pipelines CI */
  containerCi: ContainerCiScanResult
  knowledgeCorrelation: EnrichedIssue[]
  profilerReports: ProfilerReport[]
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
  /** Ferramentas detectadas no ambiente de build */
  detectedTools: SerializedTools
  /** Se false, o agente deve perguntar ao usuário pelos caminhos ausentes antes de prosseguir */
  allToolsFound: boolean
  /** Mensagem a exibir ao usuário quando alguma ferramenta obrigatória não foi encontrada */
  missingToolsMessage?: string
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
        toolOverrides: z
          .record(z.string())
          .optional()
          .default({})
          .describe(
            'Caminhos de ferramentas informados pelo usuário quando a auto-detecção falha. ' +
            'Chaves aceitas: JAVA_HOME, MAVEN_HOME, M2_HOME, GRADLE_HOME, GIT_EXEC_PATH. ' +
            'Exemplo: { "JAVA_HOME": "C:\\\\Program Files\\\\Zulu\\\\zulu-21", "MAVEN_HOME": "C:\\\\maven" }',
          ),
      },
    },
    async ({ projectPath, toolOverrides = {} }) => {
      try {
        const report = await discoverProject(projectPath, toolOverrides)
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

async function discoverProject(
  projectPath: string,
  toolOverrides: Record<string, string> = {},
): Promise<DiscoveryReport> {
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

  // 1b. Detectar ferramentas do ambiente de build
  const toolDetection = await detectTools(toolOverrides)
  const serializedTools = serializeTools(toolDetection)

  // Se alguma ferramenta obrigatória está ausente, retorna imediatamente com a mensagem
  if (!toolDetection.allRequiredFound) {
    const missingToolsMessage = buildMissingToolsMessage(toolDetection.missing)
    // Ainda persiste o report parcial para não perder o que foi detectado
    const reportDir = join(projectPath, '.jdk-migration')
    mkdirSync(reportDir, { recursive: true })
    const partialReport: DiscoveryReport = {
      projectPath,
      timestamp: new Date().toISOString(),
      sourceJdk: '?',
      detectedStacks: [],
      buildSystem: '?',
      isMultiModule: false,
      staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 0, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: null, compiledClassesFound: false },
      knowledgeCorrelation: [],
      profilerReports: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0, manualReviewRequired: false, estimatedEffortDays: 0 },
      prerequisites: { jdk21Available: false, gitAvailable: false, compiledClassesFound: false },
      containerCi: { findings: [], filesScanned: [], hasIncompatibleImages: false, hasIncompatibleCiJdk: false },
      detectedTools: serializedTools,
      allToolsFound: false,
      missingToolsMessage,
      savedReportPath: join(reportDir, 'discovery-report.json'),
    }
    writeFileSync(partialReport.savedReportPath, JSON.stringify(partialReport, null, 2), 'utf-8')
    return partialReport
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

  // 5. Run stack profilers
  const profilers = getProfilersForStacks(detectedStacks)
  const configForProfilers = configExists(projectPath)
    ? readConfig(projectPath)
    : {
        sourceJdk: sourceJdk as '6' | '8', targetJdk: '21' as const,
        stack: detectedStacks, buildSystem: buildSystem as 'maven' | 'gradle' | 'ant',
        appServer: null, multiModule: isMultiModule, modulePaths: [],
        ciSystem: null, testCoverageThreshold: 80, dryRunBeforeExecute: true,
        phases: {} as never,
      }
  const profilerReports: ProfilerReport[] = await Promise.all(
    profilers.map(p => p.analyze(projectPath, configForProfilers)),
  )

  // 6. Compute risk summary (inclui dados dos profilers)
  const riskSummary = computeRiskSummary(enrichedIssues, profilerReports, detectedStacks)

  // 7. Check prerequisites
  const prerequisites = {
    jdk21Available: staticResult.javaHomeUsed !== null,
    gitAvailable: await checkGitAvailable(projectPath),
    compiledClassesFound: staticResult.compiledClassesFound,
  }

  // 8. Persist report
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
    profilerReports,
    riskSummary,
    prerequisites,
    containerCi: staticResult.containerCi,
    detectedTools: serializedTools,
    allToolsFound: true,
    savedReportPath: reportPath,
  }

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')

  // 9. Create jdk-migration.config.json if not present + ensure .gitignore entries
  if (!configExists(projectPath)) {
    writeConfig(projectPath, {
      sourceJdk: sourceJdk as '6' | '8',
      targetJdk: '21',
      stack: detectedStacks,
      buildSystem: buildSystem as 'maven' | 'gradle' | 'ant',
      appServer: null,
      multiModule: isMultiModule,
      modulePaths: [],
      ciSystem: null,
      testCoverageThreshold: 80,
      dryRunBeforeExecute: true,
      reportMode: 'phase-gate-step',
      phases: createDefaultPhases(),
      detectedTools: serializedTools,
    })
  } else {
    // Atualiza apenas detectedTools no config existente
    const existing = readConfig(projectPath)
    writeConfig(projectPath, { ...existing, detectedTools: serializedTools })
  }
  ensureGitignoreEntries(projectPath)

  return report
}

function computeRiskSummary(
  issues: EnrichedIssue[],
  profilerReports: ProfilerReport[],
  stacks: StackType[],
): DiscoveryReport['riskSummary'] {
  const counts: Record<RiskSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const issue of issues) counts[issue.severity]++

  // Adiciona contagens dos profilers
  for (const pr of profilerReports) {
    for (const ri of pr.riskItems) counts[ri.severity]++
  }

  const hasCriticalStacks = stacks.some(s => s === 'ejb' || s === 'jsf')
  const hasManualItems = profilerReports.some(pr => pr.manualReviewItems.length > 0)
  const manualReviewRequired = counts.critical > 0 || hasCriticalStacks || hasManualItems

  const profilerEffort = profilerReports.reduce((sum, pr) => sum + pr.estimatedEffortDays, 0)
  const issueEffort = Math.ceil(
    counts.critical * 5 + counts.high * 2 + counts.medium * 0.5 + counts.low * 0.1,
  )
  const estimatedEffortDays = issueEffort + profilerEffort

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
