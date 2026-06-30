import { randomBytes } from 'node:crypto'

export type JobStatus = 'running' | 'done' | 'failed'

export interface JobRecord<T = unknown> {
  jobId: string
  status: JobStatus
  startedAt: string
  finishedAt: string | null
  result: T | null
  error: string | null
}

export interface JobRunner {
  /**
   * Inicia uma tarefa em background e retorna IMEDIATAMENTE — sem esperar a
   * tarefa terminar. Resolve R3 (builds longos do execute_phase estourando o
   * timeout síncrono do MCP Connector): em vez de bloquear a chamada por 10-15
   * min de Maven/OpenRewrite, o chamador recebe um jobId na hora e consulta o
   * progresso via getJob() — mesmo padrão que get_phase_status vai expor.
   *
   * Idempotente: se jobId já existe, retorna o registro existente sem reiniciar
   * a tarefa (proteção contra retry duplicado da Squad).
   */
  startJob<T>(jobId: string, task: () => Promise<T>): JobRecord<T>
  getJob(jobId: string): JobRecord | null
}

/** Gera um jobId único e legível, ex: job_8f2a1c9b4e3d7a6f */
export function createJobId(): string {
  return `job_${randomBytes(8).toString('hex')}`
}

export function createJobRunner(): JobRunner {
  const jobs = new Map<string, JobRecord>()

  return {
    startJob<T>(jobId: string, task: () => Promise<T>): JobRecord<T> {
      const existing = jobs.get(jobId)
      if (existing) return existing as JobRecord<T>

      const record: JobRecord<T> = {
        jobId,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      }
      jobs.set(jobId, record as JobRecord)

      // Fire-and-forget deliberado: não fazemos `await` aqui. startJob() retorna
      // antes da tarefa terminar; o estado é atualizado in-place quando resolve.
      void task()
        .then((result) => {
          record.status = 'done'
          record.result = result
          record.finishedAt = new Date().toISOString()
        })
        .catch((err: unknown) => {
          record.status = 'failed'
          record.error = err instanceof Error ? err.message : String(err)
          record.finishedAt = new Date().toISOString()
        })

      return record
    },

    getJob(jobId: string): JobRecord | null {
      return jobs.get(jobId) ?? null
    },
  }
}
