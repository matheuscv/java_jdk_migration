import type { StackProfiler, ProfilerReport, RiskItem } from '../types.js'
import type { JdkMigrationConfig } from '../../lib/config.js'
import type { PhaseNumber } from '../../types.js'
import { findJavaFiles, findXmlFiles, scanFiles } from '../scanner.js'

interface JakartaMapping {
  javaxPackage: string
  jakartaPackage: string
  severity: RiskItem['severity']
  recipe: string | null
  automatable: boolean
}

const JAKARTA_MAPPINGS: JakartaMapping[] = [
  {
    javaxPackage: 'javax.persistence',
    jakartaPackage: 'jakarta.persistence',
    severity: 'critical',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxPersistenceMigrationToJakartaPersistence',
    automatable: true,
  },
  {
    javaxPackage: 'javax.servlet',
    jakartaPackage: 'jakarta.servlet',
    severity: 'high',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxServletMigrationToJakartaServlet',
    automatable: true,
  },
  {
    javaxPackage: 'javax.validation',
    jakartaPackage: 'jakarta.validation',
    severity: 'high',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxValidationMigrationToJakartaValidation',
    automatable: true,
  },
  {
    javaxPackage: 'javax.transaction',
    jakartaPackage: 'jakarta.transaction',
    severity: 'high',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxTransactionMigrationToJakartaTransaction',
    automatable: true,
  },
  {
    javaxPackage: 'javax.faces',
    jakartaPackage: 'jakarta.faces',
    severity: 'critical',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxFacesMigrationToJakartaFaces',
    automatable: false,  // Faces 4 tem mudanças breaking que precisam de revisão UI
  },
  {
    javaxPackage: 'javax.ejb',
    jakartaPackage: 'jakarta.ejb',
    severity: 'critical',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxEjbMigrationToJakartaEjb',
    automatable: false,  // EJB tem semântica complexa — apenas namespace é automático
  },
  {
    javaxPackage: 'javax.xml.bind',
    jakartaPackage: 'jakarta.xml.bind',
    severity: 'high',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxXmlBindMigrationToJakartaXmlBind',
    automatable: true,
  },
  {
    javaxPackage: 'javax.ws.rs',
    jakartaPackage: 'jakarta.ws.rs',
    severity: 'high',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxWsRsMigrationToJakartaWsRs',
    automatable: true,
  },
  {
    javaxPackage: 'javax.annotation',
    jakartaPackage: 'jakarta.annotation',
    severity: 'medium',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxAnnotationMigrationToJakartaAnnotation',
    automatable: true,
  },
  {
    javaxPackage: 'javax.security',
    jakartaPackage: 'jakarta.security',
    severity: 'high',
    recipe: 'org.openrewrite.java.migrate.jakarta.JavaxSecurityMigrationToJakartaSecurity',
    automatable: true,
  },
]

export const jakartaProfiler: StackProfiler = {
  stackType: 'rest',  // Usado transversalmente — qualquer stack que use javax.*

  async analyze(projectPath, _config): Promise<ProfilerReport> {
    const javaFiles = findJavaFiles(projectPath)
    const xmlFiles = findXmlFiles(projectPath)
    const riskItems: RiskItem[] = []

    for (const mapping of JAKARTA_MAPPINGS) {
      const pattern = new RegExp(`import ${mapping.javaxPackage.replace('.', '\\.')}`)
      const javaHits = scanFiles(javaFiles, projectPath, pattern)
      const xmlHits = scanFiles(xmlFiles, projectPath, pattern)
      const allHits = [...javaHits, ...xmlHits]

      if (allHits.length > 0) {
        const uniqueFiles = [...new Set(allHits.map(h => h.file))]
        riskItems.push({
          id: `jakarta-${mapping.javaxPackage.replace(/\./g, '-')}`,
          severity: mapping.severity,
          title: `${mapping.javaxPackage}.* → ${mapping.jakartaPackage}.*`,
          description:
            `${allHits.length} ocorrência(s) em ${uniqueFiles.length} arquivo(s). ` +
            (mapping.automatable
              ? 'Recipe OpenRewrite disponível.'
              : 'Requer revisão manual — mudanças de comportamento possíveis.'),
          file: allHits[0].file,
          line: allHits[0].line,
          automationAvailable: mapping.automatable,
          recipe: mapping.recipe,
        })
      }
    }

    const estimatedEffortDays = Math.ceil(
      riskItems.reduce((sum, r) => {
        return sum + ({ critical: 2, high: 1, medium: 0.25, low: 0.1 }[r.severity] ?? 0)
      }, 0),
    )

    return {
      stackType: 'rest',
      riskItems,
      manualReviewItems: [],
      estimatedEffortDays,
      prerequisiteChecks: [
        {
          name: 'javax.* detectado',
          passed: riskItems.length > 0,
          message: riskItems.length > 0
            ? `${riskItems.length} pacote(s) javax detectado(s) — migração Jakarta necessária`
            : 'Nenhum import javax.* detectado',
        },
      ],
    }
  },

  getRiskItems(report) { return report.riskItems },
  getManualReviewItems(report) { return report.manualReviewItems },

  getRecipes(phase, report): string[] {
    if (phase !== 3) return []
    return report.riskItems
      .filter(r => r.automationAvailable && r.recipe !== null)
      .map(r => r.recipe!)
      .filter((r, i, arr) => arr.indexOf(r) === i)  // deduplica
  },
}
