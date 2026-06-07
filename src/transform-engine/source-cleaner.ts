/**
 * source-cleaner.ts
 *
 * Responsável pela limpeza de chamadas a APIs removidas em código-fonte Java.
 * Executado na Fase 2 (Language Modernization), após o OpenRewrite.
 *
 * E2.2 — Remove chamadas seguras a APIs removidas no JDK 9–11:
 *   • System.runFinalizersOnExit(...)     — removido JDK 11, era no-op
 *   • Runtime.runFinalizersOnExit(...)    — removido JDK 11, era no-op
 *   • Runtime.getRuntime().runFinalizersOnExit(...) — idem
 *   • java.lang.Compiler.*               — removido JDK 9, era no-op desde JDK 1.3
 *
 * Somente chamadas para as quais a remoção é semanticamente segura são tocadas.
 * Usos não seguros (ex: Thread.stop()) são registrados em `humanDecisionsNeeded`
 * para surfacing obrigatório no Gate.
 *
 * Não lança exceção — retorna resultado mesmo em caso de falha parcial.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TransformResult } from './index.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

function readSafe(p: string): string | null {
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

function relPath(projectPath: string, abs: string): string {
  return relative(projectPath, abs).replace(/\\/g, '/')
}

function findJavaFiles(dir: string): string[] {
  const results: string[] = []
  function walk(d: string) {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      if (e === 'target' || e === '.git') continue
      const full = join(d, e)
      let st: ReturnType<typeof statSync> | null = null
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (e.endsWith('.java')) results.push(full)
    }
  }
  walk(dir)
  return results
}

function minimalDiff(filename: string, original: string, updated: string): string {
  const orig = original.split('\n')
  const upd  = updated.split('\n')
  const lines = [`--- ${filename}`, `+++ ${filename}`]
  for (let i = 0; i < Math.max(orig.length, upd.length); i++) {
    if (orig[i] !== upd[i]) {
      if (orig[i] !== undefined) lines.push(`- ${orig[i]}`)
      if (upd[i]  !== undefined) lines.push(`+ ${upd[i]}`)
    }
  }
  return lines.join('\n')
}

// ─── padrões de remoção segura ────────────────────────────────────────────────

interface SafeRemovalPattern {
  /** Regex que identifica a chamada inteira (statement completo) */
  re: RegExp
  /** Comentário inline a adicionar no lugar */
  comment: string
  /** Nome da recipe para relatório */
  recipe: string
}

/**
 * Patterns cuja remoção é 100% segura pois eram no-ops ou documentadamente removidos.
 * A linha é substituída por um comentário para rastreabilidade.
 */
const SAFE_REMOVALS: SafeRemovalPattern[] = [
  {
    re: /^(\s*)System\.runFinalizersOnExit\s*\([^)]*\)\s*;/gm,
    comment: '// [jdk-migration] System.runFinalizersOnExit() removido — era no-op desde JDK 1.1, removido no JDK 11',
    recipe: 'remove-System.runFinalizersOnExit',
  },
  {
    re: /^(\s*)Runtime\.runFinalizersOnExit\s*\([^)]*\)\s*;/gm,
    comment: '// [jdk-migration] Runtime.runFinalizersOnExit() removido — era no-op desde JDK 1.1, removido no JDK 11',
    recipe: 'remove-Runtime.runFinalizersOnExit',
  },
  {
    re: /^(\s*)Runtime\.getRuntime\s*\(\s*\)\.runFinalizersOnExit\s*\([^)]*\)\s*;/gm,
    comment: '// [jdk-migration] Runtime.getRuntime().runFinalizersOnExit() removido — era no-op, removido no JDK 11',
    recipe: 'remove-Runtime.runFinalizersOnExit',
  },
  {
    re: /^(\s*)java\.lang\.Compiler\.\w+\s*\([^)]*\)\s*;/gm,
    comment: '// [jdk-migration] java.lang.Compiler removido no JDK 9 — era no-op desde JDK 1.3',
    recipe: 'remove-java.lang.Compiler',
  },
]

/** Imports que podem ser removidos em conjunto com as chamadas acima. */
const SAFE_IMPORT_REMOVALS: RegExp[] = [
  /^import\s+java\.lang\.Compiler\s*;\s*\n?/gm,
]

// ─── padrões que requerem decisão humana (não são tocados automaticamente) ────

interface HumanDecisionPattern {
  re: RegExp
  id: string
  title: string
  description: string
  blocking: boolean
}

const HUMAN_DECISION_PATTERNS: HumanDecisionPattern[] = [
  {
    re: /\.stop\s*\(\s*\)|\.stop\s*\(\s*new\s+\w/,
    id: 'thread-stop',
    title: 'Thread.stop() — removido no JDK 21',
    description:
      'Thread.stop() lança UnsupportedOperationException no JDK 21 (JEP 214). ' +
      'Substitua pelo padrão interrupt() + flag booleana volatile:\n' +
      '  volatile boolean running = true;\n' +
      '  // Em vez de thread.stop(): running = false; thread.interrupt();\n' +
      '  // No loop da thread: while (running && !Thread.interrupted()) { ... }',
    blocking: true,
  },
  {
    re: /\.destroy\s*\(\s*\)/,
    id: 'thread-destroy',
    title: 'Thread.destroy() — removido no JDK 21',
    description:
      'Thread.destroy() sempre lançou UnsupportedOperationException e foi removido no JDK 21. ' +
      'Substitua pela mesma abordagem de interrupt() + flag.',
    blocking: true,
  },
  {
    re: /\.countStackFrames\s*\(\s*\)/,
    id: 'thread-countStackFrames',
    title: 'Thread.countStackFrames() — removido no JDK 21',
    description:
      'Thread.countStackFrames() foi removido no JDK 21. ' +
      'Use Thread.getStackTrace().length ou StackWalker (JDK 9+) como alternativa.',
    blocking: true,
  },
  {
    re: /extends\s+SecurityManager\b|System\.setSecurityManager\s*\(|new\s+SecurityManager\s*\(/,
    id: 'security-manager',
    title: 'SecurityManager — removido no JDK 17',
    description:
      'SecurityManager foi removido no JDK 17 (JEP 411). ' +
      'Qualquer chamada ou subclasse lança UnsupportedOperationException. ' +
      'Avalie se a restrição de segurança é realmente necessária e use módulos JPMS ou políticas de container como alternativa.',
    blocking: true,
  },
]

export interface SourceCleanerDetail {
  filesModifiedList: string[]
  removedCalls: Array<{ file: string; line: number; pattern: string }>
  humanDecisionsNeeded: Array<{
    id: string
    title: string
    description: string
    blocking: boolean
    occurrences: Array<{ file: string; line: number }>
  }>
}

// ─── entry point público ──────────────────────────────────────────────────────

export async function runSourceCleaner(
  projectPath: string,
  dryRun: boolean,
): Promise<TransformResult & { detail: SourceCleanerDetail }> {
  const detail: SourceCleanerDetail = {
    filesModifiedList: [],
    removedCalls: [],
    humanDecisionsNeeded: [],
  }

  const diffs: string[] = []
  const warnings: string[] = []
  const recipesAppliedSet = new Set<string>()
  let totalModified = 0

  // Coleta todos os arquivos Java de main + test
  const srcDirs = [
    join(projectPath, 'src', 'main', 'java'),
    join(projectPath, 'src', 'test', 'java'),
  ].filter(existsSync)

  if (srcDirs.length === 0) {
    return {
      recipesApplied: [],
      filesModified: 0,
      filesAdded: 0,
      diffSummary: 'source-cleaner: nenhum diretório src/main/java ou src/test/java encontrado',
      warnings: [],
      detail,
    }
  }

  // ── Inicializa mapa de ocorrências de human decisions ─────────────────────
  const humanMap = new Map<string, SourceCleanerDetail['humanDecisionsNeeded'][0]>()
  for (const p of HUMAN_DECISION_PATTERNS) {
    humanMap.set(p.id, { id: p.id, title: p.title, description: p.description, blocking: p.blocking, occurrences: [] })
  }

  const allJavaFiles = srcDirs.flatMap(findJavaFiles)

  for (const f of allJavaFiles) {
    const original = readSafe(f)
    if (!original) continue

    const rel = relPath(projectPath, f)
    let updated = original

    // ── Remoções seguras ─────────────────────────────────────────────────────
    for (const pattern of SAFE_REMOVALS) {
      pattern.re.lastIndex = 0
      if (!pattern.re.test(original)) continue
      pattern.re.lastIndex = 0

      updated = updated.replace(pattern.re, (match, indent) => {
        // Encontra número de linha aproximado para o relatório
        const linesBefore = original.slice(0, original.indexOf(match)).split('\n').length
        detail.removedCalls.push({ file: rel, line: linesBefore, pattern: pattern.recipe })
        recipesAppliedSet.add(pattern.recipe)
        return `${indent}${pattern.comment}`
      })
    }

    // Remove imports desnecessários
    for (const importRe of SAFE_IMPORT_REMOVALS) {
      importRe.lastIndex = 0
      if (importRe.test(updated)) {
        importRe.lastIndex = 0
        updated = updated.replace(importRe, '')
        recipesAppliedSet.add('remove-obsolete-imports')
      }
    }

    // ── Detecção de human decisions ──────────────────────────────────────────
    const lines = original.split('\n')
    for (const p of HUMAN_DECISION_PATTERNS) {
      p.re.lastIndex = 0
      for (let i = 0; i < lines.length; i++) {
        if (p.re.test(lines[i])) {
          humanMap.get(p.id)!.occurrences.push({ file: rel, line: i + 1 })
          p.re.lastIndex = 0
        }
      }
    }

    // ── Grava se mudou ───────────────────────────────────────────────────────
    if (updated !== original) {
      diffs.push(minimalDiff(rel, original, updated))
      if (!dryRun) writeFileSync(f, updated, 'utf-8')
      detail.filesModifiedList.push(rel)
      totalModified++
    }
  }

  // ── Consolida human decisions encontradas ─────────────────────────────────
  for (const entry of humanMap.values()) {
    if (entry.occurrences.length > 0) {
      detail.humanDecisionsNeeded.push(entry)
      const blockingLabel = entry.blocking ? ' ⛔ BLOQUEANTE' : ''
      warnings.push(
        `${entry.title}${blockingLabel}: ${entry.occurrences.length} ocorrência(s) em ` +
        `${[...new Set(entry.occurrences.map(o => o.file))].join(', ')}. ` +
        `Requer correção manual — surfaceado no Gate 2.`,
      )
    }
  }

  const prefix = dryRun ? '[dry-run] ' : ''
  const removedCount = detail.removedCalls.length
  const humanCount   = detail.humanDecisionsNeeded.length

  const diffSummary = removedCount > 0 || humanCount > 0
    ? `${prefix}source-cleaner: ${removedCount} chamada(s) removida(s) em ${detail.filesModifiedList.length} arquivo(s)` +
      (humanCount > 0 ? `; ${humanCount} padrão(ões) requerem intervenção humana (ver Gate 2)` : '') +
      (diffs.length > 0 ? `\n${diffs.join('\n')}` : '')
    : `${prefix}source-cleaner: nenhuma chamada de API obsoleta encontrada`

  return {
    recipesApplied: [...recipesAppliedSet],
    filesModified: dryRun ? 0 : totalModified,
    filesAdded: 0,
    diffSummary,
    warnings,
    detail,
  }
}
