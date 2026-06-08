/**
 * Testes adicionais para spring-batch profiler — cobre branches não alcançados
 * pelo spring-batch-profiler.test.ts principal:
 *   - MapJobRepositoryFactoryBean (risk + manual)
 *   - JobRepositoryFactoryBean (risk + manual)
 *   - DataSourceTransactionManager (risk)
 *   - isBatch4 === false  (Spring Batch 5+ detectado)
 *   - isBatch4 === null   (versão não detectada)
 *   - getRecipes retorna [] quando não há factory issues (hasFactoryIssues=false) — já coberto
 *     mas aqui sem batch-enable-annotation também
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { springBatchProfiler } from '../../src/profilers/spring-batch/index.js'
import { createDefaultPhases } from '../../src/lib/config.js'
import type { JdkMigrationConfig } from '../../src/lib/config.js'

function tempDir(): string {
  const d = join(tmpdir(), `sb-batch-extra-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function writeJava(dir: string, name: string, content: string) {
  const pkg = join(dir, 'src', 'main', 'java', 'com', 'example')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, name), content, 'utf-8')
}

function writePom(dir: string, batchVersion: string | null) {
  const batchDep = batchVersion
    ? `  <dependency>
    <groupId>org.springframework.batch</groupId>
    <artifactId>spring-batch-core</artifactId>
    <version>${batchVersion}</version>
  </dependency>`
    : ''
  writeFileSync(join(dir, 'pom.xml'), `<project>
  <dependencies>
${batchDep}
  </dependencies>
</project>`, 'utf-8')
}

function makeConfig(): JdkMigrationConfig {
  return {
    sourceJdk: '8', targetJdk: '21', stack: ['spring-batch'],
    buildSystem: 'maven', appServer: null, multiModule: false,
    modulePaths: [], ciSystem: null, testCoverageThreshold: 80,
    dryRunBeforeExecute: true, phases: createDefaultPhases(),
  }
}

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── MapJobRepositoryFactoryBean ─────────────────────────────────────────────

describe('springBatchProfiler — MapJobRepositoryFactoryBean detectado', () => {
  it('emite risk batch-map-job-repo com severity critical', async () => {
    writePom(dir, '4.3.8')
    writeJava(dir, 'TestRepoConfig.java', `
package com.example;
import org.springframework.batch.core.repository.support.MapJobRepositoryFactoryBean;
public class TestRepoConfig {
    MapJobRepositoryFactoryBean factory = new MapJobRepositoryFactoryBean();
}`)
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-map-job-repo')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('critical')
    expect(risk?.automationAvailable).toBe(false)
    expect(risk?.recipe).toBeNull()
  })

  it('emite ManualReviewItem batch-map-job-repo-manual', async () => {
    writePom(dir, '4.3.8')
    writeJava(dir, 'TestRepoConfig.java', `
package com.example;
public class TestRepoConfig {
    // MapJobRepositoryFactoryBean usage here
}`)
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'batch-map-job-repo-manual')
    expect(manual).toBeDefined()
    expect(manual?.category).toBe('behavioral')
    expect(manual?.suggestedApproach).toContain('H2')
  })
})

// ─── JobRepositoryFactoryBean ─────────────────────────────────────────────────

describe('springBatchProfiler — JobRepositoryFactoryBean detectado', () => {
  it('emite risk batch-job-repo-factory com severity high', async () => {
    writePom(dir, '4.3.8')
    writeJava(dir, 'RepoConfig.java', `
package com.example;
import org.springframework.batch.core.repository.support.JobRepositoryFactoryBean;
public class RepoConfig {
    JobRepositoryFactoryBean factory;
}`)
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-job-repo-factory')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.automationAvailable).toBe(false)
  })

  it('emite ManualReviewItem batch-job-repo-factory-manual', async () => {
    writePom(dir, '4.3.8')
    writeJava(dir, 'RepoConfig.java', `
package com.example;
public class RepoConfig {
    // JobRepositoryFactoryBean here
}`)
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const manual = report.manualReviewItems.find(m => m.id === 'batch-job-repo-factory-manual')
    expect(manual).toBeDefined()
    expect(manual?.suggestedApproach).toContain('autoconfiguration')
  })
})

// ─── DataSourceTransactionManager ────────────────────────────────────────────

describe('springBatchProfiler — DataSourceTransactionManager detectado', () => {
  it('emite risk batch-tx-manager com severity high', async () => {
    writePom(dir, '4.3.8')
    writeJava(dir, 'TxConfig.java', `
package com.example;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
public class TxConfig {
    DataSourceTransactionManager txManager;
}`)
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const risk = report.riskItems.find(r => r.id === 'batch-tx-manager')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.description).toContain('transaction manager')
  })
})

// ─── isBatch4 === false  (versão 5.x detectada) ───────────────────────────────

describe('springBatchProfiler — Spring Batch 5+ detectado (isBatch4 === false)', () => {
  it('prerequisiteCheck "Spring Batch 4.x" passed=false com mensagem de 5+', async () => {
    writePom(dir, '5.0.2')
    writeJava(dir, 'App.java', 'package com.example; public class App {}')
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === 'Spring Batch 4.x (precisa de migração)')
    expect(check?.passed).toBe(false)
    expect(check?.message).toContain('5+')
  })

  it('prerequisiteCheck "Spring Batch versão detectada" passed=true', async () => {
    writePom(dir, '5.0.2')
    writeJava(dir, 'App.java', 'package com.example; public class App {}')
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === 'Spring Batch versão detectada')
    expect(check?.passed).toBe(true)
    expect(check?.message).toContain('5.0.2')
  })
})

// ─── isBatch4 === null  (versão não detectada) ────────────────────────────────

describe('springBatchProfiler — versão Spring Batch não detectada (isBatch4 === null)', () => {
  it('prerequisiteCheck "Spring Batch versão detectada" passed=false', async () => {
    writePom(dir, null) // sem versão
    writeJava(dir, 'App.java', 'package com.example; public class App {}')
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === 'Spring Batch versão detectada')
    expect(check?.passed).toBe(false)
    expect(check?.message).toContain('não detectada')
  })

  it('prerequisiteCheck "Spring Batch 4.x" passed=false com "Versão não detectada"', async () => {
    writePom(dir, null)
    writeJava(dir, 'App.java', 'package com.example; public class App {}')
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    const check = report.prerequisiteChecks.find(c => c.name === 'Spring Batch 4.x (precisa de migração)')
    expect(check?.passed).toBe(false)
    expect(check?.message).toBe('Versão não detectada')
  })
})

// ─── getRecipes — fase 3 sem factory issues ───────────────────────────────────

describe('springBatchProfiler.getRecipes — sem factory issues', () => {
  it('retorna [] para fase 3 quando só há batch-tx-manager (sem factory)', async () => {
    writePom(dir, '4.3.8')
    writeJava(dir, 'TxOnly.java', `
package com.example;
public class TxOnly {
    // DataSourceTransactionManager only, no builders
}`)
    const report = await springBatchProfiler.analyze(dir, makeConfig())
    // Garante que não há factory issues
    const hasFactoryRisk = report.riskItems.some(
      r => r.id === 'batch-job-builder-factory' ||
           r.id === 'batch-step-builder-factory' ||
           r.id === 'batch-enable-annotation',
    )
    expect(hasFactoryRisk).toBe(false)
    const recipes = springBatchProfiler.getRecipes(3, report)
    expect(recipes).toHaveLength(0)
  })
})
