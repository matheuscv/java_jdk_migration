import { fetchBrlRate } from './exchange-rate.js'
import { estimateHumanHoursForPhase } from './human-time-estimator.js'
import type { PhaseRoiData, RoiSummary, TokenUsageInput } from './types.js'
import type { StackType } from '../types.js'

/** Pricing Claude Sonnet 4.6 (USD por token) */
const CLAUDE_INPUT_PRICE_PER_TOKEN  = 3    / 1_000_000  // $3 / MTok
const CLAUDE_OUTPUT_PRICE_PER_TOKEN = 15   / 1_000_000  // $15 / MTok
const DEFAULT_HOURLY_RATE_USD = 75  // senior Java developer

export type { PhaseRoiData, RoiSummary, TokenUsageInput }

export interface RoiPhaseInput {
  phaseNumber: number
  startedAt: string | null
  completedAt: string | null
  tokenUsage?: TokenUsageInput
  /** Tamanho em bytes do JSON de output do tool — usado para estimar tokens quando tokenUsage não é informado */
  outputJsonBytes?: number
}

/**
 * Calcula o ROI para uma fase individual.
 * Busca a taxa de câmbio live; salva o resultado como PhaseRoiData.
 */
export async function computePhaseRoi(
  input: RoiPhaseInput,
  stacks: StackType[],
  isMultiModule: boolean,
  discoveryEffortDays: number,
  hourlyRateUsd = DEFAULT_HOURLY_RATE_USD,
): Promise<PhaseRoiData> {
  const { rate: exchangeRate } = await fetchBrlRate()

  const durationMinutes = computeDurationMinutes(input.startedAt, input.completedAt)

  const humanEst = estimateHumanHoursForPhase(
    input.phaseNumber,
    stacks,
    isMultiModule,
    discoveryEffortDays,
  )
  const humanCostUsd  = round2(humanEst.hours * hourlyRateUsd)
  const humanCostBrl  = round2(humanCostUsd * exchangeRate)

  const { inputTokens, outputTokens } = resolveTokens(input)
  const claudeCostUsd = round2(
    inputTokens  * CLAUDE_INPUT_PRICE_PER_TOKEN +
    outputTokens * CLAUDE_OUTPUT_PRICE_PER_TOKEN,
  )
  const claudeCostBrl = round2(claudeCostUsd * exchangeRate)

  return {
    phaseNumber:            input.phaseNumber,
    startedAt:              input.startedAt,
    completedAt:            input.completedAt,
    durationMinutes,
    humanEstimateHours:     humanEst.hours,
    humanHourlyRateUsd:     hourlyRateUsd,
    humanCostUsd,
    humanCostBrl,
    estimatedInputTokens:   inputTokens,
    estimatedOutputTokens:  outputTokens,
    claudeCostUsd,
    claudeCostBrl,
  }
}

/**
 * Consolida os dados de todas as fases em um RoiSummary.
 */
export async function buildRoiSummary(phases: PhaseRoiData[]): Promise<RoiSummary> {
  const { rate, fetchedAt } = await fetchBrlRate()
  const hourlyRateUsd = phases[0]?.humanHourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD

  const totalHumanHours  = sum(phases, p => p.humanEstimateHours)
  const totalHumanUsd    = round2(sum(phases, p => p.humanCostUsd))
  const totalHumanBrl    = round2(sum(phases, p => p.humanCostBrl))
  const totalMcpMinutes  = sum(phases, p => p.durationMinutes ?? 0)
  const totalInputTok    = sum(phases, p => p.estimatedInputTokens)
  const totalOutputTok   = sum(phases, p => p.estimatedOutputTokens)
  const totalClaudeUsd   = round2(sum(phases, p => p.claudeCostUsd))
  const totalClaudeBrl   = round2(sum(phases, p => p.claudeCostBrl))
  const savingsUsd       = round2(totalHumanUsd - totalClaudeUsd)
  const savingsBrl       = round2(totalHumanBrl - totalClaudeBrl)
  const savingsPct       = totalHumanUsd > 0
    ? round2((savingsUsd / totalHumanUsd) * 100)
    : 0

  return {
    generatedAt:                  new Date().toISOString(),
    exchangeRateBrl:              rate,
    exchangeRateFetchedAt:        fetchedAt,
    hourlyRateUsd,
    totalHumanEstimateHours:      totalHumanHours,
    totalHumanEstimateDays:       round2(totalHumanHours / 8),
    totalHumanCostUsd:            totalHumanUsd,
    totalHumanCostBrl:            totalHumanBrl,
    totalMcpDurationMinutes:      round2(totalMcpMinutes),
    totalMcpDurationHours:        round2(totalMcpMinutes / 60),
    totalEstimatedInputTokens:    totalInputTok,
    totalEstimatedOutputTokens:   totalOutputTok,
    totalEstimatedTokens:         totalInputTok + totalOutputTok,
    totalClaudeCostUsd:           totalClaudeUsd,
    totalClaudeCostBrl:           totalClaudeBrl,
    savingsUsd,
    savingsBrl,
    savingsPct,
    phases,
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function computeDurationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 0) return null
  return round2(ms / 60_000)
}

function resolveTokens(input: RoiPhaseInput): { inputTokens: number; outputTokens: number } {
  if (input.tokenUsage) {
    return { inputTokens: input.tokenUsage.inputTokens, outputTokens: input.tokenUsage.outputTokens }
  }
  // Estimativa: output ≈ bytes/4 (UTF-8 média ≈ 4 chars/token)
  const outputTokens = Math.ceil((input.outputJsonBytes ?? 0) / 4)
  // Heurística conservadora: input ≈ 2× output (contexto + instrução + resposta)
  const inputTokens  = outputTokens * 2
  return { inputTokens, outputTokens }
}

function sum<T>(arr: T[], fn: (item: T) => number): number {
  return arr.reduce((acc, item) => acc + fn(item), 0)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
