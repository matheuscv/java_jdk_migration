/**
 * Testes unitários para build-validator.ts
 * Cobre runBuild, runTests, runSourceBuild, detectMissingArtifacts, parseTestCounts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/process-runner.js', () => ({
  runProcess: vi.fn(),
}))

import { runBuild, runTests, runSourceBuild } from '../../src/orchestrator/build-validator.js'
import { runProcess } from '../../src/lib/process-runner.js'

const DIR = '/tmp/test-project'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── runBuild — maven ─────────────────────────────────────────────────────────

describe('runBuild — maven sucesso', () => {
  it('retorna success=true quando exitCode=0', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '[INFO] BUILD SUCCESS', stderr: '', timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.success).toBe(true)
    expect(result.failureReason).toBeNull()
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining(['clean', 'compile', '-B']), expect.any(Object))
  })

  it('usa mavenExecutable personalizado', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runBuild(DIR, 'maven', { mavenExecutable: '/opt/mvn/bin/mvn' })
    expect(runProcess).toHaveBeenCalledWith('/opt/mvn/bin/mvn', expect.any(Array), expect.any(Object))
  })

  it('injeta JAVA_HOME e PATH quando targetJdkHome fornecido', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runBuild(DIR, 'maven', { targetJdkHome: '/usr/lib/jvm/java-21' })
    const call = vi.mocked(runProcess).mock.calls[0]
    const opts = call[2] as { env?: NodeJS.ProcessEnv }
    expect(opts.env?.JAVA_HOME).toBe('/usr/lib/jvm/java-21')
    expect(opts.env?.PATH).toContain('java-21')
  })
})

describe('runBuild — maven timeout', () => {
  it('retorna failureReason=timeout quando timedOut=true', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: -1, stdout: '', stderr: '', timedOut: true,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('timeout')
  })
})

describe('runBuild — maven command_not_found', () => {
  it('retorna failureReason=command_not_found quando stderr contém "não encontrado"', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: -1, stdout: '', stderr: 'mvn não encontrado no PATH', timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('command_not_found')
  })
})

describe('runBuild — maven missing_artifact', () => {
  it('retorna failureReason=missing_artifact quando stderr contém "Could not resolve artifact"', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: '[ERROR] Could not resolve artifact com.example:lib:jar:1.0.0',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('missing_artifact')
    expect(result.missingArtifacts).toContain('com.example:lib:jar:1.0.0')
  })

  it('retorna missing_artifact quando "Could not find artifact" no stdout', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'Could not find artifact org.foo:bar:jar:2.0',
      stderr: '',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.failureReason).toBe('missing_artifact')
    expect(result.missingArtifacts).toContain('org.foo:bar:jar:2.0')
  })

  it('retorna missing_artifact quando "Non-resolvable parent POM" no stderr', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Non-resolvable parent POM for com.example:child: com.example:parent:1.0',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.failureReason).toBe('missing_artifact')
  })
})

describe('runBuild — maven compilation failure', () => {
  it('retorna failureReason=compilation quando stderr contém COMPILATION ERROR', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: '[ERROR] COMPILATION ERROR',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('compilation')
  })

  it('retorna failureReason=compilation quando stderr contém "error:"', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Foo.java:10: error: cannot find symbol',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.failureReason).toBe('compilation')
  })

  it('retorna failureReason=compilation quando stderr contém "cannot find symbol"', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Foo.java: cannot find symbol',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.failureReason).toBe('compilation')
  })

  it('retorna failureReason=tests quando falha sem indicação de erro de compilação', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'Tests FAILED',
      stderr: '',
      timedOut: false,
    })
    const result = await runBuild(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('tests')
  })
})

describe('runBuild — gradle', () => {
  it('usa gradle command e compileJava task', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: 'BUILD SUCCESSFUL', stderr: '', timedOut: false,
    })
    const result = await runBuild(DIR, 'gradle')
    expect(runProcess).toHaveBeenCalledWith('gradle', expect.arrayContaining(['compileJava']), expect.any(Object))
    expect(result.success).toBe(true)
  })

  it('usa gradleExecutable personalizado', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runBuild(DIR, 'gradle', { gradleExecutable: './gradlew' })
    expect(runProcess).toHaveBeenCalledWith('./gradlew', expect.any(Array), expect.any(Object))
  })
})

// ─── runTests ─────────────────────────────────────────────────────────────────

describe('runTests — maven', () => {
  it('retorna success=true quando testes passam', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'Tests run: 10, Failures: 0, Errors: 0',
      stderr: '',
      timedOut: false,
    })
    const result = await runTests(DIR, 'maven')
    expect(result.success).toBe(true)
    expect(result.testsPassed).toBe(10)
    expect(result.testsFailed).toBe(0)
    expect(result.failureReason).toBeNull()
  })

  it('retorna testsFailed quando maven reporta falhas', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'Tests run: 10, Failures: 3, Errors: 0',
      stderr: '',
      timedOut: false,
    })
    const result = await runTests(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.testsPassed).toBe(7)
    expect(result.testsFailed).toBe(3)
  })

  it('retorna testsPassed=null quando não há output de tests', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'BUILD SUCCESS',
      stderr: '',
      timedOut: false,
    })
    const result = await runTests(DIR, 'maven')
    expect(result.testsPassed).toBeNull()
    expect(result.testsFailed).toBeNull()
  })

  it('retorna timeout quando timedOut=true', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: -1, stdout: '', stderr: '', timedOut: true,
    })
    const result = await runTests(DIR, 'maven')
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('timeout')
  })

  it('usa task "test" para maven', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runTests(DIR, 'maven')
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining(['test']), expect.any(Object))
  })
})

describe('runTests — gradle', () => {
  it('retorna success=true quando testes passam', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '10 tests completed, 0 failed',
      stderr: '',
      timedOut: false,
    })
    const result = await runTests(DIR, 'gradle')
    expect(result.success).toBe(true)
    expect(result.testsPassed).toBe(10)
    expect(result.testsFailed).toBe(0)
  })

  it('retorna testsFailed quando gradle reporta falhas', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '5 tests completed, 2 failed',
      stderr: '',
      timedOut: false,
    })
    const result = await runTests(DIR, 'gradle')
    expect(result.success).toBe(false)
    expect(result.testsPassed).toBe(5)
    expect(result.testsFailed).toBe(2)
  })

  it('usa task "test" para gradle', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runTests(DIR, 'gradle')
    expect(runProcess).toHaveBeenCalledWith('gradle', expect.arrayContaining(['test']), expect.any(Object))
  })
})

// ─── runSourceBuild ───────────────────────────────────────────────────────────

describe('runSourceBuild — maven sucesso', () => {
  it('retorna success=true com sourceJdkHome', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '[INFO] BUILD SUCCESS', stderr: '', timedOut: false,
    })
    const result = await runSourceBuild(DIR, 'maven', { sourceJdkHome: '/usr/lib/jvm/java-8' })
    expect(result.success).toBe(true)
    expect(result.failureReason).toBeNull()
    // Verifica que JAVA_HOME foi setado
    const call = vi.mocked(runProcess).mock.calls[0]
    const opts = call[2] as { env?: NodeJS.ProcessEnv }
    expect(opts.env?.JAVA_HOME).toBe('/usr/lib/jvm/java-8')
  })

  it('usa mavenExecutable personalizado para source build', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runSourceBuild(DIR, 'maven', {
      sourceJdkHome: '/usr/lib/jvm/java-8',
      mavenExecutable: '/opt/mvn8/bin/mvn',
    })
    expect(runProcess).toHaveBeenCalledWith('/opt/mvn8/bin/mvn', expect.any(Array), expect.any(Object))
  })

  it('inclui -Dmaven.test.skip=true no source build', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: '', stderr: '', timedOut: false,
    })
    await runSourceBuild(DIR, 'maven', { sourceJdkHome: '/usr/lib/jvm/java-8' })
    expect(runProcess).toHaveBeenCalledWith('mvn', expect.arrayContaining(['-Dmaven.test.skip=true']), expect.any(Object))
  })
})

describe('runSourceBuild — timeout', () => {
  it('retorna failureReason=timeout', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: -1, stdout: '', stderr: '', timedOut: true,
    })
    const result = await runSourceBuild(DIR, 'maven', { sourceJdkHome: '/usr/lib/jvm/java-8' })
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('timeout')
  })
})

describe('runSourceBuild — command_not_found', () => {
  it('retorna failureReason=command_not_found quando stderr contém "não encontrado"', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: -1, stdout: '', stderr: 'mvn não encontrado', timedOut: false,
    })
    const result = await runSourceBuild(DIR, 'maven', { sourceJdkHome: '/usr/lib/jvm/java-8' })
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('command_not_found')
  })
})

describe('runSourceBuild — missing_artifact', () => {
  it('retorna failureReason=missing_artifact com artefatos detectados', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Could not resolve artifact com.corp:private-lib:jar:3.0.0',
      timedOut: false,
    })
    const result = await runSourceBuild(DIR, 'maven', { sourceJdkHome: '/usr/lib/jvm/java-8' })
    expect(result.failureReason).toBe('missing_artifact')
    expect(result.missingArtifacts).toContain('com.corp:private-lib:jar:3.0.0')
  })
})

describe('runSourceBuild — compilation failure', () => {
  it('retorna failureReason=compilation quando exitCode !== 0', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1, stdout: '', stderr: '[ERROR] Some compilation error', timedOut: false,
    })
    const result = await runSourceBuild(DIR, 'maven', { sourceJdkHome: '/usr/lib/jvm/java-8' })
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe('compilation')
  })
})

describe('runSourceBuild — gradle', () => {
  it('usa compileJava task para gradle', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0, stdout: 'BUILD SUCCESSFUL', stderr: '', timedOut: false,
    })
    await runSourceBuild(DIR, 'gradle', {
      sourceJdkHome: '/usr/lib/jvm/java-8',
      gradleExecutable: './gradlew',
    })
    expect(runProcess).toHaveBeenCalledWith('./gradlew', expect.arrayContaining(['compileJava']), expect.any(Object))
  })
})
