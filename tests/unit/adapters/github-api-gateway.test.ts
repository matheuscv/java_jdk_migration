import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Octokit } from '@octokit/rest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createGitHubApiGateway } from '../../../src/adapters/cloud/github-api-gateway.js'
import { MigrationError } from '../../../src/lib/errors.js'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function makeLocalRepo(): string {
  const dir = join(tmpdir(), `jdk-migration-ghapi-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  git(['init', '--initial-branch=main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'README.md'), '# seed\n', 'utf-8')
  git(['add', '-A'], dir)
  git(['commit', '-m', 'initial commit'], dir)
  return dir
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeOctokit(): Octokit {
  return new Octokit({ auth: 'fake-token-for-tests' })
}

describe('GitHubApiGateway — createPhaseBranch', () => {
  let repoDir: string

  beforeEach(() => { repoDir = makeLocalRepo() })
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('cria a branch via GitHub API (POST /git/refs) e faz checkout local', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u.includes('/git/refs') && init?.method === 'POST') {
        return jsonResponse({ ref: 'refs/heads/jdk-migration/phase-1-x', object: { sha: 'abc123' } }, 201)
      }
      throw new Error(`unexpected fetch call: ${init?.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    const checkpoint = await gateway.createPhaseBranch(repoDir, 1)

    expect(checkpoint.baseBranch).toBe('main')
    expect(checkpoint.branchName).toMatch(/^jdk-migration\/phase-1-\d{14}$/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const currentLocalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
    expect(currentLocalBranch).toBe(checkpoint.branchName)
  })

  it('é idempotente: branch já existente no GitHub (422) não falha a operação', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { message: 'Reference already exists' }, 422,
    )))

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    const checkpoint = await gateway.createPhaseBranch(repoDir, 2)
    expect(checkpoint.branchName).toMatch(/^jdk-migration\/phase-2-\d{14}$/)
  })

  it('propaga falha real da API (não 422) como MigrationError GIT_WORKSPACE_INIT_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Internal Server Error' }, 500)))

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    await expect(gateway.createPhaseBranch(repoDir, 3)).rejects.toMatchObject({
      code: 'GIT_WORKSPACE_INIT_FAILED',
    })
  })

  it('rejeita com GIT_DIRTY_WORKDIR quando há alterações não commitadas, sem chamar a API', async () => {
    writeFileSync(join(repoDir, 'novo-arquivo.txt'), 'sujo', 'utf-8')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    await expect(gateway.createPhaseBranch(repoDir, 1)).rejects.toBeInstanceOf(MigrationError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GitHubApiGateway — rollbackPhase (preserva branch remota para auditoria)', () => {
  let repoDir: string

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('retorna o workdir local para a branch base sem chamar a API', async () => {
    repoDir = makeLocalRepo()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    git(['checkout', '-b', 'jdk-migration/phase-1-fake'], repoDir)
    writeFileSync(join(repoDir, 'mudanca.txt'), 'x', 'utf-8')
    git(['add', '-A'], repoDir)
    git(['commit', '-m', 'mudanca da fase'], repoDir)

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    await gateway.rollbackPhase(repoDir, {
      branchName: 'jdk-migration/phase-1-fake',
      baseBranch: 'main',
      baseCommit: 'irrelevant',
      phaseCommit: null,
    })

    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).toBe('main')
    // Branch de fase ainda existe localmente (não foi deletada) — preserva auditoria.
    const branches = git(['branch', '--list', 'jdk-migration/phase-1-fake'], repoDir)
    expect(branches).toContain('jdk-migration/phase-1-fake')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GitHubApiGateway — createPullRequest', () => {
  let repoDir: string

  beforeEach(() => { repoDir = makeLocalRepo() })
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  const checkpoint = {
    branchName: 'jdk-migration/phase-3-20260630120000',
    baseBranch: 'main',
    baseCommit: 'deadbeef',
    phaseCommit: 'cafebabe',
  }

  it('cria um Draft PR via API e retorna a URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u.includes('/pulls') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string)
        expect(body.draft).toBe(true)
        expect(body.head).toBe(checkpoint.branchName)
        expect(body.base).toBe(checkpoint.baseBranch)
        return jsonResponse({ html_url: 'https://github.com/acme/billing-service/pull/42' }, 201)
      }
      throw new Error(`unexpected fetch call: ${init?.method} ${u}`)
    }))

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    const url = await gateway.createPullRequest(repoDir, 3, checkpoint, 'Resumo da fase 3')
    expect(url).toBe('https://github.com/acme/billing-service/pull/42')
  })

  it('quando o PR já existe (422), busca e retorna a URL da PR existente', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u.includes('/pulls') && init?.method === 'POST') {
        return jsonResponse({ message: 'A pull request already exists' }, 422)
      }
      if (u.includes('/pulls') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse([{ html_url: 'https://github.com/acme/billing-service/pull/41' }], 200)
      }
      throw new Error(`unexpected fetch call: ${init?.method} ${u}`)
    }))

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    const url = await gateway.createPullRequest(repoDir, 3, checkpoint, 'Resumo')
    expect(url).toBe('https://github.com/acme/billing-service/pull/41')
  })

  it('quando a API falha de forma não recuperável, retorna null sem lançar exceção', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Service Unavailable' }, 503)))

    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })
    const url = await gateway.createPullRequest(repoDir, 3, checkpoint, 'Resumo')
    expect(url).toBeNull()
  })
})

describe('GitHubApiGateway — operações locais delegadas (sem chamada de API)', () => {
  let repoDir: string

  beforeEach(() => { repoDir = makeLocalRepo() })
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('isWorkdirClean reflete o estado real do clone local', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })

    expect(await gateway.isWorkdirClean(repoDir)).toBe(true)
    writeFileSync(join(repoDir, 'sujo.txt'), 'x', 'utf-8')
    expect(await gateway.isWorkdirClean(repoDir)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('commitPhaseChanges cria um commit local sem chamar a API (push é responsabilidade do Storage)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createGitHubApiGateway({ owner: 'acme', repo: 'billing-service', octokit: makeOctokit() })

    writeFileSync(join(repoDir, 'novo.txt'), 'conteudo', 'utf-8')
    const sha = await gateway.commitPhaseChanges(repoDir, 1, 'fase 1 concluida')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
