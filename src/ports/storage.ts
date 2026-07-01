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
 * Constrói a URL Git autenticada para UM repositório específico (owner/repo).
 * Suporta múltiplos repositórios simultâneos: cada chamada recebe o par
 * owner/repo extraído do projectPath da requisição, não um valor fixo de env var.
 *
 * PAT mode: embute o token fixo na URL (funciona para qualquer repo que o PAT acesse).
 * GitHub App mode: obtém um installation access token válido para o repo (a instalação
 * pode cobrir múltiplos repositórios da mesma org).
 */
export type RepoUrlProvider = (owner: string, repo: string) => Promise<string>

/**
 * Resultado da resolução de um projectPath: caminho local (workDir do clone
 * efêmero, se aplicável) + URL Git autenticada (quando o projectPath era uma
 * referência GitHub — null quando já era um caminho de filesystem local).
 */
export interface ResolvedProject {
  path: string
  repoUrl: string | null
}

/**
 * Fábrica de MigrationStorage por chamada de tool. Recebe a URL Git autenticada
 * do repositório específico desta requisição, o workDir local e o nome da
 * branch de destino no GitHub.
 * Em modo local não é injetada — tools operam apenas no filesystem.
 */
export type StorageFactory = (repoUrl: string, workDir: string, branch: string) => MigrationStorage

/**
 * Resolve projectPath que pode ser referência GitHub ("owner/repo" ou URL)
 * para um caminho de filesystem local (clone efêmero no Render) + a URL Git
 * autenticada correspondente a ESSE repositório específico.
 * Em modo local não é injetada — tools operam no path recebido diretamente.
 */
export type ProjectPathResolver = (projectPath: string) => Promise<ResolvedProject>

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
