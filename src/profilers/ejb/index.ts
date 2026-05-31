import type { StackProfiler, ProfilerReport, RiskItem, ManualReviewItem } from '../types.js'
import type { JdkMigrationConfig } from '../../lib/config.js'
import type { PhaseNumber } from '../../types.js'
import { findJavaFiles, findXmlFiles, scanFiles, readPom } from '../scanner.js'

// ─── Invariante inegociável ────────────────────────────────────────────────
// O profiler EJB NUNCA marca como automationAvailable: true para:
// - @Stateful com @Remove e @PreDestroy
// - javax.ejb.SessionContext
// - javax.transaction.UserTransaction direto
// - @Remote interfaces
// - @EJB injection em contextos não gerenciados
// - JNDI lookups manuais via new InitialContext().lookup(...)

export const ejbProfiler: StackProfiler = {
  stackType: 'ejb',

  async analyze(projectPath, _config): Promise<ProfilerReport> {
    const javaFiles = findJavaFiles(projectPath)
    const xmlFiles = findXmlFiles(projectPath)
    const riskItems: RiskItem[] = []
    const manualItems: ManualReviewItem[] = []

    // ── @Stateful beans — SEMPRE manual, sem automação ────────────────────
    const statefulHits = scanFiles(javaFiles, projectPath, /@Stateful/)
    if (statefulHits.length > 0) {
      const files = [...new Set(statefulHits.map(h => h.file))]
      riskItems.push({
        id: 'ejb-stateful',
        severity: 'critical',
        title: `@Stateful beans detectados — redesenho necessário (${files.length} arquivo(s))`,
        description:
          '@Stateful EJBs mantêm estado de sessão via infraestrutura do container. ' +
          'Esta semântica não tem equivalente direto no Jakarta EE moderno. ' +
          'Migrar para CDI @SessionScoped + JPA, ou rearquitetar para stateless com cache externo.',
        file: statefulHits[0].file, line: statefulHits[0].line,
        automationAvailable: false,  // INVARIANTE: nunca automatizar @Stateful
        recipe: null,
      })
      manualItems.push({
        id: 'ejb-stateful-redesign',
        category: 'semantic',
        title: 'Redesenhar @Stateful EJBs',
        description:
          'Beans @Stateful precisam ser reavaliados caso a caso. ' +
          'O estado de sessão armazenado no bean pode ter comportamento diferente ' +
          'sob clustering, passivação e timeout de sessão.',
        suggestedApproach:
          '1. Catalogar todos os campos de estado em cada @Stateful.\n' +
          '2. Verificar se o estado pode ser movido para a sessão HTTP ou banco de dados.\n' +
          '3. Se clustering for necessário, avaliar solução de cache distribuído (Redis, Hazelcast).\n' +
          '4. Substituir por CDI @SessionScoped ou @ConversationScoped conforme o ciclo de vida.',
        files,
      })
    }

    // ── @Remove + @PreDestroy — crítico, manual ───────────────────────────
    const removeHits = scanFiles(javaFiles, projectPath, /@Remove/)
    if (removeHits.length > 0) {
      riskItems.push({
        id: 'ejb-remove-annotation',
        severity: 'critical',
        title: '@Remove — limpeza de estado de sessão',
        description:
          '@Remove marca métodos que encerram o ciclo de vida do bean stateful. ' +
          'Sem equivalente direto; lógica de destruição deve ser reimplementada manualmente.',
        file: removeHits[0].file, line: removeHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── SessionContext — manual ───────────────────────────────────────────
    const sessionCtxHits = scanFiles(javaFiles, projectPath, /SessionContext|EJBContext/)
    if (sessionCtxHits.length > 0) {
      riskItems.push({
        id: 'ejb-session-context',
        severity: 'critical',
        title: 'SessionContext / EJBContext — APIs específicas de container',
        description:
          'O uso de SessionContext (rollbackOnly, getUserPrincipal, getTimerService) ' +
          'é específico do container EJB. Sem equivalente direto no CDI.',
        file: sessionCtxHits[0].file, line: sessionCtxHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'ejb-session-context-manual',
        category: 'semantic',
        title: 'Substituir SessionContext por APIs CDI equivalentes',
        description: 'Cada uso de SessionContext precisa ser analisado individualmente.',
        suggestedApproach:
          '- getUserPrincipal() → injetar SecurityContext (Jakarta Security)\n' +
          '- setRollbackOnly() → injetar TransactionManager e chamar setRollbackOnly\n' +
          '- getTimerService() → injetar TimerService do CDI\n' +
          '- getCallerPrincipal() → injetar Principal via CDI',
        files: [...new Set(sessionCtxHits.map(h => h.file))],
      })
    }

    // ── UserTransaction direto — manual ───────────────────────────────────
    const utHits = scanFiles(javaFiles, projectPath, /UserTransaction/)
    if (utHits.length > 0) {
      riskItems.push({
        id: 'ejb-user-transaction',
        severity: 'critical',
        title: 'javax.transaction.UserTransaction — controle transacional manual',
        description:
          'UserTransaction é usado para controle BMT (Bean Managed Transactions). ' +
          'Verificar semanticamente cada transação; não há automação segura.',
        file: utHits[0].file, line: utHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── @Stateless — namespace automático disponível ──────────────────────
    const statelessHits = scanFiles(javaFiles, projectPath, /@Stateless/)
    if (statelessHits.length > 0) {
      riskItems.push({
        id: 'ejb-stateless',
        severity: 'medium',
        title: `@Stateless beans — migração de namespace (${[...new Set(statelessHits.map(h => h.file))].length} arquivo(s))`,
        description: 'Beans @Stateless precisam migrar de javax.ejb → jakarta.ejb via recipe.',
        file: statelessHits[0].file, line: statelessHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb',
      })
    }

    // ── @MessageDriven — JMS, namespace parcialmente automatizável ────────
    const mdbHits = scanFiles(javaFiles, projectPath, /@MessageDriven/)
    if (mdbHits.length > 0) {
      riskItems.push({
        id: 'ejb-mdb',
        severity: 'high',
        title: '@MessageDriven (JMS) — verificar configuração do broker',
        description:
          'Beans MDB precisam ter o namespace migrado E a configuração do message broker verificada. ' +
          'A configuração do listener pode ter mudado.',
        file: mdbHits[0].file, line: mdbHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb',
      })
      manualItems.push({
        id: 'ejb-mdb-broker',
        category: 'behavioral',
        title: 'Verificar configuração do message broker após migração de MDB',
        description:
          'A migração de namespace não garante que o broker (ActiveMQ, JMS provider) ' +
          'está configurado corretamente para o container de destino.',
        suggestedApproach:
          'Testar o MDB end-to-end no ambiente alvo após a migração de namespace. ' +
          'Verificar resource-ref e activation-config no ejb-jar.xml.',
        files: [...new Set(mdbHits.map(h => h.file))],
      })
    }

    // ── @Remote interfaces — manual ────────────────────────────────────────
    const remoteHits = scanFiles(javaFiles, projectPath, /@Remote|EJBHome|EJBLocalHome/)
    if (remoteHits.length > 0) {
      riskItems.push({
        id: 'ejb-remote',
        severity: 'critical',
        title: 'Interfaces @Remote / EJBHome detectadas',
        description:
          'Chamadas remotas via RMI/IIOP não têm substituto direto. ' +
          'Considerar migração para REST ou gRPC.',
        file: remoteHits[0].file, line: remoteHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'ejb-remote-redesign',
        category: 'semantic',
        title: 'Redesenhar interfaces @Remote para REST ou gRPC',
        description:
          'Interfaces remotas EJB (RMI-IIOP) devem ser reavaliadas. ' +
          'O suporte a RMI-IIOP sobre CORBA foi removido no JDK 11.',
        suggestedApproach:
          'Avaliar se as chamadas remotas podem ser expostas como REST (JAX-RS / Spring Web). ' +
          'Para chamadas síncronas com schema forte, considerar gRPC.',
        files: [...new Set(remoteHits.map(h => h.file))],
      })
    }

    // ── JNDI lookups manuais — manual ──────────────────────────────────────
    const jndiHits = scanFiles(javaFiles, projectPath, /InitialContext\(\)|lookup\s*\(/)
    if (jndiHits.length > 0) {
      riskItems.push({
        id: 'ejb-jndi-lookup',
        severity: 'high',
        title: 'JNDI lookups manuais detectados',
        description:
          'new InitialContext().lookup(...) é frágil e depende do naming do container. ' +
          'Substituir por injeção @EJB ou @Resource.',
        file: jndiHits[0].file, line: jndiHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── ejb-jar.xml — namespace parcialmente automático ───────────────────
    const ejbJarHits = scanFiles(xmlFiles, projectPath, /ejb-jar/)
    if (ejbJarHits.length > 0 || xmlFiles.some(f => f.endsWith('ejb-jar.xml'))) {
      riskItems.push({
        id: 'ejb-jar-xml',
        severity: 'medium',
        title: 'ejb-jar.xml detectado — migrar namespace do descritor',
        description: 'O descritor ejb-jar.xml usa namespace javax; migrar para jakarta.',
        file: ejbJarHits[0]?.file ?? 'META-INF/ejb-jar.xml', line: null,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb',
      })
    }

    return {
      stackType: 'ejb',
      riskItems,
      manualReviewItems: manualItems,
      estimatedEffortDays: estimateEffort(riskItems, manualItems),
      prerequisiteChecks: [
        {
          name: '@Stateful beans identificados',
          passed: statefulHits.length > 0,
          message: statefulHits.length > 0
            ? `${statefulHits.length} ocorrência(s) de @Stateful — revisão manual obrigatória`
            : 'Nenhum @Stateful detectado — stack EJB relativamente simples',
        },
      ],
    }
  },

  getRiskItems: r => r.riskItems,
  getManualReviewItems: r => r.manualReviewItems,

  getRecipes(phase, report): string[] {
    if (phase !== 3) return []
    // Apenas namespaces automáticos — @Stateful e afins nunca entram aqui
    const hasAutomatable = report.riskItems.some(r => r.automationAvailable && r.recipe)
    return hasAutomatable
      ? ['org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb']
      : []
  },
}

function estimateEffort(risks: RiskItem[], manuals: ManualReviewItem[]): number {
  const r = risks.reduce((s, ri) => s + ({ critical: 7, high: 3, medium: 1, low: 0.2 }[ri.severity] ?? 0), 0)
  return Math.ceil(r + manuals.length * 2)
}
