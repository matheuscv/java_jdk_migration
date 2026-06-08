/**
 * Testes unitários para mcp-server/tools/check-dependencies.ts
 * Cobre: CONFIG_NOT_FOUND, REGISTRY_NOT_CONFIGURED, NO_GROUP_IDS,
 *        no internal deps, nexus3 success, artifactory success, fetch error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerCheckDependencies } from '../../src/mcp-server/tools/check-dependencies.js'
import { createDefaultPhases } from '../../src/lib/config.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  const d = join(tmpdir(), `check-deps-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

type ToolHandler = (args: { projectPath: string }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

function createMockServer(): { server: McpServer; getHandler: () => ToolHandler } {
  let captured: ToolHandler | null = null
  const server = {
    tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      captured = handler
    }),
  } as unknown as McpServer
  return {
    server,
    getHandler: () => {
      if (!captured) throw new Error('tool() was not called — handler not registered')
      return captured
    },
  }
}

function writeConfig(dir: string, extra: object = {}) {
  const config = {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
    ...extra,
  }
  writeFileSync(join(dir, 'jdk-migration.config.json'), JSON.stringify(config, null, 2), 'utf-8')
}

function writePom(dir: string, content: string) {
  writeFileSync(join(dir, 'pom.xml'), content, 'utf-8')
}

const INTERNAL_POM = `<project>
  <dependencies>
    <dependency>
      <groupId>com.mycompany.platform</groupId>
      <artifactId>core-utils</artifactId>
      <version>2.1.0</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter</artifactId>
      <version>2.7.0</version>
    </dependency>
  </dependencies>
</project>`

let dir: string
beforeEach(() => {
  dir = tempDir()
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

// ─── CONFIG_NOT_FOUND ─────────────────────────────────────────────────────────

describe('check_internal_dependencies — CONFIG_NOT_FOUND', () => {
  it('retorna isError quando config não existe', async () => {
    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const handler = getHandler()
    // dir não tem jdk-migration.config.json
    const result = await handler({ projectPath: dir })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBe('CONFIG_NOT_FOUND')
  })
})

// ─── REGISTRY_NOT_CONFIGURED ─────────────────────────────────────────────────

describe('check_internal_dependencies — REGISTRY_NOT_CONFIGURED', () => {
  it('retorna erro quando artifactRegistry não está no config', async () => {
    writeConfig(dir) // sem artifactRegistry
    writePom(dir, '<project/>')
    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBe('REGISTRY_NOT_CONFIGURED')
  })

  it('retorna erro quando type é "none"', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'none', url: 'https://nexus.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, '<project/>')
    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBe('REGISTRY_NOT_CONFIGURED')
  })

  it('retorna erro quando url está ausente', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'nexus3', url: '', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, '<project/>')
    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBe('REGISTRY_NOT_CONFIGURED')
  })
})

// ─── NO_GROUP_IDS ─────────────────────────────────────────────────────────────

describe('check_internal_dependencies — NO_GROUP_IDS', () => {
  it('retorna erro quando internalGroupIds está vazio', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'nexus3', url: 'https://nexus.example.com', internalGroupIds: [] },
    })
    writePom(dir, '<project/>')
    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error).toBe('NO_GROUP_IDS')
  })
})

// ─── No internal deps found ───────────────────────────────────────────────────

describe('check_internal_dependencies — sem deps internas no pom', () => {
  it('retorna mensagem sem chamar fetch quando pom não tem deps internas', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'nexus3',
        url: 'https://nexus.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    // pom só tem deps de terceiros
    writePom(dir, `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>5.3.0</version>
    </dependency>
  </dependencies>
</project>`)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies).toHaveLength(0)
    expect(parsed.summary.total).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── Nexus3 success ───────────────────────────────────────────────────────────

describe('check_internal_dependencies — nexus3 query com versões', () => {
  it('retorna resultado com deps e summary corretos', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'nexus3',
        url: 'https://nexus.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, INTERNAL_POM)

    const nexusResponse = {
      items: [
        {
          version: '3.0.0',
          assets: [{ lastModified: '2023-05-15T10:00:00.000Z' }], // after SB3 GA
        },
        {
          version: '2.1.0',
          assets: [{ lastModified: '2022-01-10T10:00:00.000Z' }], // before SB3 GA
        },
      ],
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => nexusResponse,
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.registryType).toBe('nexus3')
    expect(parsed.dependencies).toHaveLength(1)
    expect(parsed.dependencies[0].artifactId).toBe('core-utils')
    expect(parsed.dependencies[0].likelySb3Compatible).toBe(true)
    expect(parsed.summary.total).toBe(1)
    expect(parsed.summary.likelySb3Compatible).toBe(1)
  })

  it('retorna likelySb3Compatible=false quando nenhuma versão pós SB3 GA', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'nexus3',
        url: 'https://nexus.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, INTERNAL_POM)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { version: '2.0.0', assets: [{ lastModified: '2021-06-01T00:00:00.000Z' }] },
        ],
      }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies[0].likelySb3Compatible).toBe(false)
    expect(parsed.summary.noCompatibleVersionFound).toBe(1)
  })

  it('retorna checkFailed quando registry retorna lista vazia', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'nexus3',
        url: 'https://nexus.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, INTERNAL_POM)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.summary.checkFailed).toBe(1)
  })

  it('retorna resultado mesmo quando Nexus retorna HTTP 4xx (catch block)', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'nexus3',
        url: 'https://nexus.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, INTERNAL_POM)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies[0].recommendation).toContain('Falha ao consultar registry')
  })
})

// ─── Artifactory success ──────────────────────────────────────────────────────

describe('check_internal_dependencies — artifactory query', () => {
  it('parseia URIs do Artifactory e retorna versões', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'artifactory',
        url: 'https://artifactory.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, INTERNAL_POM)

    const artifactoryResponse = {
      results: [
        {
          uri: 'https://artifactory.example.com/artifactory/libs-release/com/mycompany/platform/core-utils/3.1.0/core-utils-3.1.0.jar',
          created: '2023-08-10T12:00:00.000Z',
        },
        {
          uri: 'https://artifactory.example.com/artifactory/libs-release/com/mycompany/platform/core-utils/2.1.0/core-utils-2.1.0.jar',
          created: '2021-11-01T12:00:00.000Z',
        },
      ],
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => artifactoryResponse,
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })

    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.registryType).toBe('artifactory')
    expect(parsed.dependencies[0].likelySb3Compatible).toBe(true)
    expect(parsed.dependencies[0].availableVersions.some((v: { version: string }) => v.version === '3.1.0')).toBe(true)
  })

  it('retorna catch block quando Artifactory lança erro de rede', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'artifactory',
        url: 'https://artifactory.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, INTERNAL_POM)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies[0].recommendation).toContain('ECONNREFUSED')
  })
})

// ─── dependencyManagement block ───────────────────────────────────────────────

describe('check_internal_dependencies — deps em <dependencyManagement>', () => {
  it('detecta deps internas em bloco dependencyManagement', async () => {
    writeConfig(dir, {
      artifactRegistry: {
        type: 'nexus3',
        url: 'https://nexus.example.com',
        internalGroupIds: ['com.mycompany'],
      },
    })
    writePom(dir, `<project>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.mycompany.platform</groupId>
        <artifactId>bom-utils</artifactId>
        <version>1.5.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies/>
</project>`)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ version: '2.0.0', assets: [{ lastModified: '2023-01-01T00:00:00.000Z' }] }] }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies.some((d: { artifactId: string }) => d.artifactId === 'bom-utils')).toBe(true)
  })
})

// ─── Nexus3: assets undefined (null lastModified) ───────────────────────────

describe('check_internal_dependencies — nexus3 items sem assets', () => {
  it('retorna likelySb3Compatible=false quando assets é undefined (null lastModified)', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'nexus3', url: 'https://nexus.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, INTERNAL_POM)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { version: '2.0.0' },  // sem assets → lastModified=null → likelySb3Compatible=false
        ],
      }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies[0].availableVersions[0].publishedAt).toBeNull()
    expect(parsed.dependencies[0].availableVersions[0].likelySb3Compatible).toBe(false)
  })

  it('retorna likelySb3Compatible=false quando assets[0] é undefined', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'nexus3', url: 'https://nexus.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, INTERNAL_POM)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { version: '2.0.0', assets: [] },  // assets vazio → assets[0]=undefined → null
        ],
      }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies[0].availableVersions[0].publishedAt).toBeNull()
  })
})

// ─── Deduplicação: mesma dep em <dependencies> e <dependencyManagement> ─────

describe('check_internal_dependencies — deduplicação de deps', () => {
  it('não duplica quando mesma dep aparece em <dependencies> e <dependencyManagement>', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'nexus3', url: 'https://nexus.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, `<project>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.mycompany.platform</groupId>
        <artifactId>core-utils</artifactId>
        <version>2.1.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.mycompany.platform</groupId>
      <artifactId>core-utils</artifactId>
      <version>2.1.0</version>
    </dependency>
  </dependencies>
</project>`)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    // Só deve aparecer uma vez
    const coreUtils = parsed.dependencies.filter((d: { artifactId: string }) => d.artifactId === 'core-utils')
    expect(coreUtils).toHaveLength(1)
  })
})

// ─── Pom com versão ${...} (deve ser pulada) ─────────────────────────────────

describe('check_internal_dependencies — versão com ${} é ignorada', () => {
  it('ignora deps cujo version começa com ${', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'nexus3', url: 'https://nexus.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, `<project>
  <dependencies>
    <dependency>
      <groupId>com.mycompany.platform</groupId>
      <artifactId>core-utils</artifactId>
      <version>\${core.version}</version>
    </dependency>
  </dependencies>
</project>`)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    // Versão com ${} deve ser pulada → 0 deps
    expect(parsed.dependencies).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── Artifactory: versão duplicada com created mais recente ──────────────────

describe('check_internal_dependencies — artifactory versão duplicada', () => {
  it('mantém apenas o created mais recente para versão duplicada', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'artifactory', url: 'https://art.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, INTERNAL_POM)

    // Mesmo version (3.0.0) com 2 URIs — deve manter o created mais recente
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            uri: 'https://art.example.com/artifactory/libs/com/mycompany/platform/core-utils/3.0.0/core-utils-3.0.0.jar',
            created: '2023-01-01T00:00:00.000Z',
          },
          {
            uri: 'https://art.example.com/artifactory/libs/com/mycompany/platform/core-utils/3.0.0/core-utils-3.0.0-sources.jar',
            created: '2023-06-15T00:00:00.000Z',  // mais recente
          },
        ],
      }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    const parsed = JSON.parse(result.content[0].text)
    // Deve ter apenas uma entrada para versão 3.0.0
    const v300 = parsed.dependencies[0].availableVersions.filter((v: { version: string }) => v.version === '3.0.0')
    expect(v300).toHaveLength(1)
  })

  it('lida com URI sem versão (sem versionMatch)', async () => {
    writeConfig(dir, {
      artifactRegistry: { type: 'artifactory', url: 'https://art.example.com', internalGroupIds: ['com.mycompany'] },
    })
    writePom(dir, INTERNAL_POM)

    // URI sem o padrão /artifactId/version/
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { uri: 'https://art.example.com/artifactory/metadata.xml', created: '2023-01-01T00:00:00.000Z' },
        ],
      }),
    }))

    const { server, getHandler } = createMockServer()
    registerCheckDependencies(server)
    const result = await getHandler()({ projectPath: dir })
    // Não deve lançar exceção — resultado com 0 versions
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.dependencies[0].availableVersions).toHaveLength(0)
  })
})
