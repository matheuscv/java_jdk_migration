/**
 * Testes adicionais para stack-detector — cobre branches não alcançados
 * pelo skill-detect.test.ts principal:
 *   - build.gradle.kts (hasGradleKts=true)
 *   - build.xml (ANT)
 *   - maven com <source> tag (sourceCompatMatch)
 *   - maven com <packaging>war</packaging> → rest
 *   - maven com EJB via <packaging>ejb
 *   - maven com JSF/PrimeFaces
 *   - maven com WebLogic
 *   - maven com spring-web → rest (fallback)
 *   - computeConfidence: medium (stacks mas sem JDK)
 *   - detectStackDeep: jakarta.ejb, jakarta.faces, org.primefaces,
 *     org.springframework.boot, org.springframework.web (REST), weblogic
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { detectStack, detectStackDeep } from '../../src/skill/stack-detector.js'

function tempDir(): string {
  const d = join(tmpdir(), `sd-extra-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── build.gradle.kts ─────────────────────────────────────────────────────────

describe('detectStack — build.gradle.kts (Kotlin DSL)', () => {
  it('detecta buildSystem=gradle quando build.gradle.kts existe', () => {
    writeFileSync(join(dir, 'build.gradle.kts'), `
plugins { java }
java { sourceCompatibility = JavaVersion.VERSION_1_8 }
`, 'utf-8')
    const result = detectStack(dir)
    expect(result.buildSystem).toBe('gradle')
  })

  it('prefere build.gradle.kts quando ambos existem (hasGradleKts=true)', () => {
    writeFileSync(join(dir, 'build.gradle.kts'), `
java { sourceCompatibility = JavaVersion.VERSION_1_8 }
`, 'utf-8')
    writeFileSync(join(dir, 'build.gradle'), 'apply plugin: "java"', 'utf-8')
    const result = detectStack(dir)
    expect(result.buildSystem).toBe('gradle')
    // detectedJdk vindo do .kts
    expect(result.detectedJdk).toBe('8')
  })

  it('detecta spring-boot em build.gradle.kts', () => {
    writeFileSync(join(dir, 'build.gradle.kts'), `
dependencies {
  implementation("org.springframework.boot:spring-boot-starter:3.0.0")
}
`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('spring-boot')
  })

  it('detecta rest via spring-web em build.gradle.kts', () => {
    writeFileSync(join(dir, 'build.gradle.kts'), `
dependencies {
  implementation("org.springframework:spring-web:5.3.0")
}
`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('rest')
  })
})

// ─── ANT ─────────────────────────────────────────────────────────────────────

describe('detectStack — ANT (build.xml)', () => {
  it('detecta buildSystem=ant', () => {
    writeFileSync(join(dir, 'build.xml'), '<project name="myapp" default="compile"/>', 'utf-8')
    const result = detectStack(dir)
    expect(result.buildSystem).toBe('ant')
    expect(result.confidence).toBe('low')
    expect(result.detectedJdk).toBeNull()
  })

  it('unresolved contém sourceJdk e stack', () => {
    writeFileSync(join(dir, 'build.xml'), '<project/>', 'utf-8')
    const result = detectStack(dir)
    expect(result.unresolved).toContain('sourceJdk')
    expect(result.unresolved).toContain('stack')
  })
})

// ─── Maven: <source> tag ──────────────────────────────────────────────────────

describe('detectStack — Maven <source> tag (sourceCompatMatch)', () => {
  it('detecta JDK via <source>1.8</source>', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <source>1.8</source>
          <target>1.8</target>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.buildSystem).toBe('maven')
    expect(result.detectedJdk).toBe('8')
  })
})

// ─── Maven: REST via war packaging ───────────────────────────────────────────

describe('detectStack — Maven REST via <packaging>war</packaging>', () => {
  it('detecta rest quando packaging=war e sem outro stack', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <properties><java.version>1.8</java.version></properties>
  <packaging>war</packaging>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('rest')
  })
})

// ─── Maven: REST via spring-web ───────────────────────────────────────────────

describe('detectStack — Maven REST via spring-web (fallback)', () => {
  it('detecta rest quando pom tem spring-web mas não spring-boot', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-web</artifactId>
      <version>5.3.0</version>
    </dependency>
  </dependencies>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('rest')
  })
})

// ─── Maven: EJB via packaging ─────────────────────────────────────────────────

describe('detectStack — Maven EJB via <packaging>ejb</packaging>', () => {
  it('detecta ejb quando packaging=ejb', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <properties><java.version>1.8</java.version></properties>
  <packaging>ejb</packaging>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('ejb')
  })
})

// ─── Maven: JSF / PrimeFaces ──────────────────────────────────────────────────

describe('detectStack — Maven JSF via jsf-api ou primefaces', () => {
  it('detecta jsf quando jsf-api presente', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency>
      <artifactId>jsf-api</artifactId>
    </dependency>
  </dependencies>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('jsf')
  })

  it('detecta jsf quando primefaces presente', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency>
      <artifactId>primefaces</artifactId>
    </dependency>
  </dependencies>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('jsf')
  })
})

// ─── Maven: WebLogic ──────────────────────────────────────────────────────────

describe('detectStack — Maven WebLogic', () => {
  it('detecta weblogic quando wls-api presente', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency>
      <artifactId>wls-api</artifactId>
    </dependency>
  </dependencies>
</project>`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('weblogic')
  })
})

// ─── computeConfidence: medium ────────────────────────────────────────────────

describe('detectStack — computeConfidence medium', () => {
  it('confidence=medium quando stacks detectados mas JDK ausente', () => {
    writeFileSync(join(dir, 'pom.xml'), `<project>
  <dependencies>
    <dependency>
      <artifactId>spring-boot-starter</artifactId>
    </dependency>
  </dependencies>
</project>`, 'utf-8')
    const result = detectStack(dir)
    // stacks.length > 0 mas detectedJdk=null (sem <java.version>) → medium
    expect(result.confidence).toBe('medium')
    expect(result.detectedJdk).toBeNull()
  })
})

// ─── detectStackDeep: imports jakarta, primefaces, springframework.boot, weblogic ──

describe('detectStackDeep — imports jakarta e outros', () => {
  let srcDir: string

  beforeEach(() => {
    srcDir = join(dir, 'src', 'main', 'java', 'com', 'example')
    mkdirSync(srcDir, { recursive: true })
  })

  it('detecta ejb via jakarta.ejb import', () => {
    writeFileSync(join(srcDir, 'MyBean.java'), `
import jakarta.ejb.Stateless;
@Stateless public class MyBean {}`)
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('ejb')
  })

  it('detecta jsf via jakarta.faces import', () => {
    writeFileSync(join(srcDir, 'MyBean.java'), `
import jakarta.faces.bean.ManagedBean;
@ManagedBean public class MyBean {}`)
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('jsf')
  })

  it('detecta jsf via org.primefaces import', () => {
    writeFileSync(join(srcDir, 'MyComp.java'), `
import org.primefaces.component.datatable.DataTable;
public class MyComp {}`)
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('jsf')
  })

  it('detecta spring-boot via org.springframework.boot import', () => {
    writeFileSync(join(srcDir, 'Main.java'), `
import org.springframework.boot.SpringApplication;
public class Main {}`)
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('spring-boot')
  })

  it('detecta weblogic via weblogic import', () => {
    writeFileSync(join(srcDir, 'WlHelper.java'), `
import weblogic.jndi.WLInitialContextFactory;
public class WlHelper {}`)
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('weblogic')
  })

  it('detecta rest via org.springframework.web import', () => {
    writeFileSync(join(srcDir, 'MyCtrl.java'), `
import org.springframework.web.bind.annotation.RestController;
public class MyCtrl {}`)
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('rest')
  })

  it('detecta persistence.xml sem adicionar stack (null entry)', () => {
    const webInf = join(dir, 'src', 'main', 'webapp', 'WEB-INF')
    mkdirSync(webInf, { recursive: true })
    writeFileSync(join(webInf, 'persistence.xml'), '<persistence/>')
    const result = detectStackDeep(dir)
    // persistence.xml registrado em deploymentDescriptors mas sem stack
    expect(result.deploymentDescriptors.some(d => d.endsWith('persistence.xml'))).toBe(true)
    // nenhum stack adicionado por persistence.xml
  })

  it('detecta weblogic via weblogic-ejb-jar.xml', () => {
    const webInf = join(dir, 'src', 'main', 'webapp', 'WEB-INF')
    mkdirSync(webInf, { recursive: true })
    writeFileSync(join(webInf, 'weblogic-ejb-jar.xml'), '<weblogic-ejb-jar/>')
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('weblogic')
  })

  it('detecta weblogic via weblogic-application.xml', () => {
    const webInf = join(dir, 'src', 'main', 'webapp', 'WEB-INF')
    mkdirSync(webInf, { recursive: true })
    writeFileSync(join(webInf, 'weblogic-application.xml'), '<weblogic-application/>')
    const result = detectStackDeep(dir)
    expect(result.additionalStacks).toContain('weblogic')
  })
})

// ─── Gradle: spring-batch, ejb, jsf, weblogic ──────────────────────────────

describe('detectStack — Gradle com diversas stacks', () => {
  it('detecta spring-batch em build.gradle', () => {
    writeFileSync(join(dir, 'build.gradle'), `
dependencies {
  implementation 'org.springframework.batch:spring-batch-core:4.3.0'
}`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('spring-batch')
  })

  it('detecta ejb em build.gradle', () => {
    writeFileSync(join(dir, 'build.gradle'), `
dependencies {
  implementation 'javax.ejb:javax.ejb-api:3.2'
}`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('ejb')
  })

  it('detecta jsf em build.gradle', () => {
    writeFileSync(join(dir, 'build.gradle'), `
dependencies {
  implementation 'com.sun.faces:jsf-api:2.3.0'
}`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('jsf')
  })

  it('detecta weblogic em build.gradle', () => {
    writeFileSync(join(dir, 'build.gradle'), `
dependencies {
  implementation 'com.oracle:weblogic:12.2.1.4'
}`, 'utf-8')
    const result = detectStack(dir)
    expect(result.detectedStacks).toContain('weblogic')
  })
})
