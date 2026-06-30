import { describe, it, expect } from 'vitest'
import { Octokit } from '@octokit/rest'
import { createGitHubAppOctokit } from '../../../src/adapters/cloud/github-app-auth.js'

describe('createGitHubAppOctokit', () => {
  it('retorna uma instância de Octokit sem fazer nenhuma chamada de rede', () => {
    const octokit = createGitHubAppOctokit({
      appId: '123456',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      installationId: '987654',
    })
    expect(octokit).toBeInstanceOf(Octokit)
  })

  it('aceita appId e installationId como número ou string', () => {
    expect(() => createGitHubAppOctokit({
      appId: 123456,
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      installationId: 987654,
    })).not.toThrow()
  })
})
