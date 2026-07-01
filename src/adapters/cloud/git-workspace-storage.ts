import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
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

/**
 * Extrai os paths de `git status --porcelain` (formato "XY caminho"). Ignora
 * entradas de rename ("R  old -> new") — não esperadas nesse fluxo, já que os
 * arquivos em questão são sempre gerados do zero (report/config/plan JSON).
 *
 * Diretórios inteiramente novos aparecem como uma única linha com "/" no final
 * (ex: "?? .jdk-migration/") — expandidos recursivamente em arquivos individuais
 * por expandToFiles(), já que git não lista arquivo por arquivo nesse caso.
 */
function parsePorcelainPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.length > 0 && !line.includes(' -> '))
    .map(line => line.slice(3))
}

/** Expande paths que podem ser diretórios em todos os arquivos que contêm, recursivamente. */
function expandToFiles(workDir: string, paths: string[]): string[] {
  const files: string[] = []
  for (const p of paths) {
    const full = join(workDir, p)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full, { withFileTypes: true })) {
        const childRel = join(p, entry.name)
        if (entry.isDirectory()) {
          files.push(...expandToFiles(workDir, [childRel]))
        } else {
          files.push(childRel)
        }
      }
    } else {
      files.push(p)
    }
  }
  return files
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runProcess('git', args, { cwd, timeoutMs: 60_000, env })
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
 * Identidade de autor/committer para os commits feitos pelo servidor (não por
 * um humano) — necessária porque containers efêmeros (Render, Kubernetes) não
 * têm `git config --global user.name/user.email` configurados por padrão, o
 * que faz `git commit` falhar com "Author identity unknown".
 *
 * Usa as env vars nativas do Git (GIT_AUTHOR_* e GIT_COMMITTER_*) em vez de rodar
 * `git config --global` no container — evita mutar configuração global
 * compartilhada e funciona em qualquer ambiente (Render, EKS, etc.) sem setup.
 * Sobrescrevível via GIT_COMMIT_AUTHOR_NAME/GIT_COMMIT_AUTHOR_EMAIL se a Squad
 * quiser uma identidade corporativa específica nos commits automáticos.
 */
function commitAuthorEnv(): NodeJS.ProcessEnv {
  const name = process.env['GIT_COMMIT_AUTHOR_NAME'] ?? 'jdk-migration-mcp'
  const email = process.env['GIT_COMMIT_AUTHOR_EMAIL'] ?? 'jdk-migration-mcp@users.noreply.github.com'
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  }
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
      // Repo já clonado neste workDir por outro consumidor (ex: ProjectPathResolver,
      // que clona o branch padrão para análise/build). Isso NÃO garante que estamos
      // na branch de trabalho correta — sem essa checagem, commitState() commitaria
      // em cima do HEAD errado (ex: master) e o push para `branch` divergiria com
      // "non-fast-forward" sempre que a branch remota já tivesse histórico anterior.
      await ensureOnBranch()
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

  /**
   * Garante que o workDir está na `branch` de trabalho, preservando o conteúdo
   * de arquivos já escritos nele (ex: discovery-report.json gerado por
   * discover_project ANTES de commitState() ser chamado, ainda no checkout da
   * branch padrão). `git checkout` recusaria sobrescrever esses arquivos
   * untracked — por isso o conteúdo é salvo em memória, os arquivos são
   * removidos para liberar o checkout, e reescritos de volta depois, por cima
   * do que existir na branch de destino (a versão nova sempre vence).
   */
  async function ensureOnBranch(): Promise<void> {
    const current = await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workDir,
      timeoutMs: 10_000,
    })
    if (current.stdout.trim() === branch) return

    const status = await runProcess('git', ['status', '--porcelain'], { cwd: workDir, timeoutMs: 15_000 })
    const changedPaths = expandToFiles(workDir, parsePorcelainPaths(status.stdout))
    const snapshot = new Map<string, Buffer>()
    for (const p of changedPaths) {
      const full = join(workDir, p)
      if (existsSync(full)) {
        snapshot.set(p, readFileSync(full))
        rmSync(full, { force: true })
      }
    }

    const fetch = await runProcess('git', ['fetch', 'origin', branch], { cwd: workDir, timeoutMs: 60_000 })
    if (fetch.exitCode === 0) {
      await git(['checkout', '-B', branch, `origin/${branch}`], workDir)
    } else {
      // Branch de trabalho ainda não existe no remoto — cria a partir do HEAD atual.
      await git(['checkout', '-b', branch], workDir)
    }

    for (const [p, content] of snapshot) {
      const full = join(workDir, p)
      const dir = dirname(full)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(full, content)
    }
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

      const env = commitAuthorEnv()
      if (staged.stdout.trim() === '') {
        await git(['commit', '--allow-empty', '-m', message], workDir, env)
      } else {
        await git(['commit', '-m', message], workDir, env)
      }

      await git(['push', '-u', 'origin', `HEAD:${branch}`], workDir)
    },
  }
}
