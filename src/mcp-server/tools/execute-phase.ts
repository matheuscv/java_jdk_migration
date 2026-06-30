import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readConfig, writeConfig } from '../../lib/config.js'
import { readConfigFromStorage, writeConfigToStorage } from '../../lib/config-storage.js'
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
import { createLocalFsStorage } from '../../adapters/local/local-fs-storage.js'
import { createLocalGitCli } from '../../adapters/local/local-git-cli.js'
import type { MigrationStorage } from '../../ports/storage.js'
import type { GitGateway } from '../../ports/git-gateway.js'
import { runBuild, runTests } from '../../orchestrator/build-validator.js'
import { executePhaseTransform } from '../../transform-engine/index.js'
import { generateAuditReportSilent, generateAuditChecklist, generatePhase5Report } from '../../report-generator/index.js'
import { runMigrationAudit } from '../../static-analysis/migration-audit.js'
import { computePhaseRoi } from '../../roi-tracker/index.js'
import type { PhaseNumber } from '../../types.js'

export interface ExecutePhaseAdapters {
  /** Storage usado para ler/escrever jdk-migration.config.json e demais arquivos de estado. */
  storage: MigrationStorage
  /** Gateway Git — branch, commit, PR, rollback. */
  git: GitGateway
}

export function registerExecutePhase(server: McpServer, adapters?: ExecutePhaseAdapters): void {
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
        tokenUsage: z
          .object({
            inputTokens:          z.number().int().nonnegative(),
            outputTokens:         z.number().int().nonnegative(),
            cacheCreationTokens:  z.number().int().nonnegative().optional()
              .describe('cache_creation_input_tokens da API Claude — $3,75/MTok'),
            cacheReadTokens:      z.number().int().nonnegative().optional()
              .describe('cache_read_input_tokens da API Claude — $0,30/MTok. Dominante em sessões longas do Claude Code.'),
          })
          .optional()
          .describe(
            'Uso real de tokens desta fase. Inclua cacheCreationTokens e cacheReadTokens ' +
              'para custo preciso — esses campos dominam o gasto real em sessões longas. ' +
              'Quando ausente, o ROI tracker estima apenas a partir do tamanho do output JSON.',
          ),
      },
    },
    async ({ projectPath, phaseNumber, gateToken = '', dryRun = false, tokenUsage }) => {
      // Defaults locais mantêm comportamento idêntico ao pré-M5 quando adapters
      // não são injetados (modo local / stdio). Cloud mode injeta GitWorkspaceStorage
      // + GitHubApiGateway via createCloudMcpServer() em create-server.ts.
      const resolvedAdapters: ExecutePhaseAdapters = adapters ?? {
        storage: createLocalFsStorage(projectPath),
        git: createLocalGitCli(),
      }
      try {
        const result = await executePhase(projectPath, phaseNumber as PhaseNumber, gateToken, dryRun, tokenUsage, resolvedAdapters)
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
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number },
  adapters?: ExecutePhaseAdapters,
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
    return await _executePhaseUnlocked(projectPath, phase, gateToken, dryRun, tokenUsage, adapters)
  } finally {
    try { rmSync(lockPath) } catch { /* ignore */ }
  }
}

async function _executePhaseUnlocked(
  projectPath: string,
  phase: PhaseNumber,
  gateToken: string,
  dryRun: boolean,
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number },
  adapters?: ExecutePhaseAdapters,
) {
  // Adapters resolvidos: quando não injetados, usa implementações locais idênticas
  // ao comportamento pré-M5. Cloud mode fornece GitWorkspaceStorage + GitHubApiGateway.
  const storage = adapters?.storage ?? createLocalFsStorage(projectPath)
  const git = adapters?.git ?? createLocalGitCli()

  // ── 2. Ler config ─────────────────────────────────────────────────────────
  let config = await readConfigFromStorage(storage)

  // ── 3a. Se a fase está 'failed', o git já foi revertido automaticamente.
  //        Resetar para 'pending' para permitir retry sem edição manual do config.
  if (config.phases[phase].status === 'failed') {
    config = updatePhaseStatus(config, phase, 'pending')
    await writeConfigToStorage(storage, config)
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
  if (!await git.isWorkdirClean(projectPath)) {
    throw new MigrationError(
      'GIT_DIRTY_WORKDIR',
      'O working directory possui alterações não commitadas. Faça commit ou stash antes de executar uma fase.',
    )
  }

  // ── 7. Criar branch isolada ────────────────────────────────────────────────
  const checkpoint = await git.createPhaseBranch(projectPath, phase)

  // ── 8. Marcar fase como in_progress ────────────────────────────────────────
  config = updatePhaseStatus(config, phase, 'in_progress', {
    executedAt: new Date().toISOString(),
    gitBranch: checkpoint.branchName,
    baseBranch: checkpoint.baseBranch,
    baseCommit: checkpoint.baseCommit,
  })
  await writeConfigToStorage(storage, config)

  // ── 9. Aplicar transformação ───────────────────────────────────────────────
  let transformResult
  try {
    transformResult = await executePhaseTransform(phase, config, projectPath, false)
  } catch (err) {
    config = updatePhaseStatus(config, phase, 'failed')
    await writeConfigToStorage(storage, config)
    await git.rollbackPhase(projectPath, checkpoint)
    throw err
  }

  // ── 10. Build ──────────────────────────────────────────────────────────────
  // Fase 0 = baseline: compilar/testar com o JDK de origem (JDK 6/8).
  // Fases 1–5: usar o JDK destino (JDK 21).
  const jdkHome = phase === 0
    ? (config.sourceJdkHome ?? process.env['SOURCE_JAVA_HOME'] ?? process.env['JAVA_HOME'])
    : (config.targetJdkHome ?? process.env['JAVA_HOME'])
  const buildToolOptions = {
    mavenExecutable: config.mavenExecutable,
    gradleExecutable: config.gradleExecutable,
    targetJdkHome: jdkHome,
  }
  const buildResult = await runBuild(projectPath, config.buildSystem as 'maven' | 'gradle', buildToolOptions)
  if (!buildResult.success) {
    config = updatePhaseStatus(config, phase, 'failed')
    await writeConfigToStorage(storage, config)
    await git.rollbackPhase(projectPath, checkpoint)

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
    await writeConfigToStorage(storage, config)
    await git.rollbackPhase(projectPath, checkpoint)
    throw new MigrationError(
      'BUILD_FAILED',
      `Testes falharam na fase ${phase}. Rollback aplicado automaticamente.`,
      { testsFailed: testResult.testsFailed, stderr: testResult.stderr.slice(0, 2000) },
    )
  }

  // ── 12. Commit ────────────────────────────────────────────────────────────
  const phaseCommit = await git.commitPhaseChanges(
    projectPath,
    phase,
    transformResult.recipesApplied.join(', '),
  )
  checkpoint.phaseCommit = phaseCommit

  // ── 13. Fase → awaiting_gate ──────────────────────────────────────────────
  config = updatePhaseStatus(config, phase, 'awaiting_gate', {
    gitCommit: phaseCommit,
    // Persiste detalhes dos runners customizados para uso nas gate questions
    ...(transformResult.runnerDetails ? { runnerDetails: transformResult.runnerDetails } : {}),
  })
  await writeConfigToStorage(storage, config)

  // ── 13a. Auditoria final de migração (apenas fase 5) ─────────────────────
  let migrationAudit = null
  if (phase === 5) {
    try {
      migrationAudit = await runMigrationAudit(projectPath, config.targetJdk ?? '21')
      // Gera audit-report-phase-5.md com [X] nos critérios atendidos
      const { join } = await import('node:path')
      generateAuditChecklist(
        join(projectPath, '.jdk-migration'),
        migrationAudit,
        5,
        config,
      )
    } catch { /* não bloqueia a fase */ }
  }

  // ── 13b. Relatório automático de auditoria ────────────────────────────────
  // Fase 5: gera timestamp + audit-report-phase-5.html (nome fixo, simétrico ao phase-0.md)
  // Demais fases: apenas timestamp
  let autoReportPath: string | null = null
  let phase5ReportPath: string | null = null
  if (phase === 5) {
    const phase5Result = await generatePhase5Report(projectPath, migrationAudit ?? undefined)
    autoReportPath = phase5Result.timestamped
    phase5ReportPath = phase5Result.phase5
  } else {
    autoReportPath = await generateAuditReportSilent(projectPath)
  }

  // ── 14. PR (opcional — não falha se API/gh ausente) ───────────────────────
  const prUrl = await git.createPullRequest(
    projectPath,
    phase,
    checkpoint,
    transformResult.diffSummary,
  )
  if (prUrl) {
    config = { ...config, phases: { ...config.phases, [phase]: { ...config.phases[phase], prUrl } } }
    await writeConfigToStorage(storage, config)
  }

  // ── 15. Calcular e persistir ROI desta fase ───────────────────────────────
  const result = {
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
    ...(phase5ReportPath ? { phase5Report: phase5ReportPath } : {}),
    ...(migrationAudit ? { migrationAudit } : {}),
    nextStep: phase === 5
      ? `Auditoria concluída. Relatório fixo salvo em audit-report-phase-5.html. Revise o campo migrationAudit acima e execute approve_gate(projectPath, 5, "<seu nome>") para concluir a migração.`
      : `Execute approve_gate(projectPath, ${phase}, "<seu nome>") para liberar a Fase ${phase + 1}.`,
  }

  // ROI é calculado de forma não-bloqueante — não atrasa a resposta da fase
  const outputJsonBytes = JSON.stringify(result).length
  void (async () => {
    try {
      const cfg = readConfig(projectPath)
      const phaseRoi = await computePhaseRoi(
        {
          phaseNumber: phase,
          startedAt:   cfg.phases[phase].executedAt,
          completedAt: null,  // preenchido no approve_gate
          tokenUsage,
          outputJsonBytes,
        },
        cfg.stack,
        cfg.multiModule,
        cfg.discoveryEffortDays ?? 0,
      )
      const latestCfg = readConfig(projectPath)
      const existingRoi = latestCfg.roi ?? []
      writeConfig(projectPath, {
        ...latestCfg,
        roi: [...existingRoi.filter(r => r.phaseNumber !== phase), phaseRoi],
      })
      ;(result as Record<string, unknown>)['roi'] = phaseRoi
    } catch { /* ROI não bloqueia a fase */ }
  })()

  return result
}
