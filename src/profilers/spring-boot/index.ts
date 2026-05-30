import type { StackProfiler, ProfilerReport, RiskItem, ManualReviewItem } from '../types.js'
import type { JdkMigrationConfig } from '../../lib/config.js'
import type { PhaseNumber } from '../../types.js'
import {
  findJavaFiles, findPropertyFiles, scanFiles, readPom,
  extractPomVersion, hasPomDependency,
} from '../scanner.js'

export const springBootProfiler: StackProfiler = {
  stackType: 'spring-boot',

  async analyze(projectPath, config): Promise<ProfilerReport> {
    const pom = readPom(projectPath)
    const javaFiles = findJavaFiles(projectPath)
    const propFiles = findPropertyFiles(projectPath)
    const riskItems: RiskItem[] = []
    const manualItems: ManualReviewItem[] = []

    // ── Spring Boot version ───────────────────────────────────────────────
    const parentVersion = pom.match(
      /<parent>[\s\S]*?<artifactId>spring-boot-starter-parent<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>/,
    )?.[1] ?? null
    const majorVersion = parentVersion ? parseInt(parentVersion.split('.')[0], 10) : null

    if (majorVersion !== null && majorVersion < 3) {
      riskItems.push({
        id: 'sb-version-upgrade',
        severity: 'high',
        title: `Spring Boot ${parentVersion} → 3.x requer JDK 17+`,
        description: 'Spring Boot 3.x exige Java 17 no mínimo. A migração para JDK 21 inclui essa transição.',
        file: 'pom.xml', line: null,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0',
      })
    }

    // ── WebSecurityConfigurerAdapter (removido no Spring Security 6) ─────
    const wsca = scanFiles(javaFiles, projectPath, /WebSecurityConfigurerAdapter/)
    if (wsca.length > 0) {
      manualItems.push({
        id: 'sb-websecurity-adapter',
        category: 'security',
        title: 'WebSecurityConfigurerAdapter removido no Spring Security 6',
        description:
          'A classe WebSecurityConfigurerAdapter foi removida. ' +
          'A configuração de segurança deve usar componentes SecurityFilterChain declarados como @Bean.',
        suggestedApproach:
          'Substituir a herança de WebSecurityConfigurerAdapter por um @Bean do tipo SecurityFilterChain. ' +
          'Verificar todas as configurações de httpSecurity, authentication managers e CSRF.',
        files: [...new Set(wsca.map(h => h.file))],
      })
      riskItems.push({
        id: 'sb-websecurity-adapter-risk',
        severity: 'high',
        title: 'WebSecurityConfigurerAdapter requer refatoração manual',
        description: 'Encontrado em ' + wsca.length + ' arquivo(s). Sem substituição automática direta.',
        file: wsca[0].file, line: wsca[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── Spring Security: javax.security imports ───────────────────────────
    const javaxSecurity = scanFiles(javaFiles, projectPath, /import javax\.security\./)
    if (javaxSecurity.length > 0) {
      riskItems.push({
        id: 'sb-javax-security',
        severity: 'high',
        title: 'javax.security.* → jakarta.security.*',
        description: `${javaxSecurity.length} arquivo(s) importam javax.security — precisam de migração de namespace.`,
        file: javaxSecurity[0].file, line: javaxSecurity[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxSecurityMigrationToJakartaSecurity',
      })
    }

    // ── AuthenticationManagerBuilder (configuração legada de auth) ───────
    const authBuilder = scanFiles(javaFiles, projectPath, /AuthenticationManagerBuilder/)
    if (authBuilder.length > 0) {
      manualItems.push({
        id: 'sb-auth-manager-builder',
        category: 'security',
        title: 'AuthenticationManagerBuilder — padrão legado de autenticação',
        description:
          'O uso de AuthenticationManagerBuilder no configure(AuthenticationManagerBuilder) ' +
          'é o padrão antigo. No Spring Security 6, a autenticação é configurada via @Bean.',
        suggestedApproach:
          'Extrair a configuração de autenticação para um @Bean do tipo UserDetailsService ' +
          'ou AuthenticationProvider, removendo a sobrescrita de configure().',
        files: [...new Set(authBuilder.map(h => h.file))],
      })
    }

    // ── spring.security.oauth2 properties legadas ─────────────────────────
    const oauth2Props = scanFiles(
      propFiles, projectPath,
      /spring\.security\.oauth2\.(resourceserver|client)\.jwt\.issuer-uri/,
    )
    if (oauth2Props.length > 0) {
      riskItems.push({
        id: 'sb-oauth2-properties',
        severity: 'medium',
        title: 'Propriedades spring.security.oauth2 podem ter mudado no Boot 3',
        description: `${oauth2Props.length} propriedade(s) OAuth2 encontrada(s). Verificar compatibilidade com Spring Security 6.`,
        file: oauth2Props[0].file, line: oauth2Props[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── Actuators com autenticação alterada ───────────────────────────────
    const managementProps = scanFiles(
      propFiles, projectPath,
      /management\.endpoints\.web\.exposure\.include/,
    )
    if (managementProps.length > 0 && hasPomDependency(pom, 'spring-boot-starter-actuator')) {
      manualItems.push({
        id: 'sb-actuator-security',
        category: 'security',
        title: 'Endpoints de actuator — verificar configuração de segurança',
        description:
          'No Spring Boot 3, a configuração de segurança de actuators mudou. ' +
          'Endpoints expostos podem requerer reconfiguração de acesso.',
        suggestedApproach:
          'Revisar management.endpoints.web.exposure.include e garantir que os endpoints ' +
          'sensíveis estão protegidos com as regras corretas de SecurityFilterChain.',
        files: [...new Set(managementProps.map(h => h.file))],
      })
    }

    // ── spring.datasource.* legado ────────────────────────────────────────
    const legacyDatasource = scanFiles(
      propFiles, projectPath,
      /spring\.datasource\.initialization-mode|spring\.jpa\.generate-ddl/,
    )
    if (legacyDatasource.length > 0) {
      riskItems.push({
        id: 'sb-datasource-legacy',
        severity: 'medium',
        title: 'Propriedades de DataSource legadas',
        description:
          'spring.datasource.initialization-mode foi renomeada para spring.sql.init.mode no Spring Boot 2.5+.',
        file: legacyDatasource[0].file, line: legacyDatasource[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.spring.boot2.SpringBootProperties_2_5',
      })
    }

    // ── JUnit 4 → JUnit 5 ─────────────────────────────────────────────────
    const junit4Imports = scanFiles(javaFiles, projectPath, /import org\.junit\.(Test|Assert|Before|After|Rule)/)
    if (junit4Imports.length > 0) {
      riskItems.push({
        id: 'sb-junit4',
        severity: 'medium',
        title: `JUnit 4 detectado — migrar para JUnit 5 (${junit4Imports.length} arquivo(s))`,
        description: 'Spring Boot 3 usa JUnit 5 por padrão. Imports e annotations mudam.',
        file: junit4Imports[0].file, line: junit4Imports[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.testing.junit5.JUnit4to5Migration',
      })
    }

    const effort = computeEffort(riskItems, manualItems)

    return {
      stackType: 'spring-boot',
      riskItems,
      manualReviewItems: manualItems,
      estimatedEffortDays: effort,
      prerequisiteChecks: [
        {
          name: 'Spring Boot versão detectada',
          passed: parentVersion !== null,
          message: parentVersion
            ? `Spring Boot ${parentVersion} detectado`
            : 'Versão do Spring Boot não detectada no pom.xml',
        },
      ],
    }
  },

  getRiskItems(report) { return report.riskItems },
  getManualReviewItems(report) { return report.manualReviewItems },

  getRecipes(phase, report): string[] {
    if (phase === 3) {
      const recipes: string[] = []
      const hasSecurityRisk = report.riskItems.some(r => r.id === 'sb-javax-security')
      if (hasSecurityRisk) {
        recipes.push('org.openrewrite.java.migrate.jakarta.JavaxSecurityMigrationToJakartaSecurity')
      }
      const hasDatasourceLegacy = report.riskItems.some(r => r.id === 'sb-datasource-legacy')
      if (hasDatasourceLegacy) {
        recipes.push('org.openrewrite.java.spring.boot2.SpringBootProperties_2_5')
      }
      return recipes
    }
    return []
  },
}

function computeEffort(risks: RiskItem[], manuals: ManualReviewItem[]): number {
  const riskDays = risks.reduce((sum, r) => {
    const map = { critical: 5, high: 2, medium: 0.5, low: 0.1 }
    return sum + (map[r.severity] ?? 0)
  }, 0)
  const manualDays = manuals.length * 1.5
  return Math.ceil(riskDays + manualDays)
}
