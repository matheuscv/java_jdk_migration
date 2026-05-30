import type { JdkMigrationConfig } from '../lib/config.js'
import { MigrationError } from '../lib/errors.js'
import type { PhaseNumber, PhaseStatus } from '../types.js'

// Transições válidas: de → conjunto de destinos permitidos
const VALID_TRANSITIONS: Record<PhaseStatus, PhaseStatus[]> = {
  pending:       ['in_progress'],
  in_progress:   ['awaiting_gate', 'failed'],
  awaiting_gate: ['approved', 'rolled_back'],
  approved:      ['completed'],
  completed:     [],
  failed:        ['pending'],
  rolled_back:   ['pending'],
}

export function canTransition(from: PhaseStatus, to: PhaseStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertCanTransition(
  from: PhaseStatus,
  to: PhaseStatus,
  phase: PhaseNumber,
): void {
  if (!canTransition(from, to)) {
    throw new MigrationError(
      'PHASE_OUT_OF_ORDER',
      `Fase ${phase}: transição '${from}' → '${to}' não é permitida.`,
      { phase, from, to },
    )
  }
}

export function canExecutePhase(config: JdkMigrationConfig, phase: PhaseNumber): boolean {
  // Fase 0: inicia sem gate — basta estar pending
  if (phase === 0) return config.phases[0].status === 'pending'
  // Fases 1–5: fase anterior deve estar approved ou completed
  const previous = config.phases[(phase - 1) as PhaseNumber]
  return previous.status === 'approved' || previous.status === 'completed'
}

export function updatePhaseStatus(
  config: JdkMigrationConfig,
  phase: PhaseNumber,
  to: PhaseStatus,
  extra?: Partial<import('../lib/config.js').PhaseState>,
): JdkMigrationConfig {
  const current = config.phases[phase]
  assertCanTransition(current.status, to, phase)
  return {
    ...config,
    phases: {
      ...config.phases,
      [phase]: { ...current, status: to, ...extra },
    },
  }
}
