import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MigrationError } from '../lib/errors.js'

export interface AuditReportResult {
  reportPath: string
  phasesCompleted: number
  phasesTotal: number
  openManualItems: number
  criticalRisks: number
}

export async function generateAuditReport(projectPath: string): Promise<AuditReportResult> {
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

  const html = buildHtml({ plan, discovery, config, phases, allRiskItems, allManualItems, now, projectPath })
  writeFileSync(reportPath, html, 'utf-8')

  return {
    reportPath,
    phasesCompleted,
    phasesTotal,
    openManualItems: allManualItems.length,
    criticalRisks,
  }
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
}

function buildHtml(ctx: BuildContext): string {
  const { plan, discovery, config, phases, allRiskItems, allManualItems, now, projectPath } = ctx
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
    .card.red .num  { color: #dc2626; }
    .card.orange .num { color: #ea580c; }
    .card.green .num { color: #16a34a; }
    .card.blue .num  { color: #2563eb; }
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
  ${buildDiscoverySummary(ctx)}
  ${buildRiskRegister(allRiskItems)}
  ${buildPhaseStatus(ctx)}
  ${buildManualItems(allManualItems)}
  ${buildAuditTrail(ctx)}

  <footer>
    Gerado por jdk-migration-mcp &nbsp;•&nbsp; ${escHtml(now.toISOString())}
  </footer>

</div>
</body>
</html>`
}

function buildExecutiveSummary(ctx: BuildContext): string {
  const { phases, allRiskItems, allManualItems } = ctx
  const phaseList = Object.values(phases) as any[]
  const completed = phaseList.filter(p => p.status === 'completed').length
  const total = phaseList.length
  const critical = allRiskItems.filter(r => r.severity === 'critical').length
  const high = allRiskItems.filter(r => r.severity === 'high').length
  return `
  <section>
    <h2>Resumo Executivo</h2>
    <div class="cards">
      <div class="card ${completed === total && total > 0 ? 'green' : 'blue'}">
        <div class="num">${completed}/${total}</div>
        <div class="lbl">Fases Concluídas</div>
      </div>
      <div class="card ${critical > 0 ? 'red' : 'green'}">
        <div class="num">${critical}</div>
        <div class="lbl">Riscos Críticos</div>
      </div>
      <div class="card ${high > 0 ? 'orange' : 'green'}">
        <div class="num">${high}</div>
        <div class="lbl">Riscos Altos</div>
      </div>
      <div class="card ${allManualItems.length > 0 ? 'orange' : 'green'}">
        <div class="num">${allManualItems.length}</div>
        <div class="lbl">Itens Manuais</div>
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
