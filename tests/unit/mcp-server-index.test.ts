/**
 * Teste mínimo para src/mcp-server/index.ts
 * O entry point usa top-level await e conecta StdioServerTransport — não é
 * possível importar diretamente sem que o processo tente ler stdin.
 * Este teste verifica que os sub-módulos registrados por ele existem e exportam
 * as funções esperadas, garantindo cobertura indireta do módulo de entrada.
 */
import { describe, it, expect } from 'vitest'

describe('mcp-server entry point — sub-módulos registrados', () => {
  it('registerDiscoverProject é uma função', async () => {
    const { registerDiscoverProject } = await import('../../src/mcp-server/tools/discover-project.js')
    expect(typeof registerDiscoverProject).toBe('function')
  })

  it('registerBuildMigrationPlan é uma função', async () => {
    const { registerBuildMigrationPlan } = await import('../../src/mcp-server/tools/build-migration-plan.js')
    expect(typeof registerBuildMigrationPlan).toBe('function')
  })

  it('registerExecutePhase é uma função', async () => {
    const { registerExecutePhase } = await import('../../src/mcp-server/tools/execute-phase.js')
    expect(typeof registerExecutePhase).toBe('function')
  })

  it('registerAuxiliaryTools é uma função', async () => {
    const { registerAuxiliaryTools } = await import('../../src/mcp-server/tools/auxiliary.js')
    expect(typeof registerAuxiliaryTools).toBe('function')
  })

  it('registerCheckDependencies é uma função', async () => {
    const { registerCheckDependencies } = await import('../../src/mcp-server/tools/check-dependencies.js')
    expect(typeof registerCheckDependencies).toBe('function')
  })

  it('todos os 5 register-functions aceitam um objeto server como argumento', async () => {
    const { registerDiscoverProject } = await import('../../src/mcp-server/tools/discover-project.js')
    const { registerBuildMigrationPlan } = await import('../../src/mcp-server/tools/build-migration-plan.js')
    const { registerExecutePhase } = await import('../../src/mcp-server/tools/execute-phase.js')
    const { registerAuxiliaryTools } = await import('../../src/mcp-server/tools/auxiliary.js')
    const { registerCheckDependencies } = await import('../../src/mcp-server/tools/check-dependencies.js')

    const registeredTools: string[] = []
    const mockServer = {
      registerTool: (_name: string, _schema: unknown, _handler: unknown) => { registeredTools.push(_name) },
      tool: (_name: string, _schema: unknown, _handler: unknown) => { registeredTools.push(_name) },
    }

    registerDiscoverProject(mockServer as never)
    registerBuildMigrationPlan(mockServer as never)
    registerExecutePhase(mockServer as never)
    registerAuxiliaryTools(mockServer as never)
    registerCheckDependencies(mockServer as never)

    expect(registeredTools).toContain('discover_project')
    expect(registeredTools).toContain('build_migration_plan')
    expect(registeredTools).toContain('execute_phase')
    expect(registeredTools).toContain('get_phase_status')
    expect(registeredTools).toContain('approve_gate')
    expect(registeredTools).toContain('check_internal_dependencies')
    expect(registeredTools.length).toBeGreaterThanOrEqual(10)
  })
})
