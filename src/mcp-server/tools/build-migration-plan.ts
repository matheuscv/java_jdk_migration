import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export function registerBuildMigrationPlan(server: McpServer): void {
  server.registerTool(
    'build_migration_plan',
    {
      title: 'Build Migration Plan',
      description:
        'Consolida o relatório de diagnóstico em um plano de migração faseado, ' +
        'classificado por criticidade, com gates de aprovação definidos. ' +
        'Requer que discover_project tenha sido executado antes.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
      },
    },
    async ({ projectPath }) => {
      // TODO (Etapa 6): implementar PhasePlanner + ProfilerRegistry
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'not_implemented',
                module: 'build_migration_plan',
                projectPath,
                message:
                  'Módulo em scaffolding. Implementação completa na Etapa 6 (Stacks legadas).',
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
