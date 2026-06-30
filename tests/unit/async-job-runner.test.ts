import { describe, it, expect, vi } from 'vitest'
import { createJobRunner, createJobId } from '../../src/orchestrator/async-job-runner.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntilDone(getJob: (id: string) => { status: string } | null, jobId: string, intervalMs = 5) {
  // Mesmo padrão de consumo que a Squad usará via get_phase_status(jobId).
  while (true) {
    const job = getJob(jobId)
    if (job && job.status !== 'running') return job
    await sleep(intervalMs)
  }
}

describe('createJobId', () => {
  it('gera ids únicos com o prefixo job_', () => {
    const a = createJobId()
    const b = createJobId()
    expect(a).toMatch(/^job_[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })
})

describe('JobRunner — startJob retorna imediatamente (R3: não bloquear builds longos)', () => {
  it('startJob() resolve antes da tarefa terminar — status inicial é "running"', () => {
    const runner = createJobRunner()
    let taskResolved = false

    const record = runner.startJob('job_test_1', async () => {
      await sleep(50)
      taskResolved = true
      return { ok: true }
    })

    // Ponto-chave do R3: no instante em que startJob() retorna, a tarefa de
    // 50ms ainda não terminou — exatamente o comportamento que faltava para
    // execute_phase não travar o turno síncrono do MCP Connector num build de
    // 10-15 minutos.
    expect(record.status).toBe('running')
    expect(taskResolved).toBe(false)
  })

  it('getJob() reflete o progresso via polling até a tarefa concluir com sucesso', async () => {
    const runner = createJobRunner()
    runner.startJob('job_test_2', async () => {
      await sleep(30)
      return { phase: 3, filesChanged: 12 }
    })

    const finished = await pollUntilDone(runner.getJob.bind(runner), 'job_test_2')
    expect(finished.status).toBe('done')
  })

  it('job concluído com sucesso expõe o resultado e finishedAt', async () => {
    const runner = createJobRunner()
    runner.startJob('job_test_3', async () => ({ phase: 1, buildPassed: true }))

    await pollUntilDone(runner.getJob.bind(runner), 'job_test_3')
    const job = runner.getJob('job_test_3')

    expect(job?.status).toBe('done')
    expect(job?.result).toEqual({ phase: 1, buildPassed: true })
    expect(job?.finishedAt).not.toBeNull()
    expect(job?.error).toBeNull()
  })

  it('job que falha vira status "failed" com a mensagem de erro — não propaga exceção para o chamador', async () => {
    const runner = createJobRunner()
    const record = runner.startJob('job_test_4', async () => {
      throw new Error('mvn compile falhou: erro de sintaxe em BatchConfig.java')
    })

    // startJob não lança, mesmo a tarefa rejeitando — fire-and-forget genuíno.
    expect(record.status).toBe('running')

    const finished = await pollUntilDone(runner.getJob.bind(runner), 'job_test_4')
    expect(finished.status).toBe('failed')
    const job = runner.getJob('job_test_4')
    expect(job?.error).toContain('mvn compile falhou')
    expect(job?.result).toBeNull()
  })

  it('getJob() retorna null para um jobId desconhecido', () => {
    const runner = createJobRunner()
    expect(runner.getJob('job_nao_existe')).toBeNull()
  })

  it('startJob() é idempotente: jobId repetido não reinicia a tarefa', async () => {
    const runner = createJobRunner()
    const taskFn = vi.fn(async () => {
      await sleep(10)
      return 'primeira execução'
    })

    const first = runner.startJob('job_test_5', taskFn)
    const second = runner.startJob('job_test_5', taskFn) // simula retry da Squad

    expect(second).toBe(first) // mesmo objeto de registro, não uma nova tarefa
    expect(taskFn).toHaveBeenCalledTimes(1)
  })

  it('múltiplos jobs concorrentes não interferem entre si', async () => {
    const runner = createJobRunner()
    runner.startJob('job_a', async () => { await sleep(20); return 'A' })
    runner.startJob('job_b', async () => { await sleep(5); throw new Error('falha em B') })

    const doneB = await pollUntilDone(runner.getJob.bind(runner), 'job_b')
    expect(doneB.status).toBe('failed')

    // job_a ainda pode estar rodando neste ponto — não foi afetado pela falha de B.
    const doneA = await pollUntilDone(runner.getJob.bind(runner), 'job_a')
    expect(doneA.status).toBe('done')
    expect(runner.getJob('job_a')?.result).toBe('A')
  })
})
