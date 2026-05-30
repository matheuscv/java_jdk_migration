import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJdeprscanOutput } from '../../src/static-analysis/jdeprscan-runner.js'
import { parseJdepsOutput } from '../../src/static-analysis/jdeps-runner.js'
import { scanSourceFiles } from '../../src/static-analysis/source-scanner.js'
import { getEntriesForJdk } from '../../src/knowledge-base/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURES = join(__dirname, '../fixtures')

// ─── jdeprscan parser ─────────────────────────────────────────────────────────

describe('parseJdeprscanOutput', () => {
  const SAMPLE_OUTPUT = `
Jar file or class path: target/classes
Scanning using release 21

class com/example/LegacyController uses deprecated class sun/misc/BASE64Encoder (for removal)
class com/example/LegacyService uses deprecated method java/lang/Thread.stop()V
class com/example/App uses deprecated class javax/xml/bind/JAXBContext
  `.trim()

  it('parses deprecated class usage', () => {
    const items = parseJdeprscanOutput(SAMPLE_OUTPUT)
    const base64 = items.find(i => i.className.includes('BASE64Encoder'))
    expect(base64).toBeDefined()
    expect(base64?.className).toBe('sun.misc.BASE64Encoder')
  })

  it('parses deprecated method usage', () => {
    const items = parseJdeprscanOutput(SAMPLE_OUTPUT)
    const stop = items.find(i => i.className.includes('Thread') && i.member === 'stop')
    expect(stop).toBeDefined()
    expect(stop?.member).toBe('stop')
  })

  it('parses JAXB class usage', () => {
    const items = parseJdeprscanOutput(SAMPLE_OUTPUT)
    const jaxb = items.find(i => i.className.includes('JAXBContext'))
    expect(jaxb).toBeDefined()
  })

  it('returns empty array for empty output', () => {
    expect(parseJdeprscanOutput('')).toHaveLength(0)
    expect(parseJdeprscanOutput('Jar file or class path: target/classes')).toHaveLength(0)
  })

  it('deduplicates identical items', () => {
    const repeated = `
class com/example/A uses deprecated class sun/misc/BASE64Encoder (for removal)
class com/example/B uses deprecated class sun/misc/BASE64Encoder (for removal)
    `.trim()
    const items = parseJdeprscanOutput(repeated)
    const base64Items = items.filter(i => i.className === 'sun.misc.BASE64Encoder')
    expect(base64Items).toHaveLength(1)
  })
})

// ─── jdeps parser ─────────────────────────────────────────────────────────────

describe('parseJdepsOutput', () => {
  const SAMPLE_JDEPS = `
com.example.LegacyService -> sun.misc.Unsafe  JDK internal API (java.base)
com.example.App -> sun.reflect.Reflection  JDK internal API (java.base)
Warning: split package: javax.xml.bind [module java.xml.bind, unnamed module]
   --add-opens java.base/sun.misc=ALL-UNNAMED
  `.trim()

  it('parses internal API violations', () => {
    const result = parseJdepsOutput(SAMPLE_JDEPS)
    expect(result.violations).toHaveLength(2)
    expect(result.violations[0].sourceClass).toBe('com.example.LegacyService')
    expect(result.violations[0].targetPackage).toBe('sun.misc.Unsafe')
    expect(result.violations[0].internalModule).toBe('java.base')
  })

  it('parses split package warnings', () => {
    const result = parseJdepsOutput(SAMPLE_JDEPS)
    expect(result.splitPackages).toContain('javax.xml.bind')
  })

  it('parses --add-opens runtime warnings', () => {
    const result = parseJdepsOutput(SAMPLE_JDEPS)
    expect(result.runtimeWarnings.some(w => w.includes('--add-opens'))).toBe(true)
  })

  it('returns empty result for empty output', () => {
    const result = parseJdepsOutput('')
    expect(result.violations).toHaveLength(0)
    expect(result.splitPackages).toHaveLength(0)
    expect(result.runtimeWarnings).toHaveLength(0)
  })
})

// ─── source scanner ───────────────────────────────────────────────────────────

describe('scanSourceFiles — jdk8-spring-boot fixture', () => {
  const projectPath = join(FIXTURES, 'jdk8-spring-boot')
  const entries = getEntriesForJdk(8, 21)

  it('detects sun.misc.BASE64Encoder import in LegacyController.java', () => {
    const items = scanSourceFiles(projectPath, entries)
    const found = items.find(i => i.className.includes('BASE64Encoder'))
    expect(found).toBeDefined()
    expect(found?.file).toMatch(/LegacyController\.java/)
  })

  it('detects javax.xml.bind import', () => {
    const items = scanSourceFiles(projectPath, entries)
    const found = items.find(i => i.className.includes('xml.bind') || i.className.includes('JAXBContext'))
    expect(found).toBeDefined()
  })

  it('detects Thread.stop() usage in LegacyService.java', () => {
    const items = scanSourceFiles(projectPath, entries)
    const found = items.find(i => i.member === 'stop' || i.className.includes('Thread#stop'))
    expect(found).toBeDefined()
    expect(found?.file).toMatch(/LegacyService\.java/)
  })

  it('detects finalize() override in LegacyService.java', () => {
    const items = scanSourceFiles(projectPath, entries)
    const found = items.find(i => i.member === 'finalize' || i.className.includes('finalize'))
    expect(found).toBeDefined()
  })

  it('returns file and line number for each finding', () => {
    const items = scanSourceFiles(projectPath, entries)
    for (const item of items) {
      expect(item.file).toBeTruthy()
      expect(item.line).toBeGreaterThan(0)
    }
  })
})

describe('scanSourceFiles — jdk6-app fixture', () => {
  const projectPath = join(FIXTURES, 'jdk6-app')
  const entries = getEntriesForJdk(6, 21)

  it('detects BASE64Encoder and BASE64Decoder', () => {
    const items = scanSourceFiles(projectPath, entries)
    const encoder = items.find(i => i.className.includes('BASE64Encoder'))
    const decoder = items.find(i => i.className.includes('BASE64Decoder'))
    expect(encoder).toBeDefined()
    expect(decoder).toBeDefined()
  })

  it('detects java.util.Observer', () => {
    const items = scanSourceFiles(projectPath, entries)
    const found = items.find(i => i.className.includes('Observer'))
    expect(found).toBeDefined()
  })
})
