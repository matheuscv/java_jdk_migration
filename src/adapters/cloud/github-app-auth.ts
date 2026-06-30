import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'

/**
 * Credenciais do GitHub App (ver plano de migração, fase M3): App com escopo
 * mínimo — Contents: Read & write, Pull requests: Read & write, Issues: Read & write.
 */
export interface GitHubAppCredentials {
  appId: string | number
  privateKey: string
  installationId: string | number
}

/**
 * Cria um cliente Octokit autenticado como instalação de GitHub App.
 * A autenticação é resolvida sob demanda (lazy) na primeira requisição —
 * esta função não faz nenhuma chamada de rede.
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
