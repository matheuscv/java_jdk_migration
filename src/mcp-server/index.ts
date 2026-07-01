#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer, createCloudMcpServer, type CloudServerOptions } from './create-server.js'
import { createHttpServer } from './http-transport.js'
import { createGitHubAppOctokit, createGitHubPatOctokit } from '../adapters/cloud/github-app-auth.js'
import { createGitHubApiGateway } from '../adapters/cloud/github-api-gateway.js'
import { createGraphNotifier } from '../adapters/cloud/graph-notifier.js'
import { createGitWorkspaceStorage } from '../adapters/cloud/git-workspace-storage.js'
import type { StorageFactory, ProjectPathResolver, RepoUrlProvider } from '../ports/storage.js'
import { resolveProjectPath } from '../lib/project-path-resolver.js'
import { createJobRunner } from '../orchestrator/async-job-runner.js'
import { MigrationError } from '../lib/errors.js'

/**
 * Seleção de transporte por variável de ambiente:
 *  - MCP_TRANSPORT=stdio (padrão) — modo local atual, inalterado
 *  - MCP_TRANSPORT=http           — modo remoto (Render), exige MCP_AUTH_TOKEN em produção
 *
 * Variáveis de ambiente para modo HTTP (todas configuradas no Render):
 *   MCP_AUTH_TOKEN          — Bearer token para autenticação do endpoint /mcp
 *   PORT                    — porta HTTP (default 3000; Render injeta automaticamente)
 *   GITHUB_APP_ID           — ID do GitHub App (ex: "123456")
 *   GITHUB_APP_PRIVATE_KEY  — PEM completo da private key do GitHub App
 *   GITHUB_APP_INSTALLATION_ID — ID da instalação do App (cobre todos os repos da org
 *                                incluídos na instalação — suporta múltiplos repositórios)
 *   GITHUB_PAT              — fallback de teste/POC (token pessoal); alternativa ao App.
 *                              Também suporta múltiplos repositórios, desde que o PAT
 *                              tenha acesso a todos eles.
 *   (GITHUB_OWNER/GITHUB_REPO NÃO são mais usados — o owner/repo vem do projectPath
 *    de cada chamada de tool, ex: discover_project({ projectPath: "acme/billing-service" }))
 *   Multi-tenant: cada chamada de discover_project/build_migration_plan pode enviar
 *    o parâmetro opcional "githubToken" com o PAT do próprio usuário, que passa a ter
 *    prioridade sobre GITHUB_PAT/GITHUB_APP_* — permite múltiplos usuários/squads
 *    usando a mesma instância do servidor, cada um só com acesso ao(s) repo(s) que
 *    seu token cobre. Sem githubToken na chamada, cai para a credencial fixa acima.
 *   MAVEN_LOCAL_REPO       — (opcional) path de um disco persistente montado no Render
 *                            para cache do repositório local do Maven entre chamadas
 *                            (ex: "/var/data/m2-repo"). Sem isso, cada discover_project/
 *                            execute_phase baixa as dependências do zero, o que facilmente
 *                            excede o timeout de requisição HTTP em projetos Spring Boot.
 *                            Requer plano pago do Render com disco persistente habilitado.
 *   GRADLE_USER_HOME       — (opcional) mesmo propósito acima, mas para Gradle — já é
 *                            respeitada nativamente pelo Gradle, sem necessidade de flag.
 *   GRAPH_TENANT_ID         — Tenant ID do Azure AD / Entra ID
 *   GRAPH_CLIENT_ID         — Client ID do app registrado no Azure AD
 *   GRAPH_CLIENT_SECRET     — Client secret do app Azure AD
 *   GRAPH_SENDER_USER_ID    — UPN da caixa remetente (ex: "migracoes@empresa.com")
 */
const transportMode = process.env.MCP_TRANSPORT ?? 'stdio'

if (transportMode === 'http') {
  const port = Number(process.env.PORT ?? 3000)
  const authToken = process.env.MCP_AUTH_TOKEN
  if (!authToken) {
    console.error('[jdk-migration] AVISO: MCP_AUTH_TOKEN não definido — endpoint /mcp ficará sem autenticação.')
  }

  const cloudOpts: CloudServerOptions = {}

  // ── GitHub App / PAT / token por usuário (multi-tenant) ────────────────────
  // repoUrlProvider constrói a URL autenticada POR owner/repo E por requisição —
  // prioriza o token que o PRÓPRIO USUÁRIO envia na chamada da tool (githubToken),
  // permitindo que múltiplos usuários usem a mesma instância do servidor, cada
  // um com acesso apenas ao(s) repositório(s) que seu token cobre. Sem token do
  // usuário, cai para a credencial fixa do servidor (App > PAT), mantendo
  // compatibilidade com o fluxo atual de um único operador/POC.
  //
  // GitWorkspaceStorage + GitHubApiGateway para execute_phase ainda requerem
  // construção por sessão de migração, o que exige refatoração adicional do
  // execute-phase.ts para injeção por requisição. Por ora, execute_phase usa
  // LocalFsStorage + LocalGitCli sobre o workspace clonado (comportamento
  // correto quando o projectPath aponta para o clone efêmero em /tmp).
  const ghAppId = process.env['GITHUB_APP_ID']
  const ghPrivateKey = process.env['GITHUB_APP_PRIVATE_KEY']
  const ghInstallationId = process.env['GITHUB_APP_INSTALLATION_ID']
  const ghPat = process.env['GITHUB_PAT']

  const appOctokit = (ghAppId && ghPrivateKey && ghInstallationId)
    ? createGitHubAppOctokit({
        appId: ghAppId,
        privateKey: ghPrivateKey.replace(/\\n/g, '\n'),
        installationId: ghInstallationId,
      })
    : null

  if (appOctokit) {
    console.error('[jdk-migration] GitHub App configurado — usado como fallback quando a chamada não traz githubToken próprio.')
  }
  if (ghPat) {
    console.error('[jdk-migration] GitHub PAT configurado — usado como fallback (teste/POC) quando a chamada não traz githubToken próprio.')
  }
  if (!appOctokit && !ghPat) {
    console.error('[jdk-migration] INFO: nenhuma credencial GitHub fixa configurada — cada chamada precisará enviar githubToken.')
  }

  // Nunca loga o valor do token (nem o do usuário, nem o fixo do servidor) —
  // apenas metadados (owner/repo, qual fonte de credencial foi usada).
  const repoUrlProvider: RepoUrlProvider = async (owner, repo, userToken) => {
    if (userToken) {
      void createGitHubApiGateway({ owner, repo, octokit: createGitHubPatOctokit(userToken) })
      console.error(`[jdk-migration] Usando githubToken enviado na chamada para ${owner}/${repo}.`)
      return `https://${userToken}@github.com/${owner}/${repo}.git`
    }
    if (appOctokit) {
      void createGitHubApiGateway({ owner, repo, octokit: appOctokit })
      const auth = await appOctokit.auth({ type: 'installation' }) as { token: string }
      return `https://x-access-token:${auth.token}@github.com/${owner}/${repo}.git`
    }
    if (ghPat) {
      void createGitHubApiGateway({ owner, repo, octokit: createGitHubPatOctokit(ghPat) })
      return `https://${ghPat}@github.com/${owner}/${repo}.git`
    }
    throw new MigrationError(
      'GITHUB_CREDENTIALS_MISSING',
      `Nenhuma credencial GitHub disponível para ${owner}/${repo}: a chamada não enviou githubToken ` +
        'e o servidor não tem GITHUB_PAT nem GITHUB_APP_* configurados.',
    )
  }

  // Sempre injetado (mesmo sem credencial fixa no servidor) — permite que um
  // usuário sem nenhuma env var configurada ainda assim opere só com seu
  // próprio githubToken por chamada.
  const projectPathResolver: ProjectPathResolver = (projectPath, userToken) =>
    resolveProjectPath(projectPath, repoUrlProvider, undefined, userToken)
  cloudOpts.projectPathResolver = projectPathResolver

  // StorageFactory: repoUrl já vem resolvida por requisição (por repositório).
  const storageFactory: StorageFactory = (repoUrl, workDir, branch) =>
    createGitWorkspaceStorage({ repoUrl, branch, workDir })
  cloudOpts.storageFactory = storageFactory

  // ── JobRunner (discover_project em background) ────────────────────────────
  // Instância ÚNICA por processo, criada aqui fora do serverFactory (que roda
  // por requisição HTTP) — precisa sobreviver entre a chamada que inicia o job
  // (discover_project) e as chamadas seguintes de polling (get_job_status).
  // Resolve o timeout de request HTTP/MCP em planos com pouca CPU/RAM (ex:
  // Render free tier) sem depender de upgrade de plano: a resposta do
  // discover_project volta imediatamente com um jobId, e o clone+build+análise
  // continuam rodando no mesmo processo Node em background.
  cloudOpts.jobRunner = createJobRunner()

  // ── Microsoft Graph (GraphNotifier) ───────────────────────────────────────
  const graphTenantId = process.env['GRAPH_TENANT_ID']
  const graphClientId = process.env['GRAPH_CLIENT_ID']
  const graphClientSecret = process.env['GRAPH_CLIENT_SECRET']
  const graphSenderUserId = process.env['GRAPH_SENDER_USER_ID']

  if (graphTenantId && graphClientId && graphClientSecret && graphSenderUserId) {
    cloudOpts.graphNotifier = createGraphNotifier({
      tenantId: graphTenantId,
      clientId: graphClientId,
      clientSecret: graphClientSecret,
      senderUserId: graphSenderUserId,
    })
    console.error('[jdk-migration] Microsoft Graph configurado — PINs serão enviados via Teams + e-mail.')
  } else {
    console.error('[jdk-migration] AVISO: env vars do Microsoft Graph ausentes — PINs armazenados mas NÃO enviados por Teams/e-mail.')
  }

  // GATE_BYPASS=true: auto-aprova gates sem PIN (POC sem Microsoft Graph configurado).
  // Remover esta env var no Render quando o Azure AD estiver disponível.
  const gateBypass = process.env['GATE_BYPASS'] === 'true'
  if (gateBypass) {
    console.error('[jdk-migration] ⚠️  GATE_BYPASS ativo — gates serão auto-aprovados SEM PIN. Remover em produção real.')
  }
  cloudOpts.gateBypass = gateBypass

  const httpServer = createHttpServer({ authToken, serverFactory: () => createCloudMcpServer(cloudOpts) })
  httpServer.listen(port, () => {
    console.error(`[jdk-migration] MCP server (HTTP) ouvindo na porta ${port}`)
  })
} else {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
