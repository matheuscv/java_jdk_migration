#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerDiscoverProject } from './tools/discover-project.js'
import { registerBuildMigrationPlan } from './tools/build-migration-plan.js'
import { registerExecutePhase } from './tools/execute-phase.js'
import { registerAuxiliaryTools } from './tools/auxiliary.js'
import { registerCheckDependencies } from './tools/check-dependencies.js'

const server = new McpServer({
  name: 'jdk-migration',
  version: '0.2.2',
})

registerDiscoverProject(server)
registerBuildMigrationPlan(server)
registerExecutePhase(server)
registerAuxiliaryTools(server)
registerCheckDependencies(server)

const transport = new StdioServerTransport()
await server.connect(transport)
