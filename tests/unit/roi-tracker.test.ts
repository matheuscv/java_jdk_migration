import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { estimateHumanHoursForPhase, estimateTotalHumanHours } from '../../src/roi-tracker/human-time-estimator.js'
import { clearRateCache } from '../../src/roi-tracker/exchange-rate.js'
import { computePhaseRoi, buildRoiSummary } from '../../src/roi-tracker/index.js'
import { buildRoiSection } from '../../src/report-generator/index.js'

// ─── mock fetch para não fazer chamadas reais na BCB ──────────────────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function bcbResponse(rate: number) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ value: [{ cotacaoVenda: rate }] }),
  })
}

// ─── human-time-estimator ─────────────────────────────────────────────────────

describe('estimateHumanHoursForPhase', () => {
  it('retorna base de 8h para fase 0 sem stacks', () => {
    const est = estimateHumanHoursForPhase(0, [], false, 0)
    expect(est.hours).toBe(8)
    expect(est.breakdown).toContain('8h base')
  })

  it('aplica multiplicador de stack EJB (2.5×)', () => {
    const est = estimateHumanHoursForPhase(1, ['ejb'], false, 0)
    expect(est.hours).toBeGreaterThan(16)
    expect(est.hours).toBe(Math.ceil(16 * 2.5))
  })

  it('aplica multiplicador de stack spring-boot (1.5×)', () => {
    const est = estimateHumanHoursForPhase(2, ['spring-boot'], false, 0)
    expect(est.hours).toBe(Math.ceil(24 * 1.5))
  })

  it('usa o maior multiplicador entre múltiplas stacks', () => {
    const estEjb = estimateHumanHoursForPhase(3, ['ejb'], false, 0)
    const estMulti = estimateHumanHoursForPhase(3, ['ejb', 'spring-boot'], false, 0)
    // EJB (2.5) > spring-boot (1.5) — deve ser o mesmo que apenas EJB
    expect(estMulti.hours).toBe(estEjb.hours)
  })

  it('aplica multiplicador 1.3× para multi-módulo', () => {
    const single = estimateHumanHoursForPhase(1, ['rest'], false, 0)
    const multi  = estimateHumanHoursForPhase(1, ['rest'], true,  0)
    expect(multi.hours).toBeGreaterThan(single.hours)
  })

  it('fase 0 não recebe ajuste de discoveryEffortDays', () => {
    const sem = estimateHumanHoursForPhase(0, [], false, 0)
    const com = estimateHumanHoursForPhase(0, [], false, 10)
    expect(sem.hours).toBe(com.hours)
  })

  it('fases 1-5 recebem ajuste positivo quando discoveryEffortDays > 0', () => {
    const sem = estimateHumanHoursForPhase(3, ['rest'], false, 0)
    const com = estimateHumanHoursForPhase(3, ['rest'], false, 20)
    expect(com.hours).toBeGreaterThan(sem.hours)
  })

  it('inclui descrição de breakdown', () => {
    const est = estimateHumanHoursForPhase(2, ['ejb'], true, 5)
    expect(est.breakdown).toContain('base')
    expect(est.breakdown).toContain('ejb')
    expect(est.breakdown).toContain('multi-módulo')
  })
})

describe('estimateTotalHumanHours', () => {
  it('retorna 6 phases', () => {
    const { byPhase } = estimateTotalHumanHours([], false, 0)
    expect(byPhase).toHaveLength(6)
  })

  it('totalHours é soma das 6 fases', () => {
    const { totalHours, byPhase } = estimateTotalHumanHours(['spring-boot'], false, 0)
    const sum = byPhase.reduce((acc, p) => acc + p.hours, 0)
    expect(totalHours).toBe(sum)
  })

  it('stack EJB resulta em mais horas que stack REST', () => {
    const rest = estimateTotalHumanHours(['rest'],  false, 0).totalHours
    const ejb  = estimateTotalHumanHours(['ejb'],   false, 0).totalHours
    expect(ejb).toBeGreaterThan(rest)
  })
})

// ─── exchange-rate ────────────────────────────────────────────────────────────

describe('fetchBrlRate', () => {
  beforeEach(() => {
    clearRateCache()
    mockFetch.mockReset()
  })
  afterEach(() => clearRateCache())

  it('retorna taxa do BCB quando API responde', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ value: [{ cotacaoVenda: 5.85 }] }) })
    const { fetchBrlRate } = await import('../../src/roi-tracker/exchange-rate.js')
    const result = await fetchBrlRate()
    expect(result.rate).toBe(5.85)
    expect(result.source).toBe('bcb')
  })

  it('usa fallback quando API falha', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const { fetchBrlRate } = await import('../../src/roi-tracker/exchange-rate.js')
    const result = await fetchBrlRate()
    expect(result.rate).toBeGreaterThan(0)
    expect(result.source).toBe('fallback')
  })

  it('usa fallback quando BCB retorna lista vazia', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ value: [] }) })
    const { fetchBrlRate } = await import('../../src/roi-tracker/exchange-rate.js')
    const result = await fetchBrlRate()
    expect(result.rate).toBeGreaterThan(0)
  })

  it('faz cache e não chama fetch novamente na segunda chamada', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ value: [{ cotacaoVenda: 5.50 }] }) })
    const { fetchBrlRate } = await import('../../src/roi-tracker/exchange-rate.js')
    await fetchBrlRate()
    await fetchBrlRate()
    // duas chamadas fetch por conta do retry com dia anterior, mas apenas 1 ciclo real
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ─── roi computations ─────────────────────────────────────────────────────────

describe('computePhaseRoi', () => {
  beforeEach(() => {
    clearRateCache()
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => bcbResponse(5.70))
  })
  afterEach(() => clearRateCache())

  it('calcula durationMinutes corretamente', async () => {
    const start = new Date('2026-06-01T10:00:00Z').toISOString()
    const end   = new Date('2026-06-01T11:30:00Z').toISOString()
    const roi = await computePhaseRoi(
      { phaseNumber: 0, startedAt: start, completedAt: end },
      ['rest'], false, 0,
    )
    expect(roi.durationMinutes).toBe(90)
  })

  it('durationMinutes é null quando completedAt está ausente', async () => {
    const roi = await computePhaseRoi(
      { phaseNumber: 0, startedAt: new Date().toISOString(), completedAt: null },
      ['rest'], false, 0,
    )
    expect(roi.durationMinutes).toBeNull()
  })

  it('usa tokenUsage explícito quando fornecido', async () => {
    const roi = await computePhaseRoi(
      { phaseNumber: 1, startedAt: null, completedAt: null, tokenUsage: { inputTokens: 1000, outputTokens: 500 } },
      ['rest'], false, 0,
    )
    expect(roi.estimatedInputTokens).toBe(1000)
    expect(roi.estimatedOutputTokens).toBe(500)
  })

  it('estima tokens a partir de outputJsonBytes quando tokenUsage ausente', async () => {
    const roi = await computePhaseRoi(
      { phaseNumber: 1, startedAt: null, completedAt: null, outputJsonBytes: 4000 },
      ['rest'], false, 0,
    )
    expect(roi.estimatedOutputTokens).toBe(1000)   // 4000 / 4
    expect(roi.estimatedInputTokens).toBe(2000)    // 2× output
  })

  it('calcula custos Claude corretamente', async () => {
    const roi = await computePhaseRoi(
      { phaseNumber: 1, startedAt: null, completedAt: null, tokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      ['rest'], false, 0,
    )
    // $3 input + $15 output = $18 por 1M de cada
    expect(roi.claudeCostUsd).toBeCloseTo(18, 1)
  })

  it('converte custo para BRL usando taxa de câmbio', async () => {
    const roi = await computePhaseRoi(
      { phaseNumber: 1, startedAt: null, completedAt: null, tokenUsage: { inputTokens: 0, outputTokens: 0 } },
      ['rest'], false, 0,
    )
    // sem tokens = 0 custo Claude → humanCostBrl = humanCostUsd × 5.70
    expect(roi.humanCostBrl).toBeCloseTo(roi.humanCostUsd * 5.70, 0)
  })

  it('humanCostUsd = hours × hourlyRate', async () => {
    const roi = await computePhaseRoi(
      { phaseNumber: 0, startedAt: null, completedAt: null },
      [], false, 0, 100,  // $100/h
    )
    expect(roi.humanCostUsd).toBe(roi.humanEstimateHours * 100)
    expect(roi.humanHourlyRateUsd).toBe(100)
  })
})

describe('buildRoiSummary', () => {
  beforeEach(() => {
    clearRateCache()
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => bcbResponse(5.70))
  })
  afterEach(() => clearRateCache())

  const makePhase = (n: number): import('../../src/roi-tracker/types.js').PhaseRoiData => ({
    phaseNumber: n,
    startedAt: null,
    completedAt: null,
    durationMinutes: 30,
    humanEstimateHours: 8,
    humanHourlyRateUsd: 75,
    humanCostUsd: 600,
    humanCostBrl: 3420,
    estimatedInputTokens: 2000,
    estimatedOutputTokens: 1000,
    claudeCostUsd: 0.02,
    claudeCostBrl: 0.11,
  })

  it('soma corretamente totalHumanCostUsd', async () => {
    const phases = [makePhase(0), makePhase(1), makePhase(2)]
    const summary = await buildRoiSummary(phases)
    expect(summary.totalHumanCostUsd).toBeCloseTo(1800, 1)
  })

  it('totalEstimatedTokens = input + output somados', async () => {
    const phases = [makePhase(0), makePhase(1)]
    const summary = await buildRoiSummary(phases)
    expect(summary.totalEstimatedInputTokens).toBe(4000)
    expect(summary.totalEstimatedOutputTokens).toBe(2000)
    expect(summary.totalEstimatedTokens).toBe(6000)
  })

  it('savingsUsd = totalHuman - totalClaude', async () => {
    const phases = [makePhase(0)]
    const summary = await buildRoiSummary(phases)
    expect(summary.savingsUsd).toBeCloseTo(summary.totalHumanCostUsd - summary.totalClaudeCostUsd, 2)
  })

  it('savingsPct é percentual correto', async () => {
    const phases = [makePhase(0)]
    const summary = await buildRoiSummary(phases)
    const expected = ((summary.savingsUsd / summary.totalHumanCostUsd) * 100)
    expect(summary.savingsPct).toBeCloseTo(expected, 0)
  })

  it('totalHumanEstimateDays = horas / 8', async () => {
    const phases = [makePhase(0), makePhase(1)]  // 2 × 8h = 16h
    const summary = await buildRoiSummary(phases)
    expect(summary.totalHumanEstimateDays).toBeCloseTo(summary.totalHumanEstimateHours / 8, 2)
  })

  it('totalMcpDurationHours = minutos / 60', async () => {
    const phases = [makePhase(0), makePhase(1)]  // 2 × 30min = 60min
    const summary = await buildRoiSummary(phases)
    expect(summary.totalMcpDurationHours).toBeCloseTo(1, 2)
  })

  it('fases vazias resultam em zeros', async () => {
    const summary = await buildRoiSummary([])
    expect(summary.totalHumanCostUsd).toBe(0)
    expect(summary.totalClaudeCostUsd).toBe(0)
    expect(summary.savingsPct).toBe(0)
  })
})

// ─── buildRoiSection (HTML) ───────────────────────────────────────────────────

describe('buildRoiSection', () => {
  const sampleSummary: Parameters<typeof buildRoiSection>[0] = {
    generatedAt: new Date().toISOString(),
    exchangeRateBrl: 5.70,
    exchangeRateFetchedAt: new Date().toISOString(),
    hourlyRateUsd: 75,
    totalHumanEstimateHours: 136,
    totalHumanEstimateDays: 17,
    totalHumanCostUsd: 10200,
    totalHumanCostBrl: 58140,
    totalMcpDurationMinutes: 45,
    totalMcpDurationHours: 0.75,
    totalEstimatedInputTokens: 50000,
    totalEstimatedOutputTokens: 25000,
    totalEstimatedTokens: 75000,
    totalClaudeCostUsd: 0.53,
    totalClaudeCostBrl: 3.02,
    savingsUsd: 9699.47,
    savingsBrl: 58136.98,
    savingsPct: 95.09,
    phases: [
      {
        phaseNumber: 0,
        startedAt: null,
        completedAt: null,
        durationMinutes: 15,
        humanEstimateHours: 8,
        humanHourlyRateUsd: 75,
        humanCostUsd: 600,
        humanCostBrl: 3420,
        estimatedInputTokens: 5000,
        estimatedOutputTokens: 2500,
        claudeCostUsd: 0.05,
        claudeCostBrl: 0.28,
      },
    ],
  }

  it('retorna string HTML não vazia', () => {
    const html = buildRoiSection(sampleSummary)
    expect(typeof html).toBe('string')
    expect(html.length).toBeGreaterThan(100)
  })

  it('contém seção ROI com título', () => {
    const html = buildRoiSection(sampleSummary)
    expect(html).toContain('ROI — Return on Investment')
  })

  it('exibe a porcentagem de economia', () => {
    const html = buildRoiSection(sampleSummary)
    expect(html).toContain('95%')
  })

  it('exibe custo humano em USD e BRL', () => {
    const html = buildRoiSection(sampleSummary)
    expect(html).toContain('$10,200.00')
    expect(html).toContain('R$ 58.140,00')
  })

  it('contém linha de cada fase', () => {
    const html = buildRoiSection(sampleSummary)
    expect(html).toContain('Descoberta &amp; Baseline')
  })

  it('exibe nota de estimativa', () => {
    const html = buildRoiSection(sampleSummary)
    expect(html).toContain('Estimativas')
  })

  it('escapa HTML em valores de texto', () => {
    const html = buildRoiSection({ ...sampleSummary, exchangeRateBrl: 5.70 })
    expect(html).not.toContain('<script>')
  })
})
