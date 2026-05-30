import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../lib/process-runner.js'

export interface JdepsViolation {
  sourceClass: string
  targetPackage: string
  internalModule: string
}

export interface JdepsResult {
  violations: JdepsViolation[]
  splitPackages: string[]
  runtimeWarnings: string[]
}

export async function runJdeps(
  javaHome: string,
  projectPath: string,
  classesDir: string,
): Promise<JdepsResult> {
  const jdepsBin = join(javaHome, 'bin', process.platform === 'win32' ? 'jdeps.exe' : 'jdeps')
  if (!existsSync(jdepsBin) || !existsSync(classesDir)) {
    return { violations: [], splitPackages: [], runtimeWarnings: [] }
  }

  const result = await runProcess(jdepsBin, ['--jdk-internals', '--multi-release', '21', classesDir], {
    cwd: projectPath,
    timeoutMs: 60_000,
  })

  return parseJdepsOutput(result.stdout + result.stderr)
}

// Exported for unit testing
export function parseJdepsOutput(output: string): JdepsResult {
  const violations: JdepsViolation[] = []
  const splitPackages: string[] = []
  const runtimeWarnings: string[] = []

  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // "com.example.App -> sun.misc.Unsafe  JDK internal API (java.base)"
    const internalMatch = trimmed.match(/^([\w.$]+)\s+->\s+([\w.$]+)\s+JDK internal API \(([\w.]+)\)/)
    if (internalMatch) {
      violations.push({
        sourceClass: internalMatch[1],
        targetPackage: internalMatch[2],
        internalModule: internalMatch[3],
      })
      continue
    }

    // "Warning: split package: javax.xml.bind [...]"
    if (trimmed.startsWith('Warning: split package:')) {
      const pkg = trimmed.replace('Warning: split package:', '').trim().split(' ')[0]
      if (pkg) splitPackages.push(pkg)
      continue
    }

    // "--add-opens" or "--add-exports" warnings
    if (trimmed.includes('--add-opens') || trimmed.includes('--add-exports')) {
      runtimeWarnings.push(trimmed)
    }
  }

  return { violations, splitPackages, runtimeWarnings }
}
