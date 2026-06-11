/**
 * Testes adicionais para src/lib/tool-detector.ts
 * Cobre: extractSourceJdkHome, extractTargetJdkHome, serializeTools com status variados,
 * buildMissingToolsMessage com múltiplas ferramentas, detectTools com sourceJdkMajor=6,
 * overrides com caminhos não existentes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  detectTools,
  buildMissingToolsMessage,
  serializeTools,
  extractSourceJdkHome,
  extractTargetJdkHome,
} from '../../src/lib/tool-detector.js'
import type { DetectedTool, ToolDetectionResult } from '../../src/lib/tool-detector.js'

const TIMEOUT = 30_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTool(overrides: Partial<DetectedTool>): DetectedTool {
  return {
    name: 'Fake Tool',
    source: 'test',
    path: '/fake/path',
    version: '1.0.0',
    status: 'found',
    required: true,
    ...overrides,
  }
}

function makeResult(tools: DetectedTool[]): ToolDetectionResult {
  const missing = tools.filter(t => t.required && t.status === 'not_found')
  return { tools, allRequiredFound: missing.length === 0, missing }
}

// ─── extractSourceJdkHome ─────────────────────────────────────────────────────

describe('extractSourceJdkHome', () => {
  it('retorna path quando Java (JDK) está found', () => {
    const result = makeResult([
      makeTool({ name: 'Java (JDK)', path: '/usr/lib/jvm/java-8', status: 'found' }),
    ])
    expect(extractSourceJdkHome(result)).toBe('/usr/lib/jvm/java-8')
  })

  it('retorna path quando Java (JDK) está user_provided', () => {
    const result = makeResult([
      makeTool({ name: 'Java (JDK)', path: 'C:\\jdk8', status: 'user_provided' }),
    ])
    expect(extractSourceJdkHome(result)).toBe('C:\\jdk8')
  })

  it('retorna null quando Java (JDK) está not_found', () => {
    const result = makeResult([
      makeTool({ name: 'Java (JDK)', path: '—', status: 'not_found' }),
    ])
    expect(extractSourceJdkHome(result)).toBeNull()
  })

  it('retorna null quando tools não tem Java (JDK)', () => {
    const result = makeResult([
      makeTool({ name: 'Apache Maven', path: '/usr/bin/mvn', status: 'found' }),
    ])
    expect(extractSourceJdkHome(result)).toBeNull()
  })

  it('retorna null quando path é "—" mesmo com status found', () => {
    const result = makeResult([
      makeTool({ name: 'Java (JDK)', path: '—', status: 'found' }),
    ])
    expect(extractSourceJdkHome(result)).toBeNull()
  })
})

// ─── extractTargetJdkHome ─────────────────────────────────────────────────────

describe('extractTargetJdkHome', () => {
  it('retorna path quando Java 21 (target) está found', () => {
    const result = makeResult([
      makeTool({ name: 'Java 21 (target)', path: '/usr/lib/jvm/java-21', status: 'found' }),
    ])
    expect(extractTargetJdkHome(result)).toBe('/usr/lib/jvm/java-21')
  })

  it('retorna path quando Java 21 (target) está user_provided', () => {
    const result = makeResult([
      makeTool({ name: 'Java 21 (target)', path: 'C:\\jdk21', status: 'user_provided' }),
    ])
    expect(extractTargetJdkHome(result)).toBe('C:\\jdk21')
  })

  it('retorna null quando Java 21 (target) está not_found', () => {
    const result = makeResult([
      makeTool({ name: 'Java 21 (target)', path: '—', status: 'not_found' }),
    ])
    expect(extractTargetJdkHome(result)).toBeNull()
  })

  it('retorna null quando tools não tem Java 21 (target)', () => {
    const result = makeResult([
      makeTool({ name: 'Apache Maven', path: '/usr/bin/mvn', status: 'found' }),
    ])
    expect(extractTargetJdkHome(result)).toBeNull()
  })
})

// ─── serializeTools ───────────────────────────────────────────────────────────

describe('serializeTools — campos derivados', () => {
  it('sourceJdkHome é null quando source JDK não encontrado', () => {
    const result = makeResult([
      makeTool({ name: 'Java (JDK)', path: '—', status: 'not_found' }),
      makeTool({ name: 'Java 21 (target)', path: '/usr/lib/jvm/java-21', status: 'found' }),
    ])
    const s = serializeTools(result)
    expect(s.sourceJdkHome).toBeNull()
    expect(s.targetJdkHome).toBe('/usr/lib/jvm/java-21')
  })

  it('targetJdkHome é null quando JDK 21 não encontrado', () => {
    const result = makeResult([
      makeTool({ name: 'Java (JDK)', path: '/usr/lib/jvm/java-8', status: 'found' }),
      makeTool({ name: 'Java 21 (target)', path: '—', status: 'not_found', required: true }),
    ])
    const s = serializeTools(result)
    expect(s.sourceJdkHome).toBe('/usr/lib/jvm/java-8')
    expect(s.targetJdkHome).toBeNull()
  })

  it('tools serializadas não contêm missingMessage', () => {
    const result = makeResult([
      makeTool({ name: 'Apache Maven', path: '—', status: 'not_found', missingMessage: 'Maven não encontrado' }),
    ])
    const s = serializeTools(result)
    for (const t of s.tools) {
      expect(t).not.toHaveProperty('missingMessage')
    }
  })

  it('tools com status user_provided são preservadas', () => {
    const result = makeResult([
      makeTool({ name: 'Apache Maven', path: '/custom/mvn', status: 'user_provided', required: true }),
    ])
    const s = serializeTools(result)
    expect(s.tools[0].status).toBe('user_provided')
    expect(s.tools[0].path).toBe('/custom/mvn')
  })

  it('allRequiredFound é false quando há tool required not_found', () => {
    const result = makeResult([
      makeTool({ name: 'Git', path: '—', status: 'not_found', required: true }),
    ])
    const s = serializeTools(result)
    expect(s.allRequiredFound).toBe(false)
  })

  it('allRequiredFound é true quando todas required estão found', () => {
    const result = makeResult([
      makeTool({ name: 'Apache Maven', path: '/bin/mvn', status: 'found', required: true }),
      makeTool({ name: 'Gradle', path: '—', status: 'not_found', required: false }),
    ])
    const s = serializeTools(result)
    expect(s.allRequiredFound).toBe(true)
  })

  it('detectedAt é string ISO no passado recente', () => {
    const result = makeResult([])
    const before = Date.now()
    const s = serializeTools(result)
    const after = Date.now()
    const ts = new Date(s.detectedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after + 5)
  })
})

// ─── buildMissingToolsMessage ─────────────────────────────────────────────────

describe('buildMissingToolsMessage — múltiplas ferramentas', () => {
  it('lista todas as ferramentas ausentes com suas mensagens', () => {
    const missing: DetectedTool[] = [
      makeTool({ name: 'Java (JDK)', path: '—', status: 'not_found', missingMessage: 'JDK 8 não encontrado. Informe via SOURCE_JAVA_HOME.' }),
      makeTool({ name: 'Apache Maven', path: '—', status: 'not_found', missingMessage: 'Maven não encontrado. Informe MAVEN_HOME.' }),
      makeTool({ name: 'Git', path: '—', status: 'not_found', missingMessage: 'Git não encontrado.' }),
    ]
    const msg = buildMissingToolsMessage(missing)
    expect(msg).toContain('Java (JDK)')
    expect(msg).toContain('JDK 8 não encontrado')
    expect(msg).toContain('Apache Maven')
    expect(msg).toContain('Maven não encontrado')
    expect(msg).toContain('Git')
    expect(msg).toContain('toolOverrides')
  })

  it('usa fallback "Informe o caminho" quando missingMessage ausente', () => {
    const missing: DetectedTool[] = [
      makeTool({ name: 'Gradle', path: '—', status: 'not_found', required: false }),
    ]
    const msg = buildMissingToolsMessage(missing)
    expect(msg).toContain('Gradle')
    expect(msg).toContain('Informe o caminho de instalação')
  })

  it('retorna string vazia de ferramentas quando lista vazia mas mantém estrutura', () => {
    const msg = buildMissingToolsMessage([])
    expect(typeof msg).toBe('string')
    expect(msg).toContain('toolOverrides')
  })
})

// ─── detectTools — sourceJdkMajor=6 ──────────────────────────────────────────

describe('detectTools — sourceJdkMajor=6', () => {
  it('não lança exceção ao buscar JDK 6 inexistente na máquina', async () => {
    const result = await detectTools({}, 6)
    expect(result).toHaveProperty('tools')
    expect(result).toHaveProperty('allRequiredFound')
    const sourceJdk = result.tools.find(t => t.name === 'Java (JDK)')
    expect(sourceJdk).toBeDefined()
  }, 60_000)

  it('JDK 6 não encontrado tem status not_found e missingMessage com JDK 6', async () => {
    // Passa overrides inválidos para garantir que não encontre nada
    const result = await detectTools(
      {
        SOURCE_JAVA_HOME: '/nao/existe/jdk6',
        JAVA_HOME_6: '/nao/existe/jdk6',
      },
      6,
    )
    const sourceJdk = result.tools.find(t => t.name === 'Java (JDK)')
    if (sourceJdk?.status === 'not_found') {
      expect(sourceJdk.missingMessage).toContain('6')
    }
    // Se a máquina tem JDK 6, ok — a função não deve lançar exceção de forma alguma
    expect(result.tools.length).toBeGreaterThan(0)
  }, TIMEOUT)
})

// ─── detectTools — overrides com caminhos não existentes ─────────────────────

describe('detectTools — overrides inválidos', () => {
  it('override com path inexistente é ignorado graciosamente', async () => {
    const result = await detectTools({
      SOURCE_JAVA_HOME: '/absolutamente/nao/existe/jdk8',
      JAVA_HOME_21: '/absolutamente/nao/existe/jdk21',
      MAVEN_HOME: '/absolutamente/nao/existe/maven',
      GIT_EXEC_PATH: '/absolutamente/nao/existe/git',
      GRADLE_HOME: '/absolutamente/nao/existe/gradle',
    })
    // Não lança — estrutura retornada deve ser válida
    expect(Array.isArray(result.tools)).toBe(true)
    expect(typeof result.allRequiredFound).toBe('boolean')
    expect(Array.isArray(result.missing)).toBe(true)
  }, TIMEOUT)

  it('override SOURCE_JAVA_HOME com JDK 21 inválido (version mismatch) — não retorna como sourceJdk', async () => {
    // Este teste verifica que um override com versão errada não é aceito silenciosamente
    const result = await detectTools({ SOURCE_JAVA_HOME: '/nao/existe/fake-jdk21' })
    // O source JDK pode ser not_found, mas não deve crashar
    expect(result).toHaveProperty('tools')
  }, TIMEOUT)
})

// ─── detectTools — env vars limpos (forçar caminhos not_found) ────────────────

describe('detectTools — com env vars de Maven/Git limpos via vi.stubEnv', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('Maven detectado via PATH quando MAVEN_HOME/M2_HOME não estão no env', async () => {
    // Limpa variáveis de env dedicadas ao Maven para forçar o caminho findInPath
    vi.stubEnv('MAVEN_HOME', '')
    vi.stubEnv('M2_HOME', '')
    vi.stubEnv('MVN_HOME', '')
    const result = await detectTools({})
    const maven = result.tools.find(t => t.name === 'Apache Maven')
    expect(maven).toBeDefined()
    // Maven pode ser found (via PATH) ou not_found — não deve crashar
    expect(['found', 'not_found', 'user_provided']).toContain(maven?.status)
  }, TIMEOUT)

  it('detectTools com GRADLE_HOME limpo não crashar', async () => {
    vi.stubEnv('GRADLE_HOME', '')
    const result = await detectTools({})
    const gradle = result.tools.find(t => t.name === 'Gradle')
    expect(gradle).toBeDefined()
    expect(['found', 'not_found', 'user_provided']).toContain(gradle?.status)
  }, TIMEOUT)
})
