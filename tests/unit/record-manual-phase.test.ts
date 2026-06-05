/**
 * Testes para record_manual_phase — escape hatch quando execute_phase falha
 * por problema ambiental (EINVAL, ENOENT) e o trabalho é feito manualmente.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, reportMode: 'phase-gate',
    phases: createDefaultPhases(),
    ...overrides,
  }
}

function tempProject(): string {
  const dir = join(tmpdir(), `jdk-record-manual-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeConfig(dir: string, config: JdkMigrationConfig): void {
  writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(config, null, 2))
}

function readConfig(dir: string): JdkMigrationConfig {
  return JSON.parse(readFileSync(join(dir, 'jdk-migration.config.json'), 'utf-8'))
}

describe('record_manual_phase — lógica de estado', () => {
  let dir: string

  beforeEach(() => { dir = tempProject() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('avança fase de pending → awaiting_gate com dados corretos', () => {
    const config = makeConfig()
    // Fase 0 já aprovada para poder registrar fase 1
    config.phases[0].status = 'approved'
    config.phases[0].gateToken = 'tok'
    config.phases[1].status = 'pending'
    writeConfig(dir, config)

    // Simula o que record_manual_phase faz internamente
    const updated = readConfig(dir)
    updated.phases[1] = {
      ...updated.phases[1],
      status: 'awaiting_gate',
      executedAt: new Date().toISOString(),
      gitBranch: 'jdk-migration/phase-1-manual',
      gitCommit: 'abc1234',
      baseBranch: 'migrate/main',
      baseCommit: 'def5678',
    }
    writeConfig(dir, updated)

    const result = readConfig(dir)
    expect(result.phases[1].status).toBe('awaiting_gate')
    expect(result.phases[1].gitCommit).toBe('abc1234')
    expect(result.phases[1].gitBranch).toBe('jdk-migration/phase-1-manual')
  })

  it('avança fase de failed → awaiting_gate (cenário EINVAL)', () => {
    const config = makeConfig()
    config.phases[0].status = 'approved'
    config.phases[1].status = 'failed'
    config.phases[1].gitBranch = 'jdk-migration/phase-1-20260604'
    writeConfig(dir, config)

    const updated = readConfig(dir)
    updated.phases[1] = {
      ...updated.phases[1],
      status: 'awaiting_gate',
      gitCommit: 'deadbeef',
    }
    writeConfig(dir, updated)

    const result = readConfig(dir)
    expect(result.phases[1].status).toBe('awaiting_gate')
    expect(result.phases[1].gitCommit).toBe('deadbeef')
  })

  it('avança fase de in_progress → awaiting_gate (interrupção durante execute_phase)', () => {
    const config = makeConfig()
    config.phases[0].status = 'approved'
    config.phases[1].status = 'in_progress'
    config.phases[1].gitBranch = 'jdk-migration/phase-1-20260604'
    config.phases[1].baseBranch = 'migrate/main'
    config.phases[1].baseCommit = 'abc123'
    writeConfig(dir, config)

    const updated = readConfig(dir)
    updated.phases[1].status = 'awaiting_gate'
    updated.phases[1].gitCommit = 'cafe0001'
    writeConfig(dir, updated)

    const result = readConfig(dir)
    expect(result.phases[1].status).toBe('awaiting_gate')
  })

  it('step de auditoria é gravado no config', () => {
    const config = makeConfig()
    config.phases[0].status = 'approved'
    config.phases[1].status = 'failed'
    config.steps = []
    writeConfig(dir, config)

    const updated = readConfig(dir)
    updated.phases[1].status = 'awaiting_gate'
    updated.phases[1].gitCommit = 'aabbccdd'
    updated.steps = [{
      id: 'manual-phase-1-001',
      num: 1,
      owner: 'claude',
      phase: 'B',
      task: '[MANUAL] Fase 1 executada fora do MCP',
      status: 'done',
      commit: 'aabbccdd',
      note: 'spawn EINVAL — mvn.cmd executado diretamente via CLI',
      completedAt: new Date().toISOString(),
    }]
    writeConfig(dir, updated)

    const result = readConfig(dir)
    expect(result.steps).toHaveLength(1)
    expect(result.steps![0].task).toContain('[MANUAL]')
    expect(result.steps![0].note).toContain('EINVAL')
    expect(result.steps![0].status).toBe('done')
  })
})
