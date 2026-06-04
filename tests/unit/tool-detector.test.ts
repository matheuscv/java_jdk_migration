import { describe, it, expect } from 'vitest'
import { detectTools, buildMissingToolsMessage, serializeTools } from '../../src/lib/tool-detector.js'

describe('detectTools', () => {
  it('retorna estrutura com tools, allRequiredFound e missing', async () => {
    const result = await detectTools()
    expect(result).toHaveProperty('tools')
    expect(result).toHaveProperty('allRequiredFound')
    expect(result).toHaveProperty('missing')
    expect(Array.isArray(result.tools)).toBe(true)
    expect(Array.isArray(result.missing)).toBe(true)
  })

  it('cada tool tem os campos obrigatórios', async () => {
    const result = await detectTools()
    for (const t of result.tools) {
      expect(t).toHaveProperty('name')
      expect(t).toHaveProperty('source')
      expect(t).toHaveProperty('path')
      expect(t).toHaveProperty('status')
      expect(t).toHaveProperty('required')
      expect(['found', 'not_found', 'user_provided']).toContain(t.status)
    }
  })

  it('override inválido não derruba a detecção', async () => {
    const result = await detectTools({ JAVA_HOME: '/nao/existe/de/jeito-nenhum' })
    expect(result.tools.length).toBeGreaterThan(0)
  })

  it('missing é subconjunto de tools required', async () => {
    const result = await detectTools()
    for (const m of result.missing) {
      expect(m.required).toBe(true)
      expect(m.status).toBe('not_found')
    }
  })

  it('allRequiredFound é false quando há missing', async () => {
    const result = await detectTools()
    const hasMissing = result.missing.length > 0
    if (hasMissing) {
      expect(result.allRequiredFound).toBe(false)
    }
  })
})

describe('buildMissingToolsMessage', () => {
  it('retorna string com nome da ferramenta ausente', () => {
    const fakeMissing = [{
      name: 'Apache Maven',
      source: '—',
      path: '—',
      version: null,
      status: 'not_found' as const,
      required: true,
      missingMessage: 'Maven não encontrado. Informe o diretório.',
    }]
    const msg = buildMissingToolsMessage(fakeMissing)
    expect(msg).toContain('Apache Maven')
    expect(msg).toContain('Maven não encontrado')
    expect(msg).toContain('toolOverrides')
  })
})

describe('serializeTools', () => {
  it('remove missingMessage e adiciona detectedAt', async () => {
    const result = await detectTools()
    const serialized = serializeTools(result)
    expect(serialized).toHaveProperty('detectedAt')
    expect(serialized).toHaveProperty('allRequiredFound')
    expect(serialized).toHaveProperty('tools')
    for (const t of serialized.tools) {
      expect(t).not.toHaveProperty('missingMessage')
    }
  })
})
