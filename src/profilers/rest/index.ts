import type { StackProfiler, ProfilerReport, RiskItem } from '../types.js'
import type { JdkMigrationConfig } from '../../lib/config.js'
import type { PhaseNumber } from '../../types.js'
import { findJavaFiles, scanFiles, readPom, hasPomDependency } from '../scanner.js'

export const restProfiler: StackProfiler = {
  stackType: 'rest',

  async analyze(projectPath, config): Promise<ProfilerReport> {
    const pom = readPom(projectPath)
    const javaFiles = findJavaFiles(projectPath)
    const riskItems: RiskItem[] = []

    // ── Corrobora que é REST stateless (sem EJB/JSF) ─────────────────────
    const hasEjb = config.stack.includes('ejb')
    const hasJsf = config.stack.includes('jsf')
    if (hasEjb || hasJsf) {
      riskItems.push({
        id: 'rest-not-stateless',
        severity: 'medium',
        title: 'Microservice REST com componentes stateful detectados',
        description:
          `Stack inclui ${[hasEjb && 'EJB', hasJsf && 'JSF'].filter(Boolean).join(' e ')}. ` +
          'Revisar se esses componentes são necessários no serviço REST.',
        file: null, line: null,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── javax.servlet.http usage ──────────────────────────────────────────
    const servletHits = scanFiles(javaFiles, projectPath, /import javax\.servlet\./)
    if (servletHits.length > 0) {
      riskItems.push({
        id: 'rest-javax-servlet',
        severity: 'high',
        title: `javax.servlet.* detectado em ${[...new Set(servletHits.map(h => h.file))].length} arquivo(s)`,
        description: 'Imports javax.servlet precisam ser migrados para jakarta.servlet no Spring Boot 3.',
        file: servletHits[0].file, line: servletHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxServletMigrationToJakartaServlet',
      })
    }

    // ── JAX-RS usage ──────────────────────────────────────────────────────
    const jaxrsHits = scanFiles(javaFiles, projectPath, /import javax\.ws\.rs\./)
    if (jaxrsHits.length > 0) {
      riskItems.push({
        id: 'rest-jaxrs',
        severity: 'high',
        title: `JAX-RS javax.ws.rs.* detectado — migrar para jakarta.ws.rs`,
        description: 'JAX-RS com namespace javax precisa ser migrado para jakarta.',
        file: jaxrsHits[0].file, line: jaxrsHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxWsRsMigrationToJakartaWsRs',
      })
    }

    // ── sun.misc.BASE64Encoder/Decoder (crítico: removido no JDK 9) ──────
    const base64Hits = scanFiles(javaFiles, projectPath, /sun\.misc\.BASE64(Encoder|Decoder)/)
    if (base64Hits.length > 0) {
      riskItems.push({
        id: 'rest-sun-base64',
        severity: 'high',
        title: `sun.misc.BASE64Encoder/Decoder detectado — removido no JDK 9`,
        description: `${base64Hits.length} uso(s) da API removida. Substituir por java.util.Base64.`,
        file: base64Hits[0].file, line: base64Hits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.UseJavaUtilBase64ForEncoding',
      })
    }

    // ── RestTemplate → WebClient (recomendado, não obrigatório) ──────────
    const restTemplateHits = scanFiles(javaFiles, projectPath, /new RestTemplate\(\)|RestTemplate\s+\w+\s*=/)
    if (restTemplateHits.length > 0) {
      riskItems.push({
        id: 'rest-template-deprecated',
        severity: 'low',
        title: 'RestTemplate em uso — considerar migração para WebClient',
        description:
          'RestTemplate está em modo de manutenção. ' +
          'WebClient é a alternativa reativa recomendada para novos projetos.',
        file: restTemplateHits[0].file, line: restTemplateHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── Oracle JDBC: ojdbc8 → ojdbc11 ────────────────────────────────────
    if (hasPomDependency(pom, 'ojdbc8')) {
      riskItems.push({
        id: 'oracle-ojdbc8-jdk21',
        severity: 'high',
        title: 'ojdbc8 detectado — substituir por ojdbc11 para JDK 21',
        description:
          'ojdbc8 e otimizado para JDK 8 e pode apresentar problemas com o module system do JDK 11+. ' +
          'Para JDK 21, use ojdbc11 (mesmo groupId, mesma versao). A API JDBC e identica.',
        file: 'pom.xml',
        line: null,
        automationAvailable: true,
        recipe: 'update-ojdbc8-to-ojdbc11',
      })
    }

    const estimatedEffortDays = Math.ceil(
      riskItems.reduce((sum, r) => {
        return sum + ({ critical: 5, high: 2, medium: 0.5, low: 0.1 }[r.severity] ?? 0)
      }, 0),
    )

    return {
      stackType: 'rest',
      riskItems,
      manualReviewItems: [],
      estimatedEffortDays,
      prerequisiteChecks: [
        {
          name: 'Microservice REST stateless',
          passed: !hasEjb && !hasJsf,
          message: !hasEjb && !hasJsf
            ? 'Microservice REST stateless confirmado — automação alta'
            : 'Componentes stateful detectados — revisar arquitetura',
        },
      ],
    }
  },

  getRiskItems(report) { return report.riskItems },
  getManualReviewItems(report) { return report.manualReviewItems },

  getRecipes(phase, _report): string[] { return [] },
}
