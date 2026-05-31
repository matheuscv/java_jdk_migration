import type { StackProfiler, ProfilerReport, RiskItem, ManualReviewItem } from '../types.js'
import { findJavaFiles, findXmlFiles, scanFiles } from '../scanner.js'

// ─── Invariante inegociável ────────────────────────────────────────────────
// O recipe JDK (UpgradeToJava21) DEVE ser aplicado ANTES do recipe WebLogic.
// Ordem oficial Oracle (oracle/rewrite-recipes). O transform-engine garante essa ordem.

export const weblogicProfiler: StackProfiler = {
  stackType: 'weblogic',

  async analyze(projectPath, _config): Promise<ProfilerReport> {
    const javaFiles = findJavaFiles(projectPath)
    const xmlFiles = findXmlFiles(projectPath)
    const riskItems: RiskItem[] = []
    const manualItems: ManualReviewItem[] = []

    // ── import weblogic.* — APIs proprietárias Oracle ─────────────────────
    const wlApiHits = scanFiles(javaFiles, projectPath, /import weblogic\./)
    if (wlApiHits.length > 0) {
      const files = [...new Set(wlApiHits.map(h => h.file))]
      riskItems.push({
        id: 'wl-proprietary-api',
        severity: 'critical',
        title: `APIs proprietárias WebLogic detectadas (${files.length} arquivo(s))`,
        description:
          'Imports weblogic.* são APIs proprietárias Oracle. ' +
          'O recipe Oracle cobre parte da migração; residuais exigem revisão manual.',
        file: wlApiHits[0].file, line: wlApiHits[0].line,
        automationAvailable: true,
        recipe: 'com.oracle.weblogic.rewrite.UpgradeWebLogic14To21',
      })
      manualItems.push({
        id: 'wl-proprietary-api-review',
        category: 'semantic',
        title: 'Revisar APIs proprietárias WebLogic sem substituto automático',
        description: 'Após o recipe Oracle, verificar cada API que não possui substituto direto.',
        suggestedApproach:
          '- weblogic.jdbc.extensions.* → usar javax.sql.DataSource / jakarta.sql.DataSource\n' +
          '- weblogic.jms.* → usar JMS padrão (jakarta.jms.*)\n' +
          '- weblogic.management.* → sem substituto — remover ou reimplementar\n' +
          '- weblogic.cluster.* → verificar alternativa no servidor alvo',
        files,
      })
    }

    // ── weblogic.jdbc.extensions — extensões JDBC proprietárias ──────────
    const wlJdbcHits = scanFiles(javaFiles, projectPath, /weblogic\.jdbc\.extensions|weblogic\.jdbc\.vendor/)
    if (wlJdbcHits.length > 0) {
      riskItems.push({
        id: 'wl-jdbc-extensions',
        severity: 'critical',
        title: 'Extensões JDBC proprietárias WebLogic',
        description:
          'weblogic.jdbc.extensions.PooledConnection e similares não existem fora do WebLogic. ' +
          'Substituir por javax.sql.DataSource / jakarta.sql.DataSource padrão.',
        file: wlJdbcHits[0].file, line: wlJdbcHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── T3:// — protocolo proprietário de comunicação remota ─────────────
    const t3Hits = scanFiles(javaFiles, projectPath, /[Tt]3:\/\//)
    if (t3Hits.length > 0) {
      riskItems.push({
        id: 'wl-t3-protocol',
        severity: 'critical',
        title: 'Protocolo T3 WebLogic detectado',
        description:
          'T3:// é o protocolo proprietário do WebLogic para JNDI remoto e RMI. ' +
          'Sem equivalente em outros servidores. Requer migração para IIOP, REST ou gRPC.',
        file: t3Hits[0].file, line: t3Hits[0].line,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'wl-t3-redesign',
        category: 'semantic',
        title: 'Substituir URLs T3:// por protocolo padrão',
        description: 'Conexões via T3 devem ser redesenhadas para protocolo aberto.',
        suggestedApproach:
          '- Para JNDI remoto: avaliar se pode ser substituído por REST/gRPC\n' +
          '- Para EJB remoto: ver orientações do profiler EJB sobre @Remote\n' +
          '- Para JMS: usar URL padrão do broker (tcp://, amqp://)',
        files: [...new Set(t3Hits.map(h => h.file))],
      })
    }

    // ── weblogic.xml descriptor ───────────────────────────────────────────
    const hasWeblogicXml = xmlFiles.some(f => f.endsWith('weblogic.xml'))
    const wlXmlHits = scanFiles(xmlFiles, projectPath, /weblogic-version|wls:weblogic-web-app|xmlns\.bea\.com/)
    if (hasWeblogicXml || wlXmlHits.length > 0) {
      riskItems.push({
        id: 'wl-descriptor-weblogic-xml',
        severity: 'high',
        title: 'weblogic.xml — recipe Oracle disponível',
        description:
          'O descritor weblogic.xml contém configurações proprietárias (resource-ref, security-role-assignment, etc). ' +
          'Recipe Oracle cobre a migração de namespace; configurações proprietárias exigem revisão.',
        file: wlXmlHits[0]?.file ?? 'WEB-INF/weblogic.xml', line: null,
        automationAvailable: true,
        recipe: 'com.oracle.weblogic.rewrite.UpgradeWebLogic14To21',
      })
    }

    // ── weblogic-application.xml — EAR proprietário ───────────────────────
    const hasWlAppXml = xmlFiles.some(f => f.endsWith('weblogic-application.xml'))
    if (hasWlAppXml) {
      riskItems.push({
        id: 'wl-descriptor-application-xml',
        severity: 'high',
        title: 'weblogic-application.xml — configuração de EAR proprietária',
        description: 'Configurações específicas de EAR WebLogic. Recipe Oracle cobre parte.',
        file: 'META-INF/weblogic-application.xml', line: null,
        automationAvailable: true,
        recipe: 'com.oracle.weblogic.rewrite.UpgradeWebLogic14To21',
      })
    }

    // ── weblogic-ejb-jar.xml — bindings EJB proprietários ────────────────
    const hasWlEjbJar = xmlFiles.some(f => f.endsWith('weblogic-ejb-jar.xml'))
    if (hasWlEjbJar) {
      riskItems.push({
        id: 'wl-descriptor-ejb-jar',
        severity: 'high',
        title: 'weblogic-ejb-jar.xml — bindings EJB proprietários',
        description: 'Bindings e configurações EJB específicas do WebLogic.',
        file: 'META-INF/weblogic-ejb-jar.xml', line: null,
        automationAvailable: true,
        recipe: 'com.oracle.weblogic.rewrite.UpgradeWebLogic14To21',
      })
      manualItems.push({
        id: 'wl-ejb-jar-review',
        category: 'semantic',
        title: 'Revisar weblogic-ejb-jar.xml após recipe Oracle',
        description:
          'O recipe migra namespaces; bindings proprietários (jndi-name, resource-description) ' +
          'podem não ter equivalente direto.',
        suggestedApproach:
          'Após o recipe, verificar se os JNDI names dos EJBs foram preservados ' +
          'ou precisam ser reconfigurados no servidor alvo.',
        files: ['META-INF/weblogic-ejb-jar.xml'],
      })
    }

    // ── weblogic.jms — JMS proprietário ──────────────────────────────────
    const wlJmsHits = scanFiles(javaFiles, projectPath, /import weblogic\.jms\./)
    if (wlJmsHits.length > 0) {
      riskItems.push({
        id: 'wl-jms-proprietary',
        severity: 'high',
        title: 'weblogic.jms.* — substituir por JMS padrão',
        description:
          'APIs JMS proprietárias do WebLogic. Substituir por jakarta.jms.*. ' +
          'A configuração do broker pode precisar de ajuste.',
        file: wlJmsHits[0].file, line: wlJmsHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    return {
      stackType: 'weblogic',
      riskItems,
      manualReviewItems: manualItems,
      estimatedEffortDays: estimateEffort(riskItems, manualItems),
      prerequisiteChecks: [
        {
          name: 'weblogic.xml detectado',
          passed: hasWeblogicXml,
          message: hasWeblogicXml
            ? 'weblogic.xml presente — recipe Oracle necessário'
            : 'weblogic.xml não encontrado',
        },
        {
          name: 'APIs proprietárias WebLogic no código',
          passed: wlApiHits.length > 0,
          message: wlApiHits.length > 0
            ? `${wlApiHits.length} referência(s) a weblogic.* detectadas`
            : 'Nenhuma API proprietária WebLogic detectada no código fonte',
        },
      ],
    }
  },

  getRiskItems: r => r.riskItems,
  getManualReviewItems: r => r.manualReviewItems,

  getRecipes(phase, report): string[] {
    if (phase !== 3) return []
    // INVARIANTE: o transform-engine adiciona UpgradeToJava21 ANTES deste recipe.
    const hasWlIssues = report.riskItems.some(
      r => r.automationAvailable && r.recipe?.includes('weblogic'),
    )
    return hasWlIssues
      ? ['com.oracle.weblogic.rewrite.UpgradeWebLogic14To21']
      : []
  },
}

function estimateEffort(risks: RiskItem[], manuals: ManualReviewItem[]): number {
  const r = risks.reduce((s, ri) => s + ({ critical: 7, high: 3, medium: 1, low: 0.2 }[ri.severity] ?? 0), 0)
  return Math.ceil(r + manuals.length * 2)
}
