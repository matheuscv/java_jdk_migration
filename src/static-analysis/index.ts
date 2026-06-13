import { runJdeprscan, findJavaHome, findAllCompiledClasses } from './jdeprscan-runner.js'
import { runJdeps, type JdepsResult } from './jdeps-runner.js'
import { scanSourceFiles } from './source-scanner.js'
import { scanContainersAndCi, type ContainerCiScanResult } from './container-ci-scanner.js'
import { getEntriesForJdk } from '../knowledge-base/index.js'

export interface DeprecatedApiItem {
  className: string
  member: string | null
  removedInJdk: number | null
  replacement: string | null
  file: string | null
  line: number | null
}

export interface StaticAnalysisResult {
  jdeprscanItems: DeprecatedApiItem[]
  sourceItems: DeprecatedApiItem[]
  jdepsViolations: string[]
  splitPackages: string[]
  runtimeWarnings: string[]
  javaHomeUsed: string | null
  compiledClassesFound: boolean
  analysisTimestamp: string
  /** Findings de Dockerfile, docker-compose e pipelines de CI */
  containerCi: ContainerCiScanResult
}

export type { ContainerCiScanResult } from './container-ci-scanner.js'
export type { ContainerFinding } from './container-ci-scanner.js'
export type { EnrichedContainerFinding } from './container-registry-enricher.js'

export async function runStaticAnalysis(
  projectPath: string,
  buildSystem: 'maven' | 'gradle' | 'ant',
  sourceJdk: '6' | '8',
  targetJdk: string = '21',
): Promise<StaticAnalysisResult> {
  const timestamp = new Date().toISOString()
  const javaHome = findJavaHome()
  const compiledDirs = javaHome ? findAllCompiledClasses(projectPath, buildSystem) : []

  // Source-level scan — always runs regardless of JDK installation
  const entries = getEntriesForJdk(Number(sourceJdk), 21)
  const sourceItems = scanSourceFiles(projectPath, entries)

  let jdeprscanItems: DeprecatedApiItem[] = []
  let jdepsResult: JdepsResult = { violations: [], splitPackages: [], runtimeWarnings: [] }

  if (javaHome && compiledDirs.length > 0) {
    const allJdeprscan = await Promise.all(
      compiledDirs.map(classesDir =>
        runJdeprscan({ javaHome, projectPath, classesDir, classpathFile: null, release: 21 }),
      ),
    )
    jdeprscanItems = allJdeprscan.flat()

    const allJdeps = await Promise.all(
      compiledDirs.map(classesDir => runJdeps(javaHome, projectPath, classesDir)),
    )
    jdepsResult = {
      violations: allJdeps.flatMap(r => r.violations),
      splitPackages: [...new Set(allJdeps.flatMap(r => r.splitPackages))],
      runtimeWarnings: [...new Set(allJdeps.flatMap(r => r.runtimeWarnings))],
    }
  }

  // Container & CI scan — always runs, não requer JDK instalado
  const containerCi = scanContainersAndCi(projectPath, targetJdk)

  return {
    jdeprscanItems,
    sourceItems,
    jdepsViolations: jdepsResult.violations.map(
      v => `${v.sourceClass} -> ${v.targetPackage} (${v.internalModule})`,
    ),
    splitPackages: jdepsResult.splitPackages,
    runtimeWarnings: jdepsResult.runtimeWarnings,
    javaHomeUsed: javaHome,
    compiledClassesFound: compiledDirs.length > 0,
    analysisTimestamp: timestamp,
    containerCi,
  }
}
