/**
 * Busca a cotação USD/BRL do Banco Central do Brasil (API pública).
 * Fallback: última cotação conhecida hardcoded.
 */

const FALLBACK_RATE_BRL = 5.70  // atualizado na compilação — fallback de segurança
const CACHE_TTL_MS = 4 * 60 * 60 * 1000  // 4 horas
const FETCH_TIMEOUT_MS = 2_000  // 2s — não bloqueia a fase em caso de rede lenta

interface CachedRate { rate: number; fetchedAt: string }
let _cache: CachedRate | null = null

export async function fetchBrlRate(): Promise<{ rate: number; fetchedAt: string; source: 'bcb' | 'fallback' }> {
  const now = Date.now()

  if (_cache && now - new Date(_cache.fetchedAt).getTime() < CACHE_TTL_MS) {
    return { rate: _cache.rate, fetchedAt: _cache.fetchedAt, source: 'bcb' }
  }

  for (const daysBack of [0, 1, 2]) {
    try {
      const date = formatBcbDate(new Date(Date.now() - daysBack * 86_400_000))
      const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${date}'&$top=1&$format=json&$select=cotacaoVenda`
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS)
      if (!res.ok) continue
      const json: { value: Array<{ cotacaoVenda: number }> } = await res.json()
      const rate = json.value?.[0]?.cotacaoVenda
      if (!rate || typeof rate !== 'number') continue
      const fetchedAt = new Date().toISOString()
      _cache = { rate, fetchedAt }
      return { rate, fetchedAt, source: 'bcb' }
    } catch { /* tenta próximo dia */ }
  }

  return { rate: FALLBACK_RATE_BRL, fetchedAt: new Date().toISOString(), source: 'fallback' }
}

function formatBcbDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${mm}-${dd}-${yyyy}`
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Limpa o cache (útil em testes) */
export function clearRateCache(): void {
  _cache = null
}
