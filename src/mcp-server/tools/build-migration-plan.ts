import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig, configExists } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { getProfilersForStacks } from '../../orchestrator/profiler-registry.js'
import { selectRecipes } from '../../transform-engine/recipe-selector.js'
import type { RiskItem, ManualReviewItem, ProfilerReport } from '../../profilers/types.js'
import type { StackType, PhaseNumber } from '../../types.js'
import type { JdkMigrationConfig } from '../../lib/config.js'
import type { DiscoveryReport } from './discover-project.js'

export interface PhasePlan {
  number: PhaseNumber
  name: string
  criticality: 'low' | 'medium' | 'high' | 'critical'
  applicable: boolean
  estimatedDays: number
  automationLevel: 'high' | 'medium' | 'low' | 'none'
  recipes: string[]
  riskItems: RiskItem[]
  manualItems: ManualReviewItem[]
  gateDescription: string
  prerequisitesForHuman: string[]
}

export interface MigrationPlan {
  projectPath: string
  generatedAt: string
  sourceJdk: string
  targetJdk: string
  detectedStacks: StackType[]
  phases: PhasePlan[]
  totalEstimatedDays: number
  manualReviewRequired: boolean
  summary: string
}

const PHASE_META: Record<PhaseNumber, { name: string; gateDescription: string; criticality: PhasePlan['criticality'] }> = {
  0: {
    name: 'Descoberta & Baseline',
    criticality: 'low',
    gateDescription: 'Humano aprova o plano de migração e confirma cobertura de testes adequada (≥ 80%).',
  },
  1: {
    name: 'Infraestrutura & Build',
    criticality: 'low',
    gateDescription: 'Build verde no JDK 21 (mvn clean compile sem erros).',
  },
  2: {
    name: 'Modernização de Linguagem',
    criticality: 'medium',
    gateDescription: 'Diff revisado pelo responsável técnico + todos os testes verdes no JDK 21.',
  },
  3: {
    name: 'Namespace Jakarta & Frameworks',
    criticality: 'high',
    gateDescription: 'Aplicação sobe no servidor alvo; smoke tests de integração passando.',
  },
  4: {
    name: 'Refatoração Semântica Assistida',
    criticality: 'critical',
    gateDescription: 'Paridade funcional confirmada item a item pelo responsável técnico e funcional.',
  },
  5: {
    name: 'Validação Final & Cutover',
    criticality: 'medium',
    gateDescription: 'Sign-off da liderança técnica e funcional. Aprovação formal para cutover em produção.',
  },
}

export function registerBuildMigrationPlan(server: McpServer): void {
  server.registerTool(
    'build_migration_plan',
    {
      title: 'Build Migration Plan',
      description:
        'Consolida o relatório de diagnóstico em um plano de migração faseado, ' +
        'classificado por criticidade, com gates de aprovação definidos. ' +
        'Requer que discover_project tenha sido executado antes. ' +
        'Use reportMode para controlar a frequência de geração automática de audit reports: ' +
        '"phase-gate" (padrão) gera ao término de cada Fase/Gate; ' +
        '"phase-gate-step" gera também ao término de cada Step individual.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        reportMode: z
          .enum(['phase-gate', 'phase-gate-step'])
          .optional()
          .default('phase-gate')
          .describe(
            'Frequência de geração automática do audit report. ' +
            '"phase-gate": apenas ao término de cada Fase e Gate (padrão). ' +
            '"phase-gate-step": também ao término de cada Step individual da seção Progresso dos Steps.',
          ),
      },
    },
    async ({ projectPath, reportMode = 'phase-gate' }) => {
      try {
        const plan = await buildMigrationPlan(projectPath, reportMode)
        return { content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }] }
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

async function buildMigrationPlan(
  projectPath: string,
  reportMode: 'phase-gate' | 'phase-gate-step' = 'phase-gate',
): Promise<MigrationPlan> {
  // 1. Lê discovery report (obrigatório — discover_project deve ter rodado antes)
  const discoveryPath = join(projectPath, '.jdk-migration', 'discovery-report.json')
  if (!existsSync(discoveryPath)) {
    throw new MigrationError(
      'CONFIG_NOT_FOUND',
      'Relatório de descoberta não encontrado. Execute discover_project primeiro.',
      { discoveryPath },
    )
  }
  const discovery: DiscoveryReport = JSON.parse(readFileSync(discoveryPath, 'utf-8'))

  // 2. Lê config para parâmetros de migração (ou cria e persiste a partir do discovery)
  let config: JdkMigrationConfig
  if (configExists(projectPath)) {
    config = readConfig(projectPath)
    // Atualiza reportMode se foi explicitamente passado ou se ainda não está definido
    if (reportMode !== 'phase-gate' || config.reportMode === undefined) {
      config = { ...config, reportMode }
      writeConfig(projectPath, config)
    }
  } else {
    config = {
      sourceJdk: discovery.sourceJdk as '6' | '8',
      targetJdk: '21',
      stack: discovery.detectedStacks,
      buildSystem: discovery.buildSystem as 'maven' | 'gradle' | 'ant',
      appServer: null, multiModule: discovery.isMultiModule,
      modulePaths: [], ciSystem: null,
      testCoverageThreshold: 80, dryRunBeforeExecute: true,
      reportMode,
      phases: {} as never,
    }
    writeConfig(projectPath, config)
  }

  // 3. Obtém relatórios dos profilers (do discovery ou roda novamente)
  let profilerReports: ProfilerReport[] = discovery.profilerReports ?? []
  if (profilerReports.length === 0) {
    const profilers = getProfilersForStacks(discovery.detectedStacks)
    profilerReports = await Promise.all(profilers.map(p => p.analyze(projectPath, config)))
  }

  // 4. Coleta todos os RiskItems e ManualReviewItems dos profilers
  const allRiskItems = profilerReports.flatMap(pr => pr.riskItems)
  const allManualItems = profilerReports.flatMap(pr => pr.manualReviewItems)

  // 5. Constrói os PhasePlans
  const phases: PhasePlan[] = [0, 1, 2, 3, 4, 5].map(n => {
    const phase = n as PhaseNumber
    const meta = PHASE_META[phase]
    const recipeSets = selectRecipes(phase, config)
    const recipes = recipeSets.flatMap(s => s.recipes)

    // Profiler recipes para fase 3
    if (phase === 3) {
      const profilers = getProfilersForStacks(discovery.detectedStacks)
      for (const pr of profilerReports) {
        const profiler = profilers.find(p => p.stackType === pr.stackType)
        if (profiler) {
          const profilerRecipes = profiler.getRecipes(phase, pr)
          for (const r of profilerRecipes) {
            if (!recipes.includes(r)) recipes.push(r)
          }
        }
      }
    }

    // Risk items relevantes por fase
    const phaseRiskItems = phaseRisks(phase, allRiskItems, discovery)
    const phaseManualItems = phase === 4 ? allManualItems : []

    const estimatedDays = computePhaseDays(phase, phaseRiskItems, phaseManualItems)
    const automationLevel = computeAutomation(phase, recipes.length, phaseManualItems.length)
    const applicable = isPhaseApplicable(phase, config, discovery.detectedStacks)

    return {
      number: phase,
      name: meta.name,
      criticality: meta.criticality,
      applicable,
      estimatedDays,
      automationLevel,
      recipes,
      riskItems: phaseRiskItems,
      manualItems: phaseManualItems,
      gateDescription: meta.gateDescription,
      prerequisitesForHuman: buildPrerequisites(phase, config, discovery),
    }
  })

  const totalDays = phases.filter(p => p.applicable).reduce((s, p) => s + p.estimatedDays, 0)
  const manualReviewRequired = allManualItems.length > 0 ||
    allRiskItems.some(r => r.severity === 'critical')

  const plan: MigrationPlan = {
    projectPath,
    generatedAt: new Date().toISOString(),
    sourceJdk: discovery.sourceJdk,
    targetJdk: '21',
    detectedStacks: discovery.detectedStacks,
    phases,
    totalEstimatedDays: Math.ceil(totalDays),
    manualReviewRequired,
    summary: buildSummary(discovery, phases, allManualItems),
  }

  // 6. Persiste o plano
  mkdirSync(join(projectPath, '.jdk-migration'), { recursive: true })
  writeFileSync(
    join(projectPath, '.jdk-migration', 'migration-plan.json'),
    JSON.stringify(plan, null, 2),
    'utf-8',
  )

  return plan
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function phaseRisks(phase: PhaseNumber, all: RiskItem[], discovery: DiscoveryReport): RiskItem[] {
  if (phase === 0) return []
  if (phase === 1) return all.filter(r => r.id.startsWith('batch-') === false)
  if (phase === 2) return discovery.knowledgeCorrelation.map(e => ({
    id: e.apiPattern,
    severity: e.severity,
    title: `${e.apiPattern} — removido no JDK ${e.removedInJdk}`,
    description: e.migrationNote,
    file: e.foundInFiles[0] ?? null,
    line: null,
    automationAvailable: e.automatable,
    recipe: e.recipe,
  }))
  if (phase === 3) return all.filter(r => !r.automationAvailable === false)
  if (phase === 4) return all.filter(r => !r.automationAvailable)
  return []
}

function computePhaseDays(phase: PhaseNumber, risks: RiskItem[], manuals: ManualReviewItem[]): number {
  if (phase === 0) return 0.5
  if (phase === 5) return 1
  const riskDays = risks.reduce((s, r) => s + ({ critical: 5, high: 2, medium: 0.5, low: 0.1 }[r.severity] ?? 0), 0)
  return Math.max(0.5, Math.ceil(riskDays + manuals.length * 1.5))
}

function computeAutomation(
  phase: PhaseNumber,
  recipeCount: number,
  manualCount: number,
): PhasePlan['automationLevel'] {
  if (phase === 0 || phase === 5) return 'high'
  if (manualCount > 3) return 'low'
  if (recipeCount === 0) return 'none'
  if (manualCount === 0) return 'high'
  return 'medium'
}

function isPhaseApplicable(phase: PhaseNumber, config: JdkMigrationConfig, stacks: StackType[]): boolean {
  if (phase === 3) return stacks.some(s => ['spring-boot', 'ejb', 'jsf', 'weblogic', 'rest'].includes(s))
  if (phase === 4) return stacks.some(s => s === 'ejb' || s === 'jsf')
  return true
}

function buildPrerequisites(
  phase: PhaseNumber,
  config: JdkMigrationConfig,
  discovery: DiscoveryReport,
): string[] {
  const prereqs: string[] = []
  if (phase === 0) prereqs.push('Cobertura de testes ≥ 80%', 'Acesso ao repositório Git do projeto')
  if (phase === 1) prereqs.push('JDK 21 instalado no ambiente de CI', `${config.buildSystem === 'maven' ? 'Maven' : 'Gradle'} disponível no PATH`)
  if (phase === 2) prereqs.push('Fase 1 concluída com build verde no JDK 21', 'Code review do diff gerado pelo OpenRewrite')
  if (phase === 3) prereqs.push('Ambiente de staging com servidor de aplicação configurado', 'Smoke tests definidos para validar inicialização')
  if (phase === 4) prereqs.push('Lista de casos de teste funcionais mapeados', 'Ambiente de homologação disponível')
  if (phase === 5) prereqs.push('Sign-off do responsável técnico', 'Sign-off do responsável funcional', 'Plano de rollback documentado')
  return prereqs
}

function buildSummary(
  discovery: DiscoveryReport,
  phases: PhasePlan[],
  manualItems: ManualReviewItem[],
): string {
  const applicable = phases.filter(p => p.applicable)
  const manual = manualItems.length
  const autoHigh = applicable.filter(p => p.automationLevel === 'high').length
  const lines = [
    `Projeto: JDK ${discovery.sourceJdk} → JDK 21`,
    `Stacks detectadas: ${discovery.detectedStacks.join(', ')}`,
    `Fases aplicáveis: ${applicable.length}/6 (${autoHigh} com automação alta)`,
    manual > 0
      ? `⚠️  ${manual} item(ns) requerem revisão manual — não serão aplicados automaticamente.`
      : '✓ Nenhum item de revisão manual crítico detectado.',
    `Esforço estimado total: ${phases.reduce((s, p) => s + (p.applicable ? p.estimatedDays : 0), 0).toFixed(1)} dias`,
  ]
  return lines.join('\n')
}
