import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore, PinEntry } from '../../ports/secret-store.js'

const PIN_STORE_FILENAME = '.gate-pins.json'

type PinStoreFile = Partial<Record<number, PinEntry>>

/**
 * Implementação local de SecretStore: arquivo separado do config principal,
 * deliberadamente fora do retorno de qualquer MCP tool (mesma garantia que
 * src/lib/config.ts já implementa para .gate-pins.json).
 *
 * IMPORTANTE: este arquivo NUNCA deve ser incluído em commitState() de
 * MigrationStorage — é uma porta isolada por design (ver ports/secret-store.ts).
 */
export function createLocalSecretStore(projectPath: string): SecretStore {
  const storeDir = join(projectPath, '.jdk-migration')
  const storePath = join(storeDir, PIN_STORE_FILENAME)

  function readStore(): PinStoreFile {
    if (!existsSync(storePath)) return {}
    try {
      return JSON.parse(readFileSync(storePath, 'utf-8')) as PinStoreFile
    } catch {
      return {}
    }
  }

  function writeStore(store: PinStoreFile): void {
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true })
    }
    writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8')
  }

  return {
    async getPin(phase: number): Promise<PinEntry | null> {
      return readStore()[phase] ?? null
    },

    async putPin(phase: number, entry: PinEntry): Promise<void> {
      const store = readStore()
      store[phase] = entry
      writeStore(store)
    },

    async deletePin(phase: number): Promise<void> {
      const store = readStore()
      delete store[phase]
      writeStore(store)
    },
  }
}
