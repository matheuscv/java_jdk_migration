/**
 * Porta de armazenamento de segredos de gate (PINs de aprovação humana).
 *
 * Deliberadamente separada de MigrationStorage: o conteúdo desta porta NUNCA
 * deve ser persistido pela mesma via que o estado da migração (nunca commitado
 * em branch, nunca incluído em retorno de MCP tool). Ver CLAUDE.md / memória
 * de projeto "r2-gate-pin-teams-email" para o racional completo.
 *
 * LocalSecretStore (M0) envolve o arquivo .gate-pins.json atual.
 * CloudSecretStore (M4) usa disco efêmero do servidor cloud ou KV, isolado do
 * workspace clonado do GitHub.
 */
export interface PinEntry {
  pin: string
  expiresAt: string // ISO 8601
  phaseNumber: number
}

export interface SecretStore {
  getPin(phase: number): Promise<PinEntry | null>
  putPin(phase: number, entry: PinEntry): Promise<void>
  deletePin(phase: number): Promise<void>
}
