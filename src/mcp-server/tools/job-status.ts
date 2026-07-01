import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { JobRunner } from '../../orchestrator/async-job-runner.js'

export interface JobStatusAdapters {
  jobRunner?: JobRunner
}

/**
 * Registra get_job_status — companheira de discover_project (e futuramente
 * outras tools) quando rodam em background via JobRunner (modo cloud).
 *
 * Só é registrada quando jobRunner está presente (modo cloud com HTTP). Em
 * modo local/stdio, discover_project roda de forma síncrona e esta tool não
 * existe — não há jobId para consultar.
 *
 * Estado do JobRunner é em memória, por processo: se a instância do servidor
 * reiniciar (deploy, crash, restart do Render) antes do job terminar, o jobId
 * antigo deixa de existir — é preciso chamar discover_project novamente.
 */
export function registerGetJobStatus(server: McpServer, adapters?: JobStatusAdapters): void {
  if (!adapters?.jobRunner) return

  server.registerTool(
    'get_job_status',
    {
      title: 'Get Job Status',
      description:
        'Consulta o progresso de uma tarefa iniciada em background (ex: discover_project ' +
        'quando retorna { status: "running", jobId }). Status possíveis: "running" (ainda ' +
        'em andamento — aguarde e consulte novamente), "done" (concluído — resultado em ' +
        '"result") ou "failed" (erro — mensagem em "error"). Faça polling a cada ' +
        '10-20 segundos até status sair de "running".',
      inputSchema: {
        jobId: z.string().describe('jobId retornado pela tool que iniciou a tarefa em background'),
      },
    },
    ({ jobId }) => {
      const job = adapters.jobRunner!.getJob(jobId)
      if (!job) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'JOB_NOT_FOUND',
              message:
                `Nenhum job encontrado com id "${jobId}". Ou o id está incorreto, ou o ` +
                'servidor reiniciou desde que o job foi iniciado (estado em memória se perde ' +
                'em restarts) — chame a tool original novamente para reiniciar a tarefa.',
            }, null, 2),
          }],
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(job, null, 2) }],
      }
    },
  )
}
