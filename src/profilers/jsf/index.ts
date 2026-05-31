import type { StackProfiler, ProfilerReport, RiskItem, ManualReviewItem } from '../types.js'
import {
  findJavaFiles, findXmlFiles, findXhtmlFiles, scanFiles,
  readPom, extractPomVersion,
} from '../scanner.js'

export const jsfProfiler: StackProfiler = {
  stackType: 'jsf',

  async analyze(projectPath, _config): Promise<ProfilerReport> {
    const javaFiles = findJavaFiles(projectPath)
    const xmlFiles = findXmlFiles(projectPath)
    const xhtmlFiles = findXhtmlFiles(projectPath)
    const pom = readPom(projectPath)
    const riskItems: RiskItem[] = []
    const manualItems: ManualReviewItem[] = []

    // ── javax.faces.* namespace — automação via recipe ────────────────────
    const javaxFacesHits = scanFiles(javaFiles, projectPath, /import javax\.faces\./)
    if (javaxFacesHits.length > 0) {
      riskItems.push({
        id: 'jsf-javax-namespace',
        severity: 'high',
        title: `javax.faces.* → jakarta.faces.* (${[...new Set(javaxFacesHits.map(h => h.file))].length} arquivo(s))`,
        description:
          'Imports javax.faces precisam migrar para jakarta.faces. ' +
          'O recipe OpenRewrite cobre a maioria dos casos; verificar residuais manualmente.',
        file: javaxFacesHits[0].file, line: javaxFacesHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxFacesMigrationToJakartaFaces',
      })
    }

    // ── @ManagedBean — removido no Jakarta Faces 4 ───────────────────────
    const managedBeanHits = scanFiles(javaFiles, projectPath, /@ManagedBean/)
    if (managedBeanHits.length > 0) {
      const files = [...new Set(managedBeanHits.map(h => h.file))]
      riskItems.push({
        id: 'jsf-managed-bean',
        severity: 'high',
        title: `@ManagedBean → CDI @Named (${files.length} arquivo(s))`,
        description:
          '@ManagedBean foi removido no Jakarta Faces 4. ' +
          'Não tem substituto automático seguro — o escopo e ciclo de vida podem diferir.',
        file: managedBeanHits[0].file, line: managedBeanHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'jsf-managed-bean-cdi',
        category: 'semantic',
        title: 'Migrar @ManagedBean para CDI @Named',
        description:
          '@ManagedBean foi removido. CDI é o mecanismo oficial de beans no Faces 4. ' +
          'A migração pode alterar escopos e ciclo de vida.',
        suggestedApproach:
          '1. Substituir @ManagedBean por @Named (jakarta.inject).\n' +
          '2. Verificar o escopo: usar @RequestScoped/@SessionScoped/@ApplicationScoped do CDI (jakarta.enterprise.context).\n' +
          '3. Remover imports de javax.faces.bean.*.\n' +
          '4. Verificar EL expressions que referenciam os beans pelo nome.',
        files,
      })
    }

    // ── @ManagedProperty — injeção legada de JSF ──────────────────────────
    const managedPropHits = scanFiles(javaFiles, projectPath, /@ManagedProperty/)
    if (managedPropHits.length > 0) {
      riskItems.push({
        id: 'jsf-managed-property',
        severity: 'high',
        title: '@ManagedProperty removido — substituir por @Inject CDI',
        description:
          '@ManagedProperty era específico do JSF managed beans e foi removido. ' +
          'Com CDI, a injeção é feita via @Inject.',
        file: managedPropHits[0].file, line: managedPropHits[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── @ViewScoped — namespace muda ──────────────────────────────────────
    const viewScopedHits = scanFiles(
      javaFiles, projectPath,
      /javax\.faces\.view\.ViewScoped|javax\.faces\.bean\.ViewScoped/,
    )
    if (viewScopedHits.length > 0) {
      riskItems.push({
        id: 'jsf-view-scoped',
        severity: 'medium',
        title: 'javax.faces.view.ViewScoped → jakarta.faces.view.ViewScoped',
        description: 'O namespace de @ViewScoped muda; o comportamento pode diferir no Faces 4.',
        file: viewScopedHits[0].file, line: viewScopedHits[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxFacesMigrationToJakartaFaces',
      })
    }

    // ── faces-config.xml ──────────────────────────────────────────────────
    const hasFacesConfig = xmlFiles.some(f => f.endsWith('faces-config.xml'))
    const facesConfigHits = scanFiles(xmlFiles, projectPath, /xmlns\.jcp\.org\/xml\/ns\/javaee/)
    if (hasFacesConfig || facesConfigHits.length > 0) {
      riskItems.push({
        id: 'jsf-faces-config',
        severity: 'medium',
        title: 'faces-config.xml — migrar namespace para Jakarta',
        description: 'O namespace xmlns do faces-config.xml deve ser atualizado de javaee para jakarta.',
        file: facesConfigHits[0]?.file ?? 'WEB-INF/faces-config.xml', line: null,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.migrate.jakarta.JavaxFacesMigrationToJakartaFaces',
      })
    }

    // ── web.xml FacesServlet — verificação manual ─────────────────────────
    const webXmlHits = scanFiles(xmlFiles, projectPath, /FacesServlet/)
    if (webXmlHits.length > 0) {
      manualItems.push({
        id: 'jsf-faces-servlet',
        category: 'behavioral',
        title: 'FacesServlet no web.xml — verificar mapeamento e inicialização',
        description:
          'O mapeamento do FacesServlet pode precisar de ajuste para Jakarta Faces 4. ' +
          'Verificar load-on-startup e url-patterns.',
        suggestedApproach:
          'Verificar se o mapping *.xhtml ou /faces/* ainda é correto para o servidor alvo. ' +
          'Confirmar que o namespace do web.xml foi atualizado para jakarta.servlet.',
        files: [...new Set(webXmlHits.map(h => h.file))],
      })
    }

    // ── PrimeFaces — versão mínima 13 para Faces 4 ───────────────────────
    const pfVersion = extractPomVersion(pom, 'primefaces')
    if (pfVersion) {
      const pfMajor = parseInt(pfVersion.split('.')[0], 10)
      if (pfMajor < 13) {
        riskItems.push({
          id: 'jsf-primefaces-version',
          severity: 'high',
          title: `PrimeFaces ${pfVersion} → 13.x necessário para Jakarta Faces 4`,
          description:
            'PrimeFaces 13+ é a versão compatível com Jakarta Faces 4 e JDK 21. ' +
            'Versões anteriores usam javax.faces e não funcionam com o runtime moderno.',
          file: 'pom.xml', line: null,
          automationAvailable: false,
          recipe: null,
        })
        manualItems.push({
          id: 'jsf-primefaces-upgrade',
          category: 'ui',
          title: `Upgrade PrimeFaces ${pfVersion} → 13.x`,
          description: 'Componentes visuais podem ter breaking changes na v13+.',
          suggestedApproach:
            '1. Atualizar a dependência PrimeFaces para 13.x no pom.xml.\n' +
            '2. Revisar changelogs de breaking changes entre sua versão e 13.x.\n' +
            '3. Testar cada componente visual — especialmente DataTable, Dialog e FileUpload.\n' +
            '4. Verificar customizações de tema (Nova, Saga, etc).',
          files: ['pom.xml'],
        })
      }
    }

    // ── XHTML — revisão visual obrigatória ───────────────────────────────
    if (xhtmlFiles.length > 0) {
      manualItems.push({
        id: 'jsf-xhtml-review',
        category: 'ui',
        title: `Templates XHTML — revisão visual (${xhtmlFiles.length} arquivo(s))`,
        description:
          'Componentes XHTML podem ter comportamento visual alterado no Faces 4 / PrimeFaces 13.',
        suggestedApproach:
          'Executar smoke tests visuais após a migração. ' +
          'Atenção a: p:dataTable, p:dialog, p:fileUpload, f:ajax, composite components.',
        files: xhtmlFiles,
      })
    }

    return {
      stackType: 'jsf',
      riskItems,
      manualReviewItems: manualItems,
      estimatedEffortDays: estimateEffort(riskItems, manualItems),
      prerequisiteChecks: [
        {
          name: 'PrimeFaces detectado',
          passed: !!pfVersion,
          message: pfVersion
            ? `PrimeFaces ${pfVersion} detectado`
            : 'PrimeFaces não detectado no pom.xml — pode ser JSF vanilla',
        },
        {
          name: 'faces-config.xml detectado',
          passed: hasFacesConfig,
          message: hasFacesConfig
            ? 'faces-config.xml presente — migração de namespace necessária'
            : 'faces-config.xml não encontrado',
        },
      ],
    }
  },

  getRiskItems: r => r.riskItems,
  getManualReviewItems: r => r.manualReviewItems,

  getRecipes(phase, report): string[] {
    if (phase !== 3) return []
    const hasNamespaceIssue = report.riskItems.some(
      r => r.automationAvailable && r.recipe?.includes('Faces'),
    )
    return hasNamespaceIssue
      ? ['org.openrewrite.java.migrate.jakarta.JavaxFacesMigrationToJakartaFaces']
      : []
  },
}

function estimateEffort(risks: RiskItem[], manuals: ManualReviewItem[]): number {
  const r = risks.reduce((s, ri) => s + ({ critical: 7, high: 3, medium: 1, low: 0.2 }[ri.severity] ?? 0), 0)
  return Math.ceil(r + manuals.length * 2)
}
