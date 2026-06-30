import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { MigrationStorage } from '../../ports/storage.js'

/**
 * Implementação local de MigrationStorage: lê/escreve diretamente no
 * filesystem da máquina onde o MCP roda, sob a raiz `projectPath`.
 *
 * Mesma semântica de I/O hoje usada por src/lib/config.ts — extraída aqui
 * como adapter para permitir troca por GitWorkspaceStorage (M2) sem alterar
 * a lógica de negócio das tools.
 */
export function createLocalFsStorage(projectPath: string): MigrationStorage {
  return {
    async read(relPath: string): Promise<string | null> {
      const fullPath = join(projectPath, relPath)
      if (!existsSync(fullPath)) return null
      return readFileSync(fullPath, 'utf-8')
    },

    async write(relPath: string, content: string): Promise<void> {
      const fullPath = join(projectPath, relPath)
      const dir = dirname(fullPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(fullPath, content, 'utf-8')
    },

    async exists(relPath: string): Promise<boolean> {
      return existsSync(join(projectPath, relPath))
    },

    async commitState(): Promise<void> {
      // No-op: write() já persiste em disco local. GitWorkspaceStorage (M2)
      // sobrescreve este método para fazer commit + push da branch de trabalho.
    },
  }
}
