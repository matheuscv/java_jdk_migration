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
        recipe: 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_2',
      })
    }

    // ── [SB3-01] Springfox — bloqueador crítico no Spring Boot 3 ─────────
    const hasSpringfox = hasPomDependency(pom, 'springfox-swagger2') ||
      hasPomDependency(pom, 'springfox-swagger-ui') ||
      hasPomDependency(pom, 'springfox-boot-starter')
    if (hasSpringfox) {
      riskItems.push({
        id: 'sb3-springfox-blocker',
        severity: 'critical',
        title: 'Springfox incompatível com Spring Boot 3 — app não inicia',
        description:
          'Springfox está abandonado (último release 2020) e não funciona com Spring MVC 6. ' +
          'Causa NoSuchMethodError em startup. Substituto: springdoc-openapi-starter-webmvc-ui:2.x.',
        file: 'pom.xml', line: null,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'sb3-springfox-migration',
        category: 'semantic',
        title: 'Migrar Springfox → springdoc-openapi',
        description:
          'Springfox não é compatível com Spring Boot 3. Requer substituição completa da biblioteca ' +
          'e atualização das anotações de API em todos os controllers e DTOs.',
        suggestedApproach:
          '1. Remover springfox-swagger2 e springfox-swagger-ui dos pom.xml\n' +
          '2. Adicionar springdoc-openapi-starter-webmvc-ui:2.x\n' +
          '3. Remover @EnableSwagger2 e reescrever SwaggerConfig sem Docket\n' +
          '4. Substituir @ApiOperation → @Operation (io.swagger.v3.oas.annotations)\n' +
          '5. Substituir @ApiModelProperty → @Schema\n' +
          '6. Substituir @Api → @Tag\n' +
          '7. Swagger UI em /swagger-ui/index.html (não mais /swagger-ui.html)',
        files: ['pom.xml'],
        requiresHumanDecision: false,
        claudeCanResearch: false,
      })
    }

    // ── [SB3-02] APPLICATION_JSON_UTF8_VALUE removido no Spring 6 ────────
    const utf8ValueUsages = scanFiles(javaFiles, projectPath, /APPLICATION_JSON_UTF8_VALUE/)
    if (utf8ValueUsages.length > 0) {
      riskItems.push({
        id: 'sb3-utf8-mediatype-removed',
        severity: 'critical',
        title: `MediaType.APPLICATION_JSON_UTF8_VALUE removido no Spring 6 (${utf8ValueUsages.length} ocorrência(s))`,
        description:
          'MediaType.APPLICATION_JSON_UTF8_VALUE foi deprecated no Spring 5.2 e removido no Spring 6. ' +
          'Causa falha de compilação. Substituir por APPLICATION_JSON_VALUE.',
        file: utf8ValueUsages[0].file, line: utf8ValueUsages[0].line,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── [SB3-03] OpenFeign versão < 11 com Request.Options incompatível ──
    const feignVersionMatch = pom.match(/<feign\.version>([^<]+)<\/feign\.version>/)
    const feignVersion = feignVersionMatch?.[1] ?? null
    const feignMajor = feignVersion ? parseInt(feignVersion.split('.')[0], 10) : null
    const hasFeign = hasPomDependency(pom, 'feign-core')
    if (hasFeign && feignMajor !== null && feignMajor < 11) {
      const feignOptionsUsages = scanFiles(javaFiles, projectPath, /new\s+Request\.Options\s*\(\s*\w+\s*,\s*\w+\s*\)/)
      riskItems.push({
        id: 'sb3-feign-options-api-break',
        severity: 'medium',
        title: `OpenFeign ${feignVersion} → construtor Request.Options mudou na versão 11+`,
        description:
          'O construtor Request.Options(int connectTimeout, int readTimeout) foi removido no OpenFeign 11. ' +
          `${feignOptionsUsages.length > 0 ? `Detectado em ${feignOptionsUsages.length} local(is). ` : ''}` +
          'Agora exige TimeUnit como parâmetro. Causa falha de compilação após upgrade.',
        file: feignOptionsUsages[0]?.file ?? 'pom.xml', line: feignOptionsUsages[0]?.line ?? null,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── [SB3-04] Apache HttpClient 4.x com versão explícita ──────────────
    const hasExplicitHttpClient = pom.match(/<httpClient\.version>4\.[^<]+<\/httpClient\.version>/) !== null ||
      pom.match(/<artifactId>httpclient<\/artifactId>[\s\S]{0,100}<version>4\.[^<]+<\/version>/) !== null
    if (hasExplicitHttpClient) {
      riskItems.push({
        id: 'sb3-httpclient4-explicit',
        severity: 'medium',
        title: 'Apache HttpClient 4.x com versão explícita — conflito com BOM Spring Boot 3',
        description:
          'Spring Framework 6 (Spring Boot 3) usa Apache HttpClient 5. ' +
          'Versões explícitas 4.x declaradas no pom.xml podem conflitar com o BOM. ' +
          'No HttpClient 5 o prefixo de pacote muda de org.apache.http.* para org.apache.hc.*.',
        file: 'pom.xml', line: null,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── [SB3-05] Jersey 2.x (javax.ws.rs) ───────────────────────────────
    const hasJersey2 = pom.match(/<artifactId>jersey-client<\/artifactId>[\s\S]{0,200}<version>2\.[^<]+<\/version>/) !== null ||
      hasPomDependency(pom, 'jersey-hk2')
    if (hasJersey2) {
      riskItems.push({
        id: 'sb3-jersey2-namespace',
        severity: 'high',
        title: 'Jersey 2.x usa javax.ws.rs — incompatível com namespace Jakarta EE 9',
        description:
          'Jersey 2.x usa javax.ws.rs.* (JAX-RS 2.x). Jersey 3.x migrou para jakarta.ws.rs.*. ' +
          'Em projeto Spring Boot 3, a presença de Jersey 2.x causa conflito de namespace.',
        file: 'pom.xml', line: null,
        automationAvailable: false,
        recipe: null,
      })
      manualItems.push({
        id: 'sb3-jersey2-decision',
        category: 'semantic',
        title: 'Decidir: upgrade Jersey 2→3 ou substituir por JDK HttpClient',
        description:
          'Jersey 2.x é incompatível com o namespace jakarta.* exigido pelo Spring Boot 3. ' +
          'Duas estratégias disponíveis.',
        suggestedApproach:
          'Opção A: upgrade jersey-client + jersey-hk2 para 3.x e atualizar imports javax.ws.rs → jakarta.ws.rs\n' +
          'Opção B (recomendada): substituir por java.net.http.HttpClient nativo (JDK 11+), ' +
          'eliminando a dependência Jersey inteiramente. Reduz o classpath e remove risco futuro.',
        files: ['pom.xml'],
        requiresHumanDecision: true,
        claudeCanResearch: false,
        decisionOptions: [
          'Upgrade Jersey 2 → 3 (mantém a classe, atualiza imports e dependências)',
          'Substituir por java.net.http.HttpClient nativo JDK 11+ (remove dependência externa)',
        ],
      })
    }

    // ── [SB3-06] JAXB runtime 2.x incompatível com Spring Boot 3 ─────────
    const hasJaxbRuntime2 = pom.match(/jaxb-runtime[\s\S]{0,200}<version>2\.[^<]+<\/version>/) !== null
    if (hasJaxbRuntime2) {
      riskItems.push({
        id: 'sb3-jaxb-runtime-version',
        severity: 'high',
        title: 'jaxb-runtime 2.x usa javax.xml.bind — incompatível com Spring Boot 3',
        description:
          'Spring Boot 3 gerencia jakarta.xml.bind-api (Jakarta EE 9). ' +
          'O runtime jaxb-runtime:2.x usa o namespace javax.xml.bind e é incompatível. ' +
          'Precisa ser atualizado para 4.x.',
        file: 'pom.xml', line: null,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── [SB3-07] logback-contrib desatualizado ────────────────────────────
    const hasLogbackContrib = hasPomDependency(pom, 'logback-jackson') ||
      hasPomDependency(pom, 'logback-json-classic')
    if (hasLogbackContrib) {
      riskItems.push({
        id: 'sb3-logback-contrib-outdated',
        severity: 'low',
        title: 'logback-contrib desatualizado — consolidar no logstash-logback-encoder',
        description:
          'logback-jackson e logback-json-classic do logback-contrib não têm manutenção desde 2017. ' +
          'logstash-logback-encoder 7.x cobre o mesmo caso de uso com qualidade superior.',
        file: 'pom.xml', line: null,
        automationAvailable: false,
        recipe: null,
      })
    }

    // ── [SB3-08] Propriedades Actuator renomeadas no Spring Boot 3 ────────
    const legacyActuatorProps = scanFiles(
      propFiles, projectPath,
      /management\.metrics\.export\.prometheus/,
    )
    if (legacyActuatorProps.length > 0) {
      riskItems.push({
        id: 'sb3-actuator-props-renamed',
        severity: 'low',
        title: 'Propriedades Prometheus do Actuator renomeadas no Spring Boot 3',
        description:
          'management.metrics.export.prometheus.* foi movido para ' +
          'management.prometheus.metrics.export.* no Spring Boot 3 / Micrometer 1.10+.',
        file: legacyActuatorProps[0].file, line: legacyActuatorProps[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.spring.boot3.ActuatorEndpointSanitization',
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
        requiresHumanDecision: false,
        claudeCanResearch: false,
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
        requiresHumanDecision: false,
        claudeCanResearch: false,
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
        requiresHumanDecision: false,
        claudeCanResearch: false,
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
        title: `JUnit 4 detectado (${junit4Imports.length} arquivo(s)) — Spring Boot 3 não inclui vintage engine`,
        description:
          'Spring Boot 3 não inclui junit-vintage-engine por padrão. ' +
          'Testes JUnit 4 são silenciosamente ignorados sem ele, podendo mascarar falhas.',
        file: junit4Imports[0].file, line: junit4Imports[0].line,
        automationAvailable: true,
        recipe: 'org.openrewrite.java.testing.junit5.JUnit4to5Migration',
      })
      manualItems.push({
        id: 'sb3-junit4-strategy',
        category: 'semantic',
        title: 'Decidir estratégia para testes JUnit 4',
        description:
          `${junit4Imports.length} arquivo(s) de teste usam JUnit 4 (@RunWith, org.junit.*). ` +
          'Spring Boot 3 não inclui junit-vintage-engine por padrão.',
        suggestedApproach:
          'Opção A (paliativo): adicionar junit-vintage-engine como dep de test em todos os módulos com testes. Zero mudança de código.\n' +
          'Opção B (correto): migrar para JUnit 5 com @ExtendWith(MockitoExtension.class) e org.junit.jupiter.api.*',
        files: [...new Set(junit4Imports.map(h => h.file))],
        requiresHumanDecision: true,
        claudeCanResearch: false,
        decisionOptions: [
          'Adicionar junit-vintage-engine (zero mudança de código, paliativo rápido)',
          'Migrar testes para JUnit 5 (correto, mais trabalho)',
        ],
      })
    }

    // ── [SB3-09] @ComponentScan amplo — libs externas perdem varredura no Spring Boot 3 ──
    if (majorVersion !== null && majorVersion < 3) {
      const compScanHits = scanFiles(javaFiles, projectPath, /@ComponentScan/)
      const basePackagesLines = scanFiles(javaFiles, projectPath, /basePackages\s*=/)
      const sbAppHits = scanFiles(javaFiles, projectPath, /@SpringBootApplication/)
      const scanBasePkgsLines = scanFiles(javaFiles, projectPath, /scanBasePackages\s*=/)

      const broadScanFiles = compScanHits.filter(h =>
        basePackagesLines.some(bp => bp.file === h.file),
      )
      const sbAppBroadFiles = sbAppHits.filter(h =>
        scanBasePkgsLines.some(sp => sp.file === h.file) &&
        !broadScanFiles.some(s => s.file === h.file),
      )
      const allBroadUsages = [...broadScanFiles, ...sbAppBroadFiles]

      if (allBroadUsages.length > 0) {
        riskItems.push({
          id: 'sb3-componentscan-broad',
          severity: 'high',
          title: `@ComponentScan com basePackages explícito detectado (${allBroadUsages.length} arquivo(s)) — risco de regressão no Spring Boot 3`,
          description:
            'Em Spring Boot 3 / Spring Framework 6, é necessário restringir @ComponentScan aos pacotes do ' +
            'próprio projeto para evitar carregar classes de bibliotecas que usam APIs javax.* removidas ' +
            '(WebMvcConfigurerAdapter, javax.servlet.Filter, etc.). ' +
            'Essa restrição tem efeito colateral: @ControllerAdvice, @Component e filtros de bibliotecas ' +
            'deixam de ser registrados automaticamente, fazendo com que exceções de negócio ' +
            '(ex: NotFoundException, BusinessException) retornem 500 em vez do código HTTP correto.',
          file: allBroadUsages[0].file,
          line: allBroadUsages[0].line,
          automationAvailable: false,
          recipe: null,
        })
        manualItems.push({
          id: 'sb3-componentscan-restrict-handlers',
          category: 'behavioral',
          title: 'Cobrir @ExceptionHandler de libs externas após restringir @ComponentScan',
          description:
            'Ao restringir @ComponentScan para compatibilidade com Spring Boot 3, os @ControllerAdvice ' +
            'de bibliotecas externas (ex: star-exception-handler, ou qualquer lib com @ControllerAdvice) ' +
            'deixam de ser varridos. Exceções que antes retornavam 400/404 passam a retornar 500 genérico.',
          suggestedApproach:
            '1. Restringir @ComponentScan ao(s) pacote(s) do próprio projeto:\n' +
            '   @ComponentScan(basePackages = {"com.empresa.projeto"})\n\n' +
            '2. Identificar os @ControllerAdvice das libs que eram varridos:\n' +
            '   jar tf dependencia.jar | grep -i "controlleradvice\\|exceptionhandler"\n\n' +
            '3. Para cada exceção de lib sem handler, adicionar @ExceptionHandler no ' +
            '@ControllerAdvice do próprio projeto (ex: CustomGlobalExceptionHandler):\n' +
            '   - NotFoundException  →  HTTP 404\n' +
            '   - BusinessException  →  HTTP derivado de errorCode.getCode()\n\n' +
            '4. Verificar também filtros (javax.servlet.Filter → jakarta.servlet.Filter) ' +
            'e outros @Component de libs que eram varridos automaticamente.',
          files: [...new Set(allBroadUsages.map(h => h.file))],
          requiresHumanDecision: false,
          claudeCanResearch: false,
        })
      }
    }

    // ── Oracle JDBC: ojdbc8 → ojdbc11 ────────────────────────────────────
    const hasOjdbc8 = hasPomDependency(pom, 'ojdbc8')
    if (hasOjdbc8) {
      riskItems.push({
        id: 'oracle-ojdbc8-jdk21',
        severity: 'high',
        title: 'ojdbc8 detectado — substituir por ojdbc11 para JDK 21',
        description:
          'ojdbc8 e otimizado para JDK 8 e pode apresentar problemas com o module system do JDK 11+. ' +
          'Para JDK 21, use ojdbc11 (mesmo groupId com.oracle.database.jdbc, mesma versao). ' +
          'A API JDBC e identica — nenhuma mudanca de codigo necessaria.',
        file: 'pom.xml',
        line: null,
        automationAvailable: true,
        recipe: 'update-ojdbc8-to-ojdbc11',
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
      if (report.riskItems.some(r => r.id === 'sb-javax-security')) {
        recipes.push('org.openrewrite.java.migrate.jakarta.JavaxSecurityMigrationToJakartaSecurity')
      }
      if (report.riskItems.some(r => r.id === 'sb-datasource-legacy')) {
        recipes.push('org.openrewrite.java.spring.boot2.SpringBootProperties_2_5')
      }
      if (report.riskItems.some(r => r.id === 'sb3-actuator-props-renamed')) {
        recipes.push('org.openrewrite.java.spring.boot3.ActuatorEndpointSanitization')
      }
      if (report.riskItems.some(r => r.id === 'sb-junit4')) {
        recipes.push('org.openrewrite.java.testing.junit5.JUnit4to5Migration')
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
