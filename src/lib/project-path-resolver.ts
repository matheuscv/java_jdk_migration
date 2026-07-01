import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from './process-runner.js'
import { MigrationError } from './errors.js'

/**
 * Detecta se o projectPath é uma referência GitHub (owner/repo ou URL completa)
 * em vez de um caminho de filesystem local.
 *
 * Aceita:
 *   "matheuscv/projeto-teste-migracao-jdk8"
 *   "https://github.com/matheuscv/projeto-teste-migracao-jdk8"
 *   "https://github.com/matheuscv/projeto-teste-migracao-jdk8.git"
 */
export function isGitHubRef(projectPath: string): boolean {
  if (projectPath.startsWith('https://github.com/')) return true
  if (projectPath.startsWith('http://github.com/')) return true
  // owner/repo — exatamente um slash, sem espaços, sem separadores de path
  const ownerRepo = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(projectPath)
  return ownerRepo
}

/**
 * Extrai "owner/repo" de qualquer forma de referência GitHub.
 */
function parseOwnerRepo(projectPath: string): { owner: string; repo: string } {
  let path = projectPath.replace(/\.git$/, '')
  if (path.startsWith('https://github.com/') || path.startsWith('http://github.com/')) {
    path = path.replace(/^https?:\/\/github\.com\//, '')
  }
  const [owner, repo] = path.split('/')
  if (!owner || !repo) {
    throw new MigrationError(
      'INVALID_GITHUB_REF',
      `Referência GitHub inválida: "${projectPath}". Use "owner/repo" ou a URL completa do GitHub.`,
    )
  }
  return { owner, repo }
}

/**
 * Resolve um projectPath que pode ser referência GitHub ou caminho local.
 *
 * - Se for referência GitHub: clona o repo em /tmp/workspaces/{repo} usando a
 *   repoUrl autenticada (com PAT ou token de App) e retorna o caminho local.
 * - Se já for caminho de filesystem: retorna sem alteração.
 *
 * O clone é idempotente — se o diretório já existe com um .git, faz apenas
 * `git pull --ff-only` para garantir que está atualizado.
 */
export async function resolveProjectPath(
  projectPath: string,
  authenticatedRepoUrl: string | null,
  workspacesDir = '/tmp/workspaces',
): Promise<string> {
  if (!isGitHubRef(projectPath)) {
    return projectPath
  }

  if (!authenticatedRepoUrl) {
    throw new MigrationError(
      'GITHUB_CREDENTIALS_MISSING',
      'projectPath parece uma referência GitHub mas nenhuma credencial foi configurada no servidor. ' +
        'Configure GITHUB_PAT (ou GITHUB_APP_*) nas variáveis de ambiente do Render.',
    )
  }

  const { repo } = parseOwnerRepo(projectPath)
  const workDir = join(workspacesDir, repo)

  if (!existsSync(workspacesDir)) {
    mkdirSync(workspacesDir, { recursive: true })
  }

  if (existsSync(join(workDir, '.git'))) {
    // Já clonado — atualiza
    const pull = await runProcess('git', ['pull', '--ff-only'], { cwd: workDir, timeoutMs: 60_000 })
    if (pull.exitCode !== 0) {
      // Se pull falhar (ex: divergência), reseta para o remote
      await runProcess('git', ['fetch', 'origin'], { cwd: workDir, timeoutMs: 60_000 })
      await runProcess('git', ['reset', '--hard', 'origin/HEAD'], { cwd: workDir, timeoutMs: 30_000 })
    }
    return workDir
  }

  // Clone inicial
  mkdirSync(workDir, { recursive: true })
  const clone = await runProcess(
    'git',
    ['clone', '--depth', '50', authenticatedRepoUrl, '.'],
    { cwd: workDir, timeoutMs: 180_000 },
  )

  if (clone.exitCode !== 0) {
    throw new MigrationError(
      'GITHUB_CLONE_FAILED',
      `Não foi possível clonar o repositório "${projectPath}": ${clone.stderr.trim()}`,
      { stderr: clone.stderr },
    )
  }

  return workDir
}
