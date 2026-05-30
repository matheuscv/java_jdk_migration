import { runProcess } from '../lib/process-runner.js'

export interface BuildResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  failureReason: 'compilation' | 'tests' | 'timeout' | null
  testsPassed: number | null
  testsFailed: number | null
}

const BUILD_TIMEOUT_MS = 10 * 60_000  // 10 minutos

export async function runBuild(
  projectPath: string,
  buildSystem: 'maven' | 'gradle',
): Promise<BuildResult> {
  const [cmd, args] = buildSystem === 'maven'
    ? ['mvn', ['clean', 'compile', '-B', '-q', '-Dmaven.deploy.skip=true']]
    : ['gradle', ['compileJava', '-q']]

  const result = await runProcess(cmd, args, { cwd: projectPath, timeoutMs: BUILD_TIMEOUT_MS })

  if (result.timedOut) {
    return { success: false, exitCode: -1, stdout: result.stdout, stderr: result.stderr, failureReason: 'timeout', testsPassed: null, testsFailed: null }
  }

  const compilationFailed =
    result.exitCode !== 0 &&
    (result.stdout.includes('COMPILATION ERROR') ||
      result.stderr.includes('error:') ||
      result.stderr.includes('cannot find symbol'))

  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    failureReason: result.exitCode !== 0 ? (compilationFailed ? 'compilation' : 'tests') : null,
    testsPassed: null,
    testsFailed: null,
  }
}

export async function runTests(
  projectPath: string,
  buildSystem: 'maven' | 'gradle',
): Promise<BuildResult> {
  const [cmd, args] = buildSystem === 'maven'
    ? ['mvn', ['test', '-B', '-q', '-Dmaven.deploy.skip=true']]
    : ['gradle', ['test', '-q']]

  const result = await runProcess(cmd, args, { cwd: projectPath, timeoutMs: BUILD_TIMEOUT_MS })

  if (result.timedOut) {
    return { success: false, exitCode: -1, stdout: result.stdout, stderr: result.stderr, failureReason: 'timeout', testsPassed: null, testsFailed: null }
  }

  const { passed, failed } = parseTestCounts(result.stdout + result.stderr, buildSystem)

  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    failureReason: result.exitCode !== 0 ? 'tests' : null,
    testsPassed: passed,
    testsFailed: failed,
  }
}

function parseTestCounts(
  output: string,
  buildSystem: 'maven' | 'gradle',
): { passed: number | null; failed: number | null } {
  if (buildSystem === 'maven') {
    // "Tests run: 10, Failures: 0, Errors: 0"
    const match = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+)/)
    if (match) return { passed: parseInt(match[1]) - parseInt(match[2]), failed: parseInt(match[2]) }
  } else {
    // "10 tests completed, 0 failed"
    const match = output.match(/(\d+) tests? completed(?:, (\d+) failed)?/)
    if (match) return { passed: parseInt(match[1]), failed: match[2] ? parseInt(match[2]) : 0 }
  }
  return { passed: null, failed: null }
}
