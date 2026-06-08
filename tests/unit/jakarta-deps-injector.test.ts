/**
 * Testes unitários para jakarta-deps-injector.ts (E2.3)
 * Cobre detecção de imports javax.xml.ws/soap/jws/activation e injeção no pom.xml
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runJakartaDepsInjector } from '../../src/transform-engine/jakarta-deps-injector.js'

function tempDir(): string {
  const d = join(tmpdir(), `jakarta-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function write(base: string, rel: string, content: string): void {
  const parts = rel.split('/')
  if (parts.length > 1) mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(base, rel), content, 'utf-8')
}

function read(base: string, rel: string): string {
  return readFileSync(join(base, rel), 'utf-8')
}

const MINIMAL_POM = '<project><dependencies>\n</dependencies></project>'

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── sem diretórios Java ───────────────────────────────────────────────────────

describe('runJakartaDepsInjector — projeto sem src/', () => {
  it('retorna resultado vazio sem lançar exceção', async () => {
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.recipesApplied).toHaveLength(0)
    expect(result.filesModified).toBe(0)
    expect(result.detail.injected).toHaveLength(0)
  })
})

// ─── detecção e injeção ───────────────────────────────────────────────────────

describe('javax.xml.ws — JAX-WS', () => {
  it('injeta jakarta.xml.ws-api quando detectado javax.xml.ws import', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    const pom = read(dir, 'pom.xml')
    expect(pom).toContain('jakarta.xml.ws-api')
    expect(pom).toContain('4.0.0')
    expect(result.detail.injected.some(d => d.id === 'jakarta-xml-ws')).toBe(true)
    expect(result.recipesApplied).toContain('inject-jakarta-xml-ws')
  })
})

describe('javax.xml.soap — SAAJ', () => {
  it('injeta jakarta.xml.soap-api quando detectado javax.xml.soap import', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/SoapClient.java',
      'import javax.xml.soap.SOAPMessage;\npublic class SoapClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    const pom = read(dir, 'pom.xml')
    expect(pom).toContain('jakarta.xml.soap-api')
    expect(result.detail.injected.some(d => d.id === 'jakarta-xml-soap')).toBe(true)
  })
})

describe('javax.jws — JWS annotations', () => {
  it('injeta jakarta.jws-api quando detectado javax.jws import', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/MyService.java',
      'import javax.jws.WebService;\npublic class MyService {}')
    const result = await runJakartaDepsInjector(dir, false)
    const pom = read(dir, 'pom.xml')
    expect(pom).toContain('jakarta.jws-api')
    expect(result.detail.injected.some(d => d.id === 'jakarta-jws')).toBe(true)
  })
})

describe('javax.activation — JAF', () => {
  it('injeta jakarta.activation-api quando detectado javax.activation import', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/DataHandler.java',
      'import javax.activation.DataHandler;\npublic class DataHandler {}')
    const result = await runJakartaDepsInjector(dir, false)
    const pom = read(dir, 'pom.xml')
    expect(pom).toContain('jakarta.activation-api')
    expect(result.detail.injected.some(d => d.id === 'jakarta-activation')).toBe(true)
  })
})

// ─── múltiplos namespaces de uma vez ──────────────────────────────────────────

describe('múltiplos namespaces detectados em simultâneo', () => {
  it('injeta todas as dependências detectadas no mesmo pom.xml', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/Legacy.java', [
      'import javax.xml.ws.Service;',
      'import javax.xml.soap.SOAPMessage;',
      'import javax.jws.WebService;',
      'import javax.activation.DataHandler;',
      'public class Legacy {}',
    ].join('\n'))
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.detail.injected).toHaveLength(4)
    const pom = read(dir, 'pom.xml')
    expect(pom).toContain('jakarta.xml.ws-api')
    expect(pom).toContain('jakarta.xml.soap-api')
    expect(pom).toContain('jakarta.jws-api')
    expect(pom).toContain('jakarta.activation-api')
  })
})

// ─── já presente ──────────────────────────────────────────────────────────────

describe('dependência já presente no pom.xml', () => {
  it('registra como alreadyPresent sem duplicar', async () => {
    write(dir, 'pom.xml',
      '<project><dependencies><dependency><artifactId>jakarta.xml.ws-api</artifactId></dependency></dependencies></project>')
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.detail.alreadyPresent.some(d => d.id === 'jakarta-xml-ws')).toBe(true)
    expect(result.detail.injected).toHaveLength(0)
    const pom = read(dir, 'pom.xml')
    // Não deve ter duplicado a dependência
    const count = (pom.match(/jakarta\.xml\.ws-api/g) ?? []).length
    expect(count).toBe(1)
  })
})

// ─── sem imports EE ───────────────────────────────────────────────────────────

describe('sem imports Java EE removidos', () => {
  it('retorna resultado vazio quando não há imports javax.xml.ws/soap/jws/activation', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/App.java',
      'import java.util.List;\npublic class App {}')
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.detail.injected).toHaveLength(0)
    expect(result.filesModified).toBe(0)
  })
})

// ─── dryRun ───────────────────────────────────────────────────────────────────

describe('dryRun', () => {
  it('não modifica o pom.xml em dryRun mesmo com imports detectados', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, true)
    const pom = read(dir, 'pom.xml')
    // Arquivo não deve ter sido alterado no disco
    expect(pom).toBe(MINIMAL_POM)
    // Deve ter detectado a necessidade de injeção
    expect(result.detail.injected.length).toBeGreaterThan(0)
  })
})

// ─── detectedInFiles ──────────────────────────────────────────────────────────

describe('detectedInFiles', () => {
  it('registra os arquivos onde os imports foram encontrados', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.detail.detectedInFiles['jakarta-xml-ws']).toBeDefined()
    expect(result.detail.detectedInFiles['jakarta-xml-ws'].length).toBeGreaterThan(0)
    expect(result.detail.detectedInFiles['jakarta-xml-ws'][0]).toContain('WsClient.java')
  })
})

// ─── sem pom.xml ──────────────────────────────────────────────────────────────

describe('sem pom.xml', () => {
  it('retorna resultado vazio quando pom.xml não existe', async () => {
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.detail.injected).toHaveLength(0)
    expect(result.filesModified).toBe(0)
  })
})

// ─── diffSummary ──────────────────────────────────────────────────────────────

describe('diffSummary', () => {
  it('diffSummary menciona dependências injetadas', async () => {
    write(dir, 'pom.xml', MINIMAL_POM)
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.diffSummary).toContain('jakarta.xml.ws-api')
  })

  it('diffSummary indica "já presentes" quando dep já existe', async () => {
    write(dir, 'pom.xml',
      '<project><dependencies><dependency><artifactId>jakarta.xml.ws-api</artifactId></dependency></dependencies></project>')
    write(dir, 'src/main/java/com/example/WsClient.java',
      'import javax.xml.ws.Service;\npublic class WsClient {}')
    const result = await runJakartaDepsInjector(dir, false)
    expect(result.diffSummary).toContain('presentes')
  })
})
