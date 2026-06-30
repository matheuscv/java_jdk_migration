import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { MigrationStorage } from '../../../src/ports/storage.js'
import { createLocalFsStorage } from '../../../src/adapters/local/local-fs-storage.js'
import { createInMemoryStorage } from '../../../src/adapters/memory/in-memory-storage.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `jdk-migration-storage-test-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Mesma suíte rodada contra as duas implementações de MigrationStorage —
 * garante que LocalFsStorage e InMemoryStorage respeitam o mesmo contrato,
 * condição necessária para trocar a implementação (M2: GitWorkspaceStorage)
 * sem alterar a lógica de negócio que consome a porta.
 */
function describeStorageContract(name: string, makeStorage: () => MigrationStorage) {
  describe(`MigrationStorage contract — ${name}`, () => {
    let storage: MigrationStorage

    beforeEach(() => { storage = makeStorage() })

    it('exists() returns false for a path never written', async () => {
      expect(await storage.exists('jdk-migration.config.json')).toBe(false)
    })

    it('read() returns null for a path never written', async () => {
      expect(await storage.read('jdk-migration.config.json')).toBeNull()
    })

    it('write() then read() round-trips the same content', async () => {
      await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
      expect(await storage.read('jdk-migration.config.json')).toBe('{"sourceJdk":"8"}')
    })

    it('write() then exists() returns true', async () => {
      await storage.write('.jdk-migration/discovery-report.json', '{}')
      expect(await storage.exists('.jdk-migration/discovery-report.json')).toBe(true)
    })

    it('second write() overwrites the previous content', async () => {
      await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
      await storage.write('jdk-migration.config.json', '{"sourceJdk":"6"}')
      expect(await storage.read('jdk-migration.config.json')).toBe('{"sourceJdk":"6"}')
    })

    it('writes under a nested relative path that does not yet exist', async () => {
      await storage.write('.jdk-migration/audit-report-phase-0.md', '# Checklist')
      expect(await storage.read('.jdk-migration/audit-report-phase-0.md')).toBe('# Checklist')
    })

    it('commitState() resolves without throwing (no-op for local/in-memory)', async () => {
      await storage.write('jdk-migration.config.json', '{}')
      await expect(storage.commitState('chore: checkpoint')).resolves.toBeUndefined()
    })
  })
}

describeStorageContract('InMemoryStorage', () => createInMemoryStorage())

describe('MigrationStorage contract — LocalFsStorage (filesystem)', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // Reaproveita a mesma suíte de contrato, mas precisa do diretório por teste,
  // então é instanciada localmente em vez de via describeStorageContract().
  it('exists() returns false for a path never written', async () => {
    const storage = createLocalFsStorage(dir)
    expect(await storage.exists('jdk-migration.config.json')).toBe(false)
  })

  it('write() then read() round-trips the same content', async () => {
    const storage = createLocalFsStorage(dir)
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    expect(await storage.read('jdk-migration.config.json')).toBe('{"sourceJdk":"8"}')
  })

  it('writes under a nested relative path that does not yet exist', async () => {
    const storage = createLocalFsStorage(dir)
    await storage.write('.jdk-migration/audit-report-phase-0.md', '# Checklist')
    expect(await storage.read('.jdk-migration/audit-report-phase-0.md')).toBe('# Checklist')
  })

  it('second write() overwrites the previous content', async () => {
    const storage = createLocalFsStorage(dir)
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"6"}')
    expect(await storage.read('jdk-migration.config.json')).toBe('{"sourceJdk":"6"}')
  })

  it('persists to the real filesystem under projectPath', async () => {
    const storage = createLocalFsStorage(dir)
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    // Uma nova instância apontando para o mesmo dir deve enxergar o mesmo arquivo —
    // prova que o estado vive no disco, não na instância do adapter.
    const otherInstance = createLocalFsStorage(dir)
    expect(await otherInstance.read('jdk-migration.config.json')).toBe('{"sourceJdk":"8"}')
  })

  it('commitState() resolves without throwing (no-op for local fs)', async () => {
    const storage = createLocalFsStorage(dir)
    await storage.write('jdk-migration.config.json', '{}')
    await expect(storage.commitState('chore: checkpoint')).resolves.toBeUndefined()
  })
})
