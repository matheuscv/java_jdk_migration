import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PhaseNumber } from '../types.js'
import type { JdkMigrationConfig } from '../lib/config.js'

const TOKEN_PREFIX = 'jdkm'
const TOKEN_VERSION = '1'
const TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000 // 30 dias

// Deriva a chave secreta deterministicamente do caminho do projeto
function deriveSecret(projectPath: string): Buffer {
  return createHash('sha256')
    .update(projectPath + ':jdk-migration-gate-v1')
    .digest()
}

// Formato: jdkm.{version}.{phase}.{issuedAtHex}.{hmac32}
export function generateGateToken(projectPath: string, phase: PhaseNumber): string {
  const issuedAt = Math.floor(Date.now() / 1000).toString(16)
  const payload = `${TOKEN_VERSION}.${phase}.${issuedAt}`
  const hmac = createHmac('sha256', deriveSecret(projectPath))
    .update(payload)
    .digest('hex')
    .slice(0, 32)
  return `${TOKEN_PREFIX}.${payload}.${hmac}`
}

export function validateGateToken(
  token: string,
  projectPath: string,
  phase: PhaseNumber,
): boolean {
  const parts = token.split('.')
  if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) return false

  const [, version, tokenPhase, issuedAtHex, hmac] = parts as [string, string, string, string, string]

  if (version !== TOKEN_VERSION) return false
  if (parseInt(tokenPhase, 10) !== phase) return false

  const issuedAt = parseInt(issuedAtHex, 16)
  if (isNaN(issuedAt)) return false
  if (Date.now() - issuedAt * 1000 > TOKEN_VALIDITY_MS) return false

  const payload = `${version}.${tokenPhase}.${issuedAtHex}`
  const expected = createHmac('sha256', deriveSecret(projectPath))
    .update(payload)
    .digest('hex')
    .slice(0, 32)

  try {
    return timingSafeEqual(Buffer.from(hmac, 'ascii'), Buffer.from(expected, 'ascii'))
  } catch {
    return false
  }
}

// Marca o token da fase como consumido ao iniciar a fase seguinte.
// Na prática, a máquina de estados impede reuso (fase já vai para in_progress),
// mas esta função fornece o contrato explícito do spec e pode ser usada para
// registrar o consumo em audit logs.
export function consumeGateToken(
  config: JdkMigrationConfig,
  phase: PhaseNumber,
): JdkMigrationConfig {
  const existing = config.phases[phase]
  if (!existing.gateToken) return config
  return {
    ...config,
    phases: {
      ...config.phases,
      [phase]: { ...existing, status: 'completed' as const },
    },
  }
}

// Expõe o timestamp embutido no token (para auditoria)
export function getTokenIssuedAt(token: string): Date | null {
  const parts = token.split('.')
  if (parts.length !== 5) return null
  const issuedAt = parseInt(parts[3], 16)
  if (isNaN(issuedAt)) return null
  return new Date(issuedAt * 1000)
}
