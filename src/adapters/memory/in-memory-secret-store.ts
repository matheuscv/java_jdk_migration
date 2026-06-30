import type { SecretStore, PinEntry } from '../../ports/secret-store.js'

/**
 * Implementação em memória de SecretStore, usada em testes (inclusive na
 * suíte de segurança do M4 — comprovar que o PIN não vaza por nenhum outro
 * caminho que não seja getPin/putPin diretos).
 */
export function createInMemorySecretStore(): SecretStore {
  const pins = new Map<number, PinEntry>()

  return {
    async getPin(phase: number): Promise<PinEntry | null> {
      return pins.get(phase) ?? null
    },

    async putPin(phase: number, entry: PinEntry): Promise<void> {
      pins.set(phase, entry)
    },

    async deletePin(phase: number): Promise<void> {
      pins.delete(phase)
    },
  }
}
