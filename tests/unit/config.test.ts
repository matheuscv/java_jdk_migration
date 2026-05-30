import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  readConfig,
  writeConfig,
  configExists,
  createDefaultPhases,
  type JdkMigrationConfig,
} from '../../src/lib/config.js'
import { MigrationError } from '../../src/lib/errors.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `jdk-migration-test-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeMinimalConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8',
    targetJdk: '21',
    stack: ['spring-boot'],
    buildSystem: 'maven',
    appServer: null,
    multiModule: false,
    modulePaths: [],
    ciSystem: null,
    testCoverageThreshold: 80,
    dryRunBeforeExecute: true,
    phases: createDefaultPhases(),
  }
}

describe('configExists', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns false when config file is absent', () => {
    expect(configExists(dir)).toBe(false)
  })

  it('returns true after writeConfig', () => {
    writeConfig(dir, makeMinimalConfig())
    expect(configExists(dir)).toBe(true)
  })
})

describe('writeConfig + readConfig', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips a minimal config without data loss', () => {
    const original = makeMinimalConfig()
    writeConfig(dir, original)
    const loaded = readConfig(dir)
    expect(loaded).toEqual(original)
  })

  it('preserves all phase fields after write/read', () => {
    const config = makeMinimalConfig()
    config.phases[0] = {
      status: 'approved',
      gateToken: 'abc123',
      approvedBy: 'Alice',
      approvedAt: '2026-05-29T10:00:00.000Z',
      executedAt: null,
      gitBranch: 'jdk-migration/phase-0-20260529',
      gitCommit: 'deadbeef',
      baseBranch: 'main',
      baseCommit: 'cafebabe',
      prUrl: null,
    }
    writeConfig(dir, config)
    const loaded = readConfig(dir)
    expect(loaded.phases[0]).toEqual(config.phases[0])
  })

  it('overwrites an existing config on second write', () => {
    writeConfig(dir, makeMinimalConfig())
    const updated = makeMinimalConfig()
    updated.sourceJdk = '6'
    updated.stack = ['ejb']
    writeConfig(dir, updated)
    const loaded = readConfig(dir)
    expect(loaded.sourceJdk).toBe('6')
    expect(loaded.stack).toEqual(['ejb'])
  })
})

describe('readConfig — error cases', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('throws MigrationError with code CONFIG_NOT_FOUND when file is missing', () => {
    expect(() => readConfig(dir)).toThrow(MigrationError)
    try {
      readConfig(dir)
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationError)
      expect((err as MigrationError).code).toBe('CONFIG_NOT_FOUND')
    }
  })
})

describe('createDefaultPhases', () => {
  it('creates 6 phases all with status pending', () => {
    const phases = createDefaultPhases()
    const keys = Object.keys(phases).map(Number)
    expect(keys).toEqual([0, 1, 2, 3, 4, 5])
    for (const key of keys) {
      expect(phases[key as keyof typeof phases].status).toBe('pending')
      expect(phases[key as keyof typeof phases].gateToken).toBeNull()
    }
  })

  it('returns independent copies — mutating one phase does not affect another', () => {
    const phases = createDefaultPhases()
    phases[0].status = 'completed'
    expect(phases[1].status).toBe('pending')
  })
})
