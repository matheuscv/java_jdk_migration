import type { StackType } from '../types.js'

/**
 * Horas-base por fase para um desenvolvedor sênior experiente em Java.
 * Representa o esforço mínimo para um projeto de baixa complexidade.
 */
const PHASE_BASE_HOURS: Record<number, number> = {
  0: 8,   // Descoberta & Baseline: 1 dia
  1: 16,  // Infra & Build: 2 dias
  2: 24,  // Modernização de Linguagem: 3 dias
  3: 40,  // Namespace Jakarta & Frameworks: 5 dias
  4: 32,  // Refatoração Semântica: 4 dias
  5: 16,  // Validação Final & Cutover: 2 dias
}

/** Multiplicadores de complexidade por stack */
const STACK_MULTIPLIERS: Partial<Record<StackType, number>> = {
  'ejb':         2.5,
  'jsf':         2.0,
  'weblogic':    2.0,
  'spring-boot': 1.5,
  'spring-batch': 1.5,
  'rest':        1.0,
  'jakarta':     1.2,
}

export interface HumanTimeEstimate {
  hours: number
  breakdown: string
}

/**
 * Estima as horas de trabalho humano para uma fase específica,
 * levando em conta a stack e a complexidade do projeto.
 */
export function estimateHumanHoursForPhase(
  phaseNumber: number,
  stacks: StackType[],
  isMultiModule: boolean,
  discoveryEffortDays: number,
): HumanTimeEstimate {
  const base = PHASE_BASE_HOURS[phaseNumber] ?? 8

  // Complexidade da stack: usa o maior multiplicador entre as stacks presentes
  const stackMultiplier = stacks.length > 0
    ? Math.max(...stacks.map(s => STACK_MULTIPLIERS[s] ?? 1.0))
    : 1.0

  // Multi-módulo adiciona 30% de overhead
  const moduleMultiplier = isMultiModule ? 1.3 : 1.0

  // Fase 0 usa o estimatedEffortDays do discover_project como referência adicional
  // para as fases subsequentes — distribui o esforço proporcionalmente
  const effortAdjustment = phaseNumber > 0
    ? computeEffortAdjustment(phaseNumber, discoveryEffortDays)
    : 0

  const adjusted = base * stackMultiplier * moduleMultiplier + effortAdjustment
  const hours = Math.ceil(adjusted)

  const breakdownParts = [
    `${base}h base`,
    stackMultiplier !== 1.0 ? `×${stackMultiplier.toFixed(1)} stack (${stacks.join('+')})` : null,
    isMultiModule ? '×1.3 multi-módulo' : null,
    effortAdjustment > 0 ? `+${effortAdjustment.toFixed(1)}h por complexidade` : null,
  ].filter(Boolean)

  return { hours, breakdown: breakdownParts.join(', ') }
}

/**
 * Ajuste de esforço baseado no `estimatedEffortDays` retornado pelo discover_project.
 * Distribui as horas extras proporcionalmente entre as fases 1–5.
 */
function computeEffortAdjustment(phaseNumber: number, discoveryEffortDays: number): number {
  if (discoveryEffortDays <= 0) return 0
  // Fases mais complexas recebem maior proporção do esforço adicional
  const phaseWeights: Record<number, number> = { 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.3, 5: 0.1 }
  const weight = phaseWeights[phaseNumber] ?? 0
  return discoveryEffortDays * 8 * weight  // converte dias → horas antes de aplicar peso
}

/**
 * Retorna a estimativa total de horas humanas para todo o projeto
 * (soma de todas as 6 fases).
 */
export function estimateTotalHumanHours(
  stacks: StackType[],
  isMultiModule: boolean,
  discoveryEffortDays: number,
): { totalHours: number; byPhase: HumanTimeEstimate[] } {
  const byPhase = Array.from({ length: 6 }, (_, i) =>
    estimateHumanHoursForPhase(i, stacks, isMultiModule, discoveryEffortDays),
  )
  const totalHours = byPhase.reduce((sum, e) => sum + e.hours, 0)
  return { totalHours, byPhase }
}
