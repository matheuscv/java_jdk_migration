export interface PhaseRoiData {
  phaseNumber: number
  startedAt: string | null         // ISO 8601 — início da fase (executedAt)
  completedAt: string | null       // ISO 8601 — gate aprovado
  durationMinutes: number | null   // tempo de execução MCP (wall clock)
  humanEstimateHours: number       // horas estimadas para execução humana
  humanHourlyRateUsd: number       // taxa horária usada no cálculo
  humanCostUsd: number
  humanCostBrl: number
  estimatedInputTokens: number           // input_tokens (fresh, não-cache) — $3/MTok
  estimatedCacheCreationTokens: number   // cache_creation_input_tokens — $3,75/MTok
  estimatedCacheReadTokens: number       // cache_read_input_tokens — $0,30/MTok (dominante no Claude Code)
  estimatedOutputTokens: number          // output_tokens — $15/MTok
  claudeCostUsd: number
  claudeCostBrl: number
}

export interface RoiSummary {
  generatedAt: string              // ISO 8601
  exchangeRateBrl: number          // BRL por 1 USD
  exchangeRateFetchedAt: string    // ISO 8601
  hourlyRateUsd: number            // taxa horária para custo humano
  totalHumanEstimateHours: number
  totalHumanEstimateDays: number   // horas / 8
  totalHumanCostUsd: number
  totalHumanCostBrl: number
  totalMcpDurationMinutes: number
  totalMcpDurationHours: number    // minutos / 60
  totalEstimatedInputTokens: number
  totalEstimatedCacheCreationTokens: number
  totalEstimatedCacheReadTokens: number
  totalEstimatedOutputTokens: number
  totalEstimatedTokens: number
  totalClaudeCostUsd: number
  totalClaudeCostBrl: number
  savingsUsd: number               // custo humano - custo Claude
  savingsBrl: number
  savingsPct: number               // (savings / humanCost) * 100
  phases: PhaseRoiData[]
}

export interface TokenUsageInput {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number  // cache_creation_input_tokens da API Claude ($3,75/MTok)
  cacheReadTokens?: number      // cache_read_input_tokens da API Claude ($0,30/MTok) — dominante em sessões longas
}
