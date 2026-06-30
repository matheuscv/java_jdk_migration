import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { SecretStore, PinEntry } from '../../../src/ports/secret-store.js'
import { createLocalSecretStore } from '../../../src/adapters/local/local-secret-store.js'
import { createInMemorySecretStore } from '../../../src/adapters/memory/in-memory-secret-store.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `jdk-migration-secret-test-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function samplePin(phase: number): PinEntry {
  return { pin: '847291', expiresAt: '2026-06-30T23:59:59.000Z', phaseNumber: phase }
}

function describeSecretStoreContract(name: string, makeStore: () => SecretStore) {
  describe(`SecretStore contract — ${name}`, () => {
    let store: SecretStore

    beforeEach(() => { store = makeStore() })

    it('getPin() returns null when nothing was stored for the phase', async () => {
      expect(await store.getPin(3)).toBeNull()
    })

    it('putPin() then getPin() round-trips the same entry', async () => {
      await store.putPin(3, samplePin(3))
      expect(await store.getPin(3)).toEqual(samplePin(3))
    })

    it('deletePin() removes the entry', async () => {
      await store.putPin(3, samplePin(3))
      await store.deletePin(3)
      expect(await store.getPin(3)).toBeNull()
    })

    it('keeps PINs of different phases isolated from each other', async () => {
      await store.putPin(0, samplePin(0))
      await store.putPin(4, samplePin(4))
      expect(await store.getPin(0)).toEqual(samplePin(0))
      expect(await store.getPin(4)).toEqual(samplePin(4))
      await store.deletePin(0)
      expect(await store.getPin(0)).toBeNull()
      expect(await store.getPin(4)).toEqual(samplePin(4))
    })
  })
}

describeSecretStoreContract('InMemorySecretStore', () => createInMemorySecretStore())

describe('SecretStore contract — LocalSecretStore (filesystem)', () => {
  let dir: string

  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('getPin() returns null when nothing was stored for the phase', async () => {
    const store = createLocalSecretStore(dir)
    expect(await store.getPin(3)).toBeNull()
  })

  it('putPin() then getPin() round-trips the same entry', async () => {
    const store = createLocalSecretStore(dir)
    await store.putPin(3, samplePin(3))
    expect(await store.getPin(3)).toEqual(samplePin(3))
  })

  it('deletePin() removes the entry', async () => {
    const store = createLocalSecretStore(dir)
    await store.putPin(3, samplePin(3))
    await store.deletePin(3)
    expect(await store.getPin(3)).toBeNull()
  })

  it('persists under .jdk-migration/.gate-pins.json — same path the agent never reads', async () => {
    const store = createLocalSecretStore(dir)
    await store.putPin(4, samplePin(4))
    const pinFile = join(dir, '.jdk-migration', '.gate-pins.json')
    expect(existsSync(pinFile)).toBe(true)
    const raw = JSON.parse(readFileSync(pinFile, 'utf-8'))
    expect(raw['4'].pin).toBe('847291')
  })
})
