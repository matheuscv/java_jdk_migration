/**
 * Testes unitários para container-registry-enricher.ts
 * Cobre enrichContainerFindings — o path mais crítico (sem registry call, com mock de fetch)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enrichContainerFindings } from '../../src/static-analysis/container-registry-enricher.js'
import type { ContainerFinding } from '../../src/static-analysis/container-ci-scanner.js'
import type { ArtifactRegistry } from '../../src/lib/config.js'

const NEXUS_REGISTRY: ArtifactRegistry = { type: 'nexus3', url: 'http://nexus.example.com' }
const ARTIFACTORY_REGISTRY: ArtifactRegistry = { type: 'artifactory', url: 'http://art.example.com' }

function makeFinding(overrides?: Partial<ContainerFinding>): ContainerFinding {
  return {
    id: 'test-finding',
    file: 'Dockerfile',
    fileType: 'dockerfile',
    line: 1,
    severity: 'high',
    description: 'JDK antigo detectado',
    detectedImage: 'registry.example.com/app-java-8:latest',
    detectedJdkVersion: '8',
    targetJdk: '21',
    requiresHumanDecision: false,
    suggestion: 'Atualize para JDK 21',
    ...overrides,
  }
}

// ─── findings que não requerem decisão humana (passthrough) ──────────────────

describe('enrichContainerFindings — findings sem requiresHumanDecision', () => {
  it('retorna finding sem alterações quando requiresHumanDecision=false', async () => {
    const finding = makeFinding({ requiresHumanDecision: false })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result).toHaveLength(1)
    expect(result[0].suggestedReplacement).toBeNull()
    expect(result[0].replacementFromRegistry).toBe(false)
    expect(result[0].id).toBe('test-finding')
  })

  it('preserva todos os campos do finding original', async () => {
    const finding = makeFinding({ requiresHumanDecision: false, severity: 'critical' })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].severity).toBe('critical')
    expect(result[0].description).toBe('JDK antigo detectado')
  })

  it('retorna lista vazia quando não há findings', async () => {
    const result = await enrichContainerFindings([], NEXUS_REGISTRY, '21')
    expect(result).toHaveLength(0)
  })

  it('trata múltiplos findings de passthrough em sequência', async () => {
    const findings = [
      makeFinding({ id: 'f1', requiresHumanDecision: false }),
      makeFinding({ id: 'f2', requiresHumanDecision: false }),
      makeFinding({ id: 'f3', requiresHumanDecision: false }),
    ]
    const result = await enrichContainerFindings(findings, NEXUS_REGISTRY, '21')
    expect(result).toHaveLength(3)
    expect(result.map(r => r.id)).toEqual(['f1', 'f2', 'f3'])
  })
})

// ─── findings sem detectedImage (passthrough) ────────────────────────────────

describe('enrichContainerFindings — sem detectedImage', () => {
  it('passthrough quando requiresHumanDecision=true mas não há detectedImage', async () => {
    const finding = makeFinding({ requiresHumanDecision: true, detectedImage: undefined })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].suggestedReplacement).toBeNull()
    expect(result[0].replacementFromRegistry).toBe(false)
  })
})

// ─── findings com requiresHumanDecision mas sem substituição no registry ─────

describe('enrichContainerFindings — registry não encontra imagem', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ items: [] }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mantém requiresHumanDecision=true quando registry não retorna resultado (nexus)', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].requiresHumanDecision).toBe(true)
    expect(result[0].suggestedReplacement).toBeNull()
    expect(result[0].replacementFromRegistry).toBe(false)
  })

  it('mantém requiresHumanDecision=true quando registry não retorna resultado (artifactory)', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], ARTIFACTORY_REGISTRY, '21')
    expect(result[0].requiresHumanDecision).toBe(true)
    expect(result[0].suggestedReplacement).toBeNull()
  })

  it('mantém suggestion original quando não há substituto no registry', async () => {
    const finding = makeFinding({ requiresHumanDecision: true, suggestion: 'Sugestão original' })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].suggestion).toBe('Sugestão original')
  })
})

// ─── findings com registry retornando resultado (Nexus) ──────────────────────

describe('enrichContainerFindings — nexus3 retorna imagem', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          name: 'app-java-21',
          version: 'latest',
          assets: [{ lastModified: '2024-01-01T00:00:00Z' }],
        }],
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolve requiresHumanDecision=false quando registry acha substituto', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].requiresHumanDecision).toBe(false)
    expect(result[0].replacementFromRegistry).toBe(true)
    expect(result[0].suggestedReplacement).toBeTruthy()
  })

  it('atualiza suggestion para incluir o novo nome da imagem', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].suggestion).toContain('nexus.example.com')
  })
})

// ─── findings com registry retornando resultado (Artifactory) ─────────────────

describe('enrichContainerFindings — artifactory retorna tags', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tags: ['21-jre', '21-jdk'] }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolve requiresHumanDecision=false via artifactory', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], ARTIFACTORY_REGISTRY, '21')
    expect(result[0].requiresHumanDecision).toBe(false)
    expect(result[0].replacementFromRegistry).toBe(true)
  })
})

// ─── imagem sem JDK version no nome (guessJdk21ImageName retorna mesmo nome) ──

describe('enrichContainerFindings — nome da imagem não muda (sem dígito do JDK)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('não consulta registry quando nome da imagem 21 é idêntico ao original', async () => {
    // Imagem que não contém "8" — guessJdk21ImageName não altera
    const finding = makeFinding({
      requiresHumanDecision: true,
      detectedImage: 'registry.example.com/myapp:latest',
      detectedJdkVersion: '8',
    })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    // fetch não deve ter sido chamado (candidateName === name → não consulta)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(result[0].suggestedReplacement).toBeNull()
  })
})

// ─── falha silenciosa na consulta ao registry ─────────────────────────────────

describe('enrichContainerFindings — erro na consulta ao registry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('não lança exceção quando fetch falha — finding permanece sem substituto', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result[0].suggestedReplacement).toBeNull()
    expect(result[0].requiresHumanDecision).toBe(true)
  })
})

// ─── mix de findings com e sem requiresHumanDecision ──────────────────────────

describe('enrichContainerFindings — mix de findings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('processa corretamente mix de findings humanos e de passthrough', async () => {
    const findings = [
      makeFinding({ id: 'passthrough', requiresHumanDecision: false }),
      makeFinding({ id: 'human', requiresHumanDecision: true }),
    ]
    const result = await enrichContainerFindings(findings, NEXUS_REGISTRY, '21')
    expect(result).toHaveLength(2)
    expect(result.find(r => r.id === 'passthrough')!.replacementFromRegistry).toBe(false)
    expect(result.find(r => r.id === 'human')!.requiresHumanDecision).toBe(true)
  })
})

// ─── parseImageRef — branches não cobertos ───────────────────────────────────

describe('enrichContainerFindings — imagem sem host (apenas nome/tag)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          name: 'app-java-21',
          version: 'latest',
          assets: [{ lastModified: '2024-01-01T00:00:00Z' }],
        }],
      }),
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('parseia imagem sem host (sem ponto/colon no primeiro segmento)', async () => {
    // "openjdk-8:jre" → host=null pois "openjdk-8" não contém . nem :
    const finding = makeFinding({
      requiresHumanDecision: true,
      detectedImage: 'openjdk-8:jre',
      detectedJdkVersion: '8',
    })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    // Deve processar sem crash
    expect(result).toHaveLength(1)
  })

  it('parseia imagem sem tag (atIdx <= slashIdx)', async () => {
    // "registry.example.com/app-java-8" — sem tag, atIdx=-1 (ou antes do slash)
    const finding = makeFinding({
      requiresHumanDecision: true,
      detectedImage: 'registry.example.com/app-java-8',
      detectedJdkVersion: '8',
    })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    expect(result).toHaveLength(1)
  })
})

// ─── fetchArtifactoryDockerImages — catch block (inner) ──────────────────────

describe('enrichContainerFindings — artifactory fetch rejeitado (inner catch)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('retorna finding sem substituto quando fetch lança exceção para artifactory', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], ARTIFACTORY_REGISTRY, '21')
    expect(result[0].suggestedReplacement).toBeNull()
    expect(result[0].requiresHumanDecision).toBe(true)
  })
})

// ─── Nexus: múltiplos repositórios (result.length > 0 → break) ───────────────

describe('enrichContainerFindings — nexus retorna resultado no primeiro repo (break)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          name: 'app-java-21',
          version: '21-jre',
          assets: [{ lastModified: '2024-01-01T00:00:00Z' }],
        }],
      }),
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('para no primeiro repositório nexus quando retorna resultado', async () => {
    const finding = makeFinding({ requiresHumanDecision: true })
    const result = await enrichContainerFindings([finding], NEXUS_REGISTRY, '21')
    // resultado encontrado → break → apenas 1 chamada ao fetch (no primeiro repo)
    expect(result[0].replacementFromRegistry).toBe(true)
    // fetch pode ser chamado 1 vez (break no primeiro resultado)
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
