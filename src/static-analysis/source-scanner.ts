import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import type { DeprecatedApiItem } from './index.js'
import type { KnowledgeEntry } from '../knowledge-base/index.js'

// Scans .java source files for import/usage patterns matching knowledge base entries.
// Works without compilation — complements jdeprscan for projects with no pre-built classes.
export function scanSourceFiles(
  projectPath: string,
  entries: KnowledgeEntry[],
): DeprecatedApiItem[] {
  const javaFiles = findJavaFiles(join(projectPath, 'src'))
  const items: DeprecatedApiItem[] = []

  for (const filePath of javaFiles) {
    const relPath = relative(projectPath, filePath)
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const entry of entries) {
        if (matchesInSource(line, entry)) {
          items.push({
            className: entry.apiPattern.replace('#', '.'),
            member: entry.apiPattern.includes('#') ? entry.apiPattern.split('#')[1] : null,
            removedInJdk: entry.removedInJdk,
            replacement: entry.replacement,
            file: relPath,
            line: i + 1,
          })
          break
        }
      }
    }
  }

  return deduplicate(items)
}

function matchesInSource(line: string, entry: KnowledgeEntry): boolean {
  const pattern = entry.apiPattern
  const trimmed = line.trim()

  if (pattern.includes('#')) {
    // Method pattern: match both import of class AND direct call
    const [cls, method] = pattern.split('#')
    return (
      (trimmed.startsWith('import') && trimmed.includes(cls)) ||
      trimmed.includes(method + '(')
    )
  }

  // Package/class pattern: match import statements
  if (trimmed.startsWith('import') && trimmed.includes(pattern)) return true

  // Also match fully-qualified usage in code (e.g. new sun.misc.BASE64Encoder())
  if (trimmed.includes(pattern)) return true

  return false
}

function findJavaFiles(dir: string): string[] {
  const results: string[] = []
  if (!statSafe(dir)?.isDirectory()) return results

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSafe(full)
    if (!st) continue
    if (st.isDirectory()) {
      results.push(...findJavaFiles(full))
    } else if (extname(full) === '.java') {
      results.push(full)
    }
  }

  return results
}

function statSafe(p: string) {
  try { return statSync(p) } catch { return null }
}

function deduplicate(items: DeprecatedApiItem[]): DeprecatedApiItem[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${item.className}#${item.member ?? ''}:${item.file ?? ''}:${item.line ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
