/**
 * Testes unitários para source-cleaner.ts
 * Cobre remoção segura de APIs no-op, detecção de human-decisions e injeção Nashorn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runSourceCleaner } from '../../src/transform-engine/source-cleaner.js'

function tempDir(): string {
  const d = join(tmpdir(), `sc-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(d, { recursive: true })
  return d
}

function write(base: string, rel: string, content: string): void {
  const parts = rel.split('/')
  if (parts.length > 1) mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(base, rel), content, 'utf-8')
}

function read(base: string, rel: string): string {
  return readFileSync(join(base, rel), 'utf-8')
}

let dir: string
beforeEach(() => { dir = tempDir() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── projeto sem Java ─────────────────────────────────────────────────────────

describe('runSourceCleaner — projeto sem src/', () => {
  it('retorna resultado vazio sem lançar exceção', async () => {
    const result = await runSourceCleaner(dir, false)
    expect(result.recipesApplied).toHaveLength(0)
    expect(result.filesModified).toBe(0)
    expect(result.detail.humanDecisionsNeeded).toHaveLength(0)
  })
})

// ─── remoções seguras (SAFE_REMOVALS) ────────────────────────────────────────

describe('SAFE_REMOVALS — System.runFinalizersOnExit', () => {
  it('substitui chamada por comentário', async () => {
    write(dir, 'src/main/java/com/example/App.java',
      'public class App {\n  void init() {\n    System.runFinalizersOnExit(true);\n  }\n}')
    const result = await runSourceCleaner(dir, false)
    const content = read(dir, 'src/main/java/com/example/App.java')
    expect(content).toContain('[jdk-migration]')
    expect(content).not.toContain('System.runFinalizersOnExit(true)')
    expect(result.detail.removedCalls.length).toBeGreaterThan(0)
    expect(result.detail.filesModifiedList).toContain('src/main/java/com/example/App.java')
  })

  it('substitui Runtime.runFinalizersOnExit por comentário', async () => {
    write(dir, 'src/main/java/com/example/App.java',
      'public class App {\n  void x() {\n    Runtime.runFinalizersOnExit(false);\n  }\n}')
    await runSourceCleaner(dir, false)
    const content = read(dir, 'src/main/java/com/example/App.java')
    expect(content).toContain('[jdk-migration]')
    expect(content).not.toContain('Runtime.runFinalizersOnExit(false)')
  })

  it('substitui Runtime.getRuntime().runFinalizersOnExit()', async () => {
    write(dir, 'src/main/java/com/example/App.java',
      'public class App {\n  void x() {\n    Runtime.getRuntime().runFinalizersOnExit(true);\n  }\n}')
    await runSourceCleaner(dir, false)
    const content = read(dir, 'src/main/java/com/example/App.java')
    expect(content).not.toContain('Runtime.getRuntime().runFinalizersOnExit(true)')
  })
})

describe('SAFE_REMOVALS — java.lang.Compiler', () => {
  it('remove chamada a java.lang.Compiler.enable()', async () => {
    write(dir, 'src/main/java/com/example/App.java',
      'public class App {\n  void x() {\n    java.lang.Compiler.enable();\n  }\n}')
    await runSourceCleaner(dir, false)
    const content = read(dir, 'src/main/java/com/example/App.java')
    expect(content).not.toContain('java.lang.Compiler.enable()')
    expect(content).toContain('[jdk-migration]')
  })

  it('remove import java.lang.Compiler', async () => {
    write(dir, 'src/main/java/com/example/App.java',
      'import java.lang.Compiler;\npublic class App {}')
    const result = await runSourceCleaner(dir, false)
    const content = read(dir, 'src/main/java/com/example/App.java')
    expect(content).not.toContain('import java.lang.Compiler')
    expect(result.recipesApplied).toContain('remove-obsolete-imports')
  })
})

// ─── dryRun ───────────────────────────────────────────────────────────────────

describe('dryRun', () => {
  it('não modifica arquivos em dryRun', async () => {
    const original = 'public class App {\n  void x() {\n    System.runFinalizersOnExit(true);\n  }\n}'
    write(dir, 'src/main/java/com/example/App.java', original)
    const result = await runSourceCleaner(dir, true)
    const content = read(dir, 'src/main/java/com/example/App.java')
    expect(content).toBe(original)
    expect(result.filesModified).toBe(0)
    expect(result.diffSummary).toContain('dry-run')
  })
})

// ─── HUMAN_DECISION_PATTERNS ─────────────────────────────────────────────────

describe('Thread.stop() — human decision bloqueante', () => {
  it('detecta Thread.stop() e adiciona human decision bloqueante', async () => {
    write(dir, 'src/main/java/com/example/Worker.java',
      'public class Worker { void stop(Thread t) { t.stop(); } }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'thread-stop')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
    expect(hd!.occurrences.length).toBeGreaterThan(0)
    // Arquivo não deve ser modificado (apenas detectado)
    const content = read(dir, 'src/main/java/com/example/Worker.java')
    expect(content).toContain('t.stop()')
  })
})

describe('Thread.destroy() — human decision bloqueante', () => {
  it('detecta Thread.destroy()', async () => {
    write(dir, 'src/main/java/com/example/Worker.java',
      'public class Worker { void kill(Thread t) { t.destroy(); } }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'thread-destroy')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
  })
})

describe('Thread.countStackFrames() — human decision bloqueante', () => {
  it('detecta countStackFrames()', async () => {
    write(dir, 'src/main/java/com/example/Debug.java',
      'public class Debug { int count(Thread t) { return t.countStackFrames(); } }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'thread-countStackFrames')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
  })
})

describe('SecurityManager — human decision bloqueante', () => {
  it('detecta extends SecurityManager', async () => {
    write(dir, 'src/main/java/com/example/SM.java',
      'public class SM extends SecurityManager { }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'security-manager')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
    expect(hd!.occurrences[0].file).toContain('SM.java')
  })

  it('detecta System.setSecurityManager()', async () => {
    write(dir, 'src/main/java/com/example/App.java',
      'public class App { static { System.setSecurityManager(null); } }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'security-manager')
    expect(hd).toBeDefined()
  })
})

describe('finalize() override — human decision não-bloqueante', () => {
  it('detecta protected void finalize()', async () => {
    write(dir, 'src/main/java/com/example/Resource.java',
      'public class Resource { @Override protected void finalize() throws Throwable {} }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'finalize-override')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(false)
  })

  it('detecta public void finalize()', async () => {
    write(dir, 'src/main/java/com/example/Resource.java',
      'public class Resource { public void finalize() {} }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'finalize-override')
    expect(hd).toBeDefined()
  })
})

describe('sun.misc.Unsafe — human decision bloqueante', () => {
  it('detecta import sun.misc.Unsafe', async () => {
    write(dir, 'src/main/java/com/example/UnsafeUser.java',
      'import sun.misc.Unsafe;\npublic class UnsafeUser { }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'sun-unsafe')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
  })
})

describe('sun.misc.Signal — human decision bloqueante', () => {
  it('detecta import sun.misc.Signal', async () => {
    write(dir, 'src/main/java/com/example/SigHandler.java',
      'import sun.misc.Signal;\npublic class SigHandler { }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'sun-signal')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
  })
})

describe('com.sun.image.codec.jpeg — human decision bloqueante', () => {
  it('detecta import com.sun.image.codec.jpeg', async () => {
    write(dir, 'src/main/java/com/example/ImageUtil.java',
      'import com.sun.image.codec.jpeg.JPEGCodec;\npublic class ImageUtil { }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'com-sun-image-codec')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(true)
  })
})

describe('sun.misc.BASE64Encoder — human decision não-bloqueante', () => {
  it('detecta import sun.misc.BASE64Encoder', async () => {
    write(dir, 'src/main/java/com/example/Enc.java',
      'import sun.misc.BASE64Encoder;\npublic class Enc { }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'sun-base64')
    expect(hd).toBeDefined()
    expect(hd!.blocking).toBe(false)
  })
})

// ─── Nashorn injection ────────────────────────────────────────────────────────

describe('Nashorn — injeção de nashorn-core no pom.xml', () => {
  it('injeta nashorn-core quando ScriptEngineManager é detectado', async () => {
    write(dir, 'pom.xml',
      '<project><dependencies></dependencies></project>')
    write(dir, 'src/main/java/com/example/Eval.java',
      'import javax.script.*;\npublic class Eval { void run() { new ScriptEngineManager(); } }')
    const result = await runSourceCleaner(dir, false)
    expect(result.detail.nashornDepInjected).toBe(true)
    const pom = read(dir, 'pom.xml')
    expect(pom).toContain('nashorn-core')
    expect(pom).toContain('15.4')
    expect(result.recipesApplied).toContain('inject-nashorn-core-dependency')
  })

  it('detecta getEngineByName("nashorn")', async () => {
    write(dir, 'pom.xml',
      '<project><dependencies></dependencies></project>')
    write(dir, 'src/main/java/com/example/Eval.java',
      'import javax.script.*;\npublic class Eval {\n  void run() {\n    ScriptEngine engine = mgr.getEngineByName("nashorn");\n  }\n}')
    const result = await runSourceCleaner(dir, false)
    expect(result.detail.nashornDepInjected).toBe(true)
  })

  it('não injeta nashorn-core quando já está presente no pom.xml', async () => {
    write(dir, 'pom.xml',
      '<project><dependencies><dependency><groupId>org.openjdk.nashorn</groupId><artifactId>nashorn-core</artifactId></dependency></dependencies></project>')
    write(dir, 'src/main/java/com/example/Eval.java',
      'public class Eval { void run() { new ScriptEngineManager(); } }')
    const result = await runSourceCleaner(dir, false)
    expect(result.detail.nashornDepInjected).toBe(false)
  })

  it('não injeta nashorn quando não há uso de ScriptEngine', async () => {
    write(dir, 'pom.xml', '<project><dependencies></dependencies></project>')
    write(dir, 'src/main/java/com/example/App.java', 'public class App {}')
    const result = await runSourceCleaner(dir, false)
    expect(result.detail.nashornDepInjected).toBe(false)
  })

  it('em dryRun não modifica o pom.xml mesmo com ScriptEngine detectado', async () => {
    const originalPom = '<project><dependencies></dependencies></project>'
    write(dir, 'pom.xml', originalPom)
    write(dir, 'src/main/java/com/example/Eval.java',
      'public class Eval { void run() { new ScriptEngineManager(); } }')
    await runSourceCleaner(dir, true)
    const pom = read(dir, 'pom.xml')
    expect(pom).toBe(originalPom)
  })
})

// ─── varredura em src/test/java ───────────────────────────────────────────────

describe('varredura de src/test/java', () => {
  it('também detecta issues em arquivos de teste', async () => {
    write(dir, 'src/test/java/com/example/LegacyTest.java',
      'public class LegacyTest { void test(Thread t) { t.stop(); } }')
    const result = await runSourceCleaner(dir, false)
    const hd = result.detail.humanDecisionsNeeded.find(h => h.id === 'thread-stop')
    expect(hd).toBeDefined()
    expect(hd!.occurrences[0].file).toContain('test')
  })
})

// ─── detail.nashornDepInjected default ───────────────────────────────────────

describe('SourceCleanerDetail — campo nashornDepInjected', () => {
  it('nashornDepInjected é false por padrão (sem nashorn)', async () => {
    write(dir, 'src/main/java/com/example/App.java', 'public class App {}')
    const result = await runSourceCleaner(dir, false)
    expect(result.detail.nashornDepInjected).toBe(false)
  })
})
