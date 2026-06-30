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
