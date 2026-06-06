import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { canExecutePhase, updatePhaseStatus } from '../../orchestrator/state-machine.js'
import { validateGateToken } from '../../orchestrator/gate-validator.js'
import {
  isWorkdirClean,
  createPhaseBranch,
  commitPhaseChanges,
  rollbackPhase,
  createPullRequest,
} from '../../orchestrator/git-checkpoint.js'
import { runBuild, runTests } from '../../orchestrator/build-validator.js'
import { executePhaseTransform } from '../../transform-engine/index.js'
import { generateAuditReportSilent } from '../../report-generator/index.js'
import type { PhaseNumber } from '../../types.js'

export function registerExecutePhase(server: McpServer): void {
  server.registerTool(
    'execute_phase',
    {
      title: 'Execute Phase',
      description:
        'Aplica uma fase de migração aprovada. Exige o token do gate da fase anterior. ' +
        'Cada fase cria uma branch Git isolada — em caso de falha de build, o rollback ' +
        'é automático. Suporta dryRun para preview do diff sem aplicar mudanças.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase a executar (0–5)'),
        gateToken: z
          .string()
          .optional()
          .default('')
          .describe(
            'Token emitido por approve_gate ao aprovar a fase anterior. ' +
              'Fase 0 não requer token.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Se true, exibe o diff sem modificar arquivos. Recomendado antes de executar ' +
              'fases de alta e crítica criticidade.',
          ),
      },
    },
    async ({ projectPath, phaseNumber, gateToken = '', dryRun = false }) => {
      try {
        const result = await executePhase(projectPath, phaseNumber as PhaseNumber, gateToken, dryRun)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        if (err instanceof MigrationError) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: err.code, message: err.message, details: err.details }, null, 2),
            }],
          }
        }
        throw err
      }
    },
  )
}

export { executePhase as executePhaseForTest }

async function executePhase(
  projectPath: string,
  phase: PhaseNumber,
  gateToken: string,
  dryRun: boolean,
) {
  // ── 1. Lock ────────────────────────────────────────────────────────────────
  const lockPath = join(projectPath, '.jdk-migration', 'lock')
  if (existsSync(lockPath)) {
    throw new MigrationError(
      'LOCK_FILE_EXISTS',
      `execute_phase já está em execução em ${projectPath}. Aguarde ou remova ${lockPath}.`,
    )
  }
  mkdirSync(join(projectPath, '.jdk-migration'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))

  try {
    return await _executePhaseUnlocked(projectPath, phase, gateToken, dryRun)
  } finally {
    try { rmSync(lockPath) } catch { /* ignore */ }
  }
}

async function _executePhaseUnlocked(
  projectPath: string,
  phase: PhaseNumber,
  gateToken: string,
  dryRun: boolean,
) {
  // ── 2. Ler config ─────────────────────────────────────────────────────────
  let config = readConfig(projectPath)

  // ── 3a. Se a fase está 'failed', o git já foi revertido automaticamente.
  //        Resetar para 'pending' para permitir retry sem edição manual do config.
  if (config.phases[phase].status === 'failed') {
    config = updatePhaseStatus(config, phase, 'pending')
    writeConfig(projectPath, config)
  }

  // ── 3. Verificar se pode executar esta fase ───────────────────────────────
  if (!canExecutePhase(config, phase)) {
    const prevPhase = phase > 0 ? config.phases[(phase - 1) as PhaseNumber] : null
    throw new MigrationError(
      'PHASE_OUT_OF_ORDER',
      phase === 0
        ? 'Fase 0 já foi executada ou não está no estado pending.'
        : `Fase ${phase} requer que a fase ${phase - 1} esteja 'approved'. Estado atual: '${prevPhase?.status}'.`,
      { phase },
    )
  }

  // ── 4. Validar token do gate (fases 1–5) ─────────────────────────────────
  if (phase > 0) {
    const prevPhase = (phase - 1) as PhaseNumber
    if (!validateGateToken(gateToken, projectPath, prevPhase)) {
      throw new MigrationError(
        'GATE_TOKEN_INVALID',
        `Token de gate inválido ou expirado para a fase ${prevPhase}. ` +
          `Execute approve_gate(${prevPhase}) para gerar um novo token.`,
        { phase },
      )
    }
  }

  // ── 5. dryRun — preview sem aplicar ───────────────────────────────────────
  if (dryRun) {
    const preview = await executePhaseTransform(phase, config, projectPath, true)
    return {
      status: 'dry_run',
      phase,
      diffSummary: preview.diffSummary,
      recipesWouldApply: preview.recipesApplied,
      message: 'dryRun concluído. Chame execute_phase sem dryRun para aplicar as transformações.',
    }
  }

  // ── 6. Verificar workdir limpo ─────────────────────────────────────────────
  if (!await isWorkdirClean(projectPath)) {
    throw new MigrationError(
      'GIT_DIRTY_WORKDIR',
      'O working directory possui alterações não commitadas. Faça commit ou stash antes de executar uma fase.',
    )
  }

  // ── 7. Criar branch isolada ────────────────────────────────────────────────
  const checkpoint = await createPhaseBranch(projectPath, phase)

  // ── 8. Marcar fase como in_progress ────────────────────────────────────────
  config = updatePhaseStatus(config, phase, 'in_progress', {
    executedAt: new Date().toISOString(),
    gitBranch: checkpoint.branchName,
    baseBranch: checkpoint.baseBranch,
    baseCommit: checkpoint.baseCommit,
  })
  writeConfig(projectPath, config)

  // ── 9. Aplicar transformação ───────────────────────────────────────────────
  let transformResult
  try {
    transformResult = await executePhaseTransform(phase, config, projectPath, false)
  } catch (err) {
    config = updatePhaseStatus(config, phase, 'failed')
    writeConfig(projectPath, config)
    await rollbackPhase(projectPath, checkpoint)
    throw err
  }

  // ── 10. Build ──────────────────────────────────────────────────────────────
  const buildToolOptions = {
    mavenExecutable: config.mavenExecutable,
    gradleExecutable: config.gradleExecutable,
    targetJdkHome: config.targetJdkHome ?? process.env['JAVA_HOME'],
  }
  const buildResult = await runBuild(projectPath, config.buildSystem as 'maven' | 'gradle', buildToolOptions)
  if (!buildResult.success) {
    config = updatePhaseStatus(config, phase, 'failed')
    writeConfig(projectPath, config)
    await rollbackPhase(projectPath, checkpoint)

    if (buildResult.failureReason === 'missing_artifact') {
      throw new MigrationError(
        'BUILD_FAILED',
        `Build falhou na fase ${phase}: artifact(s) Maven inacessível(is) — provavelmente dependência privada ausente do repositório local ou de um registry interno não configurado. ` +
          `Configure 'artifactRegistry' em jdk-migration.config.json ou garanta que o registry interno está acessível. Rollback aplicado.`,
        { failureReason: 'missing_artifact', missingArtifacts: buildResult.missingArtifacts, exitCode: buildResult.exitCode },
      )
    }
    if (buildResult.failureReason === 'command_not_found') {
      throw new MigrationError(
        'BUILD_FAILED',
        `Build falhou na fase ${phase}: ferramenta de build não encontrada no PATH do processo MCP. ` +
          `Adicione o diretório bin do Maven/Gradle à variável PATH no env do MCP server em ~/.claude.json e reinicie o Claude Code.`,
        { failureReason: 'command_not_found', stderr: buildResult.stderr },
      )
    }

    throw new MigrationError(
      'BUILD_FAILED',
      `Build falhou na fase ${phase} (${buildResult.failureReason}). Rollback aplicado automaticamente.`,
      { exitCode: buildResult.exitCode, stderr: buildResult.stderr.slice(0, 2000) },
    )
  }

  // ── 11. Testes ────────────────────────────────────────────────────────────
  const testResult = await runTests(projectPath, config.buildSystem as 'maven' | 'gradle', buildToolOptions)
  if (!testResult.success) {
    config = updatePhaseStatus(config, phase, 'failed')
    writeConfig(projectPath, config)
    await rollbackPhase(projectPath, checkpoint)
    throw new MigrationError(
      'BUILD_FAILED',
      `Testes falharam na fase ${phase}. Rollback aplicado automaticamente.`,
      { testsFailed: testResult.testsFailed, stderr: testResult.stderr.slice(0, 2000) },
    )
  }

  // ── 12. Commit ────────────────────────────────────────────────────────────
  const phaseCommit = await commitPhaseChanges(
    projectPath,
    phase,
    transformResult.recipesApplied.join(', '),
  )
  checkpoint.phaseCommit = phaseCommit

  // ── 13. Fase → awaiting_gate ──────────────────────────────────────────────
  config = updatePhaseStatus(config, phase, 'awaiting_gate', {
    gitCommit: phaseCommit,
  })
  writeConfig(projectPath, config)

  // ── 13a. Relatório automático de auditoria ────────────────────────────────
  const autoReportPath = await generateAuditReportSilent(projectPath)

  // ── 14. PR (opcional — não falha se gh ausente) ───────────────────────────
  const prUrl = await createPullRequest(
    projectPath,
    phase,
    checkpoint,
    transformResult.diffSummary,
  )
  if (prUrl) {
    config = { ...config, phases: { ...config.phases, [phase]: { ...config.phases[phase], prUrl } } }
    writeConfig(projectPath, config)
  }

  return {
    status: 'awaiting_gate',
    phase,
    branchName: checkpoint.branchName,
    commit: phaseCommit,
    prUrl,
    recipesApplied: transformResult.recipesApplied,
    filesModified: transformResult.filesModified,
    buildPassed: true,
    testsPassed: testResult.testsPassed,
    diffSummary: transformResult.diffSummary,
    auditReport: autoReportPath ?? null,
    nextStep: `Execute approve_gate(projectPath, ${phase}, "<seu nome>") para liberar a Fase ${phase + 1}.`,
  }
}
