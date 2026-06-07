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
  {
    re: /(?:protected|public)\s+void\s+finalize\s*\(\s*\)/,
    id: 'finalize-override',
    title: 'finalize() override — descontinuado (JEP 421), finalização desativada no JDK 21',
    description:
      'Overrides de finalize() foram descontinuados no JDK 18 (JEP 421) e a finalização ' +
      'está desativada por padrão no JDK 21. O GC não chama mais finalize() de forma confiável. ' +
      'Substitua por java.lang.ref.Cleaner (JDK 9+) ou implemente AutoCloseable + try-with-resources:\n' +
      '  private final Cleaner.Cleanable cleanable;\n' +
      '  MyClass() { cleanable = Cleaner.create().register(this, () -> { /* cleanup */ }); }\n' +
      '  // Remova o finalize() override.',
    blocking: false,
  },
  {
    re: /new\s+ScriptEngineManager\s*\(\s*\)|getEngineByName\s*\(\s*["'](?:nashorn|javascript|js)["']\s*\)/i,
    id: 'nashorn-scriptengine',
    title: 'Nashorn ScriptEngine — removido do JDK 15 (JEP 372)',
    description:
      'O engine Nashorn foi removido do JDK 15 (JEP 372). ' +
      'A dependência org.openjdk.nashorn:nashorn-core:15.4 foi injetada automaticamente no pom.xml ' +
      'para preservar o comportamento existente sem alteração de código. ' +
      'Alternativa recomendada a longo prazo: GraalVM Polyglot API ou migração para Java puro.',
    blocking: false,
  },
  {
    re: /import\s+sun\.misc\.BASE64(?:En|De)coder/,
    id: 'sun-base64',
    title: 'sun.misc.BASE64Encoder/Decoder — API interna removida no JDK 9',
    description:
      'sun.misc.BASE64Encoder e sun.misc.BASE64Decoder foram removidos no JDK 9. ' +
      'OpenRewrite (UpgradeToJava21) cobre esta substituição automaticamente. ' +
      'Se ainda presente após a Fase 2, substitua manualmente por java.util.Base64:\n' +
      '  Base64.getEncoder().encodeToString(bytes)  // codificar\n' +
      '  Base64.getDecoder().decode(str)             // decodificar',
    blocking: false,
  },
  {
    re: /import\s+sun\.misc\.Unsafe\b|(?:^|[^.])sun\.misc\.Unsafe\s/m,
    id: 'sun-unsafe',
    title: 'sun.misc.Unsafe — fortemente restrito no JDK 21',
    description:
      'sun.misc.Unsafe está encapsulado no módulo java.base a partir do JDK 9 e será ' +
      'bloqueado em versões futuras (JEP 471). ' +
      'Substitua operações atômicas por VarHandle (java.lang.invoke.VarHandle, JDK 9+) ou ' +
      'java.util.concurrent.atomic.*. Para memória off-heap, avalie ByteBuffer.allocateDirect() ' +
      'ou Foreign Memory API (java.lang.foreign, JDK 21 estável).',
    blocking: true,
  },
  {
    re: /import\s+sun\.misc\.Signal\b|new\s+sun\.misc\.Signal\s*\(/,
    id: 'sun-signal',
    title: 'sun.misc.Signal — API interna sem equivalente público',
    description:
      'sun.misc.Signal não possui equivalente público no JDK. Opções:\n' +
      '  1. Remover tratamento de sinal se não crítico para a aplicação.\n' +
      '  2. Em ambiente de container (Kubernetes), delegar ao SIGTERM do orquestrador via ' +
      '     ShutdownHook: Runtime.getRuntime().addShutdownHook(new Thread(() -> { ... })).\n' +
      '  3. Biblioteca externa de signal-handling se absolutely necessário.',
    blocking: true,
  },
  {
    re: /import\s+com\.sun\.image\.codec\.jpeg\b|com\.sun\.image\.codec\.jpeg\.\w+/,
    id: 'com-sun-image-codec',
    title: 'com.sun.image.codec.jpeg — removido no JDK 9',
    description:
      'com.sun.image.codec.jpeg foi removido no JDK 9. ' +
      'Substitua por javax.imageio.ImageIO (disponível desde JDK 1.4):\n' +
      '  ImageIO.write(bufferedImage, "JPEG", outputStream)  // escrever\n' +
      '  ImageIO.read(inputStream)                           // ler',
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
  /** true se a dependência nashorn-core foi injetada no pom.xml nesta execução */
  nashornDepInjected: boolean
}

// ─── Nashorn dependency injection ────────────────────────────────────────────

const NASHORN_DEP_BLOCK = `
        <!-- [jdk-migration] nashorn-core: substituto do Nashorn removido no JDK 15 (JEP 372) -->
        <dependency>
            <groupId>org.openjdk.nashorn</groupId>
            <artifactId>nashorn-core</artifactId>
            <version>15.4</version>
        </dependency>`

/**
 * Injeta nashorn-core no pom.xml se ainda não estiver presente.
 * Retorna true se a dependência foi adicionada, false caso já existisse ou não haja pom.xml.
 */
function injectNashornDependency(projectPath: string, dryRun: boolean): boolean {
  const pomPath = join(projectPath, 'pom.xml')
  const content = readSafe(pomPath)
  if (!content) return false
  if (/nashorn-core/.test(content)) return false  // já presente

  // Insere antes de </dependencies>
  const marker = '</dependencies>'
  const idx = content.lastIndexOf(marker)
  if (idx === -1) return false

  const updated = content.slice(0, idx) + NASHORN_DEP_BLOCK + '\n    ' + content.slice(idx)
  if (!dryRun) writeFileSync(pomPath, updated, 'utf-8')
  return true
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
    nashornDepInjected: false,
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

  // ── Injeta nashorn-core se padrão Nashorn/ScriptEngine detectado ─────────
  const nashornEntry = humanMap.get('nashorn-scriptengine')
  if (nashornEntry && nashornEntry.occurrences.length > 0) {
    const injected = injectNashornDependency(projectPath, dryRun)
    detail.nashornDepInjected = injected
    if (injected) {
      recipesAppliedSet.add('inject-nashorn-core-dependency')
      diffs.push('[pom.xml] injetada dependência org.openjdk.nashorn:nashorn-core:15.4')
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
