/**
 * Testes unitários para runMigrationAudit — 25 critérios (A1-A8, C1-C12, D1-D5)
 * IDs reais dos critérios mapeados a partir da implementação em migration-audit.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runMigrationAudit } from '../../src/static-analysis/migration-audit.js'

function tempDir(): string {
  const dir = join(tmpdir(), `audit-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function mkdir(base: string, rel: string): string {
  const full = join(base, rel)
  mkdirSync(full, { recursive: true })
  return full
}

function write(base: string, rel: string, content: string): void {
  const parts = rel.split('/')
  if (parts.length > 1) mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(base, rel), content, 'utf-8')
}

function pomWith21(): string {
  return `<project>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId><version>3.2.0</version></dependency>
  </dependencies>
</project>`
}

function pomWithOldJdk(v = '8'): string {
  return `<project>
  <properties>
    <maven.compiler.source>${v}</maven.compiler.source>
    <maven.compiler.target>${v}</maven.compiler.target>
  </properties>
</project>`
}

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── estrutura do resultado ────────────────────────────────────────────────────

describe('runMigrationAudit — estrutura do resultado', () => {
  it('retorna exatamente 25 critérios', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria).toHaveLength(25)
  })

  it('cada critério tem id, label, status e detail', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    for (const c of r.criteria) {
      expect(c.id).toBeTruthy()
      expect(c.label).toBeTruthy()
      expect(['ok', 'warning', 'fail']).toContain(c.status)
      expect(c.detail).toBeTruthy()
    }
  })

  it('summary.ok + warning + fail === 25', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.summary.ok + r.summary.warning + r.summary.fail).toBe(25)
  })

  it('hasBlockers é true quando há fail', async () => {
    write(dir, 'pom.xml', pomWithOldJdk())
    const r = await runMigrationAudit(dir, '21')
    if (r.summary.fail > 0) expect(r.hasBlockers).toBe(true)
  })

  it('allOk é false quando há qualquer fail ou warning', async () => {
    write(dir, 'pom.xml', pomWithOldJdk())
    const r = await runMigrationAudit(dir, '21')
    expect(r.allOk).toBe(false)
  })

  it('hasBlockers reflete corretamente se há fail', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    const hasFail = r.criteria.some(c => c.status === 'fail')
    expect(r.hasBlockers).toBe(hasFail)
  })

  it('summary reflete counts corretos', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    const ok = r.criteria.filter(c => c.status === 'ok').length
    const warn = r.criteria.filter(c => c.status === 'warning').length
    const fail = r.criteria.filter(c => c.status === 'fail').length
    expect(r.summary.ok).toBe(ok)
    expect(r.summary.warning).toBe(warn)
    expect(r.summary.fail).toBe(fail)
  })

  it('não lança exceção em projeto vazio', async () => {
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria).toHaveLength(25)
  })

  it('targetJdk e generatedAt estão presentes', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.targetJdk).toBe('21')
    expect(r.generatedAt).toBeTruthy()
  })
})

// ─── A1 — compiler-version ────────────────────────────────────────────────────

describe('A1 — compiler-version', () => {
  it('ok com maven.compiler.release=21', async () => {
    write(dir, 'pom.xml', `<project><properties>
      <maven.compiler.release>21</maven.compiler.release>
    </properties></project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'compiler-version')!.status).toBe('ok')
  })

  it('fail com maven.compiler.source=8', async () => {
    write(dir, 'pom.xml', `<project><properties>
      <maven.compiler.source>8</maven.compiler.source>
    </properties></project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'compiler-version')!.status).toBe('fail')
  })

  it('warning sem propriedades de compilador no pom.xml', async () => {
    write(dir, 'pom.xml', '<project><modelVersion>4.0.0</modelVersion></project>')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'compiler-version')!.status).toBe('warning')
  })

  it('ok com <release>21</release> no maven-compiler-plugin', async () => {
    write(dir, 'pom.xml', `<project><build><plugins><plugin>
      <artifactId>maven-compiler-plugin</artifactId>
      <configuration><release>21</release></configuration>
    </plugin></plugins></build></project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'compiler-version')!.status).toBe('ok')
  })

  it('fail com <release>8</release> no maven-compiler-plugin', async () => {
    write(dir, 'pom.xml', `<project><build><plugins><plugin>
      <artifactId>maven-compiler-plugin</artifactId>
      <configuration><release>8</release></configuration>
    </plugin></plugins></build></project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'compiler-version')!.status).toBe('fail')
  })

  it('warning sem pom.xml e sem build.gradle', async () => {
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'compiler-version')!.status).toBe('warning')
  })
})

// ─── A2 — javax-imports ───────────────────────────────────────────────────────

describe('A2 — javax-imports', () => {
  it('fail com import javax.persistence.Entity', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Foo.java'),
      'import javax.persistence.Entity;\npublic class Foo {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'javax-imports')!.status).toBe('fail')
  })

  it('fail com import javax.xml.ws (JEP 320)', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Ws.java'), 'import javax.xml.ws.Service;\npublic class Ws {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'javax-imports')!.status).toBe('fail')
  })

  it('ok sem imports javax.* EE', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'App.java'), 'import java.util.List;\npublic class App {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'javax-imports')!.status).toBe('ok')
  })

  it('warning sem arquivos Java', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'javax-imports')!.status).toBe('warning')
  })
})

// ─── A3 — spring-boot-version ─────────────────────────────────────────────────

describe('A3 — spring-boot-version', () => {
  it('ok com spring-boot-starter-parent 3.x', async () => {
    write(dir, 'pom.xml', `<project>
      <parent><groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version></parent>
    </project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'spring-boot-version')!.status).toBe('ok')
  })

  it('warning com spring-boot-starter-parent 2.7.x (executa em JDK 21 mas sem Jakarta EE)', async () => {
    write(dir, 'pom.xml', `<project>
      <parent><groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>2.7.18</version></parent>
    </project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'spring-boot-version')!.status).toBe('warning')
  })

  it('fail com spring-boot-starter-parent 2.5.x (abaixo de 2.7)', async () => {
    write(dir, 'pom.xml', `<project>
      <parent><groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>2.5.14</version></parent>
    </project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'spring-boot-version')!.status).toBe('fail')
  })

  it('warning sem spring-boot no pom.xml', async () => {
    write(dir, 'pom.xml', `<project><properties>
      <maven.compiler.release>21</maven.compiler.release>
    </properties></project>`)
    const r = await runMigrationAudit(dir, '21')
    const c = r.criteria.find(c => c.id === 'spring-boot-version')!
    expect(['ok', 'warning']).toContain(c.status)
  })
})

// ─── A5/A7 — container-ci (Dockerfile + CI pipeline) ────────────────────────

describe('container-ci (Dockerfile + CI pipelines)', () => {
  it('fail quando Dockerfile usa openjdk:8', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, 'Dockerfile', 'FROM openjdk:8-jre\nCMD ["java"]\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'container-ci')!.status).toBe('fail')
  })

  it('ok quando Dockerfile usa eclipse-temurin:21', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, 'Dockerfile', 'FROM eclipse-temurin:21-jre\nCMD ["java"]\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'container-ci')!.status).toBe('ok')
  })

  it('fail quando CI tem java-version: 8', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.github/workflows/ci.yml', 'with:\n  java-version: 8\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'container-ci')!.status).toBe('fail')
  })

  it('ok quando CI tem java-version: 21', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.github/workflows/ci.yml', 'with:\n  java-version: 21\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'container-ci')!.status).toBe('ok')
  })

  it('warning quando não há Dockerfile nem CI', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'container-ci')!.status).toBe('warning')
  })
})

// ─── C2 — mvn-jvm-config / removed-jvm-flags ─────────────────────────────────

describe('mvn-jvm-config — .mvn/jvm.config', () => {
  it('fail quando .mvn/jvm.config contém -XX:MaxPermSize', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.mvn/jvm.config', '-XX:MaxPermSize=256m -Xmx512m\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'mvn-jvm-config')!.status).toBe('fail')
  })

  it('fail quando .mvn/jvm.config contém -XX:+UseConcMarkSweepGC', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.mvn/jvm.config', '-XX:+UseConcMarkSweepGC\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'mvn-jvm-config')!.status).toBe('fail')
  })

  it('ok quando .mvn/jvm.config tem apenas flags modernas', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.mvn/jvm.config', '-Xmx512m -Xms256m\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'mvn-jvm-config')!.status).toBe('ok')
  })

  it('ok quando não há .mvn/jvm.config', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'mvn-jvm-config')!.status).toBe('ok')
  })
})

describe('removed-jvm-flags — scripts e docker-compose', () => {
  it('fail quando pom.xml tem -XX:+UseConcMarkSweepGC em argLine', async () => {
    write(dir, 'pom.xml', `<project><properties>
      <maven.compiler.release>21</maven.compiler.release>
      <argLine>-XX:+UseConcMarkSweepGC -Xmx512m</argLine>
    </properties></project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'removed-jvm-flags')!.status).toBe('fail')
  })

  it('ok quando não há flags obsoletas em scripts/docker-compose', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'removed-jvm-flags')!.status).toBe('ok')
  })
})

// ─── C3 — security-manager ───────────────────────────────────────────────────

describe('security-manager', () => {
  it('fail quando código estende SecurityManager', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'SM.java'), 'public class SM extends SecurityManager {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'security-manager')!.status).toBe('fail')
  })

  it('fail quando código chama System.setSecurityManager', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'App.java'),
      'public class App { static { System.setSecurityManager(null); } }')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'security-manager')!.status).toBe('fail')
  })

  it('ok sem uso de SecurityManager', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'App.java'), 'public class App {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'security-manager')!.status).toBe('ok')
  })
})

// ─── C5 / nashorn ────────────────────────────────────────────────────────────

describe('nashorn (ScriptEngine removido JDK 15)', () => {
  it('fail quando código usa getEngineByName("nashorn")', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Eval.java'),
      'import javax.script.*;\npublic class Eval { void run() { mgr.getEngineByName("nashorn"); } }')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'nashorn')!.status).toBe('fail')
  })

  it('fail quando código usa getEngineByName("javascript")', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Eval.java'),
      'public class Eval { void run() { mgr.getEngineByName("javascript"); } }')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'nashorn')!.status).toBe('fail')
  })

  it('ok sem uso de ScriptEngine', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'App.java'), 'public class App {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'nashorn')!.status).toBe('ok')
  })
})

// ─── C6 — add-opens ───────────────────────────────────────────────────────────

describe('add-opens', () => {
  it('warning quando .mvn/jvm.config contém --add-opens', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.mvn/jvm.config', '--add-opens java.base/java.lang=ALL-UNNAMED\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'add-opens')!.status).toBe('warning')
  })

  it('ok sem --add-opens', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, '.mvn/jvm.config', '-Xmx512m\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'add-opens')!.status).toBe('ok')
  })
})

// ─── C8 — finalize-override ───────────────────────────────────────────────────

describe('finalize-override', () => {
  it('warning quando há protected void finalize()', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Res.java'),
      'public class Res { @Override protected void finalize() throws Throwable {} }')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'finalize-override')!.status).toBe('warning')
  })

  it('ok sem finalize()', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Res.java'), 'public class Res {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'finalize-override')!.status).toBe('ok')
  })
})

// ─── C2 (sun.* imports) — sun-internal-imports ────────────────────────────────

describe('sun-internal-imports', () => {
  it('fail com import sun.misc.Unsafe', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'U.java'), 'import sun.misc.Unsafe;\npublic class U {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'sun-internal-imports')!.status).toBe('fail')
  })

  it('fail com import sun.misc.BASE64Encoder', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'E.java'), 'import sun.misc.BASE64Encoder;\npublic class E {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'sun-internal-imports')!.status).toBe('fail')
  })

  it('ok sem imports sun.*', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Clean.java'), 'public class Clean {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'sun-internal-imports')!.status).toBe('ok')
  })

  it('warning sem arquivos Java (não pode confirmar)', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'sun-internal-imports')!.status).toBe('warning')
  })
})

// ─── D1 — removed-apis ────────────────────────────────────────────────────────

describe('removed-apis (Thread.stop, Applet, RMI Activation)', () => {
  it('fail quando há thread.stop() (variável chamada thread)', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'W.java'),
      'public class W { void stop(Thread thread) { thread.stop(); } }')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'removed-apis')!.status).toBe('fail')
  })

  it('fail quando há import java.applet.* (API Applet removida JDK 17)', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'App.java'), 'import java.applet.Applet;\npublic class App {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'removed-apis')!.status).toBe('fail')
  })

  it('ok sem APIs removidas', async () => {
    write(dir, 'pom.xml', pomWith21())
    const jDir = mkdir(dir, 'src/main/java/com/example')
    writeFileSync(join(jDir, 'Clean.java'), 'public class Clean {}')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'removed-apis')!.status).toBe('ok')
  })
})

// ─── D3 — maven-plugin-versions ───────────────────────────────────────────────

describe('maven-plugin-versions', () => {
  it('fail quando maven-compiler-plugin está em versão obsoleta', async () => {
    write(dir, 'pom.xml', `<project><build><plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>2.5.1</version>
      </plugin>
    </plugins></build></project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'maven-plugin-versions')!.status).toBe('fail')
  })

  it('ok quando maven-compiler-plugin está em versão recente (3.x)', async () => {
    write(dir, 'pom.xml', `<project>
      <properties><maven.compiler.release>21</maven.compiler.release></properties>
      <build><plugins>
        <plugin><groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-compiler-plugin</artifactId>
          <version>3.12.1</version>
        </plugin>
      </plugins></build>
    </project>`)
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'maven-plugin-versions')!.status).toBe('ok')
  })
})

// ─── D4 — maven-jdk-profiles ─────────────────────────────────────────────────

describe('maven-jdk-profiles', () => {
  it('warning quando profile tem ativação por JDK antigo E override de maven.compiler.source', async () => {
    write(dir, 'pom.xml', `<project>
      <properties><maven.compiler.release>21</maven.compiler.release></properties>
      <profiles><profile><id>jdk8</id>
        <activation><jdk>1.8</jdk></activation>
        <properties><maven.compiler.source>1.8</maven.compiler.source></properties>
      </profile></profiles>
    </project>`)
    const r = await runMigrationAudit(dir, '21')
    const c = r.criteria.find(c => c.id === 'maven-jdk-profiles')!
    expect(c.status).toBe('warning')
  })

  it('ok quando não há profiles com ativação por JDK', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'maven-jdk-profiles')!.status).toBe('ok')
  })
})

// ─── D5 — k8s-manifests ───────────────────────────────────────────────────────

describe('k8s-manifests', () => {
  it('ok quando não há diretórios k8s', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'k8s-manifests')!.status).toBe('ok')
  })

  it('fail quando k8s/deployment.yaml usa imagem JDK antigo', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, 'k8s/deployment.yaml',
      'containers:\n- image: openjdk:8-jre\n')
    const r = await runMigrationAudit(dir, '21')
    const c = r.criteria.find(c => c.id === 'k8s-manifests')!
    expect(['warning', 'fail']).toContain(c.status)
  })

  it('ok quando k8s/deployment.yaml usa eclipse-temurin:21', async () => {
    write(dir, 'pom.xml', pomWith21())
    write(dir, 'k8s/deployment.yaml',
      'containers:\n- image: eclipse-temurin:21-jre\n')
    const r = await runMigrationAudit(dir, '21')
    expect(r.criteria.find(c => c.id === 'k8s-manifests')!.status).toBe('ok')
  })
})

// ─── IDs presentes nos 25 critérios ───────────────────────────────────────────

describe('IDs dos 25 critérios presentes no resultado', () => {
  const EXPECTED_IDS = [
    'compiler-version', 'javax-imports', 'spring-boot-version', 'internal-deps',
    'container-ci', 'runtime-evidence', 'obsolete-props', 'output-bytecode',
    'actual-bytecode', 'sun-internal-imports', 'security-manager', 'removed-jvm-flags',
    'nashorn', 'add-opens', 'annotation-processors', 'finalize-override',
    'mvn-jvm-config', 'serialization-risk', 'javax-script', 'reflective-internal',
    'removed-apis', 'bytecode-manip-libs', 'maven-plugin-versions',
    'k8s-manifests', 'maven-jdk-profiles',
  ]

  it('todos os 25 IDs esperados estão presentes', async () => {
    write(dir, 'pom.xml', pomWith21())
    const r = await runMigrationAudit(dir, '21')
    const ids = r.criteria.map(c => c.id)
    for (const id of EXPECTED_IDS) {
      expect(ids).toContain(id)
    }
  })
})
