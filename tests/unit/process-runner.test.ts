import { describe, it, expect } from 'vitest'
import { runProcess } from '../../src/lib/process-runner.js'

// process.execPath garante o binário Node correto em qualquer OS
const node = process.execPath
const cwd = process.cwd()

describe('runProcess', () => {
  it('captura stdout e retorna exitCode 0', async () => {
    const result = await runProcess(node, ['-e', 'process.stdout.write("ola")'], { cwd })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('ola')
    expect(result.timedOut).toBe(false)
  })

  it('captura stderr', async () => {
    const result = await runProcess(node, ['-e', 'process.stderr.write("erro")'], { cwd })
    expect(result.stderr).toBe('erro')
  })

  it('retorna exitCode não-zero em falha', async () => {
    const result = await runProcess(node, ['-e', 'process.exit(42)'], { cwd })
    expect(result.exitCode).toBe(42)
    expect(result.timedOut).toBe(false)
  })

  it('respeita timeout e sinaliza timedOut', async () => {
    const result = await runProcess(
      node,
      ['-e', 'setTimeout(()=>{},10000)'],
      { cwd, timeoutMs: 200 },
    )
    expect(result.timedOut).toBe(true)
  }, 3000)

  it('executa comandos com múltiplas flags sem intermediar shell', async () => {
    // passa --version como arg separado: se usasse shell como string, quebraria
    const result = await runProcess(node, ['--version'], { cwd })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^v\d+\.\d+/)
  })

  it('usa env customizado quando fornecido', async () => {
    const result = await runProcess(
      node,
      ['-e', 'process.stdout.write(process.env.TEST_VAR ?? "nao_definido")'],
      { cwd, env: { ...process.env, TEST_VAR: 'valor_teste' } },
    )
    expect(result.stdout).toBe('valor_teste')
  })
})
