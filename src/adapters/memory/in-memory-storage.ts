import type { MigrationStorage } from '../../ports/storage.js'

/**
 * Implementação em memória de MigrationStorage, usada em testes para validar
 * a porta sem tocar o filesystem. Mesmo contrato de LocalFsStorage.
 */
export function createInMemoryStorage(): MigrationStorage {
  const files = new Map<string, string>()

  return {
    async read(relPath: string): Promise<string | null> {
      return files.get(relPath) ?? null
    },

    async write(relPath: string, content: string): Promise<void> {
      files.set(relPath, content)
    },

    async exists(relPath: string): Promise<boolean> {
      return files.has(relPath)
    },

    async commitState(): Promise<void> {
      // No-op — sem persistência real a sincronizar.
    },
  }
}
