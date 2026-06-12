import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { TokenUsageInput } from './types.js'

/**
 * Converte o path absoluto do projeto no slug usado pelo Claude Code para nomear
 * o diretório em ~/.claude/projects/.
 * Regra: cada caractere não-alfanumérico vira '-'.
 * Ex: C:\devtools\workspace\java_jdk_migration → C--devtools-workspace-java-jdk-migration
 */
export function projectPathToSlug(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Lê todos os arquivos .jsonl do projeto e soma os tokens de uso do Claude
 * cujo timestamp cai dentro do intervalo [startedAt, completedAt].
 *
 * Retorna null se o diretório não existir ou nenhuma entrada de uso for encontrada
 * no intervalo — nesse caso o caller deve usar a heurística de fallback.
 */
export function readTokensForPhase(
  projectPath: string,
  startedAt: string | null,
  completedAt: string | null,
): TokenUsageInput | null {
  if (!startedAt) return null

  const slug = projectPathToSlug(projectPath)
  const projectsDir = join(homedir(), '.claude', 'projects', slug)
  if (!existsSync(projectsDir)) return null

  // Margem de 5 minutos antes do startedAt: o turno que dispara execute_phase/approve_gate
  // é gerado pelo modelo ~segundos antes do MCP gravar executedAt/completedAt.
  const PRE_MARGIN_MS = 5 * 60_000
  const start = new Date(startedAt).getTime() - PRE_MARGIN_MS
  const end   = completedAt ? new Date(completedAt).getTime() : Date.now()

  let inputTokens         = 0
  let cacheCreationTokens = 0
  let cacheReadTokens     = 0
  let outputTokens        = 0
  let found               = false

  let files: string[]
  try {
    files = readdirSync(projectsDir).filter(f => f.endsWith('.jsonl'))
  } catch {
    return null
  }

  for (const file of files) {
    let content: string
    try { content = readFileSync(join(projectsDir, file), 'utf-8') } catch { continue }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue

      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

      if (entry['type'] !== 'assistant') continue

      const ts = entry['timestamp']
      if (typeof ts !== 'string') continue
      const t = new Date(ts).getTime()
      if (t < start || t > end) continue

      const msg = entry['message'] as Record<string, unknown> | undefined
      const usage = msg?.['usage'] as Record<string, number> | undefined
      if (!usage) continue

      inputTokens         += usage['input_tokens']                  ?? 0
      cacheCreationTokens += usage['cache_creation_input_tokens']   ?? 0
      cacheReadTokens     += usage['cache_read_input_tokens']       ?? 0
      outputTokens        += usage['output_tokens']                 ?? 0
      found = true
    }
  }

  return found
    ? { inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens }
    : null
}
