import { randomInt } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig, deletePinEntry } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { generateGateToken } from '../../orchestrator/gate-validator.js'
import { computePhaseRoi } from '../../roi-tracker/index.js'
import { generateAuditReportSilent, generateFinalReport } from '../../report-generator/index.js'
import { syncMigrationBranch } from '../../orchestrator/git-checkpoint.js'
import type { SecretStore } from '../../ports/secret-store.js'
import type { GraphNotifier } from '../../adapters/cloud/graph-notifier.js'
import type { PhaseNumber } from '../../types.js'

const PIN_VALIDITY_MS = 30 * 60 * 1000 // 30 minutos

const FORBIDDEN_APPROVER_NAMES = new Set([
  'bot', 'claude', 'ai', 'agent', 'automation', 'system', 'robot', 'llm', 'claude code',
])

function isForbiddenApprover(name: string): boolean {
  const lower = name.toLowerCase().trim()
  if (FORBIDDEN_APPROVER_NAMES.has(lower)) return true
  if (/\b(bot|claude|ai|agent|llm|robot|automation)\b/.test(lower)) return true
  return false
}

/**
 * Registra as tools de gate (request_gate_approval + approve_gate) em MODO CLOUD.
 *
 * Diferença crítica em relação à versão local (auxiliary.ts):
 *  - request_gate_approval: NUNCA inclui o PIN no retorno da tool — o PIN é
 *    enviado ao aprovador via Teams + e-mail fora do canal do agente (notifier).
 *    O agente só sabe que o PIN foi enviado, nunca qual é.
 *  - approve_gate: valida o PIN contra o CloudSecretStore isolado (não contra
 *    arquivo .gate-pins.json no workdir, que poderia ser lido pela Squad).
 *
 * Essas tools substituem request_gate_approval e approve_gate do registerAuxiliaryTools
 * quando o servidor roda em modo cloud (MCP_TRANSPORT=http).
 */
export function registerGateToolsCloud(
  server: McpServer,
  secretStore: SecretStore,
  notifier?: GraphNotifier,
): void {
  server.registerTool(
    'request_gate_approval',
    {
      title: 'Request Gate Approval (Cloud)',
      description:
        'Solicita aprovação humana para o gate de uma fase. Em modo cloud, o PIN é enviado ' +
        'diretamente ao aprovador via Microsoft Teams + e-mail corporativo — NUNCA retornado ' +
        'nesta resposta. O agente deve aguardar o humano digitar o PIN no chat para prosseguir.',
      inputSchema: {
        projectPath: z.string().describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z.number().int().min(0).max(5).describe('Número da fase aguardando aprovação'),
        approverEmail: z.string().email().describe('E-mail corporativo do aprovador humano — receberá o PIN via Teams e e-mail'),
      },
    },
    async ({ projectPath, phaseNumber: phase, approverEmail }) => {
      try {
        const config = readConfig(projectPath)
        const phaseState = config.phases[phase as PhaseNumber]
        if (phaseState.status !== 'awaiting_gate') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'PHASE_NOT_AWAITING_GATE',
                message: `Fase ${phase} não está aguardando aprovação (status: ${phaseState.status}).`,
              }, null, 2),
            }],
          }
        }

        const pin = String(randomInt(100000, 999999))
        const expiresAt = new Date(Date.now() + PIN_VALIDITY_MS).toISOString()

        // Armazena o PIN no CloudSecretStore (servidor, fora do workdir clonado —
        // nunca commitado na branch, nunca acessível pela Squad via GitHub API).
        await secretStore.putPin(phase, { pin, expiresAt, phaseNumber: phase })

        // Dispara notificação ao humano via Teams + e-mail. Se o notifier não
        // estiver configurado (ex: ambiente de dev local), apenas persiste o PIN.
        if (notifier) {
          try {
            await notifier.sendGatePin(approverEmail, phase, pin, expiresAt)
          } catch (notifErr) {
            // Falha de notificação não cancela o gate — o PIN foi armazenado.
            // O responsável pode requisitar um novo PIN se não receber.
            const errMsg = notifErr instanceof Error ? notifErr.message : String(notifErr)
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'pin_generated_notification_failed',
                  phase,
                  pinExpiresAt: expiresAt,
                  notificationError: errMsg,
                  message:
                    `PIN gerado e armazenado, mas a notificação falhou (${errMsg}). ` +
                    `Peça ao aprovador que solicite o PIN diretamente ou tente novamente. ` +
                    `ESTE RETORNO NÃO CONTÉM O PIN — o código nunca trafega pelo canal do agente.`,
                }, null, 2),
              }],
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'awaiting_human_pin',
              phase,
              approverEmail,
              pinExpiresAt: expiresAt,
              message:
                `PIN de aprovação enviado ao aprovador via Microsoft Teams e e-mail corporativo. ` +
                `O aprovador deve ler o código fora deste chat e digitá-lo aqui para confirmar. ` +
                `O PIN expira em 30 minutos (${expiresAt}). ` +
                `ESTE RETORNO NÃO CONTÉM O PIN — nunca trafega pelo canal do agente.`,
              nextStep: `Aguarde o aprovador digitar: approve_gate(projectPath, ${phase}, "<nome_aprovador>", "<PIN_6_dígitos>")`,
            }, null, 2),
          }],
        }
      } catch (err) {
        if (err instanceof MigrationError) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
            }],
          }
        }
        throw err
      }
    },
  )

  server.registerTool(
    'approve_gate',
    {
      title: 'Approve Gate (Cloud)',
      description:
        'Registra a aprovação humana para uma fase e emite o token que libera a fase seguinte. ' +
        'REQUER que request_gate_approval tenha sido chamado antes e que o humano forneça o PIN ' +
        'que recebeu via Teams/e-mail. NUNCA deve ser chamado por automação.',
      inputSchema: {
        projectPath: z.string().describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z.number().int().min(0).max(5),
        approverName: z.string().min(2).describe('Nome real do aprovador humano — sistemas automatizados são rejeitados'),
        humanPin: z.string().length(6).regex(/^\d{6}$/).describe('PIN de 6 dígitos recebido via Teams/e-mail'),
      },
    },
    async ({ projectPath, phaseNumber, approverName, humanPin }) => {
      try {
        if (isForbiddenApprover(approverName)) {
          throw new MigrationError(
            'GATE_TOKEN_INVALID',
            `approverName "${approverName}" identifica um sistema automatizado. ` +
              `A aprovação de gate deve ser feita por um humano com seu nome real.`,
          )
        }

        // Valida o PIN contra o CloudSecretStore — isolado do canal do agente.
        const pinEntry = await secretStore.getPin(phaseNumber)
        if (!pinEntry) {
          throw new MigrationError(
            'GATE_TOKEN_INVALID',
            `Nenhum PIN foi gerado para a Fase ${phaseNumber}. ` +
              `Chame request_gate_approval primeiro.`,
          )
        }

        // Verificação explícita de expiração — defesa em profundidade independente
        // da implementação de SecretStore (CloudSecretStore já filtra na getPin,
        // mas InMemorySecretStore não; verificar aqui garante comportamento correto
        // com qualquer implementação da porta).
        if (new Date(pinEntry.expiresAt).getTime() < Date.now()) {
          await secretStore.deletePin(phaseNumber)
          throw new MigrationError(
            'GATE_TOKEN_INVALID',
            `O PIN da Fase ${phaseNumber} expirou (${pinEntry.expiresAt}). ` +
              `Chame request_gate_approval novamente para gerar um novo PIN.`,
          )
        }

        if (pinEntry.pin !== humanPin) {
          throw new MigrationError(
            'GATE_TOKEN_INVALID',
            `PIN incorreto para a Fase ${phaseNumber}. Verifique o código recebido no Teams/e-mail.`,
          )
        }

        // PIN válido — consumir (uso único).
        await secretStore.deletePin(phaseNumber)

        const phase = phaseNumber as PhaseNumber
        let config = readConfig(projectPath)
        const approvedAt = new Date().toISOString()
        const gateToken = generateGateToken(projectPath, phase)

        config = {
          ...config,
          phases: {
            ...config.phases,
            [phase]: {
              ...config.phases[phase],
              status: 'approved',
              gateToken,
              approvedBy: approverName,
              approvedAt,
              completedAt: approvedAt,
            },
          },
        }
        writeConfig(projectPath, config)

        // Sincronia da branch de migração na fase 5 (cutover)
        let syncResult = null
        if (phase === 5) {
          const phase1Branch = config.phases[1]?.gitBranch
          const phase5Branch = config.phases[5]?.gitBranch
          if (phase1Branch && phase5Branch) {
            const baseBranch = phase1Branch.replace(/^jdk-migration\/phase-1-\d+$/, '') || 'main'
            const migrationBranch = `migrate/${baseBranch}`
            syncResult = await syncMigrationBranch(projectPath, migrationBranch, phase5Branch)
          }
        }

        const autoReport = await generateAuditReportSilent(projectPath)
        let finalReport = null
        if (phase === 5) {
          try { finalReport = await generateFinalReport(projectPath) } catch { /* não bloqueia */ }
        }

        void (async () => {
          try {
            const cfg = readConfig(projectPath)
            const phaseRoi = await computePhaseRoi(
              { phaseNumber: phase, startedAt: cfg.phases[phase].executedAt, completedAt: approvedAt, tokenUsage: undefined, outputJsonBytes: 0 },
              cfg.stack, cfg.multiModule, cfg.discoveryEffortDays ?? 0,
            )
            const existingRoi = cfg.roi ?? []
            writeConfig(projectPath, { ...cfg, roi: [...existingRoi.filter(r => r.phaseNumber !== phase), phaseRoi] })
          } catch { /* ROI não bloqueia */ }
        })()

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'approved',
              phase,
              gateToken,
              approvedBy: approverName,
              approvedAt,
              auditReport: autoReport,
              ...(finalReport ? { finalReport } : {}),
              ...(syncResult ? { syncMigrationBranch: syncResult } : {}),
              nextStep: phase === 5
                ? 'Migração concluída. Revise o relatório final e valide em produção.'
                : `Execute execute_phase(projectPath, ${phase + 1}, gateToken) para iniciar a Fase ${phase + 1}.`,
            }, null, 2),
          }],
        }
      } catch (err) {
        if (err instanceof MigrationError) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
            }],
          }
        }
        throw err
      }
    },
  )
}
