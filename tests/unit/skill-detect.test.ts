import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { detectStack, detectStackDeep } from '../../src/skill/stack-detector.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURES = join(__dirname, '../fixtures')

describe('detectStack — Maven (jdk8-spring-boot)', () => {
  const projectPath = join(FIXTURES, 'jdk8-spring-boot')

  it('detects Maven as build system', () => {
    const result = detectStack(projectPath)
    expect(result.buildSystem).toBe('maven')
  })

  it('detects JDK 8 from <java.version>1.8</java.version>', () => {
    const result = detectStack(projectPath)
    expect(result.detectedJdk).toBe('8')
  })

  it('detects spring-boot stack', () => {
    const result = detectStack(projectPath)
    expect(result.detectedStacks).toContain('spring-boot')
  })

  it('detects spring-batch stack', () => {
    const result = detectStack(projectPath)
    expect(result.detectedStacks).toContain('spring-batch')
  })

  it('returns high confidence when JDK and stacks are resolved', () => {
    const result = detectStack(projectPath)
    expect(result.confidence).toBe('high')
  })

  it('returns no unresolved fields', () => {
    const result = detectStack(projectPath)
    expect(result.unresolved).toHaveLength(0)
  })
})

describe('detectStack — Maven (jdk6-app)', () => {
  const projectPath = join(FIXTURES, 'jdk6-app')

  it('detects Maven as build system', () => {
    const result = detectStack(projectPath)
    expect(result.buildSystem).toBe('maven')
  })

  it('detects JDK 6 from <maven.compiler.source>1.6</maven.compiler.source>', () => {
    const result = detectStack(projectPath)
    expect(result.detectedJdk).toBe('6')
  })

  it('returns medium or low confidence (no stacks detected for plain app)', () => {
    const result = detectStack(projectPath)
    // JDK detected but no recognized framework deps → medium at best
    expect(['medium', 'low']).toContain(result.confidence)
  })
})

describe('detectStack — Gradle (jdk8-spring-boot/build.gradle)', () => {
  // The fixture has both pom.xml and build.gradle; pom.xml takes precedence.
  // To test Gradle path, we create an in-memory-like test using a temp dir with only build.gradle.
  // For now, verify that pom.xml is preferred.
  it('prefers pom.xml over build.gradle when both exist', () => {
    const projectPath = join(FIXTURES, 'jdk8-spring-boot')
    const result = detectStack(projectPath)
    expect(result.buildSystem).toBe('maven')
  })
})

describe('detectStack — unknown project (no build file)', () => {
  it('returns unknown buildSystem and low confidence for empty dir', () => {
    // Use a path that exists (src dir) but has no build files
    const projectPath = join(FIXTURES)
    const result = detectStack(projectPath)
    // fixtures dir itself has no pom.xml/build.gradle
    expect(result.buildSystem).toBe('unknown')
    expect(result.confidence).toBe('low')
    expect(result.detectedStacks).toHaveLength(0)
  })
})

// ─── detectStackDeep ──────────────────────────────────────────────────────────

describe('detectStackDeep — jdk8-spring-boot fixture', () => {
  const projectPath = join(FIXTURES, 'jdk8-spring-boot')

  // A fixture usa org.springframework.web.* (→ 'rest') e org.springframework.stereotype.*
  // mas NÃO org.springframework.boot.* — o detectStack (shallow) já captura spring-boot via pom.xml
  it('detects rest stack from org.springframework.web imports', () => {
    const result = detectStackDeep(projectPath)
    expect(result.additionalStacks).toContain('rest')
  })

  it('returns non-empty javaImportPatterns when source has Spring imports', () => {
    const result = detectStackDeep(projectPath)
    expect(result.javaImportPatterns.length).toBeGreaterThan(0)
  })
})

describe('detectStackDeep — deployment descriptors', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `jdkm-deep-${randomBytes(4).toString('hex')}`)
    mkdirSync(join(dir, 'src/main/webapp/WEB-INF'), { recursive: true })
    mkdirSync(join(dir, 'src/main/webapp/WEB-INF'), { recursive: true })
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detects hasWebInf when WEB-INF directory exists', () => {
    const result = detectStackDeep(dir)
    expect(result.hasWebInf).toBe(true)
  })

  it('detects ejb stack from ejb-jar.xml', () => {
    writeFileSync(join(dir, 'src/main/webapp/WEB-INF/ejb-jar.xml'), '<ejb-jar/>')
    const result = detectStackDeep(dir)
    expect(result.deploymentDescriptors.some(d => d.endsWith('ejb-jar.xml'))).toBe(true)
    expect(result.additionalStacks).toContain('ejb')
  })

  it('detects jsf stack from faces-config.xml', () => {
    writeFileSync(join(dir, 'src/main/webapp/WEB-INF/faces-config.xml'), '<faces-config/>')
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('jsf')
  })

  it('detects weblogic stack from weblogic.xml', () => {
    writeFileSync(join(dir, 'src/main/webapp/WEB-INF/weblogic.xml'), '<weblogic-web-app/>')
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('weblogic')
  })

  it('returns empty additionalStacks for project with no source or descriptors', () => {
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toHaveLength(0)
    expect(result.deploymentDescriptors).toHaveLength(0)
  })
})

describe('detectStackDeep — Java source import scan', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `jdkm-src-${randomBytes(4).toString('hex')}`)
    mkdirSync(join(dir, 'src/main/java/com/example'), { recursive: true })
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detects ejb stack from javax.ejb import', () => {
    writeFileSync(
      join(dir, 'src/main/java/com/example/MyBean.java'),
      'import javax.ejb.Stateless;\n@Stateless public class MyBean {}',
    )
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('ejb')
  })

  it('detects jsf stack from javax.faces import', () => {
    writeFileSync(
      join(dir, 'src/main/java/com/example/MyBean.java'),
      'import javax.faces.bean.ManagedBean;\n@ManagedBean public class MyBean {}',
    )
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('jsf')
  })

  it('detects spring-batch from org.springframework.batch import', () => {
    writeFileSync(
      join(dir, 'src/main/java/com/example/MyJob.java'),
      'import org.springframework.batch.core.Job;\npublic class MyJob {}',
    )
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('spring-batch')
  })
})
