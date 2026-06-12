/**
 * Testes para generateAuditChecklist, generateFinalReport, generatePhase5Report
 * e funções auxiliares do report-generator não cobertas pelos outros arquivos.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  generateAuditChecklist,
  generateFinalReport,
  generateAuditReport,
} from '../../src/report-generator/index.js'
import type { MigrationAuditResult } from '../../src/static-analysis/migration-audit.js'

function makeTempDir(): string {
  const dir = join(tmpdir(), `rg-checklist-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeAudit(overrides: Partial<MigrationAuditResult> = {}): MigrationAuditResult {
  const ok = (id: string, label: string): any => ({
    id, label, status: 'ok', detail: 'ok', action: '', recommendation: '',
  })
  const fail = (id: string, label: string): any => ({
    id, label, status: 'fail', detail: 'falhou', action: 'corrigir', recommendation: '',
  })
  const warn = (id: string, label: string): any => ({
    id, label, status: 'warning', detail: 'atenção', action: '', recommendation: '',
  })

  const criteria: any[] = [
    ok('compiler-version', 'Versão do compilador'),
    ok('javax-imports', 'Imports javax.*'),
    ok('spring-boot-version', 'Versão Spring Boot'),
    ok('internal-deps', 'Dependências internas'),
    ok('container-ci', 'Container/CI'),
    ok('runtime-evidence', 'Evidência de runtime'),
    ok('obsolete-props', 'Properties obsoletas'),
    ok('output-bytecode', 'Bytecode de saída'),
    ok('actual-bytecode', 'Bytecode real'),
    ok('sun-internal-imports', 'Imports sun.*'),
    ok('security-manager', 'SecurityManager'),
    ok('removed-jvm-flags', 'JVM flags removidas'),
    ok('nashorn', 'Nashorn'),
    ok('add-opens', 'add-opens'),
    ok('annotation-processors', 'Processors'),
    ok('finalize-override', 'finalize()'),
    ok('mvn-jvm-config', 'jvm.config'),
    ok('serialization-risk', 'Serialização'),
    ok('javax-script', 'javax.script'),
    ok('reflective-internal', 'Reflexão interna'),
    ok('removed-apis', 'APIs removidas'),
    ok('bytecode-manip-libs', 'Libs bytecode'),
    ok('maven-plugin-versions', 'Plugins Maven'),
    ok('maven-jdk-profiles', 'Profiles JDK'),
    ok('k8s-manifests', 'Manifestos K8s'),
  ]

  return {
    projectPath: '/tmp/project',
    targetJdk: '21',
    generatedAt: new Date('2026-06-01T10:00:00Z').toISOString(),
    criteria,
    allOk: true,
    summary: { ok: 25, warning: 0, fail: 0 },
    ...overrides,
  } as MigrationAuditResult
}

describe('generateAuditChecklist — fase 0 (baseline)', () => {
  let migDir: string

  beforeEach(() => {
    migDir = makeTempDir()
  })
  afterEach(() => rmSync(migDir, { recursive: true, force: true }))

  it('gera audit-report-phase-0.md', () => {
    const audit = makeAudit()
    generateAuditChecklist(migDir, audit, 0, { sourceJdk: '8' })
    expect(existsSync(join(migDir, 'audit-report-phase-0.md'))).toBe(true)
  })

  it('conteúdo contém título baseline', () => {
    generateAuditChecklist(migDir, makeAudit(), 0, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-0.md'), 'utf-8')
    expect(md).toContain('Baseline')
    expect(md).toContain('Pré-Migração')
  })

  it('marcadores ficam como [ ] no baseline', () => {
    generateAuditChecklist(migDir, makeAudit(), 0, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-0.md'), 'utf-8')
    expect(md).toMatch(/\[ \]/)
    expect(md).not.toMatch(/\[X\]/)
  })

  it('contém os grupos A, C, D', () => {
    generateAuditChecklist(migDir, makeAudit(), 0, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-0.md'), 'utf-8')
    expect(md).toContain('Grupo A')
    expect(md).toContain('Grupo C')
    expect(md).toContain('Grupo D')
  })

  it('não lança exceção com config null', () => {
    expect(() => generateAuditChecklist(migDir, makeAudit(), 0, null)).not.toThrow()
  })
})

describe('generateAuditChecklist — fase 5 (resultado final)', () => {
  let migDir: string

  beforeEach(() => {
    migDir = makeTempDir()
  })
  afterEach(() => rmSync(migDir, { recursive: true, force: true }))

  it('gera audit-report-phase-5.md', () => {
    generateAuditChecklist(migDir, makeAudit(), 5, { sourceJdk: '8' })
    expect(existsSync(join(migDir, 'audit-report-phase-5.md'))).toBe(true)
  })

  it('critérios OK têm [X]', () => {
    generateAuditChecklist(migDir, makeAudit(), 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('[X]')
  })

  it('conteúdo contém STATUS FINAL quando allOk=true', () => {
    generateAuditChecklist(migDir, makeAudit({ allOk: true }), 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('STATUS FINAL')
    expect(md).toContain('SUCESSO')
  })

  it('conteúdo contém STATUS FINAL de falha quando allOk=false', () => {
    const audit = makeAudit()
    audit.allOk = false
    audit.summary = { ok: 24, warning: 0, fail: 1 }
    const failedCrit = audit.criteria.find(c => c.id === 'compiler-version') as any
    failedCrit.status = 'fail'
    generateAuditChecklist(migDir, audit, 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('ISSUES')
  })

  it('usa verdict.label quando verdict está presente', () => {
    const audit = makeAudit() as any
    audit.verdict = {
      level: 'approved',
      label: 'APROVADO',
      headline: 'Projeto pronto para produção',
      conditions: [],
      positiveEvidence: ['Bytecode JDK 21'],
    }
    generateAuditChecklist(migDir, audit, 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('APROVADO')
    expect(md).toContain('Projeto pronto para produção')
  })

  it('verdict conditionally_approved usa ⚠️', () => {
    const audit = makeAudit() as any
    audit.verdict = {
      level: 'conditionally_approved',
      label: 'APROVADO COM RESSALVAS',
      headline: 'Verificar itens pendentes',
      conditions: ['Validar K8s'],
      positiveEvidence: [],
    }
    generateAuditChecklist(migDir, audit, 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('APROVADO COM RESSALVAS')
  })

  it('gera PARECER FINAL quando fail=0', () => {
    generateAuditChecklist(migDir, makeAudit({ allOk: true, summary: { ok: 25, warning: 0, fail: 0 } }), 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('PARECER FINAL')
    expect(md).toContain('RESULTADO DA AUDITORIA')
  })

  it('PARECER FINAL mostra ZERO para javax quando ok', () => {
    generateAuditChecklist(migDir, makeAudit(), 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('ZERO')
  })

  it('PARECER FINAL com warnings pendentes', () => {
    const audit = makeAudit()
    audit.summary = { ok: 24, warning: 1, fail: 0 }
    const warnCrit = audit.criteria.find(c => c.id === 'k8s-manifests') as any
    warnCrit.status = 'warning'
    generateAuditChecklist(migDir, audit, 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('PARECER FINAL')
  })

  it('PARECER FINAL com verdict e conditions', () => {
    const audit = makeAudit() as any
    audit.verdict = {
      level: 'conditionally_approved',
      label: 'APROVADO COM RESSALVAS',
      headline: 'Verificar items',
      conditions: ['Condição 1', 'Condição 2'],
      falsePosCount: 1,
      positiveEvidence: [],
    }
    generateAuditChecklist(migDir, audit, 5, { sourceJdk: '8' })
    const md = readFileSync(join(migDir, 'audit-report-phase-5.md'), 'utf-8')
    expect(md).toContain('PARECER FINAL')
    expect(md).toContain('Condição 1')
  })
})

describe('generateFinalReport', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = makeTempDir()
    const migDir = join(projectDir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })

    // Mínimo para generateAuditReport não lançar
    const discovery = {
      projectPath: projectDir,
      timestamp: '2026-06-01T10:00:00Z',
      sourceJdk: '8',
      detectedStacks: ['spring-boot'],
      buildSystem: 'maven',
      isMultiModule: false,
      staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 0, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: '/usr/lib/jvm/java-21', compiledClassesFound: false },
      knowledgeCorrelation: [],
      profilerReports: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0, manualReviewRequired: false, estimatedEffortDays: 0 },
      prerequisites: { jdk21Available: true, gitAvailable: true, compiledClassesFound: false },
      savedReportPath: join(migDir, 'discovery-report.json'),
    }
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(discovery), 'utf-8')
  })
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }))

  it('gera audit-report-final.html e retorna paths não nulos', async () => {
    const result = await generateFinalReport(projectDir)
    expect(result.timestamped).not.toBeNull()
    expect(result.final).not.toBeNull()
    expect(existsSync(result.final!)).toBe(true)
    expect(result.final!).toContain('audit-report-final.html')
  })

  it('retorna {timestamped: null, final: null} em erro', async () => {
    const result = await generateFinalReport('/non-existent-path-xyz')
    expect(result.timestamped).toBeNull()
    expect(result.final).toBeNull()
  })
})

describe('generateAuditReport — branches descoberta-sem-plano', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = makeTempDir()
    const migDir = join(projectDir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })

    const discovery = {
      projectPath: projectDir,
      timestamp: '2026-06-01T10:00:00Z',
      sourceJdk: '8',
      detectedStacks: ['spring-boot'],
      buildSystem: 'maven',
      isMultiModule: false,
      staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 0, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: '/jdk21', compiledClassesFound: false },
      knowledgeCorrelation: [],
      profilerReports: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0, manualReviewRequired: false, estimatedEffortDays: 0 },
      prerequisites: { jdk21Available: true, gitAvailable: true, compiledClassesFound: false },
      savedReportPath: join(migDir, 'discovery-report.json'),
    }
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify(discovery), 'utf-8')
  })
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }))

  it('gera relatório com apenas discovery (sem plano)', async () => {
    const result = await generateAuditReport(projectDir)
    expect(result.reportPath).toContain('audit-report-')
    expect(existsSync(result.reportPath)).toBe(true)
  })

  it('generateAuditReportSilent retorna null quando não há dados', async () => {
    const { generateAuditReportSilent } = await import('../../src/report-generator/index.js')
    const result = await generateAuditReportSilent('/non-existent-zzz')
    expect(result).toBeNull()
  })

  it('gera phase5-checklist.md quando fase 5 está in_progress', async () => {
    const migDir = join(projectDir, '.jdk-migration')
    const config = {
      sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'], buildSystem: 'maven',
      phases: {
        0: { status: 'completed', gateToken: 'tok', approvedBy: 'Alice', approvedAt: '2026-06-01T00:00:00Z', executedAt: '2026-06-01T00:00:00Z', gitBranch: 'jdk/0', gitCommit: 'abc', baseBranch: 'main', baseCommit: 'def', prUrl: null },
        5: { status: 'in_progress', gateToken: null, approvedBy: null, approvedAt: null, executedAt: null, gitBranch: null, gitCommit: null, baseBranch: null, baseCommit: null, prUrl: null },
      },
    }
    writeFileSync(join(projectDir, 'jdk-migration.config.json'), JSON.stringify(config), 'utf-8')
    await generateAuditReport(projectDir)
    expect(existsSync(join(migDir, 'phase5-checklist.md'))).toBe(true)
  })
})
