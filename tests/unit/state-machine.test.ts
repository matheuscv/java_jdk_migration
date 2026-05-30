import { describe, it, expect } from 'vitest'
import {
  canTransition,
  assertCanTransition,
  canExecutePhase,
  updatePhaseStatus,
} from '../../src/orchestrator/state-machine.js'
import { createDefaultPhases, type JdkMigrationConfig } from '../../src/lib/config.js'
import { MigrationError } from '../../src/lib/errors.js'

function makeConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
    ...overrides,
  }
}

describe('canTransition', () => {
  it('pending → in_progress is valid', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true)
  })

  it('in_progress → awaiting_gate is valid', () => {
    expect(canTransition('in_progress', 'awaiting_gate')).toBe(true)
  })

  it('in_progress → failed is valid', () => {
    expect(canTransition('in_progress', 'failed')).toBe(true)
  })

  it('awaiting_gate → approved is valid', () => {
    expect(canTransition('awaiting_gate', 'approved')).toBe(true)
  })

  it('awaiting_gate → rolled_back is valid', () => {
    expect(canTransition('awaiting_gate', 'rolled_back')).toBe(true)
  })

  it('approved → completed is valid', () => {
    expect(canTransition('approved', 'completed')).toBe(true)
  })

  it('failed → pending is valid', () => {
    expect(canTransition('failed', 'pending')).toBe(true)
  })

  it('rolled_back → pending is valid', () => {
    expect(canTransition('rolled_back', 'pending')).toBe(true)
  })

  // Invalid transitions
  it('pending → completed is INVALID', () => {
    expect(canTransition('pending', 'completed')).toBe(false)
  })

  it('completed → pending is INVALID', () => {
    expect(canTransition('completed', 'pending')).toBe(false)
  })

  it('approved → in_progress is INVALID', () => {
    expect(canTransition('approved', 'in_progress')).toBe(false)
  })

  it('failed → completed is INVALID', () => {
    expect(canTransition('failed', 'completed')).toBe(false)
  })
})

describe('assertCanTransition', () => {
  it('throws MigrationError with PHASE_OUT_OF_ORDER for invalid transition', () => {
    expect(() => assertCanTransition('completed', 'pending', 2)).toThrow(MigrationError)
    try {
      assertCanTransition('completed', 'pending', 2)
    } catch (e) {
      expect((e as MigrationError).code).toBe('PHASE_OUT_OF_ORDER')
    }
  })

  it('does not throw for valid transition', () => {
    expect(() => assertCanTransition('pending', 'in_progress', 0)).not.toThrow()
  })
})

describe('canExecutePhase', () => {
  it('phase 0 can execute when pending', () => {
    expect(canExecutePhase(makeConfig(), 0)).toBe(true)
  })

  it('phase 0 cannot execute when already in_progress', () => {
    const config = makeConfig()
    config.phases[0].status = 'in_progress'
    expect(canExecutePhase(config, 0)).toBe(false)
  })

  it('phase 1 cannot execute when phase 0 is pending', () => {
    expect(canExecutePhase(makeConfig(), 1)).toBe(false)
  })

  it('phase 1 can execute when phase 0 is approved', () => {
    const config = makeConfig()
    config.phases[0].status = 'approved'
    expect(canExecutePhase(config, 1)).toBe(true)
  })

  it('phase 1 can execute when phase 0 is completed', () => {
    const config = makeConfig()
    config.phases[0].status = 'completed'
    expect(canExecutePhase(config, 1)).toBe(true)
  })

  it('phase 3 requires phase 2 to be approved', () => {
    const config = makeConfig()
    config.phases[0].status = 'completed'
    config.phases[1].status = 'completed'
    config.phases[2].status = 'awaiting_gate'  // not yet approved
    expect(canExecutePhase(config, 3)).toBe(false)

    config.phases[2].status = 'approved'
    expect(canExecutePhase(config, 3)).toBe(true)
  })
})

describe('updatePhaseStatus', () => {
  it('updates status and persists extra fields', () => {
    const config = makeConfig()
    const updated = updatePhaseStatus(config, 0, 'in_progress', {
      executedAt: '2026-05-29T10:00:00Z',
      gitBranch: 'jdk-migration/phase-0-test',
    })
    expect(updated.phases[0].status).toBe('in_progress')
    expect(updated.phases[0].executedAt).toBe('2026-05-29T10:00:00Z')
    expect(updated.phases[0].gitBranch).toBe('jdk-migration/phase-0-test')
  })

  it('does not mutate original config', () => {
    const config = makeConfig()
    updatePhaseStatus(config, 0, 'in_progress')
    expect(config.phases[0].status).toBe('pending')
  })

  it('throws for invalid transition', () => {
    const config = makeConfig()
    expect(() => updatePhaseStatus(config, 0, 'completed')).toThrow(MigrationError)
  })
})
