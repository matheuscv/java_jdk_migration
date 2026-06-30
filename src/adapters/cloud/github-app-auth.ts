import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'

/**
 * Credenciais do GitHub App (produção — Cielo ou qualquer org corporativa).
 * Escopo mínimo: Contents R/W, Pull requests R/W, Issues R/W.
 */
export interface GitHubAppCredentials {
  appId: string | number
  privateKey: string
  installationId: string | number
}

/**
 * Cria Octokit autenticado como instalação de GitHub App.
 * Autenticação lazy — nenhuma chamada de rede nesta função.
 */
export function createGitHubAppOctokit(credentials: GitHubAppCredentials): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      installationId: credentials.installationId,
    },
  })
}

/**
 * Cria Octokit autenticado via Personal Access Token (PAT).
 * Usar apenas em ambiente de teste/POC pessoal.
 * Em produção corporativa, sempre preferir createGitHubAppOctokit.
 */
export function createGitHubPatOctokit(pat: string): Octokit {
  return new Octokit({ auth: pat })
}
