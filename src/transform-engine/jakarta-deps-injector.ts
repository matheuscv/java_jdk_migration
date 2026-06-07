/**
 * jakarta-deps-injector.ts
 *
 * E2.3 — Injeção automática de dependências Jakarta para APIs removidas do JDK (JEP 320).
 * Executado na Fase 3 (Jakarta + Frameworks), após o OpenRewrite / SBM.
 *
 * Detecta uso de:
 *   • javax.xml.ws.*      → jakarta.xml.ws-api
 *   • javax.xml.soap.*    → jakarta.xml.soap-api
 *   • javax.jws.*         → jakarta.jws-api
 *   • javax.activation.*  → jakarta.activation-api (ou com.sun.activation)
 *
 * Para cada namespace detectado injeta a dependência correspondente no pom.xml,
 * caso ainda não esteja presente. Registra o resultado em `detail` para surfacing
 * no Gate 3 e na seção de auditoria do relatório.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TransformResult } from './index.js'

// ─── mapeamento namespace → dependência Maven ─────────────────────────────────

interface JakartaMapping {
  /** Regex que detecta o import no código Java */
  importRe: RegExp
  /** Id curto para relatório */
  id: string
  /** Coordenadas Maven groupId:artifactId:version */
  groupId: string
  artifactId: string
  version: string
  /** Descrição para o relatório de auditoria */
  description: string
}

const JAKARTA_MAPPINGS: JakartaMapping[] = [
  {
    importRe: /import\s+javax\.xml\.ws\./,
    id: 'jakarta-xml-ws',
    groupId: 'jakarta.xml.ws',
    artifactId: 'jakarta.xml.ws-api',
    version: '4.0.0',
    description: 'JAX-WS (javax.xml.ws) removido do JDK 11 (JEP 320) — jakarta.xml.ws-api adicionado',
  },
  {
    importRe: /import\s+javax\.xml\.soap\./,
    id: 'jakarta-xml-soap',
    groupId: 'jakarta.xml.soap',
    artifactId: 'jakarta.xml.soap-api',
    version: '3.0.0',
    description: 'SAAJ (javax.xml.soap) removido do JDK 11 (JEP 320) — jakarta.xml.soap-api adicionado',
  },
  {
    importRe: /import\s+javax\.jws\./,
    id: 'jakarta-jws',
    groupId: 'jakarta.jws',
    artifactId: 'jakarta.jws-api',
    version: '3.0.0',
    description: 'javax.jws (anotações JAX-WS) removido do JDK 11 — jakarta.jws-api adicionado',
  },
  {
    importRe: /import\s+javax\.activation\./,
    id: 'jakarta-activation',
    groupId: 'jakarta.activation',
    artifactId: 'jakarta.activation-api',
    version: '2.1.0',
    description: 'JAF (javax.activation) removido do JDK 11 (JEP 320) — jakarta.activation-api adicionado',
  },
]

// ─── helpers ──────────────────────────────────────────────────────────────────

function readSafe(p: string): string | null {
  try { return readFileSync(p, 'utf-8') } catch { return null }
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

function buildDepBlock(m: JakartaMapping): string {
  return `
        <!-- [jdk-migration] ${m.description} -->
        <dependency>
            <groupId>${m.groupId}</groupId>
            <artifactId>${m.artifactId}</artifactId>
            <version>${m.version}</version>
        </dependency>`
}

// ─── export de detalhes ───────────────────────────────────────────────────────

export interface JakartaDepsDetail {
  /** Dependências efetivamente injetadas no pom.xml */
  injected: Array<{ id: string; coords: string; description: string }>
  /** Namespaces detectados mas cuja dep já estava presente no pom.xml */
  alreadyPresent: Array<{ id: string; coords: string }>
  /** Arquivos Java onde cada namespace foi detectado (amostra) */
  detectedInFiles: Record<string, string[]>
}

// ─── entry point público ──────────────────────────────────────────────────────

export async function runJakartaDepsInjector(
  projectPath: string,
  dryRun: boolean,
): Promise<TransformResult & { detail: JakartaDepsDetail }> {
  const detail: JakartaDepsDetail = {
    injected: [],
    alreadyPresent: [],
    detectedInFiles: {},
  }

  const srcDirs = [
    join(projectPath, 'src', 'main', 'java'),
    join(projectPath, 'src', 'test', 'java'),
  ].filter(existsSync)

  if (srcDirs.length === 0) {
    return {
      recipesApplied: [],
      filesModified: 0,
      filesAdded: 0,
      diffSummary: 'jakarta-deps-injector: nenhum diretório Java encontrado',
      warnings: [],
      detail,
    }
  }

  const pomPath = join(projectPath, 'pom.xml')
  const pomContent = readSafe(pomPath)

  // ── Varredura de imports ──────────────────────────────────────────────────────
  const detectedMappings = new Set<string>()

  const allJavaFiles = srcDirs.flatMap(findJavaFiles)
  for (const f of allJavaFiles) {
    const content = readSafe(f)
    if (!content) continue
    const rel = relative(projectPath, f).replace(/\\/g, '/')
    for (const m of JAKARTA_MAPPINGS) {
      m.importRe.lastIndex = 0
      if (m.importRe.test(content)) {
        detectedMappings.add(m.id)
        if (!detail.detectedInFiles[m.id]) detail.detectedInFiles[m.id] = []
        if (detail.detectedInFiles[m.id].length < 10) {
          detail.detectedInFiles[m.id].push(rel)
        }
      }
    }
  }

  if (detectedMappings.size === 0 || !pomContent) {
    return {
      recipesApplied: [],
      filesModified: 0,
      filesAdded: 0,
      diffSummary: 'jakarta-deps-injector: nenhum namespace Java EE removido detectado',
      warnings: [],
      detail,
    }
  }

  // ── Injeção no pom.xml ────────────────────────────────────────────────────────
  let updatedPom = pomContent
  const recipesApplied: string[] = []
  const injectedDiffs: string[] = []

  for (const m of JAKARTA_MAPPINGS) {
    if (!detectedMappings.has(m.id)) continue

    const alreadyPresent = updatedPom.includes(m.artifactId)
    if (alreadyPresent) {
      detail.alreadyPresent.push({ id: m.id, coords: `${m.groupId}:${m.artifactId}:${m.version}` })
      continue
    }

    const marker = '</dependencies>'
    const idx = updatedPom.lastIndexOf(marker)
    if (idx === -1) continue

    const depBlock = buildDepBlock(m)
    updatedPom = updatedPom.slice(0, idx) + depBlock + '\n    ' + updatedPom.slice(idx)
    detail.injected.push({
      id: m.id,
      coords: `${m.groupId}:${m.artifactId}:${m.version}`,
      description: m.description,
    })
    recipesApplied.push(`inject-${m.id}`)
    injectedDiffs.push(`+ ${m.groupId}:${m.artifactId}:${m.version}`)
  }

  if (detail.injected.length > 0 && !dryRun) {
    writeFileSync(pomPath, updatedPom, 'utf-8')
  }

  const diffSummary = detail.injected.length > 0
    ? `jakarta-deps-injector: ${detail.injected.length} dependência(s) injetada(s) no pom.xml:\n  ${injectedDiffs.join('\n  ')}`
    : `jakarta-deps-injector: namespace(s) Java EE detectado(s) — dependências já presentes no pom.xml`

  return {
    recipesApplied,
    filesModified: detail.injected.length > 0 ? 1 : 0,
    filesAdded: 0,
    diffSummary,
    warnings: [],
    detail,
  }
}
