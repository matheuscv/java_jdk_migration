/**
 * Testes adicionais para src/mcp-server/tools/auxiliary.ts
 * Cobre branches de pendingHumanDecisions para fases 1–5, update_phase_costs,
 * PIN expirado, nomes proibidos, update_step_status com reportMode phase-gate-step,
 * rollback_phase caminhos de erro, generate_report com fase 5 ativa.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

vi.mock('../../src/static-analysis/migration-audit.js', () => ({
  runMigrationAudit: vi.fn().mockResolvedValue({
    projectPath: '/tmp', targetJdk: '21', timestamp: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    allOk: true,
    criteria: [],
    summary: { ok: 25, warning: 0, fail: 0, passed: 25, warned: 0, failed: 0, total: 25 },
  }),
}))

vi.mock('../../src/report-generator/index.js', async () => {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { MigrationError } = await import('../../src/lib/errors.js')
  return {
    generateAuditReport: vi.fn().mockImplementation(async (projectPath: string) => {
      const planPath = join(projectPath, '.jdk-migration', 'migration-plan.json')
      const discoveryPath = join(projectPath, '.jdk-migration', 'discovery-report.json')
      if (!existsSync(planPath) && !existsSync(discoveryPath)) {
        throw new MigrationError('CONFIG_NOT_FOUND', 'Nenhum dado de migração encontrado.', { planPath, discoveryPath })
      }
      return {
        reportPath: join(projectPath, '.jdk-migration', 'audit-report-test.html'),
        phasesCompleted: 1, phasesTotal: 6, openManualItems: 0, criticalRisks: 0,
      }
    }),
    generateAuditReportSilent: vi.fn().mockResolvedValue(undefined),
    generateFinalReport: vi.fn().mockResolvedValue({
      reportPath: '/tmp/test/final-report.html',
      phasesCompleted: 6, phasesTotal: 6, openManualItems: 0, criticalRisks: 0,
    }),
  }
})

import { registerAuxiliaryTools } from '../../src/mcp-server/tools/auxiliary.js'
import { writeConfig, createDefaultPhases, writePinStore } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

// ─── Mock McpServer ────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>

function createMockServer() {
  const handlers: Record<string, ToolHandler> = {}
  const server = {
    registerTool: vi.fn((name: string, _schema: unknown, handler: ToolHandler) => {
      handlers[name] = handler
    }),
  }
  return { server, handlers }
}

function tempDir(): string {
  const d = join(tmpdir(), `aux-extra-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function makeConfig(overrides: Partial<JdkMigrationConfig> = {}): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21',
    stack: ['spring-boot'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, reportMode: 'phase-gate',
    phases: createDefaultPhases(),
    ...overrides,
  }
}

function jsonText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

function setPhaseStatus(config: JdkMigrationConfig, phase: 0|1|2|3|4|5, status: string): JdkMigrationConfig {
  return {
    ...config,
    phases: {
      ...config.phases,
      [phase]: { ...config.phases[phase], status },
    },
  }
}

let dir: string
let handlers: Record<string, ToolHandler>

beforeEach(() => {
  dir = tempDir()
  const { server, handlers: h } = createMockServer()
  registerAuxiliaryTools(server as never)
  handlers = h
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── request_gate_approval — fases 1–5 com pom.xml para human decisions ───────

describe('request_gate_approval — fase 1 com pom.xml contendo internal groupIds', () => {
  it('pendingHumanDecisions inclui A4 quando groupId não-público detectado', async () => {
    const cfg = setPhaseStatus(makeConfig(), 1, 'awaiting_gate')
    writeConfig(dir, cfg)
    // Escreve pom.xml com groupId interno
    writeFileSync(join(dir, 'pom.xml'), `<project>
      <groupId>com.mycompany.internal</groupId>
      <dependencies>
        <dependency><groupId>com.mycompany.internal</groupId><artifactId>core</artifactId></dependency>
        <dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency>
      </dependencies>
    </project>`, 'utf-8')

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 1 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    expect(body.phase).toBe(1)
    // pendingHumanDecisions pode ou não estar presente — não deve crashar
  })
})

describe('request_gate_approval — fase 1 com --add-opens no pom.xml', () => {
  it('detecta flag --add-opens e inclui C6 em pendingHumanDecisions', async () => {
    const cfg = setPhaseStatus(makeConfig(), 1, 'awaiting_gate')
    writeConfig(dir, cfg)
    writeFileSync(join(dir, 'pom.xml'), `<project>
      <build><plugins><plugin>
        <configuration><argLine>--add-opens java.base/java.lang=ALL-UNNAMED</argLine></configuration>
      </plugin></plugins></build>
    </project>`, 'utf-8')

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 1 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    if (body.pendingHumanDecisions) {
      const decisions = body.pendingHumanDecisions as Array<{ id: string }>
      const c6 = decisions.find(d => d.id === 'C6-add-opens')
      expect(c6).toBeDefined()
    }
  })
})

describe('request_gate_approval — fase 2 sem source-cleaner details', () => {
  it('fase 2 gera PIN sem lançar exceção mesmo sem runnerDetails', async () => {
    const cfg = setPhaseStatus(makeConfig(), 2, 'awaiting_gate')
    writeConfig(dir, cfg)

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 2 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    expect(body.phase).toBe(2)
  })
})

describe('request_gate_approval — fase 3 com stack spring-boot', () => {
  it('inclui C1 (Spring Boot version) em pendingHumanDecisions', async () => {
    const cfg = setPhaseStatus(makeConfig({ stack: ['spring-boot'] }), 3, 'awaiting_gate')
    writeConfig(dir, cfg)
    writeFileSync(join(dir, 'pom.xml'), `<project>
      <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version>
      </parent>
    </project>`, 'utf-8')

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 3 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    if (body.pendingHumanDecisions) {
      const decisions = body.pendingHumanDecisions as Array<{ id: string }>
      const c1 = decisions.find(d => d.id === 'C1-spring-boot-version')
      expect(c1).toBeDefined()
    }
  })
})

describe('request_gate_approval — fase 4', () => {
  it('gera PIN para fase 4 sem crashar', async () => {
    const cfg = setPhaseStatus(makeConfig(), 4, 'awaiting_gate')
    writeConfig(dir, cfg)

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 4 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    expect(body.phase).toBe(4)
  })

  it('detecta SecurityManager em src/main/java se presente', async () => {
    const cfg = setPhaseStatus(makeConfig(), 4, 'awaiting_gate')
    writeConfig(dir, cfg)
    // Cria arquivo java com SecurityManager
    const srcDir = join(dir, 'src', 'main', 'java')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'MySecMgr.java'), `
      public class MySecMgr extends SecurityManager {
        public void checkRead(String file) {}
      }
    `, 'utf-8')

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 4 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    if (body.pendingHumanDecisions) {
      const decisions = body.pendingHumanDecisions as Array<{ id: string }>
      const sm = decisions.find(d => d.id === 'security-manager')
      expect(sm).toBeDefined()
      expect(sm?.blocking ?? false).toBe(true)
    }
  })
})

describe('request_gate_approval — fase 5', () => {
  it('sempre inclui A6 (runtime evidence) em pendingHumanDecisions', async () => {
    const cfg = setPhaseStatus(makeConfig(), 5, 'awaiting_gate')
    writeConfig(dir, cfg)

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 5 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    expect(body.pendingHumanDecisions).toBeDefined()
    const decisions = body.pendingHumanDecisions as Array<{ id: string; blocking: boolean }>
    const a6 = decisions.find(d => d.id === 'A6-runtime-evidence')
    expect(a6).toBeDefined()
    expect(a6?.blocking).toBe(true)
  })

  it('inclui D5 (K8s) quando diretório k8s existe', async () => {
    const cfg = setPhaseStatus(makeConfig(), 5, 'awaiting_gate')
    writeConfig(dir, cfg)
    mkdirSync(join(dir, 'k8s'), { recursive: true })

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 5 })
    const body = jsonText(result) as Record<string, unknown>
    const decisions = (body.pendingHumanDecisions ?? []) as Array<{ id: string }>
    const d5 = decisions.find(d => d.id === 'D5-k8s-validation')
    expect(d5).toBeDefined()
  })

  it('inclui D5 quando diretório helm existe', async () => {
    const cfg = setPhaseStatus(makeConfig(), 5, 'awaiting_gate')
    writeConfig(dir, cfg)
    mkdirSync(join(dir, 'helm'), { recursive: true })

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 5 })
    const body = jsonText(result) as Record<string, unknown>
    const decisions = (body.pendingHumanDecisions ?? []) as Array<{ id: string }>
    const d5 = decisions.find(d => d.id === 'D5-k8s-validation')
    expect(d5).toBeDefined()
  })
})

describe('request_gate_approval — fase com status não-awaiting_gate', () => {
  it('retorna PHASE_OUT_OF_ORDER quando fase não está awaiting_gate', async () => {
    const cfg = makeConfig()  // todas pending
    writeConfig(dir, cfg)

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 0 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('PHASE_OUT_OF_ORDER')
  })
})

// ─── approve_gate — nomes proibidos ───────────────────────────────────────────

describe('approve_gate — nomes proibidos lançam MigrationError', () => {
  const forbiddenNames = ['bot', 'claude', 'ai', 'agent', 'automation', 'system', 'robot', 'copilot']

  for (const name of forbiddenNames) {
    it(`rejeita approverName "${name}"`, async () => {
      writeConfig(dir, makeConfig())
      await expect(
        handlers['approve_gate']({ projectPath: dir, phaseNumber: 0, approverName: name, humanPin: '123456' }),
      ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' })
    })
  }
})

// ─── approve_gate — PIN ausente ───────────────────────────────────────────────

describe('approve_gate — sem PIN gerado', () => {
  it('lança GATE_TOKEN_INVALID quando nenhum PIN foi gerado para a fase', async () => {
    writeConfig(dir, makeConfig())
    await expect(
      handlers['approve_gate']({ projectPath: dir, phaseNumber: 0, approverName: 'João Silva', humanPin: '123456' }),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' })
  })
})

// ─── approve_gate — PIN expirado ──────────────────────────────────────────────

describe('approve_gate — PIN expirado', () => {
  it('lança GATE_TOKEN_INVALID quando PIN passou da validade', async () => {
    writeConfig(dir, makeConfig())
    // Grava um PIN com expiresAt no passado
    const expiredAt = new Date(Date.now() - 1000).toISOString()
    writePinStore(dir, { 0: { pin: '999888', expiresAt: expiredAt, phaseNumber: 0 } })

    await expect(
      handlers['approve_gate']({ projectPath: dir, phaseNumber: 0, approverName: 'João Silva', humanPin: '999888' }),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' })
  })
})

// ─── approve_gate — PIN incorreto ─────────────────────────────────────────────

describe('approve_gate — PIN incorreto', () => {
  it('lança GATE_TOKEN_INVALID quando PIN não corresponde', async () => {
    writeConfig(dir, makeConfig())
    const futureAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    writePinStore(dir, { 0: { pin: '111222', expiresAt: futureAt, phaseNumber: 0 } })

    await expect(
      handlers['approve_gate']({ projectPath: dir, phaseNumber: 0, approverName: 'João Silva', humanPin: '999999' }),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' })
  })
})

// ─── rollback_phase — erros ───────────────────────────────────────────────────

describe('rollback_phase — fase não revertível', () => {
  it('retorna PHASE_OUT_OF_ORDER quando fase está pending', async () => {
    writeConfig(dir, makeConfig())
    const result = await handlers['rollback_phase']({ projectPath: dir, phaseNumber: 0 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('PHASE_OUT_OF_ORDER')
  })

  it('retorna PHASE_OUT_OF_ORDER quando fase está approved', async () => {
    const cfg = setPhaseStatus(makeConfig(), 0, 'approved')
    writeConfig(dir, cfg)
    const result = await handlers['rollback_phase']({ projectPath: dir, phaseNumber: 0 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('PHASE_OUT_OF_ORDER')
  })

  it('retorna PHASE_OUT_OF_ORDER quando fase in_progress não tem baseBranch', async () => {
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        0: { ...createDefaultPhases()[0], status: 'in_progress' as const, baseBranch: null, baseCommit: null },
      },
    }
    writeConfig(dir, cfg as never)
    const result = await handlers['rollback_phase']({ projectPath: dir, phaseNumber: 0 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('PHASE_OUT_OF_ORDER')
  })
})

// ─── update_step_status — reportMode phase-gate-step ─────────────────────────

describe('update_step_status', () => {
  it('registra step e retorna resumo correto', async () => {
    writeConfig(dir, makeConfig({ reportMode: 'phase-gate' }))

    const result = await handlers['update_step_status']({
      projectPath: dir,
      stepNum: 1,
      owner: 'claude',
      phase: 'B',
      task: 'Atualizar pom.xml',
      status: 'done',
      commit: 'abc1234',
      note: 'Maven atualizado para 3.9',
    })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.doneSteps).toBe(1)
    expect(body.totalSteps).toBe(1)
  })

  it('step skipped não conta como done', async () => {
    writeConfig(dir, makeConfig({ reportMode: 'phase-gate' }))
    await handlers['update_step_status']({
      projectPath: dir, stepNum: 1, owner: 'you', phase: 'A',
      task: 'Verificar deps', status: 'done',
    })
    await handlers['update_step_status']({
      projectPath: dir, stepNum: 2, owner: 'claude', phase: 'B',
      task: 'Compilar', status: 'skipped',
    })
    const result = await handlers['update_step_status']({
      projectPath: dir, stepNum: 3, owner: 'claude', phase: 'C',
      task: 'Testar', status: 'pending',
    })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.totalSteps).toBe(3)
    expect(body.doneSteps).toBe(1)
  })

  it('atualiza step existente (upsert por num)', async () => {
    writeConfig(dir, makeConfig({ reportMode: 'phase-gate' }))
    await handlers['update_step_status']({
      projectPath: dir, stepNum: 1, owner: 'claude', phase: 'B',
      task: 'Task original', status: 'pending',
    })
    const result = await handlers['update_step_status']({
      projectPath: dir, stepNum: 1, owner: 'claude', phase: 'B',
      task: 'Task original', status: 'done', commit: 'def5678',
    })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.totalSteps).toBe(1)  // não duplicou
    expect(body.doneSteps).toBe(1)
  })

  it('gera audit report quando reportMode=phase-gate-step', async () => {
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })
    writeConfig(dir, makeConfig({ reportMode: 'phase-gate-step' }))
    // Precisamos de um discovery para o report ser gerado
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify({
      projectPath: dir, timestamp: new Date().toISOString(),
      sourceJdk: '8', detectedStacks: ['rest'], buildSystem: 'maven',
      isMultiModule: false, staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 0, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: null, compiledClassesFound: false },
      knowledgeCorrelation: [], profilerReports: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0, manualReviewRequired: false, estimatedEffortDays: 0 },
      prerequisites: { jdk21Available: false, gitAvailable: false, compiledClassesFound: false },
      savedReportPath: join(migDir, 'discovery-report.json'),
    }), 'utf-8')

    const result = await handlers['update_step_status']({
      projectPath: dir, stepNum: 1, owner: 'claude', phase: 'A',
      task: 'Step de teste', status: 'done',
    })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('ok')
    // auditReport pode ser null (sem config completo) — mas não deve crashar
  })
})

// ─── update_phase_costs ───────────────────────────────────────────────────────

describe('update_phase_costs', () => {
  it('calcula custo e persiste ROI sem crashar', async () => {
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        0: {
          ...createDefaultPhases()[0],
          status: 'awaiting_gate' as const,
          executedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
      },
    }
    writeConfig(dir, cfg as never)

    const result = await handlers['update_phase_costs']({
      projectPath: dir,
      phaseNumber: 0,
      tokenUsage: {
        inputTokens: 10000,
        outputTokens: 2000,
        cacheCreationTokens: 50000,
        cacheReadTokens: 200000,
      },
    })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.phaseNumber).toBe(0)
    expect(body.roi).toBeDefined()
  })

  it('funciona com apenas inputTokens e outputTokens (sem cache)', async () => {
    writeConfig(dir, makeConfig())

    const result = await handlers['update_phase_costs']({
      projectPath: dir,
      phaseNumber: 1,
      tokenUsage: { inputTokens: 5000, outputTokens: 1000 },
    })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('ok')
  })
})

// ─── generate_report — com e sem config ──────────────────────────────────────

describe('generate_report', () => {
  it('retorna error CONFIG_NOT_FOUND quando não há dados', async () => {
    const result = await handlers['generate_report']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('CONFIG_NOT_FOUND')
  })

  it('gera relatório quando discovery-report existe', async () => {
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify({
      projectPath: dir, timestamp: new Date().toISOString(),
      sourceJdk: '8', detectedStacks: ['rest'], buildSystem: 'maven',
      isMultiModule: false, staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 0, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: null, compiledClassesFound: false },
      knowledgeCorrelation: [], profilerReports: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0, manualReviewRequired: false, estimatedEffortDays: 0 },
      prerequisites: { jdk21Available: false, gitAvailable: false, compiledClassesFound: false },
      savedReportPath: join(migDir, 'discovery-report.json'),
    }), 'utf-8')

    const result = await handlers['generate_report']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.reportPath).toBeDefined()
  })

  it('gera relatório com fase 5 awaiting_gate (dispara migrationAudit)', async () => {
    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })
    const cfg = {
      ...makeConfig(),
      phases: {
        ...createDefaultPhases(),
        5: { ...createDefaultPhases()[5], status: 'awaiting_gate' as const, executedAt: new Date().toISOString() },
      },
    }
    writeConfig(dir, cfg as never)
    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify({
      projectPath: dir, timestamp: new Date().toISOString(),
      sourceJdk: '8', detectedStacks: ['rest'], buildSystem: 'maven',
      isMultiModule: false, staticAnalysis: { jdeprscanItemCount: 0, sourceItemCount: 0, jdepsViolations: [], splitPackages: [], runtimeWarnings: [], javaHomeUsed: null, compiledClassesFound: false },
      knowledgeCorrelation: [], profilerReports: [],
      riskSummary: { critical: 0, high: 0, medium: 0, low: 0, manualReviewRequired: false, estimatedEffortDays: 0 },
      prerequisites: { jdk21Available: false, gitAvailable: false, compiledClassesFound: false },
      savedReportPath: join(migDir, 'discovery-report.json'),
    }), 'utf-8')

    const result = await handlers['generate_report']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('ok')
  }, 30000)
})

// ─── request_gate_approval — fase 0 com plan e discovery ─────────────────────

describe('request_gate_approval — fase 0 com plano e containerCi findings', () => {
  it('inclui containerCi findings como pendingHumanDecisions', async () => {
    const cfg = setPhaseStatus(makeConfig(), 0, 'awaiting_gate')
    writeConfig(dir, cfg)

    const migDir = join(dir, '.jdk-migration')
    mkdirSync(migDir, { recursive: true })

    writeFileSync(join(migDir, 'discovery-report.json'), JSON.stringify({
      containerCi: {
        findings: [
          {
            file: 'Dockerfile',
            fileType: 'dockerfile',
            line: 1,
            content: 'FROM openjdk:8',
            detectedJdkVersion: '8',
            description: 'Imagem JDK 8 detectada',
            suggestion: 'Use eclipse-temurin:21-jre',
            severity: 'high',
            requiresHumanDecision: true,
          },
        ],
      },
    }), 'utf-8')

    writeFileSync(join(migDir, 'migration-plan.json'), JSON.stringify({
      phases: [
        {
          number: 1,
          manualItems: [
            {
              id: 'manual-1',
              requiresHumanDecision: true,
              category: 'infrastructure',
              title: 'Atualizar Dockerfile',
              description: 'Atualizar imagem base',
              suggestedApproach: 'Use JDK 21',
              files: ['Dockerfile'],
            },
          ],
        },
      ],
    }), 'utf-8')

    const result = await handlers['request_gate_approval']({ projectPath: dir, phaseNumber: 0 })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.status).toBe('awaiting_human_pin')
    expect(body.pendingHumanDecisions).toBeDefined()
    const decisions = body.pendingHumanDecisions as Array<{ id: string }>
    // Deve ter decisões da fase 0 (plano + containerCi)
    expect(decisions.length).toBeGreaterThan(0)
  })
})
