import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createGitWorkspaceStorage } from '../../../src/adapters/cloud/git-workspace-storage.js'

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

/**
 * Cria um repositório "remoto" bare local (simula o GitHub para os testes,
 * sem depender de rede nem credenciais) com um commit inicial na branch main.
 */
function setupBareRemote(): string {
  const bareDir = makeTmpDir('jdk-migration-bare')
  git(['init', '--bare', '--initial-branch=main', bareDir], tmpdir())

  const seedDir = makeTmpDir('jdk-migration-seed')
  git(['init', '--initial-branch=main', seedDir], tmpdir())
  git(['config', 'user.email', 'test@example.com'], seedDir)
  git(['config', 'user.name', 'Test'], seedDir)
  writeFileSync(join(seedDir, 'README.md'), '# seed\n', 'utf-8')
  git(['add', '-A'], seedDir)
  git(['commit', '-m', 'initial commit'], seedDir)
  git(['remote', 'add', 'origin', bareDir], seedDir)
  git(['push', 'origin', 'main'], seedDir)
  rmSync(seedDir, { recursive: true, force: true })

  return bareDir
}

/** Clona o bare remote num diretório novo só para inspecionar estado (fora do adapter). */
function inspectClone(bareDir: string): string {
  const dir = makeTmpDir('jdk-migration-inspect')
  git(['clone', bareDir, '.'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  return dir
}

describe('GitWorkspaceStorage — durabilidade do estado na branch', () => {
  let bareDir: string
  const cleanupDirs: string[] = []

  beforeEach(() => {
    bareDir = setupBareRemote()
    cleanupDirs.length = 0
  })

  afterEach(() => {
    rmSync(bareDir, { recursive: true, force: true })
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('write + commitState persiste o estado na branch, e um novo clone (cold start) o restaura', async () => {
    const branch = 'jdk-migration/phase-0-test'
    const workDirA = makeTmpDir('jdk-migration-workA')
    cleanupDirs.push(workDirA)

    const storageA = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir: workDirA })
    await storageA.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    await storageA.commitState('chore(jdk-migration): state checkpoint')

    // Simula restart do container: novo workDir, nova instância, mesmo repoUrl+branch.
    const workDirB = makeTmpDir('jdk-migration-workB')
    cleanupDirs.push(workDirB)
    const storageB = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir: workDirB })

    expect(await storageB.read('jdk-migration.config.json')).toBe('{"sourceJdk":"8"}')
  })

  it('cria a branch de trabalho no remoto quando ela ainda não existe (primeira execução da fase)', async () => {
    const branch = 'jdk-migration/phase-1-nova-branch'
    const workDir = makeTmpDir('jdk-migration-newbranch')
    cleanupDirs.push(workDir)

    const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    await storage.commitState('chore(jdk-migration): cria branch de fase')

    // refs/remotes/origin/* local não se auto-atualiza após push em clone
    // single-branch (peculiaridade do git, não do adapter) — a verificação
    // correta é perguntar ao remoto diretamente, que é o que o GitHub real veria.
    const remoteRefs = git(['ls-remote', '--heads', bareDir], workDir)
    expect(remoteRefs).toContain(`refs/heads/${branch}`)
  })

  it('segundo write() sobrescreve o conteúdo anterior após commit', async () => {
    const branch = 'jdk-migration/phase-2-overwrite'
    const workDir = makeTmpDir('jdk-migration-overwrite')
    cleanupDirs.push(workDir)

    const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    await storage.commitState('chore: v1')
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"6"}')
    await storage.commitState('chore: v2')

    expect(await storage.read('jdk-migration.config.json')).toBe('{"sourceJdk":"6"}')
  })

  it(
    'REGRESSÃO: reaproveita um workDir já clonado por outro consumidor no branch ' +
    'padrão (ex: ProjectPathResolver) sem non-fast-forward, mesmo quando a branch ' +
    'de trabalho já tem histórico divergente no remoto',
    async () => {
      const branch = 'jdk-migration/discovery'
      const workDir = makeTmpDir('jdk-migration-shared-workdir')
      cleanupDirs.push(workDir)

      // 1. Simula uma execução anterior que já publicou algo na branch de trabalho,
      //    divergindo do histórico de "main" (cenário real: discover_project rodou
      //    antes, ou o storage foi usado num teste anterior).
      const priorRunDir = makeTmpDir('jdk-migration-prior-run')
      cleanupDirs.push(priorRunDir)
      const priorStorage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir: priorRunDir })
      await priorStorage.write('jdk-migration.config.json', '{"sourceJdk":"8","run":"anterior"}')
      await priorStorage.commitState('chore: execução anterior')

      // 2. Simula o ProjectPathResolver: clona o branch PADRÃO (main) no MESMO
      //    workDir que o storageFactory vai receber depois — reproduzindo
      //    exatamente o compartilhamento de workDir entre discover_project
      //    (análise, branch main) e o storage (persistência, branch de trabalho).
      //    --single-branch reproduz a propriedade real do clone raso de
      //    project-path-resolver.ts (--depth 50 implica --single-branch em
      //    clones de rede — usamos a flag explícita aqui porque git ignora
      //    --depth para clones locais/file://, o que mascararia o bug): o
      //    refspec de fetch fica restrito a "main" — nenhuma ref
      //    origin/<outra-branch> é criada automaticamente, nem mesmo depois
      //    de um fetch explícito daquela branch.
      git(['clone', '--single-branch', bareDir, '.'], workDir)
      git(['config', 'user.email', 'test@example.com'], workDir)
      git(['config', 'user.name', 'Test'], workDir)

      // 3. Simula discoverProject() escrevendo o relatório em disco ENQUANTO
      //    ainda está no branch main (untracked ali, pois main não o rastreia).
      mkdirSync(join(workDir, '.jdk-migration'), { recursive: true })
      writeFileSync(
        join(workDir, '.jdk-migration', 'discovery-report.json'),
        '{"stacks":["spring-boot"],"run":"nova"}',
        'utf-8',
      )

      // 4. storageFactory entra em cena reaproveitando o MESMO workDir (não um
      //    clone novo) — antes do fix, isso commitava em cima do HEAD de main e
      //    o push para `branch` falhava com "non-fast-forward" (divergência com
      //    o histórico já existente no remoto, criado no passo 1).
      const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
      await expect(storage.commitState('chore: nova execução (workDir compartilhado)')).resolves.not.toThrow()

      // 5. A branch de trabalho no remoto deve conter o conteúdo NOVO (a versão
      //    mais recente sempre vence), preservando o arquivo que foi escrito
      //    enquanto o workDir ainda estava no branch main.
      const inspect = inspectClone(bareDir)
      cleanupDirs.push(inspect)
      git(['checkout', branch], inspect)
      const reportContent = readFileSync(
        join(inspect, '.jdk-migration', 'discovery-report.json'),
        'utf-8',
      )
      expect(reportContent).toContain('"run":"nova"')

      // O histórico da branch de trabalho preserva o commit anterior (prova de
      // que o fix fez fetch+checkout da branch existente, não recriou do zero).
      const log = git(['log', '--oneline'], inspect)
      expect(log).toContain('execução anterior')
      expect(log).toContain('workDir compartilhado')
    },
  )

  it(
    'REGRESSÃO: ignora artefatos de build não relacionados (ex: target/*.class do ' +
    'sourceBuild) presentes no workDir na hora de trocar de branch',
    async () => {
      const branch = 'jdk-migration/discovery'
      const workDir = makeTmpDir('jdk-migration-build-artifacts')
      cleanupDirs.push(workDir)

      // Branch de trabalho já existe no remoto (mesmo setup do teste anterior).
      const priorRunDir = makeTmpDir('jdk-migration-prior-run-2')
      cleanupDirs.push(priorRunDir)
      const priorStorage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir: priorRunDir })
      await priorStorage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
      await priorStorage.commitState('chore: execução anterior')

      // Simula ProjectPathResolver clonando main (--single-branch reproduz a
      // restrição real de refspec do clone raso de produção; git ignora --depth
      // em clones locais/file://) + discoverProject rodando o sourceBuild (mvn
      // compile), que gera MUITOS arquivos de build não relacionados ao estado
      // do jdk-migration (ex: .class compilados).
      git(['clone', '--single-branch', bareDir, '.'], workDir)
      git(['config', 'user.email', 'test@example.com'], workDir)
      git(['config', 'user.name', 'Test'], workDir)

      mkdirSync(join(workDir, 'target', 'classes', 'com', 'example'), { recursive: true })
      writeFileSync(join(workDir, 'target', 'classes', 'com', 'example', 'Foo.class'), Buffer.from([0xca, 0xfe]))
      mkdirSync(join(workDir, '.jdk-migration'), { recursive: true })
      writeFileSync(
        join(workDir, '.jdk-migration', 'discovery-report.json'),
        '{"stacks":["spring-boot"]}',
        'utf-8',
      )

      const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
      await expect(storage.commitState('chore: nova execução com build artifacts')).resolves.not.toThrow()

      // O artefato de build nunca deveria ter sido commitado — não é estado do
      // jdk-migration, é subproduto regenerável da análise.
      const tracked = git(['ls-files', 'target'], workDir)
      expect(tracked.trim()).toBe('')

      // Mas o relatório de descoberta, sim, foi persistido normalmente.
      const inspect = inspectClone(bareDir)
      cleanupDirs.push(inspect)
      git(['checkout', branch], inspect)
      expect(existsSync(join(inspect, '.jdk-migration', 'discovery-report.json'))).toBe(true)
    },
  )

  it('escreve em path aninhado que ainda não existe (.jdk-migration/discovery-report.json)', async () => {
    const branch = 'jdk-migration/phase-0-nested'
    const workDir = makeTmpDir('jdk-migration-nested')
    cleanupDirs.push(workDir)

    const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
    await storage.write('.jdk-migration/discovery-report.json', '{"stacks":["spring-boot"]}')
    await storage.commitState('chore: discovery')

    const inspect = inspectClone(bareDir)
    cleanupDirs.push(inspect)
    git(['checkout', branch], inspect)
    expect(existsSync(join(inspect, '.jdk-migration', 'discovery-report.json'))).toBe(true)
  })
})

describe('GitWorkspaceStorage — R1: PIN store nunca é commitado (segurança crítica)', () => {
  let bareDir: string
  const cleanupDirs: string[] = []

  beforeEach(() => {
    bareDir = setupBareRemote()
    cleanupDirs.length = 0
  })

  afterEach(() => {
    rmSync(bareDir, { recursive: true, force: true })
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('write() grava o PIN store em disco, mas commitState() nunca o inclui no commit', async () => {
    const branch = 'jdk-migration/phase-4-security'
    const workDir = makeTmpDir('jdk-migration-security')
    cleanupDirs.push(workDir)

    const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
    await storage.write('jdk-migration.config.json', '{"sourceJdk":"8"}')
    await storage.write('.jdk-migration/.gate-pins.json', '{"4":{"pin":"847291"}}')
    await storage.commitState('chore: fase 4 pronta para gate')

    // O arquivo existe fisicamente no workspace (necessário para o fluxo local funcionar)...
    expect(existsSync(join(workDir, '.jdk-migration', '.gate-pins.json'))).toBe(true)

    // ...mas nunca foi commitado: git não o rastreia.
    const status = git(['status', '--porcelain', '--', '.jdk-migration/.gate-pins.json'], workDir)
    expect(status.trim()).not.toBe('')
    expect(status).toMatch(/^\?\?/) // untracked

    const tracked = git(['ls-files', '.jdk-migration/.gate-pins.json'], workDir)
    expect(tracked.trim()).toBe('')
  })

  it('nenhum commit no histórico da branch jamais referencia o PIN store', async () => {
    const branch = 'jdk-migration/phase-4-history'
    const workDir = makeTmpDir('jdk-migration-history')
    cleanupDirs.push(workDir)

    const storage = createGitWorkspaceStorage({ repoUrl: bareDir, branch, workDir })
    await storage.write('.jdk-migration/.gate-pins.json', '{"4":{"pin":"111111"}}')
    await storage.commitState('chore: tentativa 1')
    await storage.write('.jdk-migration/.gate-pins.json', '{"4":{"pin":"222222"}}') // PIN rotacionado
    await storage.commitState('chore: tentativa 2')

    const fullLog = git(['log', '--all', '--name-only', '--pretty=format:'], workDir)
    expect(fullLog).not.toContain('.gate-pins.json')

    // Uma Squad clonando a branch via GitHub API jamais veria o arquivo no histórico.
    const inspect = inspectClone(bareDir)
    cleanupDirs.push(inspect)
    git(['checkout', branch], inspect)
    expect(existsSync(join(inspect, '.jdk-migration', '.gate-pins.json'))).toBe(false)
  })

  it('um path extra de exclusão (extraExcludedPaths) também nunca é commitado', async () => {
    const branch = 'jdk-migration/phase-4-extra-exclusion'
    const workDir = makeTmpDir('jdk-migration-extra-exclusion')
    cleanupDirs.push(workDir)

    const storage = createGitWorkspaceStorage({
      repoUrl: bareDir,
      branch,
      workDir,
      extraExcludedPaths: ['.jdk-migration/segredo-extra.json'],
    })
    await storage.write('.jdk-migration/segredo-extra.json', '{"x":1}')
    await storage.commitState('chore: segredo extra')

    const tracked = git(['ls-files', '.jdk-migration/segredo-extra.json'], workDir)
    expect(tracked.trim()).toBe('')
  })
})
