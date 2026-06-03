import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig, configExists } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { generateGateToken, getTokenIssuedAt } from '../../orchestrator/gate-validator.js'
import { rollbackPhase } from '../../orchestrator/git-checkpoint.js'
import { updatePhaseStatus } from '../../orchestrator/state-machine.js'
import { generateAuditReport, generateAuditReportSilent } from '../../report-generator/index.js'
import type { PhaseNumber } from '../../types.js'

const FORBIDDEN_APPROVER_NAMES = new Set(['bot', 'automation', 'ci', 'cd', 'system', 'auto'])

export function registerAuxiliaryTools(server: McpServer): void {
  server.registerTool(
    'get_phase_status',
    {
      title: 'Get Phase Status',
      description:
        'Retorna o status atual de todas as 6 fases de migração do projeto, ' +
        'incluindo tokens de gate, datas de aprovação e branches Git associadas.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
      },
    },
    async ({ projectPath }) => {
      if (!configExists(projectPath)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'not_initialized',
                  projectPath,
                  message:
                    'jdk-migration.config.json não encontrado. Execute a Skill de instalação primeiro.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      const config = readConfig(projectPath)
      const phaseSummary = (Object.entries(config.phases) as [string, (typeof config.phases)[PhaseNumber]][]).map(
        ([num, phase]) => ({
          phase: Number(num),
          status: phase.status,
          approvedBy: phase.approvedBy,
          approvedAt: phase.approvedAt,
          executedAt: phase.executedAt,
          gitBranch: phase.gitBranch,
          gitCommit: phase.gitCommit,
          hasGateToken: phase.gateToken !== null,
        }),
      )

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projectPath,
                sourceJdk: config.sourceJdk,
                targetJdk: config.targetJdk,
                stack: config.stack,
                buildSystem: config.buildSystem,
                phases: phaseSummary,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.registerTool(
    'approve_gate',
    {
      title: 'Approve Gate',
      description:
        'Registra a aprovação humana para uma fase e emite o token que libera a fase ' +
        'seguinte. NUNCA deve ser chamado por automação — approverName é obrigatório e ' +
        'não pode ser vazio ou identificar um sistema automatizado.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase a aprovar (0–5)'),
        approverName: z
          .string()
          .min(2)
          .describe('Nome completo do responsável pela aprovação humana'),
      },
    },
    async ({ projectPath, phaseNumber, approverName }) => {
      const normalizedName = approverName.trim().toLowerCase()
      if (FORBIDDEN_APPROVER_NAMES.has(normalizedName)) {
        throw new MigrationError(
          'GATE_TOKEN_INVALID',
          `approverName "${approverName}" não é permitido — approve_gate deve ser chamado por um humano, não por automação.`,
        )
      }

      const config = readConfig(projectPath)
      const phase = config.phases[phaseNumber as PhaseNumber]

      const token = generateGateToken(projectPath, phaseNumber as PhaseNumber)
      const now = new Date().toISOString()

      config.phases[phaseNumber as PhaseNumber] = {
        ...phase,
        status: 'approved',
        gateToken: token,
        approvedBy: approverName.trim(),
        approvedAt: now,
      }

      writeConfig(projectPath, config)

      // Gera relatório de auditoria automaticamente após cada aprovação de gate
      const autoReportPath = await generateAuditReportSilent(projectPath)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'approved',
                phaseNumber,
                approvedBy: approverName.trim(),
                approvedAt: now,
                tokenIssuedAt: getTokenIssuedAt(token)?.toISOString(),
                gateToken: token,
                auditReport: autoReportPath ?? null,
                message: `Gate da Fase ${phaseNumber} aprovado. Use o gateToken para liberar a Fase ${phaseNumber + 1} via execute_phase.`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.registerTool(
    'rollback_phase',
    {
      title: 'Rollback Phase',
      description:
        'Reverte uma fase aplicada via Git, restaurando o projeto ao estado anterior ' +
        'à execução da fase. Não requer token de gate.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase a reverter'),
      },
    },
    async ({ projectPath, phaseNumber }) => {
      const config = readConfig(projectPath)
      const phase = phaseNumber as PhaseNumber
      const phaseState = config.phases[phase]

      if (phaseState.status !== 'in_progress' && phaseState.status !== 'awaiting_gate' && phaseState.status !== 'failed') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} está com status '${phaseState.status}'. Só é possível reverter fases in_progress, awaiting_gate ou failed.`,
            }, null, 2),
          }],
        }
      }

      if (!phaseState.baseBranch || !phaseState.baseCommit) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} não possui informação de branch/commit base para rollback. A fase pode não ter sido iniciada via execute_phase.`,
            }, null, 2),
          }],
        }
      }

      await rollbackPhase(projectPath, {
        branchName: phaseState.gitBranch ?? '',
        baseBranch: phaseState.baseBranch,
        baseCommit: phaseState.baseCommit,
        phaseCommit: phaseState.gitCommit,
      })

      const updated = updatePhaseStatus(config, phase, 'rolled_back')
      writeConfig(projectPath, updated)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'rolled_back',
            phase,
            restoredBranch: phaseState.baseBranch,
            message: `Fase ${phase} revertida. Branch '${phaseState.gitBranch}' preservada como histórico.`,
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'generate_report',
    {
      title: 'Generate Report',
      description:
        'Gera o relatório consolidado de auditoria da migração, com trilha completa de ' +
        'decisões, aprovações por fase, arquivos modificados e issues em aberto. ' +
        'Salvo em .jdk-migration/audit-report-{timestamp}.html.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
      },
    },
    async ({ projectPath }) => {
      try {
        const result = await generateAuditReport(projectPath)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              reportPath: result.reportPath,
              phasesCompleted: result.phasesCompleted,
              phasesTotal: result.phasesTotal,
              openManualItems: result.openManualItems,
              criticalRisks: result.criticalRisks,
              message: `Relatório HTML gerado em ${result.reportPath}`,
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

