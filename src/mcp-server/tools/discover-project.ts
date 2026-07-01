import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StorageFactory, ProjectPathResolver } from '../../ports/storage.js'
import type { JobRunner } from '../../orchestrator/async-job-runner.js'
import { createJobId } from '../../orchestrator/async-job-runner.js'
import { z } from 'zod'
import { readConfig, writeConfig, configExists, createDefaultPhases } from '../../lib/config.js'
import { ensureGitignoreEntries } from '../../skill/install.js'
import { MigrationError } from '../../lib/errors.js'
import { detectStack, detectStackDeep } from '../../skill/stack-detector.js'
import { runStaticAnalysis } from '../../static-analysis/index.js'
import { correlate, getEntriesForJdk } from '../../knowledge-base/index.js'
import { getProfilersForStacks } from '../../orchestrator/profiler-registry.js'
import { detectTools, buildMissingToolsMessage, serializeTools, extractSourceJdkHome, extractTargetJdkHome } from '../../lib/tool-detector.js'
import { runSourceBuild } from '../../orchestrator/build-validator.js'
import { runMigrationAudit } from '../../static-analysis/migration-audit.js'
import { generateAuditChecklist } from '../../report-generator/index.js'
import { findAllCompiledClasses } from '../../static-analysis/jdeprscan-runner.js'
import { enrichContainerFindings } from '../../static-analysis/container-registry-enricher.js'
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
  /**
   * Resultado da compilação prévia com o source JDK (Fase 0).
   * null = classes já existiam ou source JDK não disponível (build não foi tentado).
   * success=false indica que o build falhou — jdeprscan terá cobertura parcial.
   */
  sourceBuild: {
    attempted: boolean
    success: boolean
    failureReason: string | null
    stderr: string
  } | null
  savedReportPath: string
}

export interface DiscoverProjectAdapters {
  /** Quando presente, persiste os artefatos de descoberta em branch GitHub após a análise. */
  storageFactory?: StorageFactory
  /** Resolve "owner/repo" ou URL GitHub → caminho local clonado no Render. */
  projectPathResolver?: ProjectPathResolver
  /**
   * Quando presente, discover_project roda em background (clone + build + análise
   * podem levar minutos) e a tool retorna um jobId imediatamente, em vez de manter
   * a requisição HTTP aberta até o fim — evita estourar o timeout do proxy/cliente
   * MCP em projetos grandes ou em planos com pouca CPU/RAM (ex: Render free tier).
   * O chamador consulta o progresso via get_job_status(jobId).
   * Ausente em modo local/stdio — mantém o comportamento síncrono original.
   */
  jobRunner?: JobRunner
}

export function registerDiscoverProject(server: McpServer, adapters?: DiscoverProjectAdapters): void {
  server.registerTool(
    'discover_project',
    {
      title: 'Discover Project',
      description:
        'Escaneia a aplicação Java sem alterar seu CÓDIGO-FONTE. Identifica build system, stack, ' +
        'versão de JDK atual, dependências e pontos de incompatibilidade com JDK 21. ' +
        'Deve ser o primeiro comando executado — nenhuma fase avança sem um relatório de descoberta. ' +
        'Em modo cloud (projectPath como referência GitHub), os artefatos gerados ' +
        '(discovery-report.json, jdk-migration.config.json) são commitados e enviados via push ' +
        'para uma branch dedicada "jdk-migration/discovery" — separada do código analisado, nunca ' +
        'commitada na branch padrão do repositório. Isso é auditoria do próprio processo de migração, ' +
        'não uma alteração no código da aplicação.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java a ser analisado, ou referência GitHub ("owner/repo") em modo cloud'),
        toolOverrides: z
          .record(z.string())
          .optional()
          .default({})
          .describe(
            'Caminhos de ferramentas informados pelo usuário quando a auto-detecção falha. ' +
            'Chaves aceitas: ' +
            'SOURCE_JAVA_HOME (JDK do projeto-alvo — JDK 6 ou 8, NUNCA JDK 21), ' +
            'JAVA_HOME_21 ou JDK_21 (JDK 21 target), ' +
            'MAVEN_HOME, M2_HOME, GRADLE_HOME, GIT_EXEC_PATH. ' +
            'Exemplo para projeto JDK 8: { "SOURCE_JAVA_HOME": "C:\\\\Program Files\\\\Zulu\\\\zulu-8", "JAVA_HOME_21": "C:\\\\Program Files\\\\Zulu\\\\zulu-21" }',
          ),
        githubToken: z
          .string()
          .optional()
          .describe(
            'PAT (Personal Access Token) do GitHub do próprio usuário, usado apenas quando ' +
            'projectPath for uma referência GitHub em modo cloud (owner/repo ou URL). Tem ' +
            'prioridade sobre a credencial fixa do servidor — permite que múltiplos usuários ' +
            'usem o mesmo servidor MCP, cada um só com acesso ao(s) repositório(s) do seu ' +
            'próprio token. Nunca é persistido em disco nem incluído em nenhuma resposta.',
          ),
      },
    },
    async ({ projectPath, toolOverrides = {}, githubToken }) => {
      // ── Modo assíncrono (cloud, jobRunner injetado): retorna jobId na hora ──
      if (adapters?.jobRunner) {
        const jobId = createJobId()
        adapters.jobRunner.startJob(jobId, async () => {
          try {
            return await runDiscovery(projectPath, toolOverrides, adapters, githubToken)
          } catch (err) {
            // JobRunner só guarda err.message (string) — preserva o código
            // estruturado de MigrationError prefixando-o na mensagem.
            if (err instanceof MigrationError) throw new Error(`${err.code}: ${err.message}`)
            throw err
          }
        })

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'running',
              jobId,
              message:
                'discover_project iniciado em background — clone do repositório, build ' +
                'com o source JDK e análise estática podem levar vários minutos. ' +
                'Consulte o progresso com get_job_status.',
              nextStep: `get_job_status({ jobId: "${jobId}" })`,
            }, null, 2),
          }],
        }
      }

      // ── Modo síncrono (local/stdio) — comportamento original, sem mudanças ──
      try {
        const report = await runDiscovery(projectPath, toolOverrides, adapters, githubToken)
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

/**
 * Lógica completa de descoberta (resolução do path + análise + persistência),
 * extraída do handler da tool para ser reutilizável tanto no modo síncrono
 * quanto como corpo de uma tarefa de background (jobRunner.startJob).
 *
 * Propaga MigrationError sem modificação — o modo síncrono depende disso para
 * montar a resposta estruturada { error: code, message }; o modo assíncrono
 * reempacota o erro separadamente antes de repassar ao JobRunner (ver acima).
 */
async function runDiscovery(
  projectPath: string,
  toolOverrides: Record<string, string>,
  adapters?: DiscoverProjectAdapters,
  githubToken?: string,
): Promise<DiscoveryReport> {
  const resolved = adapters?.projectPathResolver
    ? await adapters.projectPathResolver(projectPath, githubToken)
    : { path: projectPath, repoUrl: null }

  const report = await discoverProject(resolved.path, toolOverrides)

  if (adapters?.storageFactory && resolved.repoUrl) {
    const branch = `jdk-migration/discovery`
    const storage = adapters.storageFactory(resolved.repoUrl, resolved.path, branch)
    await storage.commitState('chore(jdk-migration): discovery report + jdk-migration.config.json')
  }

  return report
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
    isMultiModule = detectIsMultiModule(projectPath, buildSystem)
  }

  // 1b. Detectar ferramentas do ambiente de build
  // sourceJdkMajor guia a busca pelo JDK correto na máquina (nunca usa JAVA_HOME direto)
  const sourceJdkMajor = (sourceJdk === '6' ? 6 : 8) as 6 | 8
  const toolDetection = await detectTools(toolOverrides, sourceJdkMajor)
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
      sourceBuild: null,
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

  // 2b. Compilar com source JDK para garantir classes disponíveis para jdeprscan
  const sourceJdkHome = extractSourceJdkHome(toolDetection)
    ?? process.env['SOURCE_JAVA_HOME']
    ?? null
  const targetJdkHome = extractTargetJdkHome(toolDetection)
    ?? process.env['JAVA_HOME']
    ?? null

  const sourceBuildResult = await (async () => {
    if (!sourceJdkHome) return null
    if (buildSystem === 'ant') return null  // ant não tem suporte a build automático
    const compiledDirs = findAllCompiledClasses(projectPath, buildSystem)
    if (compiledDirs.length > 0) return null  // classes já existem — skip

    const existingConfig = configExists(projectPath) ? readConfig(projectPath) : null
    return runSourceBuild(projectPath, buildSystem as 'maven' | 'gradle', {
      sourceJdkHome,
      mavenExecutable: existingConfig?.mavenExecutable,
      gradleExecutable: existingConfig?.gradleExecutable,
    })
  })()

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
    sourceBuild: sourceBuildResult
      ? {
          attempted: true,
          success: sourceBuildResult.success,
          failureReason: sourceBuildResult.failureReason,
          stderr: sourceBuildResult.success ? '' : sourceBuildResult.stderr,
        }
      : null,
    savedReportPath: reportPath,
  }

  // 8b. Enriquecer findings de container com dados do registry (se configurado)
  const existingConfig = configExists(projectPath) ? readConfig(projectPath) : null
  const registry = existingConfig?.artifactRegistry
  if (registry && registry.type !== 'none' && registry.url) {
    const enriched = await enrichContainerFindings(
      report.containerCi.findings,
      registry,
      '21',
    )
    report.containerCi = {
      ...report.containerCi,
      findings: enriched,
      // Reclassifica flags após enriquecimento
      hasIncompatibleImages: enriched.some(
        f => f.fileType === 'dockerfile' || f.fileType === 'docker-compose',
      ),
      hasIncompatibleCiJdk: enriched.some(
        f => !['dockerfile', 'docker-compose'].includes(f.fileType),
      ),
    }
  }

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')

  // 8b. Auditoria baseline (Fase 0) — gera audit-report-phase-0.md com os 25 critérios
  try {
    const baselineAudit = await runMigrationAudit(projectPath, '21')
    const partialConfig = { sourceJdk, targetJdk: '21' }
    generateAuditChecklist(reportDir, baselineAudit, 0, partialConfig)
  } catch { /* não bloqueia a descoberta */ }

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
      discoveryEffortDays: riskSummary.estimatedEffortDays,
      ...(sourceJdkHome ? { sourceJdkHome } : {}),
      ...(targetJdkHome ? { targetJdkHome } : {}),
    })
  } else {
    // Atualiza detectedTools + paths dos JDKs + esforço de descoberta no config existente
    const existing = readConfig(projectPath)
    writeConfig(projectPath, {
      ...existing,
      detectedTools: serializedTools,
      discoveryEffortDays: riskSummary.estimatedEffortDays,
      ...(sourceJdkHome && !existing.sourceJdkHome ? { sourceJdkHome } : {}),
      ...(targetJdkHome && !existing.targetJdkHome ? { targetJdkHome } : {}),
    })
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

/**
 * Detecta automaticamente se o projeto é multi-módulo.
 * Maven: verifica <packaging>pom</packaging> + bloco <modules> no pom.xml raiz.
 * Gradle: verifica include() em settings.gradle ou settings.gradle.kts.
 */
function detectIsMultiModule(projectPath: string, buildSystem: string): boolean {
  if (buildSystem === 'maven') {
    const pomPath = join(projectPath, 'pom.xml')
    if (!existsSync(pomPath)) return false
    try {
      const pom = readFileSync(pomPath, 'utf-8')
      return /<packaging>\s*pom\s*<\/packaging>/.test(pom) && /<modules>/.test(pom)
    } catch { return false }
  }
  if (buildSystem === 'gradle') {
    const kts = join(projectPath, 'settings.gradle.kts')
    const groovy = join(projectPath, 'settings.gradle')
    const settingsPath = existsSync(kts) ? kts : existsSync(groovy) ? groovy : null
    if (!settingsPath) return false
    try {
      const settings = readFileSync(settingsPath, 'utf-8')
      return /\binclude\s*[\("']/.test(settings)
    } catch { return false }
  }
  return false
}
