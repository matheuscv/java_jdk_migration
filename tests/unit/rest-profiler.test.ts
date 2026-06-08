/**
 * Testes unitários para restProfiler
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { restProfiler } from '../../src/profilers/rest/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function makeConfig(overrides?: Partial<JdkMigrationConfig>): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['rest'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
    ...overrides,
  }
}

function makeTempProject(files: Record<string, string>): string {
  const dir = join(tmpdir(), `rest-prof-${randomBytes(4).toString('hex')}`)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }
  return dir
}

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('restProfiler — stackType', () => {
  it('stackType é rest', () => {
    expect(restProfiler.stackType).toBe('rest')
  })
})

describe('restProfiler — javax.servlet import', () => {
  it('detecta import javax.servlet com severity high e recipe automática', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Filter.java':
        'import javax.servlet.Filter;\npublic class Filter {}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'rest-javax-servlet')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
    expect(risk?.recipe).toContain('Jakarta')
  })

  it('não cria risco quando não há javax.servlet', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/App.java': 'public class App {}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'rest-javax-servlet')
    expect(risk).toBeUndefined()
  })
})

describe('restProfiler — JAX-RS', () => {
  it('detecta import javax.ws.rs', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Resource.java':
        'import javax.ws.rs.GET;\npublic class Resource {}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'rest-jaxrs')
    expect(risk).toBeDefined()
    expect(risk?.automationAvailable).toBe(true)
  })
})

describe('restProfiler — sun.misc.BASE64', () => {
  it('detecta sun.misc.BASE64Encoder com severity high', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Enc.java':
        'import sun.misc.BASE64Encoder;\npublic class Enc {\n  sun.misc.BASE64Encoder enc;\n}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'rest-sun-base64')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(true)
  })
})

describe('restProfiler — RestTemplate', () => {
  it('detecta uso de RestTemplate com severity low', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/Client.java':
        'public class Client {\n  RestTemplate restTemplate = new RestTemplate();\n}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'rest-template-deprecated')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('low')
  })
})

describe('restProfiler — stack com EJB', () => {
  it('cria risco rest-not-stateless quando stack inclui EJB', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/App.java': 'public class App {}',
    })
    const report = await restProfiler.analyze(dir, makeConfig({ stack: ['rest', 'ejb'] }))
    const risk = report.riskItems.find(r => r.id === 'rest-not-stateless')
    expect(risk).toBeDefined()
    expect(risk?.automationAvailable).toBe(false)
  })
})

describe('restProfiler — projeto limpo', () => {
  it('retorna zero riscos para projeto REST limpo', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/App.java':
        'import org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class App {}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    expect(report.riskItems).toHaveLength(0)
  })

  it('retorna report com estrutura correta', async () => {
    dir = makeTempProject({
      'src/main/java/com/example/App.java': 'public class App {}',
    })
    const report = await restProfiler.analyze(dir, makeConfig())
    expect(report).toHaveProperty('riskItems')
    expect(report).toHaveProperty('manualReviewItems')
    expect(Array.isArray(report.riskItems)).toBe(true)
  })
})
