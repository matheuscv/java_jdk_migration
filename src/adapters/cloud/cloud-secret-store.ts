import type { SecretStore, PinEntry } from '../../ports/secret-store.js'

/**
 * Implementação cloud de SecretStore: armazenamento em memória do processo
 * (disco efêmero equivalente para um único container do Render), nunca em
 * arquivo — portanto estruturalmente impossível de ser incluído num commit
 * do GitWorkspaceStorage. Sem import de `node:fs` neste módulo, de propósito.
 *
 * Trade-off aceito: PINs não sobrevivem a um restart do container. Como a
 * validade do PIN já é de 30 minutos, isso é equivalente a uma sessão expirar
 * — o humano simplesmente solicita um novo PIN (request_gate_approval) se o
 * container reiniciar no meio da janela. Ver memória de projeto
 * "r2-gate-pin-teams-email" para o racional completo de R1.
 *
 * Para multi-instância (mais de um container do MCP atrás de um load balancer),
 * trocar por uma implementação Redis/KV — mesma porta SecretStore, sem mudar
 * a lógica de negócio que a consome.
 */
export function createCloudSecretStore(): SecretStore {
  const pins = new Map<number, PinEntry>()

  return {
    async getPin(phase: number): Promise<PinEntry | null> {
      const entry = pins.get(phase)
      if (!entry) return null

      // Reforço de expiração na própria porta — não depende do chamador lembrar
      // de checar expiresAt (defesa em profundidade para a fase mais crítica).
      if (new Date(entry.expiresAt).getTime() < Date.now()) {
        pins.delete(phase)
        return null
      }

      return entry
    },

    async putPin(phase: number, entry: PinEntry): Promise<void> {
      pins.set(phase, entry)
    },

    async deletePin(phase: number): Promise<void> {
      pins.delete(phase)
    },
  }
}
