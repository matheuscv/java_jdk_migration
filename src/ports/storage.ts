/**
 * Porta de persistência de estado da migração (jdk-migration.config.json,
 * discovery-report.json, migration-plan.json, audit reports).
 *
 * LocalFsStorage (M0) lê/escreve no filesystem local — comportamento idêntico
 * ao atual src/lib/config.ts. GitWorkspaceStorage (M2) lê/escreve no clone de
 * trabalho e comita+envia (push) o estado para a branch do GitHub.
 *
 * Todos os paths são relativos à raiz do projeto-alvo (mesma raiz onde hoje
 * vive jdk-migration.config.json).
 */
/**
 * Fábrica de MigrationStorage por chamada de tool. Recebe o projectPath (workDir
 * do clone efêmero no Render) e o nome da branch de destino no GitHub.
 * Em modo local não é injetada — tools operam apenas no filesystem.
 */
export type StorageFactory = (projectPath: string, branch: string) => MigrationStorage

/**
 * Resolve projectPath que pode ser referência GitHub ("owner/repo" ou URL)
 * para um caminho de filesystem local (clone efêmero no Render).
 * Em modo local não é injetada — tools operam no path recebido diretamente.
 */
export type ProjectPathResolver = (projectPath: string) => Promise<string>

export interface MigrationStorage {
  read(relPath: string): Promise<string | null>
  write(relPath: string, content: string): Promise<void>
  exists(relPath: string): Promise<boolean>
  /**
   * Ponto de checkpoint do estado. Em LocalFsStorage é no-op (write já persiste
   * em disco). Em GitWorkspaceStorage faz commit + push da branch de trabalho.
   */
  commitState(message: string): Promise<void>
}
