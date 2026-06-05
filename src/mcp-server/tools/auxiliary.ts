import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig, configExists } from '../../lib/config.js'
import type { MigrationStep } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { generateGateToken, getTokenIssuedAt } from '../../orchestrator/gate-validator.js'
import { rollbackPhase } from '../../orchestrator/git-checkpoint.js'
import { updatePhaseStatus } from '../../orchestrator/state-machine.js'
import { generateAuditReport, generateAuditReportSilent, generateFinalReport } from '../../report-generator/index.js'
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

      // Fase 5 (última): gera report incremental + audit-report-final.html fixo
      // Demais fases: apenas report incremental com timestamp
      let autoReportPath: string | null = null
      let finalReportPath: string | null = null

      if (phaseNumber === 5) {
        const finalResult = await generateFinalReport(projectPath)
        autoReportPath = finalResult.timestamped
        finalReportPath = finalResult.final
      } else {
        autoReportPath = await generateAuditReportSilent(projectPath)
      }

      const isFinalPhase = phaseNumber === 5
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
                ...(isFinalPhase ? { finalReport: finalReportPath ?? null } : {}),
                message: isFinalPhase
                  ? `Migracao concluida! Gate da Fase 5 aprovado por ${approverName.trim()}. Relatorio final salvo em audit-report-final.html.`
                  : `Gate da Fase ${phaseNumber} aprovado. Use o gateToken para liberar a Fase ${phaseNumber + 1} via execute_phase.`,
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
    'update_step_status',
    {
      title: 'Update Step Status',
      description:
        'Registra ou atualiza o progresso de um step individual dentro da fase ativa de migração. ' +
        'Persiste os dados em jdk-migration.config.json para que generate_report inclua ' +
        'automaticamente o progresso dos steps no relatório HTML de auditoria. ' +
        'Chame este tool sempre que um step for concluído, iniciado ou pulado. ' +
        'Se reportMode="phase-gate-step" estiver configurado, gera um novo audit-report-<timestamp>.html ' +
        'automaticamente após cada chamada, refletindo o progresso atualizado dos steps.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        stepNum: z
          .number()
          .int()
          .min(1)
          .describe('Número sequencial do step (1, 2, 3…)'),
        owner: z
          .enum(['claude', 'you'])
          .describe('Responsável: "claude" para Claude Code, "you" para o usuário humano'),
        phase: z
          .enum(['A', 'B', 'C', 'D'])
          .describe('Fase do plano de execução — A: Verificações/Decisões, B: Implementação, C: Validação, D: Limpeza'),
        task: z
          .string()
          .describe('Descrição curta da tarefa do step'),
        status: z
          .enum(['done', 'pending', 'skipped'])
          .describe('Status atual: done=concluído, pending=pendente, skipped=pulado intencionalmente'),
        commit: z
          .string()
          .optional()
          .describe('Hash curto do commit Git associado (ex: "235acc2"). Opcional.'),
        note: z
          .string()
          .optional()
          .describe('Nota adicional: arquivos afetados, decisão tomada, motivo do skip. Opcional.'),
      },
    },
    async ({ projectPath, stepNum, owner, phase, task, status, commit, note }) => {
      const config = readConfig(projectPath)

      const steps: MigrationStep[] = config.steps ?? []
      const existingIdx = steps.findIndex(s => s.num === stepNum)

      const updatedStep: MigrationStep = {
        id: `step-${stepNum}`,
        num: stepNum,
        owner,
        phase,
        task,
        status,
        ...(commit ? { commit } : {}),
        ...(note ? { note } : {}),
        ...(status === 'done' ? { completedAt: new Date().toISOString() } : {}),
      }

      if (existingIdx >= 0) {
        steps[existingIdx] = updatedStep
      } else {
        steps.push(updatedStep)
        steps.sort((a, b) => a.num - b.num)
      }

      config.steps = steps
      writeConfig(projectPath, config)

      // Gera audit report automaticamente se reportMode === 'phase-gate-step'
      let autoReportPath: string | null = null
      if (config.reportMode === 'phase-gate-step') {
        autoReportPath = await generateAuditReportSilent(projectPath)
      }

      const doneCount = steps.filter(s => s.status === 'done').length

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'ok',
            step: updatedStep,
            totalSteps: steps.length,
            doneSteps: doneCount,
            message: `Step ${stepNum} registrado como "${status}". ${doneCount}/${steps.length} steps concluídos.`,
            ...(autoReportPath ? { auditReport: autoReportPath } : {}),
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'record_manual_phase',
    {
      title: 'Record Manual Phase',
      description:
        'Registra uma fase que foi executada manualmente fora do MCP — por exemplo, quando ' +
        'o execute_phase falhou por problema ambiental (EINVAL, ENOENT) e o trabalho foi ' +
        'realizado diretamente na linha de comando. Avança a fase para awaiting_gate, ' +
        'preservando a trilha de auditoria, e permite que approve_gate seja chamado ' +
        'normalmente. NÃO aplica nenhuma transformação — apenas registra o estado. ' +
        'Use o parâmetro steps para registrar todos os steps do trabalho manual em uma ' +
        'única chamada atômica — isso garante que a seção "Progresso dos Steps" do ' +
        'relatório HTML fique completa sem precisar chamar update_step_status N vezes.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase que foi executada manualmente (0–5)'),
        gitBranch: z
          .string()
          .describe(
            'Nome da branch Git onde as alterações manuais foram commitadas. ' +
            'Pode ser a branch da fase (jdk-migration/phase-N-...) ou a branch principal de migração.',
          ),
        gitCommit: z
          .string()
          .describe('Hash (curto ou completo) do commit que representa o trabalho realizado.'),
        recipesApplied: z
          .array(z.string())
          .optional()
          .default([])
          .describe('Lista das recipes/transformações aplicadas manualmente (para auditoria).'),
        note: z
          .string()
          .describe(
            'Descrição do que foi feito manualmente e o motivo pelo qual o execute_phase ' +
            'não pôde ser usado (ex: "spawn EINVAL — mvn.cmd executado diretamente via CLI").',
          ),
        steps: z
          .array(z.object({
            num:    z.number().int().min(1).describe('Número sequencial do step (1, 2, 3…)'),
            owner:  z.enum(['claude', 'you']).describe('"claude" ou "you"'),
            phase:  z.enum(['A', 'B', 'C', 'D']).describe('A=Verificações, B=Implementação, C=Validação, D=Limpeza'),
            task:   z.string().describe('Descrição curta da tarefa'),
            status: z.enum(['done', 'pending', 'skipped']),
            commit: z.string().optional().describe('Hash curto do commit Git associado'),
            note:   z.string().optional().describe('Nota adicional ou decisão tomada'),
          }))
          .optional()
          .default([])
          .describe(
            'Steps detalhados do trabalho realizado. Quando fornecidos, são mesclados com ' +
            'os steps existentes no config (upsert por num), garantindo que a seção ' +
            '"Progresso dos Steps" do relatório fique completa em uma única chamada. ' +
            'Se omitido, apenas um step de auditoria genérico [MANUAL] é registrado.',
          ),
      },
    },
    async ({ projectPath, phaseNumber, gitBranch, gitCommit, recipesApplied = [], note, steps: incomingSteps = [] }) => {
      const config = readConfig(projectPath)
      const phase = phaseNumber as PhaseNumber
      const phaseState = config.phases[phase]

      // Permite registrar a partir de pending, in_progress ou failed
      const allowedFromStatuses = ['pending', 'in_progress', 'failed']
      if (!allowedFromStatuses.includes(phaseState.status)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} está com status '${phaseState.status}'. ` +
                `record_manual_phase só pode ser chamado em fases com status: ${allowedFromStatuses.join(', ')}.`,
            }, null, 2),
          }],
        }
      }

      const now = new Date().toISOString()

      // Grava diretamente no config sem passar pela state machine (é um override manual)
      config.phases[phase] = {
        ...phaseState,
        status: 'awaiting_gate',
        executedAt: phaseState.executedAt ?? now,
        gitBranch,
        gitCommit,
        baseBranch: phaseState.baseBranch ?? gitBranch,
        baseCommit: phaseState.baseCommit ?? gitCommit,
      }

      // ── Merge de steps: upsert por num ────────────────────────────────────────
      const existingSteps: MigrationStep[] = config.steps ?? []

      let stepsToMerge: MigrationStep[]
      if (incomingSteps.length > 0) {
        // O agente forneceu steps detalhados — usa-os diretamente
        stepsToMerge = incomingSteps.map(s => ({
          id: `step-${s.num}`,
          num: s.num,
          owner: s.owner,
          phase: s.phase,
          task: s.task,
          status: s.status,
          ...(s.commit ? { commit: s.commit } : {}),
          ...(s.note   ? { note: s.note }     : {}),
          ...(s.status === 'done' ? { completedAt: now } : {}),
        }))
      } else {
        // Fallback: registra um único step genérico de auditoria
        const nextNum = existingSteps.length > 0
          ? Math.max(...existingSteps.map(s => s.num)) + 1
          : 1
        stepsToMerge = [{
          id: `manual-phase-${phase}-${Date.now()}`,
          num: nextNum,
          owner: 'claude',
          phase: 'B',
          task: `[MANUAL] Fase ${phase} executada fora do MCP`,
          status: 'done',
          commit: gitCommit.slice(0, 8),
          note: `${note}${recipesApplied.length > 0 ? ` | Recipes: ${recipesApplied.join(', ')}` : ''}`,
          completedAt: now,
        }]
      }

      // Upsert: substitui step existente de mesmo num, adiciona os novos
      const mergedSteps = [...existingSteps]
      for (const incoming of stepsToMerge) {
        const idx = mergedSteps.findIndex(s => s.num === incoming.num)
        if (idx >= 0) {
          mergedSteps[idx] = incoming
        } else {
          mergedSteps.push(incoming)
        }
      }
      mergedSteps.sort((a, b) => a.num - b.num)
      config.steps = mergedSteps

      writeConfig(projectPath, config)

      const autoReportPath = await generateAuditReportSilent(projectPath)

      const doneCount  = mergedSteps.filter(s => s.status === 'done').length
      const totalCount = mergedSteps.length

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'awaiting_gate',
            phase,
            gitBranch,
            gitCommit,
            recipesApplied,
            note,
            stepsRegistered: stepsToMerge.length,
            stepsSummary: `${doneCount}/${totalCount} steps concluídos`,
            auditReport: autoReportPath ?? null,
            message:
              `Fase ${phase} registrada como concluída manualmente (awaiting_gate). ` +
              `${stepsToMerge.length} step(s) gravados. ` +
              `Execute approve_gate(projectPath, ${phase}, "<seu nome>") para liberar a Fase ${phase + 1}.`,
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

