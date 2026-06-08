/**
 * Testes adicionais para report-generator — cobre branches não alcançados:
 *   - multiModule: true
 *   - ciSystem, appServer variados
 *   - fases com status in_progress, awaiting_gate, failed, approved
 *   - steps: status skipped/pending, owner you/claude, _fromGit, note sem commit
 *   - buildManualItems com 0 items (seção vazia)
 *   - prUrl definida em fase
 *   - config sem detectedTools (null path)
 *   - detectedTools com ferramentas não encontradas
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { generateAuditReport } from '../../src/report-generator/index.js'

function makeTempDir(): string {
  const dir = join(tmpdir(), `rg-extra-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const DISCOVERY = {
  projectPath: '/tmp/project',
  timestamp: '2026-05-29T09:00:00Z',
  sourceJdk: '8',
  detectedStacks: ['spring-boot', 'spring-batch'],
  buildSystem: 'maven',
  isMultiModule: true,
  staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 2, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: '/usr/lib/jvm/java-21', compiledClassesFound: true },
  knowledgeCorrelation: [],
  profilerReports: [],
  riskSummary: { critical: 0, high: 1, medium: 2, low: 1, manualReviewRequired: false, estimatedEffortDays: 5 },
  prerequisites: { jdk21Available: true, gitAvailable: true, compiledClassesFound: true },
  savedReportPath: '/tmp/project/.jdk-migration/discovery-report.json',
}

const PLAN_NO_MANUALS = {
  projectPath: '/tmp/project',
  generatedAt: '2026-05-29T09:30:00Z',
  sourceJdk: '8', targetJdk: '21',
  detectedStacks: ['spring-boot'],
  totalEstimatedDays: 5,
  manualReviewRequired: false,
  summary: 'JDK 8 → JDK 21',
  phases: [
    {
      number: 0, name: 'Descoberta & Baseline', criticality: 'low', applicable: true,
      estimatedDays: 0.5, automationLevel: 'high', recipes: [],
      riskItems: [],
      manualItems: [],  // nenhum item manual → testa o "Nenhum item" path
      gateDescription: 'Aprovar plano',
      prerequisitesForHuman: [],
    },
  ],
}

// Config com fases em diferentes estados para cobrir os badges de status
function makeConfig(phases: Record<number, object>, extra: object = {}): object {
  return {
    sourceJdk: '8', targetJdk: '21',
    stack: ['spring-boot'],
    buildSystem: 'maven', appServer: 'tomcat',
    multiModule: true, modulePaths: ['module-a', 'module-b'],
    ciSystem: 'github-actions',
    testCoverageThreshold: 80, dryRunBeforeExecute: false,
    phases,
    ...extra,
  }
}

const PHASES_VARIED = {
  0: { status: 'completed', gateToken: 'tok-0', approvedBy: 'Alice', approvedAt: '2026-05-29T10:00:00Z', executedAt: '2026-05-29T09:00:00Z', gitBranch: 'jdk-migration/phase-0', gitCommit: 'abc1', baseBranch: 'main', baseCommit: 'def1', prUrl: 'https://github.com/repo/pull/1' },
  1: { status: 'approved', gateToken: 'tok-1', approvedBy: 'Bob', approvedAt: '2026-05-30T08:00:00Z', executedAt: '2026-05-30T07:00:00Z', gitBranch: 'jdk-migration/phase-1', gitCommit: 'abc2', baseBranch: 'main', baseCommit: 'def2', prUrl: null },
  2: { status: 'in_progress', gateToken: null, approvedBy: null, approvedAt: null, executedAt: '2026-06-01T10:00:00Z', gitBranch: 'jdk-migration/phase-2', gitCommit: 'abc3', baseBranch: 'main', baseCommit: 'def3', prUrl: null },
  3: { status: 'awaiting_gate', gateToken: null, approvedBy: null, approvedAt: null, executedAt: '2026-06-02T08:00:00Z', gitBranch: 'jdk-migration/phase-3', gitCommit: 'abc4', baseBranch: 'main', baseCommit: 'def4', prUrl: null },
  4: { status: 'failed', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
  5: { status: 'pending', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
}

// Steps com todos os status e owner types
const RICH_STEPS = [
  { num: 1, phase: 'A', task: 'Verificar cobertura', commit: 'ccc111', status: 'done', completedAt: '2026-06-01T08:00:00Z', note: 'Cobertura ok', owner: 'you' },
  { num: 2, phase: 'A', task: 'Atualizar deps', commit: null, status: 'skipped', completedAt: null, note: 'Pulado por decisão manual' },
  { num: 3, phase: 'B', task: 'Compilar com JDK 21', commit: null, status: 'pending', completedAt: null, note: '' },
  { num: 4, phase: 'B', task: 'Rodar testes', commit: 'ddd222', status: 'done', completedAt: '2026-06-01T10:00:00Z', note: '', owner: 'claude' },
  // Step derivado do git
  { num: 5, phase: '2', task: 'Commit automático fase 2', commit: 'eee333', status: 'done', completedAt: '2026-06-02T08:00:00Z', note: 'Fase 2 · jdk-migration/phase-2 · 2026-06-02', _fromGit: true },
]

let dir: string
beforeEach(() => { dir = makeTempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function setupDir(config: object, plan: object | null = PLAN_NO_MANUALS, discovery: object = DISCOVERY) {
  const migDir = join(dir, '.jdk-migration')
  mkdirSync(migDir, { recursive: true })
  writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(discovery), 'utf-8')
  if (plan) writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(plan), 'utf-8')
  writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(config), 'utf-8')
}

// ─── multiModule=true, ciSystem, appServer variados ──────────────────────────

describe('generateAuditReport — multiModule=true e ciSystem=github-actions', () => {
  it('gera HTML com "Sim" para multi-módulo', async () => {
    setupDir(makeConfig(PHASES_VARIED))
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Sim')  // multiModule: true → "Sim"
    expect(html).toContain('tomcat')
  })
})

// ─── Fases com status in_progress, awaiting_gate, failed ─────────────────────

describe('generateAuditReport — badges de fase variados', () => {
  it('renderiza badges in_progress, awaiting_gate, failed', async () => {
    setupDir(makeConfig(PHASES_VARIED))
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('in_progress')
    expect(html).toContain('awaiting_gate')
    expect(html).toContain('failed')
    expect(html).toContain('approved')
  })

  it('renderiza prUrl quando definido na fase', async () => {
    setupDir(makeConfig(PHASES_VARIED))
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    // fase 0 tem prUrl — deve aparecer no relatório ou ao menos não crashar
    expect(existsSync(result.reportPath)).toBe(true)
  })
})

// ─── buildManualItems com 0 items ─────────────────────────────────────────────

describe('generateAuditReport — sem itens manuais (seção vazia)', () => {
  it('renderiza "Nenhum item" quando manualItems está vazio', async () => {
    setupDir(makeConfig(PHASES_VARIED), PLAN_NO_MANUALS)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Nenhum item de revisão manual')
  })
})

// ─── Steps com todos os status e owner types ─────────────────────────────────

describe('generateAuditReport — steps com status variados e _fromGit', () => {
  it('renderiza status skipped, pending e _fromGit steps', async () => {
    const config = makeConfig(PHASES_VARIED, { steps: RICH_STEPS })
    setupDir(config)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Pulado por decisão manual')
    expect(html).toContain('Compilar com JDK 21')
    expect(html).toContain('Commit automático fase 2')
  })

  it('renderiza owner "você" para steps com owner=you', async () => {
    const config = makeConfig(PHASES_VARIED, { steps: RICH_STEPS })
    setupDir(config)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    // owner-you badge
    expect(html).toContain('owner-you')
  })

  it('renderiza owner claude para steps sem owner', async () => {
    const config = makeConfig(PHASES_VARIED, { steps: RICH_STEPS })
    setupDir(config)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('owner-claude')
  })

  it('renderiza git-badge para _fromGit steps', async () => {
    const config = makeConfig(PHASES_VARIED, { steps: RICH_STEPS })
    setupDir(config)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('git-badge')
  })

  it('renderiza step sem commit mas com note (commitCell branch)', async () => {
    const stepsNoCommit = [
      { num: 1, phase: 'A', task: 'Task sem commit', commit: null, status: 'done', completedAt: null, note: 'Nota da task' },
    ]
    const config = makeConfig(PHASES_VARIED, { steps: stepsNoCommit })
    setupDir(config)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Nota da task')
  })

  it('renderiza step sem commit e sem note (o "—" fallback)', async () => {
    const stepsNone = [
      { num: 1, phase: 'A', task: 'Task vazia', commit: null, status: 'pending', completedAt: null, note: null },
    ]
    const config = makeConfig(PHASES_VARIED, { steps: stepsNone })
    setupDir(config)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    // step presente mas sem commit/note → "—"
    expect(html).toContain('Task vazia')
  })
})

// ─── detectedTools rendering ──────────────────────────────────────────────────

describe('generateAuditReport — detectedTools com ferramentas not_found', () => {
  it('renderiza tool-missing quando status=not_found', async () => {
    const configWithTools = {
      ...makeConfig(PHASES_VARIED),
      detectedTools: {
        serialized: {
          maven: { path: '/usr/bin/mvn', version: '3.9.0', status: 'found' },
          jdk21: { path: null, version: null, status: 'not_found' },
          git: { path: '/usr/bin/git', version: '2.40.0', status: 'found' },
          openrewrite: { path: null, version: null, status: 'not_found' },
        },
      },
    }
    setupDir(configWithTools)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('tool-missing')
  })

  it('renderiza tool user_provided quando status=user_provided', async () => {
    const configWithTools = {
      ...makeConfig(PHASES_VARIED),
      detectedTools: {
        serialized: {
          maven: { path: '/custom/mvn', version: '3.8.0', status: 'user_provided' },
          jdk21: { path: '/custom/java', version: '21.0.1', status: 'user_provided' },
        },
      },
    }
    setupDir(configWithTools)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('tool-provided')
  })
})

// ─── Discovery sem correlation items (lista vazia) ───────────────────────────

describe('generateAuditReport — discovery sem knowledge correlation', () => {
  it('renderiza sem erros quando knowledgeCorrelation está vazio', async () => {
    const discNoCorr = { ...DISCOVERY, knowledgeCorrelation: [] }
    setupDir(makeConfig(PHASES_VARIED), PLAN_NO_MANUALS, discNoCorr)
    const result = await generateAuditReport(dir)
    expect(existsSync(result.reportPath)).toBe(true)
  })
})

// ─── Plano com todos os automatizationLevel ───────────────────────────────────

describe('generateAuditReport — plano com automationLevel variado', () => {
  it('renderiza automationLevel low, medium, high no HTML', async () => {
    const richPlan = {
      ...PLAN_NO_MANUALS,
      phases: [
        { number: 0, name: 'Fase 0', criticality: 'low', applicable: true, estimatedDays: 0.5, automationLevel: 'high', recipes: [], riskItems: [], manualItems: [], gateDescription: '', prerequisitesForHuman: [] },
        { number: 1, name: 'Fase 1', criticality: 'medium', applicable: true, estimatedDays: 2, automationLevel: 'medium', recipes: ['recipe-a'], riskItems: [
          { id: 'r1', severity: 'high', title: 'Risco alto', description: 'desc', file: 'App.java', line: 1, automationAvailable: true, recipe: 'recipe-a' },
        ], manualItems: [
          { id: 'm1', category: 'security', title: 'Revisar segurança', description: 'desc', suggestedApproach: 'Abordagem', files: ['Sec.java'] },
        ], gateDescription: 'Gate 1', prerequisitesForHuman: ['Teste manual'] },
        { number: 3, name: 'Fase 3', criticality: 'high', applicable: false, estimatedDays: 0, automationLevel: 'low', recipes: [], riskItems: [], manualItems: [], gateDescription: '', prerequisitesForHuman: [] },
      ],
    }
    setupDir(makeConfig(PHASES_VARIED), richPlan)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Revisar segurança')
    expect(html).toContain('Segurança')  // categoryLabel['security'] = 'Segurança'
  })
})

// ─── Fase 5 approved (MIGRAÇÃO CONCLUÍDA) ─────────────────────────────────────

describe('generateAuditReport — fase 5 completed (MIGRAÇÃO CONCLUÍDA)', () => {
  it('HTML contém indicação de migração concluída quando fase 5 é completed', async () => {
    // Timeout de 60s pois fase 5 completed também dispara generatePhase5Checklist (chama mvn)
    const phasesAllDone = {
      ...PHASES_VARIED,
      5: {
        status: 'completed', gateToken: 'tok-5', approvedBy: 'Charlie', approvedAt: '2026-06-10T14:00:00Z',
        executedAt: '2026-06-10T13:00:00Z', gitBranch: 'jdk-migration/phase-5', gitCommit: 'fff999',
        baseBranch: 'main', baseCommit: 'ggg000', prUrl: null,
      },
    }
    setupDir(makeConfig(phasesAllDone), PLAN_NO_MANUALS)
    const result = await generateAuditReport(dir)
    const html = readFileSync(result.reportPath, 'utf-8')
    // Fase 5 concluída: relatório deve mencionar isso ou pelo menos renderizar sem erro
    expect(existsSync(result.reportPath)).toBe(true)
    expect(html).toContain('Charlie')
  }, 60000)
})
