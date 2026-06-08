import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MigrationError } from '../lib/errors.js'
import { runProcess } from '../lib/process-runner.js'
import type { MigrationAuditResult } from '../static-analysis/migration-audit.js'

// ─── Grupo de critérios para o checklist MD ──────────────────────────────────
const AUDIT_GROUPS: Array<{ prefix: string; label: string; ids: string[] }> = [
  { prefix: 'A', label: 'Build & Infraestrutura (A1–A8)', ids: ['compiler-version','javax-imports','spring-boot-version','internal-deps','container-ci','runtime-evidence','obsolete-props','output-bytecode'] },
  { prefix: 'C', label: 'Análise Avançada (C1–C12)',     ids: ['actual-bytecode','sun-internal-imports','security-manager','removed-jvm-flags','nashorn','add-opens','annotation-processors','finalize-override','mvn-jvm-config','serialization-risk','javax-script','reflective-internal'] },
  { prefix: 'D', label: 'Fechamento (D1–D5)',             ids: ['removed-apis','bytecode-manip-libs','maven-plugin-versions','maven-jdk-profiles','k8s-manifests'] },
]

/**
 * Gera audit-report-phase-0.md (baseline pré-migração) ou
 * audit-report-phase-5.md (resultado pós-migração com [X] nos critérios ok).
 * Não lança exceção.
 */
export function generateAuditChecklist(
  migrationDir: string,
  audit: MigrationAuditResult,
  phase: 0 | 5,
  config: any,
): void {
  try {
    const sourceJdk = config?.sourceJdk ?? '?'
    const targetJdk = audit.targetJdk ?? '21'
    const generatedAt = new Date(audit.generatedAt).toISOString().slice(0, 10)
    const isBaseline = phase === 0

    const title = isBaseline
      ? `# Auditoria de Migração JDK — Baseline (Fase 0 — Pré-Migração)`
      : `# Auditoria de Migração JDK — Resultado Final (Fase 5 — Pós-Migração)`

    const intro = isBaseline
      ? `> ℹ️  Este é o **baseline pré-migração**. Registra o estado inicial do projeto para rastreamento.\n> Itens marcados \`[ ]\` = pendentes. Após a Fase 5 será gerado \`audit-report-phase-5.md\` com o resultado final.`
      : (() => {
          const finalStatus = audit.allOk
            ? `> ✅ **STATUS FINAL: PROJETO MIGRADO COM SUCESSO** — Todos os ${audit.criteria.length} critérios atendidos.`
            : `> ❌ **STATUS FINAL: PROJETO APRESENTA ISSUES QUE AINDA O LIGA A JDK ${sourceJdk}** — ${audit.summary.fail} falha(s) e ${audit.summary.warning} aviso(s) detectados.`
          return finalStatus
        })()

    const criteriaMap = new Map(audit.criteria.map(c => [c.id, c]))

    const groupsHtml = AUDIT_GROUPS.map(g => {
      const lines: string[] = [`## Grupo ${g.prefix} — ${g.label}`]
      g.ids.forEach((id, idx) => {
        const num = `${g.prefix}${idx + 1}`
        const c = criteriaMap.get(id)
        if (!c) return
        const checked = !isBaseline && c.status === 'ok' ? 'X' : ' '
        const icon = c.status === 'ok' ? '✅' : c.status === 'warning' ? '⚠️' : '❌'
        const statusStr = isBaseline ? '' : ` ${icon}`
        lines.push(`- [${checked}] **${num}** — ${c.label}${statusStr}`)
        if (c.detail) lines.push(`  > ${c.detail}`)
        if (!isBaseline && c.action && c.status !== 'ok') lines.push(`  > 💡 ${c.action}`)
      })
      return lines.join('\n')
    }).join('\n\n')

    const summaryRows = AUDIT_GROUPS.flatMap(g =>
      g.ids.map((id, idx) => {
        const num = `${g.prefix}${idx + 1}`
        const c = criteriaMap.get(id)
        if (!c) return ''
        const icon = c.status === 'ok' ? '✅ OK' : c.status === 'warning' ? '⚠️ Atenção' : '❌ Falha'
        const detail = c.detail.length > 90 ? c.detail.slice(0, 87) + '...' : c.detail
        return `| ${num} | ${c.label} | ${icon} | ${detail} |`
      }).filter(Boolean)
    ).join('\n')

    const summaryBlock = [
      '## Resumo dos 25 Critérios',
      '',
      `| # | Critério | Status | Detalhe |`,
      `|---|---------|--------|---------|`,
      summaryRows,
    ].join('\n')

    const finalBanner = !isBaseline
      ? [
          '---',
          '',
          audit.allOk
            ? `## ✅ STATUS FINAL: PROJETO MIGRADO COM SUCESSO\n\nTodos os ${audit.criteria.length} critérios de auditoria foram atendidos. O projeto não possui artefatos ligados ao JDK ${sourceJdk}.`
            : `## ❌ STATUS FINAL: PROJETO APRESENTA ISSUES QUE AINDA O LIGA A JDK ${sourceJdk}\n\n${audit.summary.fail} critério(s) com falha e ${audit.summary.warning} com atenção. Revise os itens acima antes do cutover.`,
          '',
        ].join('\n')
      : ''

    const md = [
      title,
      '',
      `> Gerado em: ${generatedAt} | JDK ${sourceJdk} → ${targetJdk}`,
      intro,
      '',
      '---',
      '',
      groupsHtml,
      '',
      '---',
      '',
      summaryBlock,
      '',
      finalBanner,
    ].join('\n')

    const filename = isBaseline ? 'audit-report-phase-0.md' : 'audit-report-phase-5.md'
    writeFileSync(join(migrationDir, filename), md, 'utf-8')
  } catch {
    // Falha silenciosa
  }
}

export interface AuditReportResult {
  reportPath: string
  phasesCompleted: number
  phasesTotal: number
  openManualItems: number
  criticalRisks: number
}

/**
 * Versão silenciosa — não lança exceção. Usada para geração automática ao fim de cada fase.
 * Retorna o caminho do relatório gerado ou null em caso de falha.
 */
export async function generateAuditReportSilent(
  projectPath: string,
  migrationAudit?: MigrationAuditResult,
): Promise<string | null> {
  try {
    const result = await generateAuditReport(projectPath, migrationAudit)
    return result.reportPath
  } catch {
    return null
  }
}

/**
 * Gera o relatório final de encerramento da migração.
 * Grava o snapshot com timestamp normal (como qualquer outro report) E sobrescreve
 * audit-report-final.html — artefato fixo que marca a conclusão total da migração.
 * Não lança exceção.
 */
export async function generateFinalReport(
  projectPath: string,
  migrationAudit?: MigrationAuditResult,
): Promise<{ timestamped: string | null; final: string | null }> {
  try {
    const result = await generateAuditReport(projectPath, migrationAudit)
    const finalPath = join(result.reportPath.replace(/audit-report-.+\.html$/, ''), 'audit-report-final.html')
    // Copia o HTML já gerado para o nome fixo
    const html = readFileSync(result.reportPath, 'utf-8')
    writeFileSync(finalPath, html, 'utf-8')
    return { timestamped: result.reportPath, final: finalPath }
  } catch {
    return { timestamped: null, final: null }
  }
}

export async function generateAuditReport(
  projectPath: string,
  migrationAudit?: MigrationAuditResult,
): Promise<AuditReportResult> {
  const migrationDir = join(projectPath, '.jdk-migration')
  const planPath = join(migrationDir, 'migration-plan.json')
  const discoveryPath = join(migrationDir, 'discovery-report.json')
  const configPath = join(projectPath, 'jdk-migration.config.json')

  if (!existsSync(planPath) && !existsSync(discoveryPath)) {
    throw new MigrationError(
      'CONFIG_NOT_FOUND',
      'Nenhum dado de migração encontrado. Execute discover_project e build_migration_plan primeiro.',
      { planPath, discoveryPath },
    )
  }

  const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf-8')) : null
  const discovery = existsSync(discoveryPath) ? JSON.parse(readFileSync(discoveryPath, 'utf-8')) : null
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : null

  const phases = config?.phases ?? {}
  const phasesCompleted = Object.values(phases).filter((p: any) => p.status === 'completed').length
  const phasesTotal = Object.keys(phases).length

  const allManualItems: any[] = plan?.phases?.flatMap((p: any) => p.manualItems ?? []) ?? []
  const allRiskItems: any[] = plan?.phases?.flatMap((p: any) => p.riskItems ?? []) ?? []
  const criticalRisks = allRiskItems.filter((r: any) => r.severity === 'critical').length

  mkdirSync(migrationDir, { recursive: true })

  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportPath = join(migrationDir, `audit-report-${timestamp}.html`)

  // Coleta steps de TODAS as fontes:
  // 1. config.steps — array global (gravado por update_step_status)
  // 2. config.phases[N].steps — array por fase (gravado manualmente ou por record_manual_phase)
  const globalSteps: any[] = config?.steps ?? []
  const phaseSteps: any[] = Object.values(phases).flatMap((p: any) => p.steps ?? [])

  // Mescla sem duplicatas (por num + commit)
  const seenKeys = new Set<string>()
  const manualSteps: any[] = []
  for (const s of [...globalSteps, ...phaseSteps]) {
    const key = `${s.num}-${s.commit ?? s.task}`
    if (!seenKeys.has(key)) { seenKeys.add(key); manualSteps.push(s) }
  }
  manualSteps.sort((a, b) => (a.num ?? 0) - (b.num ?? 0))

  // Deriva steps automaticamente do git log de cada fase concluída/em andamento
  // quando não há steps manuais registrados para aquela fase
  const gitDerivedSteps = await deriveStepsFromGit(phases, projectPath)

  // Mescla: steps manuais têm prioridade; git-derived preenchem o que sobrou
  const steps = mergeSteps(manualSteps, gitDerivedSteps)

  const html = buildHtml({ plan, discovery, config, phases, allRiskItems, allManualItems, now, projectPath, steps, migrationAudit })
  writeFileSync(reportPath, html, 'utf-8')

  const phase5St = config?.phases?.[5]?.status ?? config?.phases?.['5']?.status ?? 'pending'
  if (['in_progress', 'awaiting_gate', 'approved', 'completed'].includes(phase5St)) {
    await generatePhase5Checklist(migrationDir, config, plan, now)
  }

  return {
    reportPath,
    phasesCompleted,
    phasesTotal,
    openManualItems: allManualItems.length,
    criticalRisks,
  }
}

// ─── phase 5 checklist ───────────────────────────────────────────────────────

const PHASE_NAMES: Record<number, string> = {
  0: 'Descoberta & Baseline',
  1: 'Infraestrutura & Build',
  2: 'Modernização de Linguagem',
  3: 'Namespace Jakarta & Frameworks',
  4: 'Refatoração Semântica Assistida',
  5: 'Validação Final & Cutover',
}

interface JacocoCoverage {
  module: string
  missed: number
  total: number
  pct: number
}

/** Lê os relatórios Jacoco de todos os módulos encontrados no projeto. */
function readJacocoReports(projectPath: string): JacocoCoverage[] {
  const results: JacocoCoverage[] = []
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const reportPath = join(projectPath, entry.name, 'target', 'site', 'jacoco', 'index.html')
      if (!existsSync(reportPath)) continue
      try {
        const html = readFileSync(reportPath, 'utf-8')
        const match = html.match(/Total<\/td><td class="bar">([\d.]+) of ([\d.]+)<\/td><td class="ctr2">(\d+)%/)
        if (!match) continue
        // Jacoco usa '.' como separador de milhar em PT/BR — remover antes de parsear
        const missed = parseInt(match[1].replace(/\./g, ''), 10)
        const total = parseInt(match[2].replace(/\./g, ''), 10)
        const pct = parseInt(match[3], 10)
        results.push({ module: entry.name, missed, total, pct })
      } catch { /* módulo sem relatório válido — pular */ }
    }
  } catch { /* sem permissão ou diretório inválido */ }
  return results
}

/**
 * Roda `mvn compile -q` (sem testes) e retorna linhas com warnings reais do
 * compilador Java — filtrando os warnings de modelo Maven (sonar, version, etc.).
 * Retorna lista vazia se o comando não for encontrado no PATH (falha silenciosa).
 */
async function runCompilerCheck(
  projectPath: string,
  buildSystem: string,
  options?: { mavenExecutable?: string; gradleExecutable?: string },
): Promise<string[]> {
  try {
    const isMaven = buildSystem !== 'gradle'
    const cmd = isMaven ? (options?.mavenExecutable ?? 'mvn') : (options?.gradleExecutable ?? 'gradle')
    const args = isMaven
      ? ['compile', '-q', '--no-transfer-progress']
      : ['compileJava', '-q']
    const result = await runProcess(cmd, args, { cwd: projectPath, timeoutMs: 120_000 })
    if (result.exitCode === -1) return [] // comando não encontrado — pular silenciosamente
    return (result.stdout + '\n' + result.stderr)
      .split('\n')
      .filter(line => /\.java:\[?\d+/.test(line) && /\bwarning\b/i.test(line))
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function generatePhase5Checklist(migrationDir: string, config: any, plan: any, now: Date): Promise<void> {
  try {
    const phases: Record<string, any> = config?.phases ?? {}
    const phase5 = phases[5] ?? phases['5'] ?? {}
    const phase5Status: string = phase5.status ?? 'pending'
    const isCompleted = phase5Status === 'completed' || phase5Status === 'approved'
    const isActive = ['in_progress', 'awaiting_gate', 'approved', 'completed'].includes(phase5Status)

    const projectPath = join(migrationDir, '..')

    // ── Grupo A: validações automáticas ──────────────────────────────────────
    const jacocoModules = readJacocoReports(projectPath)
    const buildPassed = isActive && (!!phase5.executedAt || jacocoModules.length > 0)

    let compilerWarnings: string[] = []
    if (isActive) {
      compilerWarnings = await runCompilerCheck(projectPath, config?.buildSystem ?? 'maven', {
        mavenExecutable: config?.mavenExecutable,
        gradleExecutable: config?.gradleExecutable,
      })
    }

    // A1
    const a1Check = buildPassed ? '[x]' : '[ ]'
    const a1Note = buildPassed
      ? ` *(BUILD SUCCESS — ${phase5.executedAt ? new Date(phase5.executedAt).toISOString().slice(0, 10) : now.toISOString().slice(0, 10)})*`
      : ''

    // A2
    let a2Check = '[ ]'
    let a2Note = ''
    if (jacocoModules.length > 0) {
      a2Check = '[x]'
      const detail = jacocoModules.map(m => `${m.module}: ${m.pct}%`).join(', ')
      a2Note = ` *(${detail})*`
    }

    // A3 — marcado apenas quando o compilador respondeu e não encontrou warnings Java
    const compilerRan = isActive && compilerWarnings !== null
    let a3Check = '[ ]'
    let a3Note = ''
    if (compilerRan) {
      if (compilerWarnings.length === 0) {
        a3Check = '[x]'
        a3Note = ' *(nenhum warning de compilação Java encontrado)*'
      } else {
        a3Note = ` *(${compilerWarnings.length} warning(s) — verificar manualmente: ${compilerWarnings.slice(0, 2).join(' | ')})*`
      }
    }

    // ── Tabelas dinâmicas ────────────────────────────────────────────────────
    const phaseRows = Array.from({ length: 6 }, (_, i) => {
      const p = phases[i] ?? phases[String(i)] ?? {}
      const statusLabel =
        p.status === 'approved' || p.status === 'completed' ? 'Aprovada'
        : p.status === 'awaiting_gate' ? 'Aguardando gate'
        : p.status === 'in_progress' ? 'Em andamento'
        : 'Pendente'
      const approvedAt = p.approvedAt ? new Date(p.approvedAt).toISOString() : '—'
      return `| ${i} | ${PHASE_NAMES[i] ?? `Fase ${i}`} | ${statusLabel} | ${approvedAt} |`
    }).join('\n')

    const appPort: string = plan?.appPort ?? '8081'
    const generatedAt = now.toISOString().slice(0, 10)
    const completionNote = isCompleted
      ? `\n> ✅ **MIGRAÇÃO CONCLUÍDA** — Gate da Fase 5 aprovado em ${phase5.approvedAt ?? '—'} por ${phase5.approvedBy ?? '—'}.\n`
      : ''
    const rollbackBranch = phases[3]?.gitBranch ?? phases['3']?.gitBranch ?? '<branch-pre-migracao>'

    const md = `# Fase 5 — Checklist de Validação Final & Cutover
${completionNote}
> Gerado em: ${generatedAt} | JDK ${config?.sourceJdk ?? '?'} → ${config?.targetJdk ?? '21'}

---

## A. Build & Testes
- ${a1Check} \`mvn clean verify\` passa sem erros em JDK ${config?.targetJdk ?? '21'}${a1Note}
- ${a2Check} Cobertura Jacoco verificada${a2Note}
- ${a3Check} Nenhum warning de compilação Java novo${a3Note}

## B. Startup da Aplicação
- [ ] Aplicação sobe sem erros no ambiente de homologação
- [ ] Logs estruturados JSON aparecem normalmente
- [ ] Atuador responde: \`GET /actuator/health\` → \`{"status":"UP"}\`
- [ ] Prometheus responde: \`GET /actuator/prometheus\`

## C. Swagger UI
- [ ] **Nova URL**: \`http://localhost:${appPort}/swagger-ui/index.html\` carrega
- [ ] **URL antiga** \`http://localhost:${appPort}/swagger-ui.html\` não funciona mais — comunicar consumidores internos
- [ ] Todos os endpoints aparecem na UI

## D. Integrações Críticas (smoke tests)
- [ ] Endpoints principais respondem HTTP 200 com dados corretos
- [ ] Integrações com bancos de dados funcionando sem erros de driver/dialect
- [ ] Clientes HTTP externos (Feign / RestTemplate / WebClient) respondendo normalmente
- [ ] Mensageria (Kafka / RabbitMQ / JMS) publicando e consumindo sem erros

## E. Regressão de Comportamento
- [ ] Tratamento de exceções retorna payloads corretos (status codes e bodies)
- [ ] Autenticação / autorização funcionando normalmente
- [ ] Feature flags e configurações de ambiente carregando corretamente

## F. Rollback
- [ ] Branch de rollback identificada: \`${rollbackBranch}\`
- [ ] Procedimento: \`git checkout ${rollbackBranch} && mvn clean install && deploy\`
- [ ] Responsável pelo rollback designado e ciente

## G. Sign-offs
- [ ] **Responsável técnico** assina (valida itens A–E)
- [ ] **Responsável funcional** assina (valida item D)

---

## Histórico de Fases

| Fase | Nome | Status | Aprovado em |
|------|------|--------|-------------|
${phaseRows}
`

    writeFileSync(join(migrationDir, 'phase5-checklist.md'), md, 'utf-8')
  } catch {
    // Falha silenciosa — não deve interromper a geração do relatório HTML
  }
}

// ─── git-derived steps ────────────────────────────────────────────────────────

/**
 * Lê o git log de cada fase que tem commits registrados e converte em steps
 * derivados automaticamente. Usado como fallback quando update_step_status
 * não foi chamado.
 */
async function deriveStepsFromGit(
  phases: Record<string, any>,
  projectPath: string,
): Promise<any[]> {
  const derived: any[] = []
  let globalNum = 1000  // números altos para não conflitar com steps manuais (1–999)

  for (const [phaseNum, phase] of Object.entries(phases)) {
    const { baseCommit, gitCommit, gitBranch, status } = phase as any
    if (!baseCommit || !gitCommit) continue
    if (!['awaiting_gate', 'approved', 'completed', 'in_progress'].includes(status)) continue

    try {
      // git log baseCommit..gitCommit --format="%H|%h|%s|%ai|%an"
      const result = await runProcess(
        'git',
        ['log', `${baseCommit}..${gitCommit}`, '--format=%H|%h|%s|%ai|%an', '--no-merges'],
        { cwd: projectPath, timeoutMs: 10_000 },
      )

      if (result.exitCode !== 0 || !result.stdout.trim()) continue

      const lines = result.stdout.trim().split('\n').reverse()  // cronológico

      for (const line of lines) {
        const [, shortHash, subject, date] = line.split('|')
        if (!shortHash || !subject) continue

        derived.push({
          id: `git-${shortHash}`,
          num: globalNum++,
          owner: 'claude',
          phase: 'B',
          task: subject.trim(),
          status: 'done',
          commit: shortHash.trim(),
          note: `Fase ${phaseNum} · ${gitBranch ?? ''} · ${date?.slice(0, 10) ?? ''}`.trim(),
          completedAt: date?.trim() ?? null,
          _fromGit: true,   // flag interna para distinguir no HTML
        })
      }
    } catch {
      // git indisponível ou repo sem commits — ignora silenciosamente
    }
  }

  return derived
}

/**
 * Mescla steps manuais (registrados via update_step_status) com steps derivados do git.
 * Steps manuais têm prioridade absoluta. Steps git complementam o que ficou vazio.
 * Se há steps manuais, os git-derived são adicionados apenas para fases sem cobertura.
 */
function mergeSteps(manual: any[], gitDerived: any[]): any[] {
  if (manual.length === 0) return gitDerived
  if (gitDerived.length === 0) return manual

  // Fases que já têm steps manuais (pelo campo "note" ou pelo phase)
  const manualCommits = new Set(manual.map(s => s.commit).filter(Boolean))

  // Adiciona git-derived apenas se o commit não está já coberto por um step manual
  const extra = gitDerived.filter(g => !manualCommits.has(g.commit))

  return [...manual, ...extra].sort((a, b) => {
    // Steps manuais primeiro, depois git-derived pelo num
    if (!a._fromGit && b._fromGit) return -1
    if (a._fromGit && !b._fromGit) return 1
    return a.num - b.num
  })
}

// ─── HTML builder ──────────────────────────────────────────────────────────────

interface BuildContext {
  plan: any
  discovery: any
  config: any
  phases: Record<string, any>
  allRiskItems: any[]
  allManualItems: any[]
  now: Date
  projectPath: string
  steps: any[]
  migrationAudit?: MigrationAuditResult
}

function buildHtml(ctx: BuildContext): string {
  const { plan, discovery, config, phases, allRiskItems, allManualItems, now, projectPath, steps, migrationAudit } = ctx
  const sourceJdk = config?.sourceJdk ?? discovery?.sourceJdk ?? '?'
  const stacks: string[] = config?.stack ?? discovery?.detectedStacks ?? []
  const buildSystem: string = config?.buildSystem ?? discovery?.buildSystem ?? '?'

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JDK Migration Audit Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #1a1a2e; background: #f4f6f9; }
    .page { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
    header { background: linear-gradient(135deg, #0f3460, #1a6b9a); color: #fff; border-radius: 10px; padding: 28px 32px; margin-bottom: 24px; }
    header h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
    header .meta { font-size: 12px; opacity: 0.8; margin-top: 8px; }
    section { background: #fff; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    section h2 { font-size: 15px; font-weight: 600; color: #0f3460; border-bottom: 2px solid #e8edf3; padding-bottom: 10px; margin-bottom: 16px; }
    .cards { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
    .card { flex: 1; min-width: 140px; background: #f8fafd; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; text-align: center; }
    .card .num { font-size: 28px; font-weight: 700; }
    .card .lbl { font-size: 11px; color: #64748b; margin-top: 4px; }
    .card.red .num    { color: #dc2626; }
    .card.orange .num { color: #ea580c; }
    .card.green .num  { color: #16a34a; }
    .card.blue .num   { color: #2563eb; }
    .card.purple .num { color: #7c3aed; }
    .card.cyan .num   { color: #0891b2; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; background: #f1f5f9; color: #475569; font-weight: 600; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
    td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafbff; }
    .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
    .badge-critical { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .badge-high     { background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; }
    .badge-medium   { background: #fffbeb; color: #ca8a04; border: 1px solid #fde68a; }
    .badge-low      { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .badge-completed    { background: #f0fdf4; color: #15803d; border: 1px solid #86efac; }
    .badge-approved     { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .badge-awaiting_gate { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
    .badge-in_progress  { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
    .badge-failed       { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .badge-rolled_back  { background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; }
    .badge-pending      { background: #f8fafc; color: #64748b; border: 1px solid #e2e8f0; }
    .auto-yes { color: #16a34a; font-weight: 600; }
    .auto-no  { color: #dc2626; }
    .recipe   { font-family: monospace; font-size: 11px; color: #475569; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; }
    .filepath { font-family: monospace; font-size: 11px; color: #64748b; }
    .info-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
    .info-item label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 2px; }
    .info-item span  { font-size: 13px; font-weight: 500; }
    .phase-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .phase-num { background: #0f3460; color: #fff; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
    footer { text-align: center; font-size: 11px; color: #94a3b8; padding: 16px 0; }
    .empty { color: #94a3b8; font-style: italic; font-size: 13px; }
    /* ── Execution Plan ── */
    section.plan-section { border-left: 4px solid #0891b2; }
    section.plan-section h2 { color: #0e7490; border-color: #cffafe; }
    .owner-you    { display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#0e7490;background:#ecfeff;border:1px solid #a5f3fc;border-radius:12px;padding:2px 10px;white-space:nowrap; }
    .owner-claude { display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#5b21b6;background:#faf5ff;border:1px solid #ddd6fe;border-radius:12px;padding:2px 10px;white-space:nowrap; }
    .step-num { display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;font-size:11px;font-weight:700;flex-shrink:0; }
    .step-you    { background:#ecfeff;color:#0e7490;border:1px solid #67e8f9; }
    .step-claude { background:#faf5ff;color:#7c3aed;border:1px solid #c4b5fd; }
    tr.row-you    td { background:#f0fdff; }
    tr.row-you:hover td { background:#e0f9ff; }
    tr.row-claude td { background:#fdf8ff; }
    tr.row-claude:hover td { background:#f5eeff; }
    tr.row-you    td:first-child { border-left:3px solid #22d3ee; }
    tr.row-claude td:first-child { border-left:3px solid #a78bfa; }
    .phase-div td { background:#f1f5f9!important;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;padding:6px 10px; }
    .phase-div td:first-child { border-left:3px solid #cbd5e1; }
    .resp-grid { display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px; }
    .resp-box { border-radius:8px;padding:16px; }
    .resp-box-you    { background:#ecfeff;border:1px solid #a5f3fc; }
    .resp-box-claude { background:#faf5ff;border:1px solid #ddd6fe; }
    .resp-box h4 { font-size:13px;font-weight:700;margin-bottom:10px; }
    .resp-box-you    h4 { color:#0e7490; }
    .resp-box-claude h4 { color:#5b21b6; }
    .resp-box ul { padding-left:18px;font-size:13px;line-height:1.8; }
    .resp-box-you    ul { color:#164e63; }
    .resp-box-claude ul { color:#3b0764; }
    .crit-path { background:#fef9c3;border:1px solid #fde047;border-left:4px solid #eab308;border-radius:6px;padding:12px 16px;margin-top:16px;font-size:13px;color:#713f12; }
    /* ── Step Progress ── */
    section.steps-section { border-left: 4px solid #16a34a; }
    section.steps-section h2 { color: #15803d; border-color: #bbf7d0; }
    .steps-progress-bar { background:#e2e8f0; border-radius:99px; height:10px; margin-bottom:16px; overflow:hidden; }
    .steps-progress-fill { background: linear-gradient(90deg,#16a34a,#22c55e); height:100%; border-radius:99px; }
    .steps-progress-label { font-size:12px; color:#475569; margin-bottom:8px; }
    tr.step-done td { background:#f0fdf4!important; }
    tr.step-done:hover td { background:#dcfce7!important; }
    tr.step-done td:first-child { border-left:3px solid #22c55e; }
    tr.step-pending td { background:#f8fafc!important; }
    tr.step-pending:hover td { background:#f1f5f9!important; }
    tr.step-pending td:first-child { border-left:3px solid #cbd5e1; }
    tr.step-skipped td { background:#fffbeb!important; }
    tr.step-skipped td:first-child { border-left:3px solid #fbbf24; }
    .badge-step-done    { background:#f0fdf4;color:#15803d;border:1px solid #86efac; }
    .badge-step-pending { background:#f8fafc;color:#64748b;border:1px solid #e2e8f0; }
    .badge-step-skipped { background:#fffbeb;color:#b45309;border:1px solid #fde68a; }
    .commit-ref { font-family:monospace;font-size:11px;background:#f1f5f9;color:#475569;padding:1px 5px;border-radius:3px; }
    .git-badge { font-size:10px;font-weight:600;background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;padding:1px 6px;border-radius:8px;margin-left:5px;white-space:nowrap; }
    tr.row-git td { background:#f0f9ff!important; }
    tr.row-git:hover td { background:#e0f2fe!important; }
    tr.row-git td:first-child { border-left:3px solid #38bdf8; }
    /* ── Build Environment ── */
    section.env-section { border-left: 4px solid #0891b2; }
    section.env-section h2 { color: #0e7490; border-color: #cffafe; }
    .tool-found    td:first-child { border-left: 3px solid #22c55e; }
    .tool-missing  td:first-child { border-left: 3px solid #dc2626; }
    .tool-provided td:first-child { border-left: 3px solid #a78bfa; }
    .tool-path { font-family: monospace; font-size: 11px; color: #475569; word-break: break-all; }
    .badge-found    { background:#f0fdf4;color:#15803d;border:1px solid #86efac; }
    .badge-missing  { background:#fef2f2;color:#dc2626;border:1px solid #fecaca; }
    .badge-provided { background:#faf5ff;color:#7c3aed;border:1px solid #ddd6fe; }
    /* ── Containers & CI ── */
    section.cci-section { border-left: 4px solid #dc2626; }
    section.cci-section h2 { color: #b91c1c; border-color: #fecaca; }
    section.cci-ok { border-left: 4px solid #16a34a; }
    section.cci-ok h2 { color: #15803d; border-color: #bbf7d0; }
    .cci-file-type { font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:3px;background:#f1f5f9;color:#475569; }
    .cci-code { font-family:monospace;font-size:11px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:3px;padding:2px 6px;color:#334155;word-break:break-all; }
    .human-flag { font-size:11px;color:#b45309;font-weight:600; }
    /* ── Migration Audit ── */
    section.audit-section { border-left: 4px solid #7c3aed; }
    section.audit-section h2 { color: #6d28d9; border-color: #ddd6fe; }
    section.audit-ok    { border-left: 4px solid #16a34a; }
    section.audit-ok h2 { color: #15803d; border-color: #bbf7d0; }
    .audit-criterion { display:flex; align-items:flex-start; gap:12px; padding:10px 0; border-bottom:1px solid #f1f5f9; }
    .audit-criterion:last-child { border-bottom:none; }
    .audit-icon { font-size:18px; flex-shrink:0; width:24px; text-align:center; margin-top:1px; }
    .audit-body { flex:1; }
    .audit-label { font-size:13px; font-weight:600; color:#1e293b; margin-bottom:2px; }
    .audit-detail { font-size:12px; color:#475569; line-height:1.5; }
    .audit-action { font-size:12px; color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:4px; padding:4px 8px; margin-top:6px; }
    .audit-files { font-family:monospace; font-size:11px; color:#64748b; margin-top:4px; }
    .audit-summary-bar { display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
    .audit-pill { display:inline-flex; align-items:center; gap:5px; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600; }
    .audit-pill-ok      { background:#f0fdf4; color:#15803d; border:1px solid #86efac; }
    .audit-pill-warning { background:#fffbeb; color:#b45309; border:1px solid #fde68a; }
    .audit-pill-fail    { background:#fef2f2; color:#dc2626; border:1px solid #fecaca; }
    .audit-blocker-banner { background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:#991b1b; font-weight:600; }
    .audit-clean-banner   { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:#15803d; font-weight:600; }
  </style>
</head>
<body>
<div class="page">

  <header>
    <h1>JDK Migration Audit Report</h1>
    <div>JDK ${escHtml(sourceJdk)} → JDK 21 &nbsp;|&nbsp; ${escHtml(stacks.join(', ') || '—')} &nbsp;|&nbsp; ${escHtml(buildSystem)}</div>
    <div class="meta">
      Projeto: <code>${escHtml(projectPath)}</code><br>
      Gerado em: ${escHtml(now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}
    </div>
  </header>

  ${buildExecutiveSummary(ctx)}
  ${buildProjectInfo(ctx)}
  ${buildBuildEnvironment(ctx)}
  ${buildContainerCi(ctx)}
  ${buildDiscoverySummary(ctx)}
  ${buildRiskRegister(allRiskItems)}
  ${buildPhaseStatus(ctx)}
  ${buildStepProgress(ctx)}
  ${buildManualItems(allManualItems)}
  ${buildExecutionPlan(allRiskItems, allManualItems)}
  ${migrationAudit ? buildMigrationAuditSection(migrationAudit, config?.sourceJdk ?? discovery?.sourceJdk ?? '?') : ''}
  ${buildAuditTrail(ctx)}

  <footer>
    Gerado por jdk-migration-mcp &nbsp;•&nbsp; ${escHtml(now.toISOString())}
  </footer>

</div>
</body>
</html>`
}

function buildExecutiveSummary(ctx: BuildContext): string {
  const { phases, allRiskItems, allManualItems, steps } = ctx
  const phaseList = Object.values(phases) as any[]
  const approvedOrCompleted = phaseList.filter(p => p.status === 'approved' || p.status === 'completed').length
  const total = phaseList.length
  const critical = allRiskItems.filter(r => r.severity === 'critical').length
  const high = allRiskItems.filter(r => r.severity === 'high').length
  const humanSteps = allManualItems.filter((m: any) => m.requiresHumanDecision === true).length
  const stepsDone = steps.filter(s => s.status === 'done').length
  const stepsTotal = steps.length
  return `
  <section>
    <h2>Resumo Executivo</h2>
    <div class="cards">
      <div class="card ${approvedOrCompleted === total && total > 0 ? 'green' : 'blue'}">
        <div class="num">${approvedOrCompleted}/${total}</div>
        <div class="lbl">Fases Aprovadas</div>
      </div>
      <div class="card ${stepsTotal > 0 && stepsDone === stepsTotal ? 'green' : stepsTotal > 0 ? 'cyan' : 'blue'}">
        <div class="num">${stepsTotal > 0 ? `${stepsDone}/${stepsTotal}` : '—'}</div>
        <div class="lbl">Steps Concluídos</div>
      </div>
      <div class="card ${critical > 0 ? 'red' : 'green'}">
        <div class="num">${critical}</div>
        <div class="lbl">Riscos Críticos</div>
      </div>
      <div class="card ${high > 0 ? 'orange' : 'green'}">
        <div class="num">${high}</div>
        <div class="lbl">Riscos Altos</div>
      </div>
      <div class="card ${humanSteps > 0 ? 'purple' : 'green'}">
        <div class="num">${humanSteps}</div>
        <div class="lbl">Decisões Humanas</div>
      </div>
    </div>
  </section>`
}

function buildProjectInfo(ctx: BuildContext): string {
  const { config, discovery, plan } = ctx
  const sourceJdk = config?.sourceJdk ?? discovery?.sourceJdk ?? '?'
  const stacks: string[] = config?.stack ?? discovery?.detectedStacks ?? []
  const buildSystem = config?.buildSystem ?? discovery?.buildSystem ?? '?'
  const appServer = config?.appServer ?? '—'
  const multiModule = config?.multiModule ?? discovery?.isMultiModule ?? false
  const totalDays = plan?.totalEstimatedDays ?? '—'
  return `
  <section>
    <h2>Informações do Projeto</h2>
    <div class="info-grid">
      <div class="info-item"><label>JDK Fonte</label><span>JDK ${escHtml(String(sourceJdk))}</span></div>
      <div class="info-item"><label>JDK Destino</label><span>JDK 21</span></div>
      <div class="info-item"><label>Stacks</label><span>${escHtml(stacks.join(', ') || '—')}</span></div>
      <div class="info-item"><label>Build System</label><span>${escHtml(String(buildSystem))}</span></div>
      <div class="info-item"><label>App Server</label><span>${escHtml(String(appServer))}</span></div>
      <div class="info-item"><label>Multi-módulo</label><span>${multiModule ? 'Sim' : 'Não'}</span></div>
      <div class="info-item"><label>Esforço Estimado</label><span>${escHtml(String(totalDays))} dias</span></div>
    </div>
  </section>`
}

function buildContainerCi(ctx: BuildContext): string {
  const { discovery, config } = ctx
  const cci = discovery?.containerCi ?? (config as any)?.containerCi
  if (!cci) return ''

  const { findings, filesScanned, hasIncompatibleImages, hasIncompatibleCiJdk } = cci as any
  const hasIssues = (findings?.length ?? 0) > 0

  if (!hasIssues) {
    const scanned = (filesScanned as string[] ?? [])
    if (scanned.length === 0) return ''
    return `
  <section class="cci-ok">
    <h2>Containers &amp; CI</h2>
    <p style="font-size:13px;color:#15803d">✔ Nenhuma incompatibilidade de JDK detectada nos arquivos de infraestrutura.</p>
    <p style="font-size:11px;color:#94a3b8;margin-top:8px">Arquivos verificados: ${escHtml(scanned.join(', '))}</p>
  </section>`
  }

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, info: 3 }
  const sorted = [...(findings as any[])].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))

  const fileTypeLabel: Record<string, string> = {
    dockerfile: 'Dockerfile', 'docker-compose': 'Compose',
    'github-actions': 'GitHub Actions', 'gitlab-ci': 'GitLab CI',
    jenkinsfile: 'Jenkinsfile', 'azure-pipelines': 'Azure Pipelines',
    travis: 'Travis CI', circleci: 'CircleCI', 'other-ci': 'CI',
  }

  const rows = sorted.map((f: any) => {
    const typeLabel = fileTypeLabel[f.fileType] ?? f.fileType
    const humanFlag = f.requiresHumanDecision
      ? `<br><span class="human-flag">⚠️ Requer decisão humana</span>`
      : ''
    const replacementCell = f.suggestedReplacement
      ? `<br><span style="color:#15803d;font-size:11px;font-weight:600">
           ✔ Substituta encontrada no registry:<br>
           <span class="cci-code">${escHtml(f.suggestedReplacement)}</span>
         </span>`
      : ''
    return `
    <tr>
      <td><span class="badge badge-${f.severity}">${escHtml(f.severity)}</span></td>
      <td><span class="cci-file-type">${escHtml(typeLabel)}</span></td>
      <td class="filepath">${escHtml(f.file)}<br><span style="color:#94a3b8;font-size:10px">linha ${f.line}</span></td>
      <td><span class="cci-code">${escHtml(f.content?.slice(0, 80) ?? '')}${(f.content?.length ?? 0) > 80 ? '…' : ''}</span></td>
      <td style="font-size:12px">${escHtml(f.description)}${humanFlag}${replacementCell}</td>
      <td style="font-size:12px;color:#475569">${escHtml(f.suggestion)}</td>
    </tr>`
  }).join('')

  const alertMsg = [
    hasIncompatibleImages ? '🐳 Imagens Docker desatualizadas' : '',
    hasIncompatibleCiJdk ? '⚙️ Pipelines CI com JDK incompatível' : '',
  ].filter(Boolean).join(' &nbsp;|&nbsp; ')

  return `
  <section class="cci-section">
    <h2>Containers &amp; CI — ${findings.length} incompatibilidade(s) detectada(s)</h2>
    <p style="font-size:13px;color:#b91c1c;margin-bottom:12px">${alertMsg}</p>
    <table>
      <thead>
        <tr>
          <th>Severidade</th>
          <th>Tipo</th>
          <th>Arquivo / Linha</th>
          <th>Conteúdo</th>
          <th>Problema</th>
          <th>Sugestão</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${filesScanned?.length > 0 ? `<p style="font-size:11px;color:#94a3b8;margin-top:10px">Arquivos verificados: ${escHtml((filesScanned as string[]).join(', '))}</p>` : ''}
  </section>`
}

function buildBuildEnvironment(ctx: BuildContext): string {
  const { config, discovery } = ctx
  const tools: any[] = config?.detectedTools?.tools ?? discovery?.detectedTools?.tools ?? []
  const detectedAt: string | undefined = config?.detectedTools?.detectedAt ?? discovery?.detectedTools?.detectedAt

  if (tools.length === 0) {
    return `
  <section class="env-section">
    <h2>Ambiente de Build</h2>
    <p class="empty">Ferramentas ainda não detectadas — execute discover_project para preencher esta seção.</p>
  </section>`
  }

  const allFound = tools.filter(t => t.required).every(t => t.status !== 'not_found')
  const rows = tools.map(t => {
    const cls = t.status === 'not_found' ? 'tool-missing' : t.status === 'user_provided' ? 'tool-provided' : 'tool-found'
    const badge = t.status === 'not_found' ? 'missing' : t.status === 'user_provided' ? 'provided' : 'found'
    const badgeLabel = t.status === 'not_found' ? 'Não encontrado' : t.status === 'user_provided' ? 'Informado pelo usuário' : 'Encontrado'
    const requiredBadge = t.required
      ? `<span class="badge badge-critical" style="font-size:10px">obrigatório</span>`
      : `<span class="badge badge-low" style="font-size:10px">opcional</span>`
    return `
    <tr class="${cls}">
      <td>${escHtml(t.name)}&nbsp;${requiredBadge}</td>
      <td><span class="badge badge-${badge}">${badgeLabel}</span></td>
      <td class="tool-path">${escHtml(t.path)}</td>
      <td class="tool-path">${escHtml(t.version ?? '—')}</td>
      <td style="font-size:11px;color:#64748b">${escHtml(t.source)}</td>
    </tr>`
  }).join('')

  const summary = allFound
    ? `<p style="font-size:13px;color:#15803d;margin-bottom:12px">✔ Todas as ferramentas obrigatórias foram localizadas automaticamente.</p>`
    : `<p style="font-size:13px;color:#dc2626;margin-bottom:12px">⚠️ Uma ou mais ferramentas obrigatórias <strong>não foram encontradas</strong>. Informe os caminhos via <code>toolOverrides</code> ao chamar <code>discover_project</code>.</p>`

  return `
  <section class="env-section">
    <h2>Ambiente de Build</h2>
    ${summary}
    <table>
      <thead>
        <tr>
          <th>Ferramenta</th>
          <th>Status</th>
          <th>Caminho / Home</th>
          <th>Versão</th>
          <th>Origem da detecção</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${detectedAt ? `<p style="font-size:11px;color:#94a3b8;margin-top:10px">Detectado em: ${escHtml(new Date(detectedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}</p>` : ''}
  </section>`
}

function buildDiscoverySummary(ctx: BuildContext): string {
  const { discovery } = ctx
  if (!discovery) {
    return `<section><h2>Descoberta</h2><p class="empty">Relatório de descoberta não disponível.</p></section>`
  }
  const sa = discovery.staticAnalysis ?? {}
  const corr: any[] = discovery.knowledgeCorrelation ?? []
  const rs = discovery.riskSummary ?? {}
  return `
  <section>
    <h2>Descoberta Estática</h2>
    <div class="info-grid" style="margin-bottom:16px">
      <div class="info-item"><label>APIs deprecadas (jdeprscan)</label><span>${sa.jdeprscanItemCount ?? 0}</span></div>
      <div class="info-item"><label>Ocorrências no fonte</label><span>${sa.sourceItemCount ?? 0}</span></div>
      <div class="info-item"><label>Violações jdeps</label><span>${(sa.jdepsViolations ?? []).length}</span></div>
      <div class="info-item"><label>Split packages</label><span>${(sa.splitPackages ?? []).length}</span></div>
      <div class="info-item"><label>Esforço estimado</label><span>${rs.estimatedEffortDays ?? 0} dias</span></div>
    </div>
    ${corr.length > 0 ? `
    <table>
      <thead><tr><th>API Removida</th><th>Removida em</th><th>Gravidade</th><th>Automação</th></tr></thead>
      <tbody>
        ${corr.map(e => `
        <tr>
          <td class="recipe">${escHtml(e.apiPattern ?? '')}</td>
          <td>JDK ${escHtml(String(e.removedInJdk ?? ''))}</td>
          <td><span class="badge badge-${e.severity}">${escHtml(e.severity ?? '')}</span></td>
          <td>${e.automatable ? '<span class="auto-yes">✓ Sim</span>' : '<span class="auto-no">✗ Manual</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="empty">Nenhuma API removida detectada no código fonte.</p>'}
  </section>`
}

function buildRiskRegister(risks: any[]): string {
  if (risks.length === 0) {
    return `<section><h2>Registro de Riscos</h2><p class="empty">Nenhum risco detectado.</p></section>`
  }
  const sorted = [...risks].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 }
    return (order[a.severity as keyof typeof order] ?? 9) - (order[b.severity as keyof typeof order] ?? 9)
  })
  return `
  <section>
    <h2>Registro de Riscos (${risks.length})</h2>
    <table>
      <thead><tr><th>Gravidade</th><th>Título</th><th>Automação</th><th>Recipe</th><th>Arquivo</th></tr></thead>
      <tbody>
        ${sorted.map(r => `
        <tr>
          <td><span class="badge badge-${r.severity}">${escHtml(r.severity)}</span></td>
          <td>${escHtml(r.title ?? '')}</td>
          <td>${r.automationAvailable ? '<span class="auto-yes">✓ Disponível</span>' : '<span class="auto-no">✗ Manual</span>'}</td>
          <td>${r.recipe ? `<span class="recipe">${escHtml(shortRecipe(r.recipe))}</span>` : '—'}</td>
          <td class="filepath">${r.file ? `${escHtml(r.file)}${r.line ? `:${r.line}` : ''}` : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>`
}

function buildPhaseStatus(ctx: BuildContext): string {
  const { phases, plan } = ctx
  const phaseNames: Record<number, string> = {
    0: 'Descoberta & Baseline',
    1: 'Infraestrutura & Build',
    2: 'Modernização de Linguagem',
    3: 'Namespace Jakarta & Frameworks',
    4: 'Refatoração Semântica Assistida',
    5: 'Validação Final & Cutover',
  }
  const entries = Object.entries(phases).sort(([a], [b]) => Number(a) - Number(b))
  return `
  <section>
    <h2>Status das Fases</h2>
    <table>
      <thead><tr><th>#</th><th>Fase</th><th>Status</th><th>Aprovado por</th><th>Data de Aprovação</th><th>Branch Git</th></tr></thead>
      <tbody>
        ${entries.map(([num, phase]) => {
          const phasePlan = plan?.phases?.find((p: any) => p.number === Number(num))
          return `
        <tr>
          <td>${escHtml(num)}</td>
          <td>${escHtml(phaseNames[Number(num)] ?? `Fase ${num}`)}</td>
          <td><span class="badge badge-${phase.status}">${escHtml(phase.status)}</span></td>
          <td>${phase.approvedBy ? escHtml(phase.approvedBy) : '<span class="empty">—</span>'}</td>
          <td>${phase.approvedAt ? escHtml(fmtDate(phase.approvedAt)) : '<span class="empty">—</span>'}</td>
          <td class="filepath">${phase.gitBranch ? escHtml(phase.gitBranch) : '<span class="empty">—</span>'}</td>
        </tr>`
        }).join('')}
      </tbody>
    </table>
  </section>`
}

function buildManualItems(items: any[]): string {
  if (items.length === 0) {
    return `<section><h2>Itens de Revisão Manual</h2><p class="empty">Nenhum item de revisão manual registrado.</p></section>`
  }
  const categoryLabel: Record<string, string> = {
    semantic: 'Semântico', security: 'Segurança', behavioral: 'Comportamental', ui: 'Interface',
  }
  return `
  <section>
    <h2>Itens de Revisão Manual (${items.length})</h2>
    <table>
      <thead><tr><th>Categoria</th><th>Título</th><th>Arquivos afetados</th><th>Abordagem sugerida</th></tr></thead>
      <tbody>
        ${items.map(m => `
        <tr>
          <td><span class="badge badge-high">${escHtml(categoryLabel[m.category] ?? m.category)}</span></td>
          <td>${escHtml(m.title ?? '')}</td>
          <td class="filepath">${(m.files ?? []).slice(0, 3).map((f: string) => escHtml(f)).join('<br>') || '—'}${(m.files ?? []).length > 3 ? `<br>+${(m.files ?? []).length - 3} mais` : ''}</td>
          <td style="max-width:260px;white-space:pre-wrap;font-size:12px">${escHtml((m.suggestedApproach ?? '').slice(0, 200))}${(m.suggestedApproach ?? '').length > 200 ? '…' : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>`
}

function buildExecutionPlan(risks: any[], manuals: any[]): string {
  interface PlanStep {
    num: number
    owner: 'you' | 'claude'
    task: string
    detail: string
    dependsOn: string
    phase: string
  }

  // ── Fixed steps derived from standard migration flow ──────────────────
  const steps: PlanStep[] = []
  let stepNum = 1
  let hasRegistry = false  // will be populated from manuals if present

  // Phase A: Verification steps (all Claude — scanning + registry)
  const hasInternalDeps = risks.some((r: any) =>
    r.id?.startsWith('sb3-') && r.severity === 'critical',
  ) || manuals.some((m: any) => m.claudeCanResearch === true)

  if (hasInternalDeps) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'A',
      task: 'Verificar dependências internas no registry',
      detail: 'Executar check_internal_dependencies para listar versões disponíveis de cada dep interna e indicar compatibilidade com Spring Boot 3.',
      dependsOn: '—',
    })
    hasRegistry = true
  }

  // Phase A: Human decisions
  const humanDecisionItems = manuals.filter((m: any) => m.requiresHumanDecision === true)
  for (const item of humanDecisionItems) {
    steps.push({
      num: stepNum++, owner: 'you', phase: 'A',
      task: `Decidir: ${escHtml(item.title ?? '')}`,
      detail: item.decisionOptions?.length
        ? escHtml(item.decisionOptions.map((o: string, i: number) => `Opção ${String.fromCharCode(65 + i)}: ${o}`).join(' | '))
        : escHtml((item.suggestedApproach ?? '').slice(0, 160)),
      dependsOn: hasRegistry ? '1' : '—',
    })
  }

  const firstClaudeImplStep = stepNum

  // Phase B: Claude implementation tasks derived from risk items
  const criticalRisks = risks.filter((r: any) => r.severity === 'critical')
  const highRisks = risks.filter((r: any) => r.severity === 'high' && r.automationAvailable)
  const mediumRisks = risks.filter((r: any) => r.severity === 'medium' && r.automationAvailable)

  if (risks.some((r: any) => r.id === 'sb-version-upgrade' || r.id?.startsWith('sb-version'))) {
    const depOnSteps = steps.filter(s => s.owner === 'you').map(s => String(s.num)).join(', ') || '—'
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Atualizar spring-boot-starter-parent no pom.xml raiz',
      detail: 'Trocar versão 2.x pela versão alvo SB3 escolhida. Remover propriedades obsoletas (ex: spring.cloud.version não utilizada).',
      dependsOn: depOnSteps,
    })
  }

  if (criticalRisks.some((r: any) => r.id === 'sb3-utf8-mediatype-removed')) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Substituir APPLICATION_JSON_UTF8_VALUE → APPLICATION_JSON_VALUE',
      detail: 'Busca e substituição global em todos os arquivos afetados.',
      dependsOn: String(firstClaudeImplStep),
    })
  }

  const javaxRisks = risks.filter((r: any) =>
    r.id?.includes('javax') || r.recipe?.includes('Javax') || r.recipe?.includes('Jakarta'),
  )
  if (javaxRisks.length > 0) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: `Migrar imports javax.* → jakarta.* (${javaxRisks.length} tipo(s) de namespace)`,
      detail: javaxRisks.map((r: any) => escHtml(r.title ?? '')).slice(0, 3).join('; '),
      dependsOn: String(firstClaudeImplStep),
    })
  }

  if (risks.some((r: any) => r.id === 'sb3-jaxb-runtime-version')) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Atualizar jaxb-runtime 2.x → 4.x',
      detail: 'Atualizar versão no pom.xml raiz. Migrar imports javax.xml.bind.* → jakarta.xml.bind.* nos arquivos afetados.',
      dependsOn: String(firstClaudeImplStep),
    })
  }

  if (criticalRisks.some((r: any) => r.id === 'sb3-springfox-blocker')) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Substituir Springfox → springdoc-openapi',
      detail: 'Remover springfox dos POMs. Adicionar springdoc-openapi-starter-webmvc-ui:2.x. Reescrever SwaggerConfig. Substituir anotações @ApiOperation → @Operation, @ApiModelProperty → @Schema.',
      dependsOn: String(firstClaudeImplStep),
    })
  }

  if (risks.some((r: any) => r.id === 'sb3-feign-options-api-break')) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Upgrade OpenFeign + corrigir construtor Request.Options',
      detail: 'Atualizar feign.version para 12.x no pom.xml. Adicionar TimeUnit.MILLISECONDS aos construtores Request.Options.',
      dependsOn: String(firstClaudeImplStep),
    })
  }

  if (risks.some((r: any) => r.id === 'sb3-httpclient4-explicit')) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Remover versões explícitas do Apache HttpClient 4.x',
      detail: 'Retirar propriedades httpClient.version e httpCore.version. Deixar o BOM do SB3 gerenciar.',
      dependsOn: String(firstClaudeImplStep),
    })
  }

  if (risks.some((r: any) => r.id === 'sb3-jersey2-namespace')) {
    const jerseyDecision = manuals.find((m: any) => m.id === 'sb3-jersey2-decision')
    const depOn = jerseyDecision
      ? String(steps.find(s => s.task.includes('Jersey') || s.task.includes('Decidir'))?.num ?? firstClaudeImplStep)
      : String(firstClaudeImplStep)
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Implementar decisão sobre Jersey (passo de decisão)',
      detail: 'Opção A: upgrade Jersey 2→3, atualizar imports. Opção B: substituir por java.net.http.HttpClient nativo.',
      dependsOn: depOn,
    })
  }

  if (risks.some((r: any) => r.id === 'sb-junit4')) {
    const junitDecision = manuals.find((m: any) => m.id === 'sb3-junit4-strategy')
    const depOn = junitDecision
      ? String(steps.find(s => s.task.includes('JUnit') || s.task.includes('testes'))?.num ?? firstClaudeImplStep)
      : String(firstClaudeImplStep)
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Implementar decisão sobre JUnit 4 (passo de decisão)',
      detail: 'Opção A: adicionar junit-vintage-engine como dep de test. Opção B: migrar para JUnit 5.',
      dependsOn: depOn,
    })
  }

  if (risks.some((r: any) => r.id === 'sb3-actuator-props-renamed')) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Atualizar propriedades Actuator/Prometheus renomeadas',
      detail: 'Substituir management.metrics.export.prometheus.* → management.prometheus.metrics.export.* nas properties.',
      dependsOn: String(firstClaudeImplStep),
    })
  }

  // Internal deps update step (if registry check was done)
  if (hasRegistry) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'B',
      task: 'Atualizar versões das dependências internas nos POMs',
      detail: 'Usar as versões SB3-compatíveis confirmadas pelo check_internal_dependencies. Registrar como impedimento as que não tiverem versão disponível.',
      dependsOn: `1, ${firstClaudeImplStep}`,
    })
  }

  // Build check
  const lastBStep = stepNum - 1
  steps.push({
    num: stepNum++, owner: 'claude', phase: 'B',
    task: 'Executar mvn clean compile e corrigir erros residuais',
    detail: 'Primeira compilação completa. Erros esperados: imports faltantes, APIs removidas, conflitos de versão. Corrigir iterativamente até build limpo.',
    dependsOn: `todos os passos anteriores (até ${lastBStep})`,
  })

  // Phase C: Human validation
  steps.push({
    num: stepNum++, owner: 'you', phase: 'C',
    task: 'Testar a aplicação localmente',
    detail: 'Verificar: startup sem erros, Swagger UI em /swagger-ui/index.html, endpoints críticos, conexões com banco e sistemas externos. Requer acesso à infraestrutura real.',
    dependsOn: String(stepNum - 2),
  })

  steps.push({
    num: stepNum++, owner: 'you', phase: 'C',
    task: 'Aprovar gate da fase de migração',
    detail: 'Confirmar formalmente que a aplicação está operacional com Spring Boot 3 + JDK 21. Encerra o ciclo de migração.',
    dependsOn: String(stepNum - 2),
  })

  // Phase D: Low priority cleanup
  const lowItems = risks.filter((r: any) => r.severity === 'low')
  if (lowItems.length > 0) {
    steps.push({
      num: stepNum++, owner: 'claude', phase: 'D',
      task: `Limpeza pós-migração (${lowItems.length} item(s) de baixa prioridade)`,
      detail: lowItems.map((r: any) => escHtml(r.title ?? '')).slice(0, 4).join('; '),
      dependsOn: String(stepNum - 2),
    })
  }

  if (steps.length === 0) {
    return ''
  }

  const phaseLabels: Record<string, string> = {
    A: 'Fase A — Verificações e Decisões (antes de qualquer implementação)',
    B: 'Fase B — Implementação (Claude executa)',
    C: 'Fase C — Validação e Encerramento (você valida)',
    D: 'Fase D — Limpeza Pós-migração (baixa prioridade)',
  }

  let rows = ''
  let lastPhase = ''
  for (const step of steps) {
    if (step.phase !== lastPhase) {
      rows += `<tr class="phase-div"><td colspan="5">${escHtml(phaseLabels[step.phase] ?? step.phase)}</td></tr>`
      lastPhase = step.phase
    }
    const isYou = step.owner === 'you'
    rows += `
    <tr class="${isYou ? 'row-you' : 'row-claude'}">
      <td><span class="step-num ${isYou ? 'step-you' : 'step-claude'}">${step.num}</span></td>
      <td>${isYou ? '<span class="owner-you">👤 Você</span>' : '<span class="owner-claude">🤖 Claude</span>'}</td>
      <td>${escHtml(step.task)}</td>
      <td style="font-size:12px;color:#475569">${step.detail}</td>
      <td style="font-size:12px;white-space:nowrap">${escHtml(step.dependsOn)}</td>
    </tr>`
  }

  const youSteps = steps.filter(s => s.owner === 'you')
  const claudeSteps = steps.filter(s => s.owner === 'claude')

  return `
  <section class="plan-section">
    <h2>Plano de Execução — Divisão de Responsabilidades</h2>
    <p style="font-size:13px;color:#475569;margin-bottom:16px">
      Passos derivados automaticamente dos riscos e itens manuais identificados.
      <strong style="color:#5b21b6">Claude Code</strong> executa verificações, implementações e compilação.
      <strong style="color:#0e7490">Você</strong> toma decisões arquiteturais e valida com infraestrutura real.
      A coluna "Depende de" indica pré-requisitos.
    </p>
    <table>
      <thead>
        <tr>
          <th style="width:36px">#</th>
          <th style="width:110px">Responsável</th>
          <th>Tarefa</th>
          <th>Detalhe</th>
          <th style="width:100px">Depende de</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="resp-grid">
      <div class="resp-box resp-box-you">
        <h4>👤 Exclusivamente seu (${youSteps.length} passo(s))</h4>
        <ul>
          ${youSteps.map(s => `<li>${escHtml(s.task)}</li>`).join('')}
        </ul>
      </div>
      <div class="resp-box resp-box-claude">
        <h4>🤖 Claude Code executa (${claudeSteps.length} passo(s))</h4>
        <ul>
          ${claudeSteps.map(s => `<li>${escHtml(s.task)}</li>`).join('')}
        </ul>
      </div>
    </div>

    <div class="crit-path">
      <strong>Caminho crítico:</strong>
      ${hasRegistry
        ? 'Claude executa a verificação do registry primeiro (passo 1). ' +
          'Você toma as decisões com base nesse relatório. ' +
          'A implementação começa após suas decisões.'
        : 'As decisões arquiteturais (passos de "Você" na Fase A) desbloqueiam toda a implementação. ' +
          'Configure <code>artifactRegistry</code> no jdk-migration.config.json para que Claude verifique deps internas automaticamente.'}
    </div>
  </section>`
}

function buildStepProgress(ctx: BuildContext): string {
  const { steps } = ctx

  if (steps.length === 0) {
    return `
  <section class="steps-section">
    <h2>Progresso dos Steps</h2>
    <p class="empty">Nenhum commit de fase encontrado ainda. Execute as fases para que os steps sejam derivados automaticamente do git log.</p>
  </section>`
  }

  const sorted = [...steps].sort((a, b) => {
    if (!a._fromGit && b._fromGit) return -1
    if (a._fromGit && !b._fromGit) return 1
    return a.num - b.num
  })

  const doneCount = sorted.filter(s => s.status === 'done').length
  const total = sorted.length
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const hasGitSteps = sorted.some(s => s._fromGit)
  const hasManualSteps = sorted.some(s => !s._fromGit)

  const phaseLabels: Record<string, string> = {
    A: 'Fase A — Verificações e Decisões',
    B: 'Fase B — Implementação',
    C: 'Fase C — Validação e Encerramento',
    D: 'Fase D — Limpeza',
  }

  let rows = ''
  let lastGroup = ''

  for (const step of sorted) {
    // Agrupa: steps manuais por phase (A/B/C/D), git-derived por nota de fase
    const group = step._fromGit
      ? (step.note?.split('·')[0]?.trim() ?? 'Git')
      : (step.phase ?? '')

    const groupLabel = step._fromGit
      ? `Commits registrados — ${step.note?.split('·')[0]?.trim() ?? ''}`
      : (phaseLabels[step.phase ?? ''] ?? step.phase ?? '')

    if (group && group !== lastGroup) {
      rows += `<tr class="phase-div"><td colspan="5">${escHtml(groupLabel)}</td></tr>`
      lastGroup = group
    }

    const isYou = step.owner === 'you'
    const isGit = !!step._fromGit

    const ownerCell = isGit
      ? '<span class="git-badge">⎇ git</span>'
      : isYou
        ? '<span class="owner-you">👤 Você</span>'
        : '<span class="owner-claude">🤖 Claude</span>'

    const statusBadge = step.status === 'done'
      ? '<span class="badge badge-step-done">✓ Concluído</span>'
      : step.status === 'skipped'
        ? '<span class="badge badge-step-skipped">↷ Pulado</span>'
        : '<span class="badge badge-step-pending">⏳ Pendente</span>'

    const commitCell = step.commit
      ? `<span class="commit-ref">${escHtml(step.commit)}</span>${step.note && !isGit ? ` — ${escHtml(step.note)}` : ''}`
      : step.note
        ? escHtml(step.note)
        : '—'

    const rowClass = isGit
      ? 'row-git'
      : `step-${step.status ?? 'pending'}`

    const displayNum = isGit ? '·' : String(step.num)

    rows += `
    <tr class="${rowClass}">
      <td style="color:#94a3b8;text-align:center">${displayNum}</td>
      <td>${ownerCell}</td>
      <td>${escHtml(step.task ?? '')}</td>
      <td>${statusBadge}</td>
      <td style="font-size:12px">${commitCell}</td>
    </tr>`
  }

  const legendNote = hasGitSteps && !hasManualSteps
    ? `<p style="font-size:11px;color:#0369a1;margin-bottom:10px">
        ⎇ Steps derivados automaticamente do <strong>git log</strong> de cada fase.
        Use <code>update_step_status</code> para substituí-los por descrições estruturadas.
       </p>`
    : hasGitSteps && hasManualSteps
      ? `<p style="font-size:11px;color:#0369a1;margin-bottom:10px">
          ⎇ Linhas azuis = commits git detectados automaticamente · Demais = steps registrados manualmente.
         </p>`
      : ''

  return `
  <section class="steps-section">
    <h2>Progresso dos Steps (${doneCount}/${total} concluídos · ${pct}%)</h2>
    <p class="steps-progress-label">${doneCount} de ${total} steps concluídos</p>
    <div class="steps-progress-bar"><div class="steps-progress-fill" style="width:${pct}%"></div></div>
    ${legendNote}
    <table>
      <thead>
        <tr>
          <th style="width:36px">#</th>
          <th style="width:110px">Responsável</th>
          <th>Tarefa / Commit</th>
          <th style="width:110px">Status</th>
          <th>Ref / Nota</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`
}

function buildMigrationAuditSection(audit: MigrationAuditResult, sourceJdk: string = '?'): string {
  const { criteria, summary, allOk, generatedAt, targetJdk } = audit
  const sectionClass = allOk ? 'audit-ok' : 'audit-section'

  const iconMap: Record<string, string> = { ok: '✅', warning: '⚠️', fail: '❌' }

  const banner = allOk
    ? `<div class="audit-clean-banner">✅ STATUS FINAL: PROJETO MIGRADO COM SUCESSO — todos os ${criteria.length} critérios de auditoria foram atendidos.</div>`
    : `<div class="audit-blocker-banner">❌ STATUS FINAL: PROJETO APRESENTA ISSUES QUE AINDA O LIGA A JDK ${escHtml(sourceJdk)} — ${summary.fail} falha(s) e ${summary.warning} aviso(s) detectados. Revise os itens abaixo antes do cutover.</div>`

  const pillsHtml = `
    <div class="audit-summary-bar">
      <span class="audit-pill audit-pill-ok">✅ ${summary.ok} OK</span>
      <span class="audit-pill audit-pill-warning">⚠️ ${summary.warning} Atenção</span>
      <span class="audit-pill audit-pill-fail">❌ ${summary.fail} Falha</span>
      <span style="font-size:11px;color:#94a3b8;margin-left:auto;align-self:center;">Gerado em ${escHtml(new Date(generatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}</span>
    </div>`

  const criteriaHtml = criteria.map(c => {
    const icon = iconMap[c.status] ?? '—'
    const filesHtml = c.files && c.files.length > 0
      ? `<div class="audit-files">${c.files.map(f => `<code>${escHtml(f)}</code>`).join(' &nbsp;')}</div>`
      : ''
    const actionHtml = c.action
      ? `<div class="audit-action">💡 ${escHtml(c.action)}</div>`
      : ''
    return `
    <div class="audit-criterion">
      <div class="audit-icon">${icon}</div>
      <div class="audit-body">
        <div class="audit-label">${escHtml(c.label)}</div>
        <div class="audit-detail">${escHtml(c.detail)}</div>
        ${filesHtml}
        ${actionHtml}
      </div>
    </div>`
  }).join('')

  return `
  <section class="${sectionClass}">
    <h2>🔍 Auditoria de Migração JDK ${escHtml(targetJdk)}</h2>
    ${pillsHtml}
    ${banner}
    ${criteriaHtml}
  </section>`
}

function buildAuditTrail(ctx: BuildContext): string {
  const { phases } = ctx
  const events: { ts: string; text: string }[] = []

  for (const [num, phase] of Object.entries(phases)) {
    if (phase.approvedAt && phase.approvedBy) {
      events.push({
        ts: phase.approvedAt,
        text: `Fase ${num} aprovada por <strong>${escHtml(phase.approvedBy)}</strong>`,
      })
    }
    if (phase.executedAt) {
      events.push({
        ts: phase.executedAt,
        text: `Fase ${num} executada${phase.gitBranch ? ` — branch <code>${escHtml(phase.gitBranch)}</code>` : ''}`,
      })
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts))

  if (events.length === 0) {
    return `<section><h2>Trilha de Auditoria</h2><p class="empty">Nenhuma ação registrada ainda.</p></section>`
  }

  return `
  <section>
    <h2>Trilha de Auditoria</h2>
    <table>
      <thead><tr><th>Data/Hora</th><th>Evento</th></tr></thead>
      <tbody>
        ${events.map(e => `
        <tr>
          <td style="white-space:nowrap;font-size:12px">${escHtml(fmtDate(e.ts))}</td>
          <td>${e.text}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>`
}

// ─── utilities ────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  } catch {
    return iso
  }
}

function shortRecipe(recipe: string): string {
  // mostra apenas a parte final da recipe — ex: UpgradeToJava21
  const parts = recipe.split('.')
  return parts.slice(-1)[0] ?? recipe
}
