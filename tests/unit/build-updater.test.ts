import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { updateMavenVersion, updateGradleVersion, updateBuildVersion } from '../../src/transform-engine/build-updater.js'

// ─── updateMavenVersion (pure function) ──────────────────────────────────────

describe('updateMavenVersion', () => {
  it('updates <java.version>1.8</java.version>', () => {
    const pom = '<properties><java.version>1.8</java.version></properties>'
    expect(updateMavenVersion(pom, '21')).toContain('<java.version>21</java.version>')
  })

  it('updates <java.version>8</java.version> (without "1." prefix)', () => {
    const pom = '<properties><java.version>8</java.version></properties>'
    expect(updateMavenVersion(pom, '21')).toContain('<java.version>21</java.version>')
  })

  it('updates <maven.compiler.source>', () => {
    const pom = '<maven.compiler.source>1.8</maven.compiler.source>'
    expect(updateMavenVersion(pom, '21')).toContain('<maven.compiler.source>21</maven.compiler.source>')
  })

  it('updates <maven.compiler.target>', () => {
    const pom = '<maven.compiler.target>1.8</maven.compiler.target>'
    expect(updateMavenVersion(pom, '21')).toContain('<maven.compiler.target>21</maven.compiler.target>')
  })

  it('updates multiple properties in same pom', () => {
    const pom = [
      '<java.version>1.8</java.version>',
      '<maven.compiler.source>1.8</maven.compiler.source>',
      '<maven.compiler.target>1.8</maven.compiler.target>',
    ].join('\n')
    const updated = updateMavenVersion(pom, '21')
    expect((updated.match(/21/g) ?? []).length).toBe(3)
    expect(updated).not.toContain('1.8')
  })

  it('returns unchanged pom when no version properties found', () => {
    const pom = '<groupId>com.example</groupId>'
    expect(updateMavenVersion(pom, '21')).toBe(pom)
  })

  it('handles jdk6 source (<java.version>1.6</java.version>)', () => {
    const pom = '<java.version>1.6</java.version>'
    expect(updateMavenVersion(pom, '21')).toContain('<java.version>21</java.version>')
  })
})

// ─── updateGradleVersion (pure function) ─────────────────────────────────────

describe('updateGradleVersion', () => {
  it("updates sourceCompatibility = '1.8'", () => {
    const gradle = "sourceCompatibility = '1.8'"
    expect(updateGradleVersion(gradle, '21')).toContain('JavaVersion.VERSION_21')
  })

  it('updates sourceCompatibility = JavaVersion.VERSION_1_8', () => {
    const gradle = 'sourceCompatibility = JavaVersion.VERSION_1_8'
    expect(updateGradleVersion(gradle, '21')).toContain('JavaVersion.VERSION_21')
  })

  it('updates sourceCompatibility = 8', () => {
    const gradle = 'sourceCompatibility = 8'
    expect(updateGradleVersion(gradle, '21')).toContain('JavaVersion.VERSION_21')
  })

  it('updates targetCompatibility alongside sourceCompatibility', () => {
    const gradle = [
      'sourceCompatibility = JavaVersion.VERSION_1_8',
      'targetCompatibility = JavaVersion.VERSION_1_8',
    ].join('\n')
    const updated = updateGradleVersion(gradle, '21')
    expect((updated.match(/VERSION_21/g) ?? []).length).toBe(2)
  })

  it('updates JavaLanguageVersion.of(8)', () => {
    const gradle = 'languageVersion = JavaLanguageVersion.of(8)'
    expect(updateGradleVersion(gradle, '21')).toContain('JavaLanguageVersion.of(21)')
  })

  it('returns unchanged content when no version found', () => {
    const gradle = "apply plugin: 'java'"
    expect(updateGradleVersion(gradle, '21')).toBe(gradle)
  })
})

// ─── updateBuildVersion (integration: writes files) ──────────────────────────

describe('updateBuildVersion — Maven project', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `jdkm-bu-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pom.xml'), `
<project>
  <properties>
    <java.version>1.8</java.version>
    <maven.compiler.source>1.8</maven.compiler.source>
    <maven.compiler.target>1.8</maven.compiler.target>
  </properties>
</project>`)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('modifies pom.xml when dryRun is false', async () => {
    const result = await updateBuildVersion(dir, '21', false)
    expect(result.filesModified).toBe(1)
    const pom = readFileSync(join(dir, 'pom.xml'), 'utf-8')
    expect(pom).toContain('<java.version>21</java.version>')
    expect(pom).not.toContain('1.8')
  })

  it('does NOT modify pom.xml when dryRun is true', async () => {
    const result = await updateBuildVersion(dir, '21', true)
    expect(result.filesModified).toBe(0)
    const pom = readFileSync(join(dir, 'pom.xml'), 'utf-8')
    expect(pom).toContain('1.8')  // unchanged
  })

  it('diffSummary mentions the updated file', async () => {
    const result = await updateBuildVersion(dir, '21', false)
    expect(result.diffSummary).toContain('pom.xml')
  })

  it('reports 0 modifications when version is already 21', async () => {
    writeFileSync(join(dir, 'pom.xml'), '<properties><java.version>21</java.version></properties>')
    const result = await updateBuildVersion(dir, '21', false)
    expect(result.filesModified).toBe(0)
  })
})

describe('updateBuildVersion — Gradle project', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `jdkm-bu-g-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'build.gradle'), "sourceCompatibility = JavaVersion.VERSION_1_8\n")
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('modifies build.gradle when dryRun is false', async () => {
    const result = await updateBuildVersion(dir, '21', false)
    expect(result.filesModified).toBe(1)
    const gradle = readFileSync(join(dir, 'build.gradle'), 'utf-8')
    expect(gradle).toContain('VERSION_21')
  })

  it('does NOT modify when dryRun is true', async () => {
    await updateBuildVersion(dir, '21', true)
    const gradle = readFileSync(join(dir, 'build.gradle'), 'utf-8')
    expect(gradle).toContain('VERSION_1_8')
  })
})
