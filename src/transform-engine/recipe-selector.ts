import type { PhaseNumber } from '../types.js'
import type { JdkMigrationConfig } from '../lib/config.js'

export type RunnerType = 'openrewrite' | 'sbm' | 'eclipse-transformer' | 'build-updater' | 'infrastructure-transformer' | 'source-cleaner' | 'jakarta-deps'

export interface RecipeSet {
  runner: RunnerType
  recipes: string[]
  // JARs extras que o runner precisa baixar/incluir (ex: rewrite-weblogic)
  extraDependencies: string[]
}

// Versão pinada do plugin OpenRewrite para Maven — atualizar periodicamente
export const OPENREWRITE_PLUGIN_VERSION = '5.38.0'
export const OPENREWRITE_PLUGIN_COORDS =
  `org.openrewrite.maven:rewrite-maven-plugin:${OPENREWRITE_PLUGIN_VERSION}`

export function selectRecipes(phase: PhaseNumber, config: JdkMigrationConfig): RecipeSet[] {
  switch (phase) {
    case 0:
      // Fase 0: descoberta — nenhuma transformação de código
      return []

    case 1: {
      // Fase 1: atualizar build system + infraestrutura para JDK 21
      return [
        {
          runner: 'build-updater',
          recipes: ['update-compiler-target-21'],
          extraDependencies: [],
        },
        {
          // E1.1 Dockerfile/CI, E1.2 JVM flags, E1.3 K8s/Helm, E1.4 Maven profiles
          runner: 'infrastructure-transformer',
          recipes: ['infrastructure-transform'],
          extraDependencies: [],
        },
      ]
    }

    case 2: {
      // Fase 2: migração de linguagem Java (OpenRewrite) + limpeza de APIs removidas
      const recipes = config.sourceJdk === '6'
        ? [
            'org.openrewrite.java.migrate.Java8toJava11',
            'org.openrewrite.java.migrate.JavaVersion17to21',
            'org.openrewrite.java.migrate.UpgradeToJava21',
          ]
        : ['org.openrewrite.java.migrate.UpgradeToJava21']
      return [
        { runner: 'openrewrite', recipes, extraDependencies: [] },
        {
          // E2.2: remove chamadas no-op removidas (runFinalizersOnExit, java.lang.Compiler)
          // e sinaliza Thread.stop/destroy para intervenção humana no Gate 2
          runner: 'source-cleaner',
          recipes: ['source-clean'],
          extraDependencies: [],
        },
      ]
    }

    case 3: {
      // Fase 3: namespace Jakarta + frameworks
      const sets: RecipeSet[] = []

      // Jakarta namespace — se a stack usa APIs Java EE (javax.*)
      const jakartaStacks = ['spring-boot', 'ejb', 'jsf', 'rest']
      if (config.stack.some(s => jakartaStacks.includes(s))) {
        sets.push({
          runner: 'openrewrite',
          recipes: ['org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta'],
          extraDependencies: [],
        })
      }

      // Spring Boot 2→3 (via SBM; OpenRewrite cobre o resto)
      if (config.stack.includes('spring-boot')) {
        sets.push({
          runner: 'sbm',
          recipes: ['upgrade-spring-boot-3.0'],
          extraDependencies: [],
        })
      }

      // Spring Batch 4→5
      if (config.stack.includes('spring-batch')) {
        sets.push({
          runner: 'openrewrite',
          recipes: ['org.openrewrite.java.spring.batch.SpringBatch4To5Migration'],
          extraDependencies: [],
        })
      }

      // WebLogic — recipes Oracle oficiais; DEVE rodar DEPOIS de recipe JDK
      if (config.appServer === 'weblogic') {
        sets.push({
          runner: 'openrewrite',
          recipes: ['com.oracle.weblogic.rewrite.UpgradeWebLogic'],
          extraDependencies: ['com.oracle.weblogic.rewrite:rewrite-weblogic:LATEST'],
        })
      }

      // E2.3: injeta deps Jakarta para APIs removidas (JAX-WS, SAAJ, JWS, JAF)
      // Sempre incluído na Fase 3 — o runner faz a detecção internamente
      sets.push({
        runner: 'jakarta-deps',
        recipes: ['inject-jakarta-removed-apis-deps'],
        extraDependencies: [],
      })

      return sets
    }

    case 4:
    case 5:
      // Fases 4 e 5: revisão semântica e validação final — nenhuma transformação automática
      return []

    default:
      return []
  }
}
