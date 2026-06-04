import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * No Windows, Node.js não resolve arquivos .cmd/.bat sem shell:true.
 * Esta função procura o wrapper .cmd no PATH para comandos sem extensão,
 * evitando shell:true (que quebraria args com aspas via cmd.exe).
 */
function resolveWindowsCmd(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return command
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command
  if (/\.(cmd|bat|exe|com)$/i.test(command)) return command

  const pathDirs = (env.PATH ?? '').split(';')
  for (const dir of pathDirs) {
    const candidate = join(dir, command + '.cmd')
    if (existsSync(candidate)) return candidate
  }
  return command
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 300_000
    let timedOut = false
    const env = options.env ?? process.env
    const resolvedCommand = resolveWindowsCmd(command, env)

    const child = spawn(resolvedCommand, args, {
      cwd: options.cwd,
      env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const isEnoent = err.code === 'ENOENT'
      const detail = isEnoent
        ? `Comando '${command}' não encontrado. Verifique se está instalado e no PATH. ` +
          `No Windows, certifique-se que o diretório bin (ex: apache-maven/bin) está no PATH do MCP server (env em ~/.claude.json).`
        : err.message
      resolve({ exitCode: -1, stdout, stderr: detail, timedOut: false })
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
