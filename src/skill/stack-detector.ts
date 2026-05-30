import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { StackType, BuildSystem } from '../types.js'

export interface DeepDetectionResult {
  additionalStacks: StackType[]
  deploymentDescriptors: string[]   // XML descriptors found
  hasWebInf: boolean
  javaImportPatterns: string[]      // matched import patterns
}

export interface StackDetectionResult {
  buildSystem: BuildSystem | 'unknown'
  detectedJdk: string | null
  detectedStacks: StackType[]
  confidence: 'high' | 'medium' | 'low'
  unresolved: string[]
}

export function detectStack(projectPath: string): StackDetectionResult {
  if (existsSync(join(projectPath, 'pom.xml'))) {
    return detectFromMaven(projectPath)
  }
  const hasGradleKts = existsSync(join(projectPath, 'build.gradle.kts'))
  const hasGradle = existsSync(join(projectPath, 'build.gradle'))
  if (hasGradleKts || hasGradle) {
    return detectFromGradle(projectPath, hasGradleKts)
  }
  if (existsSync(join(projectPath, 'build.xml'))) {
    return {
      buildSystem: 'ant',
      detectedJdk: null,
      detectedStacks: [],
      confidence: 'low',
      unresolved: ['sourceJdk', 'stack'],
    }
  }
  return {
    buildSystem: 'unknown',
    detectedJdk: null,
    detectedStacks: [],
    confidence: 'low',
    unresolved: ['buildSystem', 'sourceJdk', 'stack'],
  }
}

function detectFromMaven(projectPath: string): StackDetectionResult {
  const pom = readFileSync(join(projectPath, 'pom.xml'), 'utf-8')
  const stacks: StackType[] = []
  const unresolved: string[] = []

  const javaVersionMatch = pom.match(/<java\.version>([\d.]+)<\/java\.version>/)
  const compilerSourceMatch = pom.match(/<maven\.compiler\.source>([\d.]+)<\/maven\.compiler\.source>/)
  const sourceCompatMatch = pom.match(/<source>([\d.]+)<\/source>/)
  const rawJdk = javaVersionMatch?.[1] ?? compilerSourceMatch?.[1] ?? sourceCompatMatch?.[1] ?? null
  const detectedJdk = rawJdk ? normalizeJdkString(rawJdk) : null
  if (!detectedJdk) unresolved.push('sourceJdk')

  if (/<artifactId>spring-boot-starter/.test(pom)) stacks.push('spring-boot')
  if (/<artifactId>spring-batch-core<\/artifactId>/.test(pom)) stacks.push('spring-batch')
  if (/<artifactId>javax\.ejb/.test(pom) || /<packaging>ejb<\/packaging>/.test(pom)) stacks.push('ejb')
  if (/<artifactId>jsf-api<\/artifactId>/.test(pom) || /<artifactId>primefaces<\/artifactId>/.test(pom)) stacks.push('jsf')
  if (/<artifactId>weblogic<\/artifactId>/.test(pom) || /<artifactId>wls-api<\/artifactId>/.test(pom)) stacks.push('weblogic')

  if (stacks.length === 0) {
    if (/<artifactId>spring-web/.test(pom) || /<packaging>war<\/packaging>/.test(pom)) {
      stacks.push('rest')
    }
  }

  return {
    buildSystem: 'maven',
    detectedJdk,
    detectedStacks: stacks,
    confidence: computeConfidence(stacks, detectedJdk, unresolved),
    unresolved,
  }
}

function detectFromGradle(projectPath: string, preferKts: boolean): StackDetectionResult {
  const gradlePath = preferKts
    ? join(projectPath, 'build.gradle.kts')
    : join(projectPath, 'build.gradle')
  const content = readFileSync(gradlePath, 'utf-8')
  const stacks: StackType[] = []
  const unresolved: string[] = []

  // sourceCompatibility = '1.8' | JavaVersion.VERSION_1_8 | '8' | 8
  const compatMatch = content.match(
    /sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_(?:1_)?)?(\d+)['"]?/,
  )
  // java { sourceCompatibility = JavaVersion.VERSION_1_8 }
  const javaBlockMatch = content.match(
    /JavaVersion\.VERSION_(?:1_)?(\d+)/,
  )
  const rawJdk = compatMatch?.[1] ?? javaBlockMatch?.[1] ?? null
  const detectedJdk = rawJdk ? normalizeJdkString(rawJdk) : null
  if (!detectedJdk) unresolved.push('sourceJdk')

  if (/spring-boot-starter/.test(content)) stacks.push('spring-boot')
  if (/spring-batch-core/.test(content)) stacks.push('spring-batch')
  if (/javax\.ejb:javax\.ejb-api/.test(content)) stacks.push('ejb')
  if (/jsf-api|primefaces/.test(content)) stacks.push('jsf')
  if (/weblogic/.test(content)) stacks.push('weblogic')
  if (stacks.length === 0 && /spring-web/.test(content)) stacks.push('rest')

  return {
    buildSystem: 'gradle',
    detectedJdk,
    detectedStacks: stacks,
    confidence: computeConfidence(stacks, detectedJdk, unresolved),
    unresolved,
  }
}

// Normaliza "1.8" → "8", "1.6" → "6", "8" → "8"
function normalizeJdkString(raw: string): string {
  if (raw.startsWith('1.')) return raw.slice(2)
  return raw
}

// Deep detection: scans Java source files and XML deployment descriptors.
// Used by discover_project for higher-fidelity stack identification.
export function detectStackDeep(projectPath: string): DeepDetectionResult {
  const additionalStacks = new Set<StackType>()
  const deploymentDescriptors: string[] = []
  const javaImportPatterns: string[] = []
  let hasWebInf = false

  const webInfPath = join(projectPath, 'src', 'main', 'webapp', 'WEB-INF')
  if (existsSync(webInfPath)) hasWebInf = true

  const xmlDescriptors: Record<string, StackType | null> = {
    'web.xml': 'rest',
    'faces-config.xml': 'jsf',
    'ejb-jar.xml': 'ejb',
    'weblogic.xml': 'weblogic',
    'weblogic-ejb-jar.xml': 'weblogic',
    'weblogic-application.xml': 'weblogic',
    'persistence.xml': null,
  }

  function scanDir(dir: string) {
    if (!existsSafe(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          scanDir(full)
        } else if (extname(full) === '.java') {
          scanJavaFile(full)
        } else if (extname(full) === '.xml') {
          const base = entry.toLowerCase()
          if (xmlDescriptors[base] !== undefined) {
            deploymentDescriptors.push(full)
            const stack = xmlDescriptors[base]
            if (stack) additionalStacks.add(stack)
          }
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  function scanJavaFile(filePath: string) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const importPatterns: Array<[RegExp, StackType]> = [
        [/import javax\.ejb\./, 'ejb'],
        [/import jakarta\.ejb\./, 'ejb'],
        [/import javax\.faces\./, 'jsf'],
        [/import jakarta\.faces\./, 'jsf'],
        [/import org\.primefaces\./, 'jsf'],
        [/import org\.springframework\.batch\./, 'spring-batch'],
        [/import org\.springframework\.boot\./, 'spring-boot'],
        [/import org\.springframework\.web\./, 'rest'],
        [/import weblogic\./, 'weblogic'],
      ]
      for (const [pattern, stack] of importPatterns) {
        if (pattern.test(content)) {
          additionalStacks.add(stack)
          javaImportPatterns.push(pattern.source)
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  scanDir(join(projectPath, 'src'))
  return {
    additionalStacks: [...additionalStacks],
    deploymentDescriptors,
    hasWebInf,
    javaImportPatterns: [...new Set(javaImportPatterns)],
  }
}

function existsSafe(p: string): boolean {
  try { return existsSync(p) } catch { return false }
}

function computeConfidence(
  stacks: StackType[],
  detectedJdk: string | null,
  unresolved: string[],
): 'high' | 'medium' | 'low' {
  if (unresolved.length === 0 && stacks.length > 0) return 'high'
  if (stacks.length > 0 || detectedJdk !== null) return 'medium'
  return 'low'
}
