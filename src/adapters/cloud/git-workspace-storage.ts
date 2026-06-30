import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { runProcess } from '../../lib/process-runner.js'
import { MigrationError } from '../../lib/errors.js'
import type { MigrationStorage } from '../../ports/storage.js'

/**
 * Caminhos que NUNCA devem ser commitados na branch de trabalho, mesmo que
 * fisicamente escritos no workspace clonado. Isso preserva a garantia de R1:
 * o PIN store fica isolado do estado versionado e, portanto, fora do alcance
 * de qualquer agente com acesso de leitura ao repositório via GitHub API.
 * Ver memória de projeto "r2-gate-pin-teams-email".
 */
export const DEFAULT_EXCLUDED_FROM_COMMIT = ['.jdk-migration/.gate-pins.json']

export interface GitWorkspaceStorageOptions {
  /** URL (ou path local, em testes) do repositório remoto a clonar. */
  repoUrl: string
  /** Branch de trabalho da migração — criada se ainda não existir no remoto. */
  branch: string
  /** Diretório local onde o clone é materializado (disco efêmero do container). */
  workDir: string
  /** Paths relativos adicionais a nunca commitar, além de DEFAULT_EXCLUDED_FROM_COMMIT. */
  extraExcludedPaths?: string[]
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runProcess('git', args, { cwd, timeoutMs: 60_000 })
  if (result.exitCode !== 0) {
    throw new MigrationError(
      'GIT_WORKSPACE_INIT_FAILED',
      `git ${args[0]} falhou: ${result.stderr.trim()}`,
      { args, stderr: result.stderr },
    )
  }
  return result.stdout.trim()
}

/**
 * Implementação cloud de MigrationStorage: clona a branch de trabalho para um
 * diretório efêmero e usa esse clone como árvore real (necessário para que
 * OpenRewrite/Maven possam operar). Cada commitState() faz commit + push do
 * estado para a branch do GitHub — restaurável em cold-start via re-clone.
 *
 * Mesmo contrato de LocalFsStorage (M0); troca de implementação não exige
 * mudança na lógica de negócio que consome a porta MigrationStorage.
 */
export function createGitWorkspaceStorage(options: GitWorkspaceStorageOptions): MigrationStorage {
  const { repoUrl, branch, workDir } = options
  const excludedPaths = [...DEFAULT_EXCLUDED_FROM_COMMIT, ...(options.extraExcludedPaths ?? [])]
  let cloned = false

  async function ensureCloned(): Promise<void> {
    if (cloned) return
    if (existsSync(join(workDir, '.git'))) {
      cloned = true
      return
    }

    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true })
    }

    const cloneBranch = await runProcess(
      'git',
      ['clone', '--depth', '50', '--branch', branch, repoUrl, '.'],
      { cwd: workDir, timeoutMs: 120_000 },
    )

    if (cloneBranch.exitCode !== 0) {
      // Branch de trabalho ainda não existe no remoto (primeira execução da fase) —
      // clona o branch padrão do repositório e cria a branch de trabalho localmente.
      await git(['clone', '--depth', '50', repoUrl, '.'], workDir)
      await git(['checkout', '-b', branch], workDir)
    }

    cloned = true
  }

  return {
    async read(relPath: string): Promise<string | null> {
      await ensureCloned()
      const fullPath = join(workDir, relPath)
      if (!existsSync(fullPath)) return null
      return readFileSync(fullPath, 'utf-8')
    },

    async write(relPath: string, content: string): Promise<void> {
      await ensureCloned()
      const fullPath = join(workDir, relPath)
      const dir = dirname(fullPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(fullPath, content, 'utf-8')
    },

    async exists(relPath: string): Promise<boolean> {
      await ensureCloned()
      return existsSync(join(workDir, relPath))
    },

    async commitState(message: string): Promise<void> {
      await ensureCloned()

      await git(['add', '-A'], workDir)

      // Garante que nenhum path da lista de exclusão (ex: PIN store) seja
      // commitado, mesmo que tenha sido staged pelo `add -A` acima.
      for (const excluded of excludedPaths) {
        await runProcess('git', ['rm', '--cached', '--ignore-unmatch', excluded], {
          cwd: workDir,
          timeoutMs: 10_000,
        })
      }

      const staged = await runProcess('git', ['diff', '--cached', '--name-only'], {
        cwd: workDir,
        timeoutMs: 10_000,
      })

      if (staged.stdout.trim() === '') {
        await git(['commit', '--allow-empty', '-m', message], workDir)
      } else {
        await git(['commit', '-m', message], workDir)
      }

      await git(['push', '-u', 'origin', `HEAD:${branch}`], workDir)
    },
  }
}
