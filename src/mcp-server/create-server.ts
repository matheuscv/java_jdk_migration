import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerDiscoverProject } from './tools/discover-project.js'
import { registerBuildMigrationPlan } from './tools/build-migration-plan.js'
import { registerExecutePhase, type ExecutePhaseAdapters } from './tools/execute-phase.js'
import { registerAuxiliaryTools } from './tools/auxiliary.js'
import { registerCheckDependencies } from './tools/check-dependencies.js'
import { registerGateToolsCloud, type GateToolsCloudOptions } from './tools/gate-tools-cloud.js'
import { createCloudSecretStore } from '../adapters/cloud/cloud-secret-store.js'
import type { GraphNotifier } from '../adapters/cloud/graph-notifier.js'

export const SERVER_NAME = 'jdk-migration'
export const SERVER_VERSION = '0.3.48'

/**
 * Cria o McpServer em MODO LOCAL (stdio / dev):
 * - Todas as 12 tools com adapters locais (filesystem, git CLI, PIN em arquivo).
 * - Comportamento idêntico ao pré-M5, zero regressão.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  registerDiscoverProject(server)
  registerBuildMigrationPlan(server)
  registerExecutePhase(server)           // sem adapters → defaults locais
  registerAuxiliaryTools(server)         // inclui request_gate_approval/approve_gate local
  registerCheckDependencies(server)

  return server
}

export interface CloudServerOptions {
  /** Adapters de Storage + Git para execute_phase no modo cloud. */
  executePhaseAdapters?: ExecutePhaseAdapters
  /** Notificador Microsoft Graph (Teams + e-mail). Quando ausente, PIN é armazenado mas não enviado. */
  graphNotifier?: GraphNotifier
  /**
   * Bypass mode: auto-aprova todos os gates sem PIN.
   * Ativar via GATE_BYPASS=true enquanto Microsoft Graph não está disponível (POC).
   * Reverter removendo a env var quando o Azure AD estiver configurado.
   */
  gateBypass?: boolean
}

/**
 * Cria o McpServer em MODO CLOUD (HTTP / Render):
 * - execute_phase: usa GitWorkspaceStorage + GitHubApiGateway quando injetados.
 * - request_gate_approval: NUNCA retorna o PIN — envia via Teams/e-mail.
 * - approve_gate: valida contra CloudSecretStore (não arquivo em workdir).
 * - Demais tools (discover, plan, report, check-deps): comportamento idêntico ao local.
 */
export function createCloudMcpServer(opts: CloudServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const secretStore = createCloudSecretStore()

  registerDiscoverProject(server)
  registerBuildMigrationPlan(server)
  registerExecutePhase(server, opts.executePhaseAdapters)
  // Em modo cloud, as gate tools cloud substituem as locais de auxiliary.ts:
  const gateOpts: GateToolsCloudOptions = {
    notifier: opts.graphNotifier,
    bypassMode: opts.gateBypass ?? false,
  }
  registerGateToolsCloud(server, secretStore, gateOpts)
  // Restante de auxiliary (get_phase_status, rollback, report, etc.) permanece local.
  // skipGateTools=true evita registro duplicado de request_gate_approval/approve_gate
  // que já foram registrados por registerGateToolsCloud acima.
  registerAuxiliaryTools(server, { skipGateTools: true })
  registerCheckDependencies(server)

  return server
}
