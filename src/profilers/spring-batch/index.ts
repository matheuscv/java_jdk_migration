import type { StackProfiler, ProfilerReport, RiskItem, ManualReviewItem } from '../types.js'
import type { JdkMigrationConfig } from '../../lib/config.js'
import type { PhaseNumber } from '../../types.js'
import { findJavaFiles, scanFiles, readPom, extractPomVersion } from '../scanner.js'

export const springBatchProfiler: StackProfiler = {
  stackType: 'spring-batch',

  async analyze(projectPath, _config): Promise<ProfilerReport> {
    const pom = readPom(projectPath)
    const javaFiles = findJavaFiles(projectPath)
    const riskItems: RiskItem[] = []
    const manualItems: ManualReviewItem[] = []

    // Versão pode estar inline no <dependency> ou em <properties> como spring-batch.version
    const batchVersion =
      extractPomVersion(pom, 'spring-batch-core') ??
      pom.match(/<spring[-.]batch\.version>([^<]+)<\/spring[-.]batch\.version>/)?.[1] ??
      null
    const isBatch4 = batchVersion ? parseInt(batchVersion.split('.')[0], 10) < 5 : null

    // ── JobBuilderFactory (removido no Spring Batch 5) ────────────────────
    const jobBuilderHits = scanFiles(javaFiles, projectPath, /JobBuilderFactory/)
    if (jobBuilderHits.length > 0) {
      riskItems.push({
        id: 'batch-job-builder-factory',
        severity: 'critical',
        title: 'JobBuilderFactory removido no Spring Batch 5',
        description:
          'JobBuilderFactory foi removido no Batch 5. ' +
          'Usar JobRepository + @Bean direto no lugar do builder factory.',
        file: jobBuilderHits[0].file, line: jobBuilderHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.spring.batch.SpringBatch4To5Migration',
      })
      manualItems.push({
        id: 'batch-job-builder-manual',
        category: 'behavioral',
        title: 'Refatorar Jobs criados via JobBuilderFactory',
        description:
          'No Spring Batch 5, os jobs são configurados injetando diretamente ' +
          'JobRepository e PlatformTransactionManager nos @Bean de configuração de Step/Job.',
        suggestedApproach:
          'Substituir @Autowired JobBuilderFactory por @Autowired JobRepository. ' +
          'Usar new JobBuilder("jobName", jobRepository).start(...).build().',
        files: [...new Set(jobBuilderHits.map(h => h.file))],
      })
    }

    // ── StepBuilderFactory (removido no Spring Batch 5) ──────────────────
    const stepBuilderHits = scanFiles(javaFiles, projectPath, /StepBuilderFactory/)
    if (stepBuilderHits.length > 0) {
      riskItems.push({
        id: 'batch-step-builder-factory',
        severity: 'critical',
        title: 'StepBuilderFactory removido no Spring Batch 5',
        description: 'StepBuilderFactory foi removido. Usar new StepBuilder(name, jobRepository).',
        file: stepBuilderHits[0].file, line: stepBuilderHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.spring.batch.SpringBatch4To5Migration',
      })
    }

    // ── MapJobRepositoryFactoryBean (removido no Batch 5) ─────────────────
    const mapRepoHits = scanFiles(javaFiles, projectPath, /MapJobRepositoryFactoryBean/)
    if (mapRepoHits.length > 0) {
      riskItems.push({
        id: 'batch-map-job-repo',
        severity: 'critical',
        title: 'MapJobRepositoryFactoryBean removido no Spring Batch 5',
        description:
          'MapJobRepositoryFactoryBean (repositório in-memory) foi removido. ' +
          'Usar configuração de banco de dados real ou JobRepositoryFactoryBean.',
        file: mapRepoHits[0].file, line: mapRepoHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'batch-map-job-repo-manual',
        category: 'behavioral',
        title: 'Substituir MapJobRepositoryFactoryBean por repositório com datasource',
        description:
          'MapJobRepositoryFactoryBean não existe mais no Batch 5. ' +
          'Testes e configurações que dependiam de in-memory batch repository precisam ser refatorados.',
        suggestedApproach:
          'Usar H2 em memória como datasource em testes, ' +
          'ou remover o repositório customizado e usar o autoconfiguration do Spring Boot.',
        files: [...new Set(mapRepoHits.map(h => h.file))],
      })
    }

    // ── @EnableBatchProcessing ────────────────────────────────────────────
    const enableBatchHits = scanFiles(javaFiles, projectPath, /@EnableBatchProcessing/)
    if (enableBatchHits.length > 0) {
      riskItems.push({
        id: 'batch-enable-annotation',
        severity: 'high',
        title: '@EnableBatchProcessing mudou semântica no Spring Batch 5',
        description:
          'No Spring Batch 5 com Spring Boot 3, @EnableBatchProcessing pode conflitar ' +
          'com o autoconfiguration. Remover a annotation se usando Spring Boot.',
        file: enableBatchHits[0].file, line: enableBatchHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.spring.batch.RemoveDefaultBatchConfigurer',
      })
    }

    // ── JobRepositoryFactoryBean (configuração manual) ────────────────────
    const jobRepoFactoryHits = scanFiles(javaFiles, projectPath, /JobRepositoryFactoryBean/)
    if (jobRepoFactoryHits.length > 0) {
      riskItems.push({
        id: 'batch-job-repo-factory',
        severity: 'high',
        title: 'JobRepositoryFactoryBean — configuração manual do repositório',
        description:
          'JobRepositoryFactoryBean ainda existe no Batch 5 mas sua configuração mudou.',
        file: jobRepoFactoryHits[0].file, line: jobRepoFactoryHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'batch-job-repo-factory-manual',
        category: 'behavioral',
        title: 'Revisar configuração manual de JobRepository',
        description: 'A API de JobRepositoryFactoryBean mudou no Spring Batch 5.',
        suggestedApproach:
          'Verificar se a configuração manual ainda é necessária. ' +
          'Considerar usar a autoconfiguration do Spring Boot que cria o repositório automaticamente.',
        files: [...new Set(jobRepoFactoryHits.map(h => h.file))],
      })
    }

    // ── DataSourceTransactionManager implícito ────────────────────────────
    const txManagerHits = scanFiles(javaFiles, projectPath, /DataSourceTransactionManager/)
    if (txManagerHits.length > 0) {
      riskItems.push({
        id: 'batch-tx-manager',
        severity: 'high',
        title: 'DataSourceTransactionManager — revisar configuração transacional',
        description:
          'No Spring Batch 5, o transaction manager é obrigatório explicitamente em StepBuilder. ' +
          'A injeção implícita não funciona mais.',
        file: txManagerHits[0].file, line: txManagerHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    const effort = computeEffort(riskItems, manualItems)

    return {
      stackType: 'spring-batch',
      riskItems,
      manualReviewItems: manualItems,
      estimatedEffortDays: effort,
      prerequisiteChecks: [
        {
          name: 'Spring Batch versão detectada',
          passed: batchVersion !== null,
          message: batchVersion
            ? `Spring Batch ${batchVersion} detectado`
            : 'Versão do Spring Batch não detectada no pom.xml',
        },
        {
          name: 'Spring Batch 4.x (precisa de migração)',
          passed: isBatch4 === true,
          message: isBatch4 === true
            ? 'Spring Batch 4.x detectado — migração para Batch 5 necessária'
            : isBatch4 === false
              ? 'Spring Batch 5+ detectado — verificar compatibilidade'
              : 'Versão não detectada',
        },
      ],
    }
  },

  getRiskItems(report) { return report.riskItems },
  getManualReviewItems(report) { return report.manualReviewItems },

  getRecipes(phase, report): string[] {
    if (phase !== 3) return []
    const hasFactoryIssues = report.riskItems.some(
      r => r.id === 'batch-job-builder-factory' || r.id === 'batch-step-builder-factory' || r.id === 'batch-enable-annotation',
    )
    return hasFactoryIssues ? ['org.openrewrite.java.spring.batch.SpringBatch4To5Migration'] : []
  },
}

function computeEffort(risks: RiskItem[], manuals: ManualReviewItem[]): number {
  const riskDays = risks.reduce((sum, r) => {
    return sum + ({ critical: 5, high: 2, medium: 0.5, low: 0.1 }[r.severity] ?? 0)
  }, 0)
  return Math.ceil(riskDays + manuals.length * 1.5)
}
