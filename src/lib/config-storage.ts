import type { MigrationStorage } from '../ports/storage.js'
import type { JdkMigrationConfig } from './config.js'
import { MigrationError } from './errors.js'

const CONFIG_FILENAME = 'jdk-migration.config.json'

/**
 * Lê o config da migração a partir de um MigrationStorage (qualquer implementação:
 * LocalFsStorage, GitWorkspaceStorage, InMemoryStorage). Mesma semântica e erros
 * de readConfig() de lib/config.ts, mas assíncrono e independente do filesystem
 * local — necessário para que execute-phase.ts opere sobre clones remotos em modo
 * cloud (M2: GitWorkspaceStorage).
 */
export async function readConfigFromStorage(storage: MigrationStorage): Promise<JdkMigrationConfig> {
  const raw = await storage.read(CONFIG_FILENAME)
  if (raw === null) {
    throw new MigrationError(
      'CONFIG_NOT_FOUND',
      `Arquivo ${CONFIG_FILENAME} não encontrado no storage. Execute a Skill de instalação primeiro.`,
    )
  }
  return JSON.parse(raw) as JdkMigrationConfig
}

export async function writeConfigToStorage(storage: MigrationStorage, config: JdkMigrationConfig): Promise<void> {
  await storage.write(CONFIG_FILENAME, JSON.stringify(config, null, 2))
}
