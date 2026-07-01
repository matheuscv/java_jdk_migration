import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from './process-runner.js'
import { MigrationError } from './errors.js'
import type { RepoUrlProvider, ResolvedProject } from '../ports/storage.js'

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
export function parseOwnerRepo(projectPath: string): { owner: string; repo: string } {
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
 * - Se for referência GitHub: constrói a URL autenticada para ESSE owner/repo
 *   específico via repoUrlProvider (suporta múltiplos repositórios simultâneos —
 *   cada chamada pode apontar para um repo diferente), clona em
 *   /tmp/workspaces/{owner}__{repo} e retorna o caminho local + a repoUrl usada
 *   (para reaproveitamento em storageFactory, sem precisar re-derivar credenciais).
 * - Se já for caminho de filesystem: retorna sem alteração, repoUrl null.
 *
 * O clone é idempotente — se o diretório já existe com um .git, faz apenas
 * `git pull --ff-only` para garantir que está atualizado.
 *
 * O diretório de trabalho é namespaced por "{owner}__{repo}" (não apenas "{repo}")
 * para evitar colisão entre repositórios de nome igual pertencentes a owners
 * diferentes quando várias migrações rodam em paralelo na mesma instância.
 *
 * userToken (opcional): PAT enviado pelo próprio usuário na chamada da tool
 * (multi-tenant) — repassado ao repoUrlProvider, que o usa no lugar da
 * credencial fixa do servidor quando presente. Nunca persistido em disco.
 */
export async function resolveProjectPath(
  projectPath: string,
  repoUrlProvider: RepoUrlProvider | null,
  workspacesDir = '/tmp/workspaces',
  userToken?: string,
): Promise<ResolvedProject> {
  if (!isGitHubRef(projectPath)) {
    return { path: projectPath, repoUrl: null }
  }

  if (!repoUrlProvider) {
    throw new MigrationError(
      'GITHUB_CREDENTIALS_MISSING',
      'projectPath parece uma referência GitHub mas nenhuma credencial foi configurada no servidor ' +
        'nem enviada na chamada da tool (githubToken). Configure GITHUB_PAT (ou GITHUB_APP_*) nas ' +
        'variáveis de ambiente do Render, ou informe githubToken diretamente na chamada.',
    )
  }

  const { owner, repo } = parseOwnerRepo(projectPath)
  const repoUrl = await repoUrlProvider(owner, repo, userToken)
  const workDir = join(workspacesDir, `${owner}__${repo}`)

  if (!existsSync(workspacesDir)) {
    mkdirSync(workspacesDir, { recursive: true })
  }

  if (existsSync(join(workDir, '.git'))) {
    // Já clonado — atualiza (e garante que o remote usa a credencial mais recente,
    // relevante para GitHub App cujo installation token expira em ~1h).
    await runProcess('git', ['remote', 'set-url', 'origin', repoUrl], { cwd: workDir, timeoutMs: 10_000 })
    const pull = await runProcess('git', ['pull', '--ff-only'], { cwd: workDir, timeoutMs: 60_000 })
    if (pull.exitCode !== 0) {
      // Se pull falhar (ex: divergência), reseta para o remote
      await runProcess('git', ['fetch', 'origin'], { cwd: workDir, timeoutMs: 60_000 })
      await runProcess('git', ['reset', '--hard', 'origin/HEAD'], { cwd: workDir, timeoutMs: 30_000 })
    }
    return { path: workDir, repoUrl }
  }

  // Clone inicial
  mkdirSync(workDir, { recursive: true })
  const clone = await runProcess(
    'git',
    ['clone', '--depth', '50', repoUrl, '.'],
    { cwd: workDir, timeoutMs: 180_000 },
  )

  if (clone.exitCode !== 0) {
    throw new MigrationError(
      'GITHUB_CLONE_FAILED',
      `Não foi possível clonar o repositório "${projectPath}": ${clone.stderr.trim()}`,
      { stderr: clone.stderr },
    )
  }

  return { path: workDir, repoUrl }
}
