import { spawn } from 'node:child_process'

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 300_000
    let timedOut = false

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      // sem shell: true — args nunca passam por interpretador de shell
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    // Captura ENOENT e outros erros de spawn (comando não encontrado)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr: err.message, timedOut: false })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}
