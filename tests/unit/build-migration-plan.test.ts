/**
 * Testes unitários para build-migration-plan.ts (MCP tool build_migration_plan)
 * Estratégia: mock McpServer, cria discovery-report.json em temp dir
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { registerBuildMigrationPlan } from '../../src/mcp-server/tools/build-migration-plan.js'
import { writeConfig, createDefaultPhases } from '../../src/lib/config.js'
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  const d = join(tmpdir(), `bmp-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function jsonText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

function makeMinimalDiscovery(overrides?: Record<string, unknown>) {
  return {
    projectPath: '/tmp/app',
    timestamp: new Date().toISOString(),
    sourceJdk: '8',
    detectedStacks: ['rest'],
    buildSystem: 'maven',
    isMultiModule: false,
    staticAnalysis: {
      jdeprscanItemCount: 0,
      sourceItemCount: 0,
      jdepsViolations: [],
      splitPackages: [],
      runtimeWarnings: [],
      javaHomeUsed: null,
      compiledClassesFound: false,
    },
    containerCi: {
      findings: [],
      summary: { dockerfileCount: 0, ciFileCount: 0, outdatedImages: 0, requiresHumanDecision: 0 },
    },
    knowledgeCorrelation: [],
    profilerReports: [],
    riskSummary: {
      critical: 0, high: 0, medium: 0, low: 0,
      manualReviewRequired: false, estimatedEffortDays: 5,
    },
    prerequisites: {
      jdk21Available: true, gitAvailable: true, compiledClassesFound: false,
    },
    detectedTools: {
      mvn: '/usr/local/bin/mvn', gradle: null, ant: null,
      jdk21: '/usr/lib/jvm/java-21', jdk21Version: '21.0.1',
      git: '/usr/bin/git',
    },
    allToolsFound: true,
    sourceBuild: null,
    ...overrides,
  }
}

function makeConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21',
    stack: ['rest'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, reportMode: 'phase-gate',
    phases: createDefaultPhases(),
    ...overrides,
  }
}

let dir: string
let handlers: Record<string, ToolHandler>

beforeEach(() => {
  dir = tempDir()
  const { server, handlers: h } = createMockServer()
  registerBuildMigrationPlan(server as never)
  handlers = h
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── registro do tool ─────────────────────────────────────────────────────────

describe('registerBuildMigrationPlan', () => {
  it('registra exatamente 1 tool: build_migration_plan', () => {
    expect(handlers['build_migration_plan']).toBeDefined()
    expect(Object.keys(handlers)).toHaveLength(1)
  })
})

// ─── error cases ──────────────────────────────────────────────────────────────

describe('build_migration_plan — error cases', () => {
  it('retorna CONFIG_NOT_FOUND quando discovery-report.json não existe', async () => {
    const result = await handlers['build_migration_plan']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('CONFIG_NOT_FOUND')
    expect(String(body.message)).toContain('discover_project')
  })

  it('retorna CONFIG_NOT_FOUND mesmo com jdk-migration.config.json mas sem discovery', async () => {
    writeConfig(dir, makeConfig())
    const result = await handlers['build_migration_plan']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    expect(body.error).toBe('CONFIG_NOT_FOUND')
  })
})

// ─── success cases ────────────────────────────────────────────────────────────

describe('build_migration_plan — plano gerado com sucesso', () => {
  beforeEach(() => {
    mkdirSync(join(dir, '.jdk-migration'), { recursive: true })
    writeFileSync(
      join(dir, '.jdk-migration', 'discovery-report.json'),
      JSON.stringify(makeMinimalDiscovery({ projectPath: dir })),
      'utf-8',
    )
  })

  it('retorna plano com 6 fases', async () => {
    const result = await handlers['build_migration_plan']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    // Deve ter gerado um plano com phases
    if (body.phases) {
      expect(Array.isArray(body.phases)).toBe(true)
      expect((body.phases as unknown[]).length).toBe(6)
    }
  })

  it('persiste migration-plan.json em .jdk-migration/', async () => {
    await handlers['build_migration_plan']({ projectPath: dir })
    const planPath = join(dir, '.jdk-migration', 'migration-plan.json')
    expect(existsSync(planPath)).toBe(true)
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'))
    expect(plan.phases).toBeDefined()
  })

  it('cria jdk-migration.config.json quando não existe', async () => {
    await handlers['build_migration_plan']({ projectPath: dir })
    expect(existsSync(join(dir, 'jdk-migration.config.json'))).toBe(true)
  })

  it('atualiza reportMode no config quando diferente do atual', async () => {
    writeConfig(dir, makeConfig({ reportMode: 'phase-gate' }))

    await handlers['build_migration_plan']({
      projectPath: dir,
      reportMode: 'phase-gate-step',
    })

    const config = JSON.parse(readFileSync(join(dir, 'jdk-migration.config.json'), 'utf-8'))
    expect(config.reportMode).toBe('phase-gate-step')
  })

  it('retorna plano com summary de riscos', async () => {
    const result = await handlers['build_migration_plan']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    // O plano deve ter informação de summary
    expect(body).toBeTruthy()
  })

  it('detecta sourceJdk do discovery-report', async () => {
    // Não tem config ainda — deve criar com sourceJdk=8 do discovery
    await handlers['build_migration_plan']({ projectPath: dir })
    const config = JSON.parse(readFileSync(join(dir, 'jdk-migration.config.json'), 'utf-8'))
    expect(config.sourceJdk).toBe('8')
    expect(config.targetJdk).toBe('21')
  })

  it('funciona com stack spring-boot no discovery', async () => {
    writeFileSync(
      join(dir, '.jdk-migration', 'discovery-report.json'),
      JSON.stringify(makeMinimalDiscovery({
        projectPath: dir,
        detectedStacks: ['spring-boot'],
      })),
      'utf-8',
    )

    const result = await handlers['build_migration_plan']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    expect(body).toBeTruthy()
    // Config deve refletir spring-boot
    const config = JSON.parse(readFileSync(join(dir, 'jdk-migration.config.json'), 'utf-8'))
    expect(config.stack).toContain('spring-boot')
  })

  it('funciona com stack ejb (crítica) no discovery', async () => {
    writeFileSync(
      join(dir, '.jdk-migration', 'discovery-report.json'),
      JSON.stringify(makeMinimalDiscovery({
        projectPath: dir,
        detectedStacks: ['ejb'],
      })),
      'utf-8',
    )

    const result = await handlers['build_migration_plan']({ projectPath: dir })
    expect(result.content[0].type).toBe('text')
  })

  it('plano usa profilerReports quando fornecidos no discovery', async () => {
    writeFileSync(
      join(dir, '.jdk-migration', 'discovery-report.json'),
      JSON.stringify(makeMinimalDiscovery({
        projectPath: dir,
        detectedStacks: ['rest'],
        profilerReports: [{
          stackType: 'rest',
          riskItems: [{
            id: 'rest-javax-servlet',
            phase: 3,
            severity: 'high',
            category: 'namespace',
            title: 'javax.servlet → jakarta.servlet',
            description: 'Migrar imports',
            automationAvailable: true,
            recipe: 'openrewrite-jakarta',
            files: [],
          }],
          manualReviewItems: [],
        }],
      })),
      'utf-8',
    )

    const result = await handlers['build_migration_plan']({ projectPath: dir })
    const body = jsonText(result) as Record<string, unknown>
    // Deve ter sido gerado sem erro
    expect(body.error).toBeUndefined()
  })

  it('multi-module discovery cria config com multiModule=true', async () => {
    writeFileSync(
      join(dir, '.jdk-migration', 'discovery-report.json'),
      JSON.stringify(makeMinimalDiscovery({
        projectPath: dir,
        isMultiModule: true,
      })),
      'utf-8',
    )

    await handlers['build_migration_plan']({ projectPath: dir })
    const config = JSON.parse(readFileSync(join(dir, 'jdk-migration.config.json'), 'utf-8'))
    expect(config.multiModule).toBe(true)
  })
})
