import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { generateAuditReport } from '../../src/report-generator/index.js'

function makeTempDir(): string {
  const dir = join(tmpdir(), `report-gen-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const SAMPLE_CONFIG = {
  sourceJdk: '8', targetJdk: '21',
  stack: ['ejb', 'spring-boot'],
  buildSystem: 'maven', appServer: 'jboss',
  multiModule: false, modulePaths: [], ciSystem: null,
  testCoverageThreshold: 80, dryRunBeforeExecute: true,
  phases: {
    0: { status: 'completed', gateToken: 'tok-0', approvedBy: 'Alice', approvedAt: '2026-05-29T10:00:00Z', executedAt: '2026-05-29T09:00:00Z', gitBranch: 'jdk-migration/phase-0', gitCommit: 'abc1', baseBranch: 'main', baseCommit: 'def1', prUrl: null },
    1: { status: 'completed', gateToken: 'tok-1', approvedBy: 'Bob', approvedAt: '2026-05-30T08:00:00Z', executedAt: '2026-05-30T07:00:00Z', gitBranch: 'jdk-migration/phase-1', gitCommit: 'abc2', baseBranch: 'main', baseCommit: 'def2', prUrl: null },
    2: { status: 'awaiting_gate', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
    3: { status: 'pending', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
    4: { status: 'pending', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
    5: { status: 'pending', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
  },
}

const SAMPLE_DISCOVERY = {
  projectPath: '/tmp/project',
  timestamp: '2026-05-29T09:00:00Z',
  sourceJdk: '8',
  detectedStacks: ['ejb', 'spring-boot'],
  buildSystem: 'maven',
  isMultiModule: false,
  staticAnalysis: { jdeprscanItemCount: 3, sourceItemCount: 5, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: null, compiledClassesFound: false },
  knowledgeCorrelation: [
    { apiPattern: 'sun.misc.BASE64Encoder', removedInJdk: '11', severity: 'high', automatable: true, recipe: 'org.openrewrite.java.migrate.UseApacheBase64', migrationNote: 'Use Base64 from java.util', foundInFiles: ['LegacyService.java'] },
  ],
  profilerReports: [],
  riskSummary: { critical: 2, high: 1, medium: 0, low: 0, manualReviewRequired: true, estimatedEffortDays: 14 },
  prerequisites: { jdk21Available: true, gitAvailable: true, compiledClassesFound: false },
  savedReportPath: '/tmp/project/.jdk-migration/discovery-report.json',
}

const SAMPLE_PLAN = {
  projectPath: '/tmp/project',
  generatedAt: '2026-05-29T09:30:00Z',
  sourceJdk: '8', targetJdk: '21',
  detectedStacks: ['ejb', 'spring-boot'],
  totalEstimatedDays: 14,
  manualReviewRequired: true,
  summary: 'JDK 8 → JDK 21',
  phases: [
    {
      number: 0, name: 'Descoberta & Baseline', criticality: 'low', applicable: true,
      estimatedDays: 0.5, automationLevel: 'high', recipes: [],
      riskItems: [],
      manualItems: [],
      gateDescription: 'Aprovar plano',
      prerequisitesForHuman: [],
    },
    {
      number: 3, name: 'Namespace Jakarta & Frameworks', criticality: 'high', applicable: true,
      estimatedDays: 8, automationLevel: 'medium',
      recipes: ['org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb'],
      riskItems: [
        { id: 'ejb-stateful', severity: 'critical', title: '@Stateful beans detectados', description: '...', file: 'CartBean.java', line: 10, automationAvailable: false, recipe: null },
        { id: 'ejb-stateless', severity: 'medium', title: '@Stateless beans', description: '...', file: 'OrderService.java', line: 5, automationAvailable: true, recipe: 'org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb' },
      ],
      manualItems: [
        { id: 'ejb-stateful-redesign', category: 'semantic', title: 'Redesenhar @Stateful EJBs', description: '...', suggestedApproach: '1. Catalogar campos de estado\n2. Migrar para CDI', files: ['CartBean.java'] },
      ],
      gateDescription: 'App sobe no servidor; smoke tests',
      prerequisitesForHuman: ['Staging configurado'],
    },
  ],
}

describe('generateAuditReport — geração de arquivo', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('gera o arquivo HTML e retorna o caminho correto', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    expect(existsSync(result.reportPath)).toBe(true)
    expect(result.reportPath).toContain('audit-report-')
    expect(result.reportPath).toMatch(/\.html$/)
  })

  it('reportPath está dentro de .jdk-migration/', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    expect(result.reportPath).toContain('.jdk-migration')
  })
})

describe('generateAuditReport — estatísticas de resumo', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('conta corretamente fases completadas', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    expect(result.phasesCompleted).toBe(2)  // phases 0 e 1 são completed
    expect(result.phasesTotal).toBe(6)
  })

  it('conta corretamente riscos críticos', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    expect(result.criticalRisks).toBe(1)  // ejb-stateful é critical
  })

  it('conta corretamente itens manuais', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    expect(result.openManualItems).toBe(1)  // ejb-stateful-redesign
  })
})

describe('generateAuditReport — conteúdo HTML', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('HTML contém informações do projeto (stack, JDK)', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(result.reportPath, 'utf-8')

    expect(html).toContain('JDK 8')
    expect(html).toContain('JDK 21')
    expect(html).toContain('ejb')
    expect(html).toContain('maven')
    expect(html).toContain('Alice')   // aprovadora fase 0
    expect(html).toContain('Bob')     // aprovador fase 1
  })

  it('HTML contém risco critical ejb-stateful', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(result.reportPath, 'utf-8')

    expect(html).toContain('@Stateful beans detectados')
    expect(html).toContain('badge-critical')
  })

  it('HTML contém trilha de auditoria com aprovadores', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(result.reportPath, 'utf-8')

    expect(html).toContain('Trilha de Auditoria')
    expect(html).toContain('Alice')
    expect(html).toContain('Bob')
  })
})

describe('generateAuditReport — sem dados', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('lança MigrationError quando não há dados de migração', async () => {
    dir = makeTempDir()
    await expect(generateAuditReport(dir)).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    })
  })

  it('gera relatório mesmo sem migration-plan (somente discovery)', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))

    const result = await generateAuditReport(dir)
    expect(existsSync(result.reportPath)).toBe(true)
  })
})
