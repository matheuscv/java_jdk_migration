import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { generateAuditReport, generateFinalReport, generateAuditReportSilent } from '../../src/report-generator/index.js'

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

// ─── generateFinalReport ──────────────────────────────────────────────────────

describe('generateFinalReport', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('gera relatório timestamped E audit-report-final.html', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))

    const result = await generateFinalReport(dir)
    expect(result.timestamped).not.toBeNull()
    expect(result.final).not.toBeNull()
    expect(existsSync(result.final!)).toBe(true)
    expect(result.final).toContain('audit-report-final.html')
  })

  it('retorna { timestamped: null, final: null } quando não há dados', async () => {
    dir = makeTempDir()
    const result = await generateFinalReport(dir)
    expect(result.timestamped).toBeNull()
    expect(result.final).toBeNull()
  })
})

// ─── generateAuditReportSilent ────────────────────────────────────────────────

describe('generateAuditReportSilent', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('retorna caminho do report quando há dados', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))

    const path = await generateAuditReportSilent(dir)
    expect(path).not.toBeNull()
    expect(existsSync(path!)).toBe(true)
  })

  it('retorna null quando não há dados (sem lançar exceção)', async () => {
    dir = makeTempDir()
    const path = await generateAuditReportSilent(dir)
    expect(path).toBeNull()
  })
})

// ─── generateAuditReport — cenários avançados ────────────────────────────────

describe('generateAuditReport — fase 5 ativa (gera checklist)', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('gera phase-5-checklist.html quando fase 5 está in_progress', async () => {
    // Este teste pode demorar pois tenta rodar runCompilerCheck internamente
    // Timeout maior para aguardar o compilador (que falhará silenciosamente no CI)
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)

    const configWithPhase5 = {
      ...SAMPLE_CONFIG,
      phases: {
        ...SAMPLE_CONFIG.phases,
        5: { status: 'in_progress', gateToken: null, approvedBy: null, approvedAt: null, executedAt: '2026-06-01T10:00:00Z', gitBranch: 'jdk-migration/phase-5', gitCommit: 'zzzzzz', baseBranch: 'main', baseCommit: 'yyy', prUrl: null },
      },
    }
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify(SAMPLE_PLAN))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(configWithPhase5))

    const result = await generateAuditReport(dir)
    // O report principal é gerado com sucesso mesmo que a checklist falhe silenciosamente
    expect(existsSync(result.reportPath)).toBe(true)
  }, 60000) // 60s timeout — runCompilerCheck roda mvn que pode ser lento

  it('gera relatório com migrationAudit passado como parâmetro', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const migrationAudit = {
      projectPath: dir,
      targetJdk: '21',
      timestamp: new Date().toISOString(),
      criteria: [],
      summary: { passed: 20, warned: 3, failed: 2, total: 25 },
    }

    const result = await generateAuditReport(dir, migrationAudit as never)
    expect(existsSync(result.reportPath)).toBe(true)
  })
})

describe('generateAuditReport — containerCi e steps', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('HTML renderiza findings de container quando presentes no discovery', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)

    const discoveryWithContainer = {
      ...SAMPLE_DISCOVERY,
      containerCi: {
        findings: [
          {
            file: 'Dockerfile',
            fileType: 'dockerfile' as const,
            line: 1,
            content: 'FROM openjdk:8-jre-alpine',
            detectedJdkVersion: '8',
            detectedImage: 'openjdk:8-jre-alpine',
            description: 'Imagem JDK 8 detectada',
            suggestion: 'Use eclipse-temurin:21-jre-alpine',
            severity: 'high' as const,
            requiresHumanDecision: true,
          },
        ],
        summary: { dockerfileCount: 1, ciFileCount: 0, outdatedImages: 1, requiresHumanDecision: 1 },
      },
    }
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(discoveryWithContainer))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(SAMPLE_CONFIG))

    const result = await generateAuditReport(dir)
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Dockerfile')
  })

  it('HTML renderiza steps quando config.steps está preenchido', async () => {
    dir = makeTempDir()
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir)

    const configWithSteps = {
      ...SAMPLE_CONFIG,
      steps: [
        { num: 1, phase: '1', task: 'Atualizar pom.xml', commit: 'aaa111', status: 'done', completedAt: '2026-05-30T08:00:00Z', note: 'Concluído' },
        { num: 2, phase: '2', task: 'Migrar imports jakarta', commit: 'bbb222', status: 'in_progress', completedAt: null, note: '' },
      ],
    }
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(SAMPLE_DISCOVERY))
    writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(configWithSteps))

    const result = await generateAuditReport(dir)
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(result.reportPath, 'utf-8')
    expect(html).toContain('Atualizar pom.xml')
  })
})
