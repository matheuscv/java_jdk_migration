import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import type { StackType, RiskSeverity } from '../types.js'
import type { DeprecatedApiItem, StaticAnalysisResult } from '../static-analysis/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface KnowledgeEntry {
  apiPattern: string
  removedInJdk: number
  jep: string | null
  severity: RiskSeverity
  replacement: string | null
  recipe: string | null
  affectsStacks: StackType[]
  migrationNote: string
}

export interface EnrichedIssue {
  apiPattern: string
  severity: RiskSeverity
  foundInFiles: string[]
  removedInJdk: number
  jep: string | null
  replacement: string | null
  recipe: string | null
  affectsStacks: StackType[]
  migrationNote: string
  automatable: boolean
}

function loadEntries(sourceJdk: number): KnowledgeEntry[] {
  const file = sourceJdk <= 6
    ? join(__dirname, 'data/jdk6-to-21.json')
    : join(__dirname, 'data/jdk8-to-21.json')
  return JSON.parse(readFileSync(file, 'utf-8')) as KnowledgeEntry[]
}

// ─── Spring Boot 2 → 3 framework incompatibilities ───────────────────────────

export interface SpringBoot3Entry {
  pattern: string
  type: 'framework-incompatibility' | 'api-removal' | 'api-break' | 'version-conflict' | 'namespace-conflict' | 'outdated-dependency' | 'property-rename' | 'test-framework' | 'unused-property'
  severity: RiskSeverity
  context: string
  description: string
  replacement: string | null
  automationAvailable: boolean
  recipe: string | null
  affectsStacks: StackType[]
  migrationSteps: string[]
  humanDecisionRequired: boolean
  claudeCanExecute: boolean
  decisionOptions?: string[]
}

export function getSpringBoot3Entries(): SpringBoot3Entry[] {
  const file = join(__dirname, 'data/spring-boot-2-to-3.json')
  return JSON.parse(readFileSync(file, 'utf-8')) as SpringBoot3Entry[]
}

export function getEntriesForJdk(sourceJdk: number, targetJdk: number): KnowledgeEntry[] {
  return loadEntries(sourceJdk).filter(e => e.removedInJdk <= targetJdk)
}

export function correlate(
  staticResult: StaticAnalysisResult,
  sourceJdk: number = 8,
): EnrichedIssue[] {
  const entries = getEntriesForJdk(sourceJdk, 21)
  const issueMap = new Map<string, EnrichedIssue>()

  const allItems: DeprecatedApiItem[] = [
    ...staticResult.jdeprscanItems,
    ...(staticResult.sourceItems ?? []),
  ]

  for (const item of allItems) {
    const matched = findEntry(item.className, entries)
    if (!matched) continue

    const existing = issueMap.get(matched.apiPattern)
    const file = item.file ?? item.className
    if (existing) {
      if (!existing.foundInFiles.includes(file)) {
        existing.foundInFiles.push(file)
      }
    } else {
      issueMap.set(matched.apiPattern, {
        apiPattern: matched.apiPattern,
        severity: matched.severity,
        foundInFiles: [file],
        removedInJdk: matched.removedInJdk,
        jep: matched.jep,
        replacement: matched.replacement,
        recipe: matched.recipe,
        affectsStacks: matched.affectsStacks,
        migrationNote: matched.migrationNote,
        automatable: matched.recipe !== null,
      })
    }
  }

  return [...issueMap.values()].sort((a, b) =>
    severityOrder(a.severity) - severityOrder(b.severity),
  )
}

function findEntry(
  className: string,
  entries: KnowledgeEntry[],
): KnowledgeEntry | undefined {
  // Exact match first
  const exact = entries.find(e => className === e.apiPattern)
  if (exact) return exact

  // Prefix match: entry "javax.xml.bind" matches "javax.xml.bind.JAXBContext"
  return entries.find(e => {
    const pattern = e.apiPattern
    // Method patterns like "java.lang.Thread#stop"
    if (pattern.includes('#')) {
      const [cls, method] = pattern.split('#')
      return className.startsWith(cls) && className.includes(method)
    }
    return className.startsWith(pattern)
  })
}

function severityOrder(s: RiskSeverity): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[s]
}
