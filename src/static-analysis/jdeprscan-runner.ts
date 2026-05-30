import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../lib/process-runner.js'
import type { DeprecatedApiItem } from './index.js'

export interface JdeprscanOptions {
  javaHome: string
  projectPath: string
  classesDir: string
  classpathFile: string | null
  release: number
}

export async function runJdeprscan(opts: JdeprscanOptions): Promise<DeprecatedApiItem[]> {
  const jdeprscanBin = join(opts.javaHome, 'bin', process.platform === 'win32' ? 'jdeprscan.exe' : 'jdeprscan')
  if (!existsSync(jdeprscanBin)) return []
  if (!existsSync(opts.classesDir)) return []

  const args = ['--release', String(opts.release)]
  if (opts.classpathFile) args.push('--class-path', opts.classpathFile)
  args.push(opts.classesDir)

  const result = await runProcess(jdeprscanBin, args, {
    cwd: opts.projectPath,
    timeoutMs: 60_000,
  })

  if (result.timedOut || result.exitCode > 1) return []
  return parseJdeprscanOutput(result.stdout + result.stderr)
}

// Exported for unit testing
export function parseJdeprscanOutput(output: string): DeprecatedApiItem[] {
  const items: DeprecatedApiItem[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('Jar') || trimmed.startsWith('Scanning')) continue

    // Format: "class org/example/App uses deprecated class sun/misc/BASE64Encoder (for removal)"
    // Format: "class org/example/App uses deprecated method java/lang/Thread.stop()V"
    const deprecatedMatch = trimmed.match(
      /class\s+[\w$/]+\s+uses\s+deprecated\s+(?:class|method|field|interface)\s+([\w$/.()\[\]V;]+)/,
    )
    if (deprecatedMatch) {
      const raw = deprecatedMatch[1]
      const className = jvmToJava(raw.split('(')[0].split('.')[0])
      const member = extractMember(raw)
      items.push({ className, member, removedInJdk: null, replacement: null, file: null, line: null })
      continue
    }

    // Format: "warning: [deprecation] stop() in Thread has been deprecated"
    const warningMatch = trimmed.match(/warning:\s*\[deprecation\]\s+(.+?)\s+in\s+([\w.]+)/)
    if (warningMatch) {
      const member = warningMatch[1].split('(')[0]
      const className = warningMatch[2]
      items.push({ className, member, removedInJdk: null, replacement: null, file: null, line: null })
    }
  }

  return deduplicate(items)
}

function jvmToJava(jvmName: string): string {
  return jvmName.replace(/\//g, '.').replace(/\$/g, '.')
}

function extractMember(raw: string): string | null {
  const dotIdx = raw.lastIndexOf('.')
  if (dotIdx === -1) return null
  const candidate = raw.slice(dotIdx + 1).split('(')[0]
  if (/^[A-Z]/.test(candidate)) return null  // classname, not member
  return candidate || null
}

function deduplicate(items: DeprecatedApiItem[]): DeprecatedApiItem[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${item.className}#${item.member ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function findJavaHome(): string | null {
  if (process.env['JAVA_HOME'] && existsSync(join(process.env['JAVA_HOME'], 'bin'))) {
    return process.env['JAVA_HOME']
  }
  // Common locations on Windows
  const candidates = [
    'C:\\Program Files\\Java\\jdk-21',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
    'C:\\Program Files\\Microsoft\\jdk-21',
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'bin'))) return c
  }
  return null
}

export function findCompiledClasses(projectPath: string, buildSystem: string): string | null {
  const candidates =
    buildSystem === 'gradle'
      ? ['build/classes/java/main', 'build/classes/kotlin/main']
      : ['target/classes']

  for (const rel of candidates) {
    const full = join(projectPath, rel)
    if (existsSync(full)) return full
  }
  return null
}
