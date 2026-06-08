/**
 * Testes unitários para skill/install.ts
 * Cobre install(), ensureGitignoreEntries() e resolveSourceJdk (indiretamente)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { install, ensureGitignoreEntries } from '../../src/skill/install.js'

function tempDir(): string {
  const d = join(tmpdir(), `install-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function writePom(dir: string, content: string) {
  writeFileSync(join(dir, 'pom.xml'), content, 'utf-8')
}

const SIMPLE_POM = `
<project>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.0</version>
  <properties><java.version>1.8</java.version></properties>
</project>`

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── install() ────────────────────────────────────────────────────────────────

describe('install — projeto maven básico (JDK 8)', () => {
  it('detecta buildSystem=maven e sourceJdk=8', async () => {
    writePom(dir, SIMPLE_POM)
    const result = await install(dir)
    expect(result.config.buildSystem).toBe('maven')
    expect(result.config.sourceJdk).toBe('8')
    expect(result.config.targetJdk).toBe('21')
  })

  it('grava jdk-migration.config.json na raiz do projeto', async () => {
    writePom(dir, SIMPLE_POM)
    await install(dir)
    expect(existsSync(join(dir, 'jdk-migration.config.json'))).toBe(true)
    const config = JSON.parse(readFileSync(join(dir, 'jdk-migration.config.json'), 'utf-8'))
    expect(config.targetJdk).toBe('21')
  })

  it('cria diretório .jdk-migration/', async () => {
    writePom(dir, SIMPLE_POM)
    await install(dir)
    expect(existsSync(join(dir, '.jdk-migration'))).toBe(true)
  })

  it('retorna requiresHumanInput=false quando confiança é alta', async () => {
    writePom(dir, SIMPLE_POM)
    const result = await install(dir)
    // Confiança alta → não precisa de input humano
    expect(result.requiresHumanInput).toBe(false)
  })
})

describe('install — projeto JDK 6', () => {
  it('detecta sourceJdk=6 quando pom declara java 1.6', async () => {
    writePom(dir, `
<project>
  <properties><java.version>1.6</java.version></properties>
</project>`)
    const result = await install(dir)
    expect(result.config.sourceJdk).toBe('6')
  })
})

describe('install — sourceJdk override', () => {
  it('aceita override de sourceJdk', async () => {
    writePom(dir, SIMPLE_POM)
    const result = await install(dir, { sourceJdk: '6' })
    expect(result.config.sourceJdk).toBe('6')
  })

  it('aceita override de stack', async () => {
    writePom(dir, SIMPLE_POM)
    const result = await install(dir, { stack: ['ejb'] })
    expect(result.config.stack).toContain('ejb')
  })

  it('aceita override de reportMode', async () => {
    writePom(dir, SIMPLE_POM)
    const result = await install(dir, { reportMode: 'phase-gate-step' })
    expect(result.config.reportMode).toBe('phase-gate-step')
  })
})

describe('install — sem build system detectado', () => {
  it('lança MigrationError quando não há pom.xml, build.gradle, ou build.xml', async () => {
    // dir existe mas está vazio — sem build system
    await expect(install(dir)).rejects.toMatchObject({
      code: 'STACK_NOT_DETECTED',
    })
  })
})

describe('install — projeto gradle', () => {
  it('detecta buildSystem=gradle quando build.gradle existe', async () => {
    writeFileSync(join(dir, 'build.gradle'), `
plugins { id 'java' }
sourceCompatibility = JavaVersion.VERSION_1_8
`, 'utf-8')
    const result = await install(dir)
    expect(result.config.buildSystem).toBe('gradle')
  })
})

describe('install — sourceJdk não detectado (warnings)', () => {
  it('assume JDK 8 quando versão não está no pom e adiciona warning', async () => {
    writePom(dir, '<project><artifactId>app</artifactId></project>')
    const result = await install(dir)
    expect(result.config.sourceJdk).toBe('8')
    expect(result.warnings.some(w => w.includes('JDK 8'))).toBe(true)
  })
})

describe('install — JDK fora do escopo suportado', () => {
  it('trata JDK 11 como 8 com warning (fora do escopo)', async () => {
    writePom(dir, `
<project>
  <properties><java.version>11</java.version></properties>
</project>`)
    const result = await install(dir, { sourceJdk: '11' })
    // sourceJdk fora do escopo — warning emitido, mas install() não falha
    expect(result.warnings.some(w => w.includes('fora do escopo'))).toBe(true)
  })
})

// ─── ensureGitignoreEntries() ──────────────────────────────────────────────────

describe('ensureGitignoreEntries', () => {
  it('cria .gitignore quando não existe', () => {
    ensureGitignoreEntries(dir)
    expect(existsSync(join(dir, '.gitignore'))).toBe(true)
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('.jdk-migration/')
    expect(content).toContain('jdk-migration.config.json')
  })

  it('adiciona entradas ao .gitignore existente', () => {
    writeFileSync(join(dir, '.gitignore'), '*.class\n', 'utf-8')
    ensureGitignoreEntries(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('*.class')
    expect(content).toContain('.jdk-migration/')
  })

  it('não duplica entradas quando .gitignore já contém as linhas', () => {
    writeFileSync(join(dir, '.gitignore'), '.jdk-migration/\njdk-migration.config.json\n', 'utf-8')
    ensureGitignoreEntries(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8')
    // Conta ocorrências — não deve duplicar
    const count = (content.match(/\.jdk-migration\//g) ?? []).length
    expect(count).toBe(1)
  })

  it('funciona quando .gitignore existe mas não termina em newline', () => {
    writeFileSync(join(dir, '.gitignore'), '*.log', 'utf-8') // sem \n no fim
    ensureGitignoreEntries(dir)
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain('.jdk-migration/')
  })
})
