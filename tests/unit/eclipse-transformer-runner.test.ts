/**
 * Testes unitários para eclipse-transformer-runner.ts
 * Testa findOrDownloadEclipseTransformer e transformJar — mockando runProcess e fs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// Mock runProcess antes do import
vi.mock('../../src/lib/process-runner.js', () => ({
  runProcess: vi.fn(),
}))

import { findOrDownloadEclipseTransformer, transformJar } from '../../src/transform-engine/eclipse-transformer-runner.js'
import { runProcess } from '../../src/lib/process-runner.js'

const ET_VERSION = '0.5.0'

function tempDir(): string {
  const d = join(tmpdir(), `et-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

let dir: string
beforeEach(() => {
  dir = tempDir()
  vi.clearAllMocks()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ─── findOrDownloadEclipseTransformer ─────────────────────────────────────────

describe('findOrDownloadEclipseTransformer', () => {
  it('retorna caminho do JAR quando já está no disco', async () => {
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    const jarPath = join(toolsDir, `eclipse-transformer-${ET_VERSION}.jar`)
    writeFileSync(jarPath, 'fake jar content')

    const result = await findOrDownloadEclipseTransformer(dir)
    expect(result).toBe(jarPath)
    // Não deve ter chamado mvn se já existe
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('tenta baixar via mvn quando JAR não está no disco', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'ERROR', timedOut: false })
    const result = await findOrDownloadEclipseTransformer(dir)
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining(['dependency:copy']), expect.any(Object))
    expect(result).toBeNull()
  })

  it('retorna null quando download mvn falha', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'mvn not found', timedOut: false })
    const result = await findOrDownloadEclipseTransformer(dir)
    expect(result).toBeNull()
  })

  it('retorna caminho quando download mvn succeeds e JAR existe', async () => {
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    const jarPath = join(toolsDir, `eclipse-transformer-${ET_VERSION}.jar`)

    vi.mocked(runProcess).mockImplementationOnce(async () => {
      writeFileSync(jarPath, 'downloaded jar')
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    })

    const result = await findOrDownloadEclipseTransformer(dir)
    expect(result).toBe(jarPath)
  })
})

// ─── transformJar ─────────────────────────────────────────────────────────────

describe('transformJar', () => {
  it('retorna success=false com warning quando eclipse transformer não encontrado', async () => {
    // runProcess retorna falha (download falha)
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false })

    const result = await transformJar(dir, 'input.jar', 'output.jar')
    expect(result.success).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('Eclipse Transformer não encontrado')
    expect(result.inputJar).toBe('input.jar')
    expect(result.outputJar).toBe('output.jar')
  })

  it('retorna success=false quando transformação times out', async () => {
    // Primeiro call: download falha (para forçar busca ao disco)
    // Cria o JAR para simular que findOrDownload retorna um resultado
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    const jarPath = join(toolsDir, `eclipse-transformer-${ET_VERSION}.jar`)
    writeFileSync(jarPath, 'fake jar')

    // transformJar call: timedOut
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: true })

    const result = await transformJar(dir, 'input.jar', 'output.jar')
    expect(result.success).toBe(false)
    expect(result.warnings[0]).toContain('timed out')
  })

  it('retorna success=false quando transformação falha com exitCode !== 0', async () => {
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(join(toolsDir, `eclipse-transformer-${ET_VERSION}.jar`), 'fake jar')

    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1, stdout: '', stderr: 'Transformation failed', timedOut: false,
    })

    const result = await transformJar(dir, 'input.jar', 'output.jar')
    expect(result.success).toBe(false)
    expect(result.warnings[0]).toContain('Transformation failed')
  })

  it('retorna success=true quando transformação e smoke test passam', async () => {
    const toolsDir = join(dir, '.jdk-migration', 'tools')
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(join(toolsDir, `eclipse-transformer-${ET_VERSION}.jar`), 'fake jar')

    // Cria o output jar para simular sucesso
    writeFileSync(join(dir, 'output.jar'), 'transformed jar')

    // 1a call: transformação bem-sucedida
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
      // 2a call: smoke test
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Usage: ...', stderr: '', timedOut: false })

    const result = await transformJar(dir, 'input.jar', join(dir, 'output.jar'))
    expect(result.success).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })
})
