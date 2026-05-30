import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  generateGateToken,
  validateGateToken,
  getTokenIssuedAt,
  consumeGateToken,
} from '../../src/orchestrator/gate-validator.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

const PROJECT = '/tmp/test-project'

describe('generateGateToken', () => {
  it('generates a token starting with "jdkm."', () => {
    const token = generateGateToken(PROJECT, 0)
    expect(token).toMatch(/^jdkm\./)
  })

  it('encodes the phase number', () => {
    const token2 = generateGateToken(PROJECT, 2)
    const parts = token2.split('.')
    expect(parts[2]).toBe('2')
  })

  it('generates different tokens for different phases', () => {
    const t0 = generateGateToken(PROJECT, 0)
    const t1 = generateGateToken(PROJECT, 1)
    expect(t0).not.toBe(t1)
  })

  it('generates different tokens for different projects', () => {
    const ta = generateGateToken('/project/a', 0)
    const tb = generateGateToken('/project/b', 0)
    expect(ta).not.toBe(tb)
  })
})

describe('validateGateToken', () => {
  it('validates a freshly generated token', () => {
    const token = generateGateToken(PROJECT, 1)
    expect(validateGateToken(token, PROJECT, 1)).toBe(true)
  })

  it('rejects token for wrong phase', () => {
    const token = generateGateToken(PROJECT, 1)
    expect(validateGateToken(token, PROJECT, 2)).toBe(false)
  })

  it('rejects token for wrong project', () => {
    const token = generateGateToken(PROJECT, 0)
    expect(validateGateToken(token, '/other/project', 0)).toBe(false)
  })

  it('rejects a tampered token', () => {
    const token = generateGateToken(PROJECT, 0)
    const parts = token.split('.')
    parts[4] = 'deadbeefdeadbeefdeadbeefdeadbeef'
    expect(validateGateToken(parts.join('.'), PROJECT, 0)).toBe(false)
  })

  it('rejects a malformed token', () => {
    expect(validateGateToken('not-a-token', PROJECT, 0)).toBe(false)
    expect(validateGateToken('', PROJECT, 0)).toBe(false)
    expect(validateGateToken('jdkm.1.0', PROJECT, 0)).toBe(false)
  })

  it('rejects an expired token (> 30 days old) — isolado via vi.setSystemTime', () => {
    // Gera o token num momento "no passado" (31 dias atrás)
    const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - THIRTY_ONE_DAYS_MS)
    const token = generateGateToken(PROJECT, 0)
    // Avança o relógio para "agora" — o token gerado lá atrás está expirado
    vi.useRealTimers()
    // O HMAC é válido (gerado corretamente), mas o timestamp está expirado
    expect(validateGateToken(token, PROJECT, 0)).toBe(false)
  })
})

describe('consumeGateToken', () => {
  function makeConfig(): JdkMigrationConfig {
    return {
      sourceJdk: '8', targetJdk: '21', stack: ['spring-boot'],
      buildSystem: 'maven', appServer: null, multiModule: false,
      modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
      dryRunBeforeExecute: true, phases: createDefaultPhases(),
    }
  }

  it('marks phase as completed', () => {
    const config = makeConfig()
    const token = generateGateToken(PROJECT, 0)
    config.phases[0].gateToken = token
    config.phases[0].status = 'approved'
    const updated = consumeGateToken(config, 0)
    expect(updated.phases[0].status).toBe('completed')
  })

  it('is a no-op when phase has no gateToken', () => {
    const config = makeConfig()
    const result = consumeGateToken(config, 0)
    expect(result.phases[0].status).toBe('pending')
  })

  it('does not mutate original config', () => {
    const config = makeConfig()
    config.phases[0].gateToken = generateGateToken(PROJECT, 0)
    config.phases[0].status = 'approved'
    consumeGateToken(config, 0)
    expect(config.phases[0].status).toBe('approved')
  })

  it('only affects the specified phase', () => {
    const config = makeConfig()
    config.phases[0].gateToken = generateGateToken(PROJECT, 0)
    config.phases[0].status = 'approved'
    const updated = consumeGateToken(config, 0)
    expect(updated.phases[1].status).toBe('pending')
  })
})

describe('getTokenIssuedAt', () => {
  it('extracts the issuedAt date from a valid token', () => {
    const before = new Date()
    const token = generateGateToken(PROJECT, 0)
    const after = new Date()
    const issued = getTokenIssuedAt(token)
    expect(issued).not.toBeNull()
    expect(issued!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    expect(issued!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000)
  })

  it('returns null for malformed token', () => {
    expect(getTokenIssuedAt('bad')).toBeNull()
  })
})
