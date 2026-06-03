import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readConfig, configExists } from '../../lib/config.js'
import { readPom } from '../../profilers/scanner.js'
import { MigrationError } from '../../lib/errors.js'

// Spring Boot 3.0 GA release date — used to infer if a version may support SB3
const SB3_RELEASE_DATE = new Date('2022-11-24')

export interface DependencyCheckResult {
  groupId: string
  artifactId: string
  currentVersion: string
  availableVersions: VersionInfo[]
  likelySb3Compatible: boolean
  recommendation: string
}

export interface VersionInfo {
  version: string
  publishedAt: string | null
  likelySb3Compatible: boolean
}

export interface CheckDependenciesResult {
  registryUrl: string
  registryType: string
  checkedAt: string
  dependencies: DependencyCheckResult[]
  summary: {
    total: number
    likelySb3Compatible: number
    noCompatibleVersionFound: number
    checkFailed: number
  }
}

export function registerCheckDependencies(server: McpServer): void {
  server.tool(
    'check_internal_dependencies',
    'Consulta o registry de artefatos interno (Nexus 3 / Artifactory) para verificar quais dependências internas possuem versões compatíveis com Spring Boot 3. Requer artifactRegistry configurado no jdk-migration.config.json.',
    {
      projectPath: z.string().describe('Caminho absoluto da raiz do projeto Java'),
    },
    async ({ projectPath }) => {
      if (!configExists(projectPath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'CONFIG_NOT_FOUND',
              message: 'jdk-migration.config.json não encontrado. Execute discover_project primeiro.',
            }, null, 2),
          }],
          isError: true,
        }
      }

      const config = readConfig(projectPath)
      const registry = config.artifactRegistry

      if (!registry || registry.type === 'none' || !registry.url) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'REGISTRY_NOT_CONFIGURED',
              message:
                'artifactRegistry não está configurado em jdk-migration.config.json. ' +
                'Adicione o campo com type ("nexus3" | "artifactory"), url e internalGroupIds.',
              example: {
                artifactRegistry: {
                  type: 'nexus3',
                  url: 'https://nexus.mycompany.com',
                  internalGroupIds: ['com.mycompany', 'com.mycompany.platform'],
                },
              },
            }, null, 2),
          }],
          isError: true,
        }
      }

      if (registry.internalGroupIds.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'NO_GROUP_IDS',
              message: 'internalGroupIds está vazio. Adicione os prefixos de groupId das dependências internas a verificar.',
            }, null, 2),
          }],
          isError: true,
        }
      }

      // Parse pom.xml for internal dependencies
      const pom = readPom(projectPath)
      const internalDeps = extractInternalDependencies(pom, registry.internalGroupIds)

      if (internalDeps.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              registryUrl: registry.url,
              registryType: registry.type,
              checkedAt: new Date().toISOString(),
              message: 'Nenhuma dependência interna encontrada no pom.xml para os groupIds configurados.',
              configuredGroupIds: registry.internalGroupIds,
              dependencies: [],
              summary: { total: 0, likelySb3Compatible: 0, noCompatibleVersionFound: 0, checkFailed: 0 },
            }, null, 2),
          }],
        }
      }

      // Query registry for each dependency
      const results: DependencyCheckResult[] = []
      for (const dep of internalDeps) {
        const result = await checkDependencyInRegistry(dep, registry.url, registry.type)
        results.push(result)
      }

      const summary = {
        total: results.length,
        likelySb3Compatible: results.filter(r => r.likelySb3Compatible).length,
        noCompatibleVersionFound: results.filter(r => !r.likelySb3Compatible && r.availableVersions.length > 0).length,
        checkFailed: results.filter(r => r.availableVersions.length === 0 && !r.likelySb3Compatible).length,
      }

      const output: CheckDependenciesResult = {
        registryUrl: registry.url,
        registryType: registry.type,
        checkedAt: new Date().toISOString(),
        dependencies: results,
        summary,
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(output, null, 2),
        }],
      }
    },
  )
}

// ─── internal helpers ─────────────────────────────────────────────────────────

interface InternalDep {
  groupId: string
  artifactId: string
  currentVersion: string
}

function extractInternalDependencies(pom: string, groupIdPrefixes: string[]): InternalDep[] {
  const deps: InternalDep[] = []
  // Match <dependency> blocks
  const depBlocks = pom.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []

  for (const block of depBlocks) {
    const groupId = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim() ?? ''
    const artifactId = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() ?? ''
    const version = block.match(/<version>([^<]+)<\/version>/)?.[1]?.trim() ?? ''

    if (!groupId || !artifactId) continue
    if (!groupIdPrefixes.some(prefix => groupId === prefix || groupId.startsWith(prefix + '.'))) continue
    // Skip internal modules (they reference project.version or global.version)
    if (!version || version.startsWith('${')) continue

    // Deduplicate
    if (!deps.some(d => d.groupId === groupId && d.artifactId === artifactId)) {
      deps.push({ groupId, artifactId, currentVersion: version })
    }
  }

  // Also check dependencyManagement
  const mgmtBlocks = pom.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/)?.[0] ?? ''
  const mgmtDepBlocks = mgmtBlocks.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []

  for (const block of mgmtDepBlocks) {
    const groupId = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim() ?? ''
    const artifactId = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() ?? ''
    const version = block.match(/<version>([^<]+)<\/version>/)?.[1]?.trim() ?? ''

    if (!groupId || !artifactId) continue
    if (!groupIdPrefixes.some(prefix => groupId === prefix || groupId.startsWith(prefix + '.'))) continue
    if (!version || version.startsWith('${')) continue
    if (!deps.some(d => d.groupId === groupId && d.artifactId === artifactId)) {
      deps.push({ groupId, artifactId, currentVersion: version })
    }
  }

  return deps
}

async function checkDependencyInRegistry(
  dep: InternalDep,
  registryUrl: string,
  registryType: string,
): Promise<DependencyCheckResult> {
  try {
    const versions = registryType === 'nexus3'
      ? await fetchNexus3Versions(dep.groupId, dep.artifactId, registryUrl)
      : await fetchArtifactoryVersions(dep.groupId, dep.artifactId, registryUrl)

    if (versions.length === 0) {
      return {
        groupId: dep.groupId,
        artifactId: dep.artifactId,
        currentVersion: dep.currentVersion,
        availableVersions: [],
        likelySb3Compatible: false,
        recommendation: `Nenhuma versão encontrada no registry para ${dep.groupId}:${dep.artifactId}. Verificar manualmente.`,
      }
    }

    // A version is likely SB3-compatible if published after SB3 GA (Nov 2022)
    const sb3Candidates = versions.filter(v => {
      if (!v.publishedAt) return false
      return new Date(v.publishedAt) > SB3_RELEASE_DATE
    })

    const latestSb3 = sb3Candidates[0] ?? null
    const likelySb3Compatible = sb3Candidates.length > 0

    const recommendation = likelySb3Compatible
      ? `Versão ${latestSb3!.version} publicada em ${latestSb3!.publishedAt} (após Spring Boot 3 GA). ` +
        `Atualizar de ${dep.currentVersion} → ${latestSb3!.version} e validar compatibilidade em runtime.`
      : `Nenhuma versão publicada após o Spring Boot 3 GA (Nov 2022). ` +
        `Atual: ${dep.currentVersion}. ` +
        `Avaliar fork interno, exclusão temporária ou migração para alternativa open source.`

    return {
      groupId: dep.groupId,
      artifactId: dep.artifactId,
      currentVersion: dep.currentVersion,
      availableVersions: versions.slice(0, 10),  // top 10 most recent
      likelySb3Compatible,
      recommendation,
    }
  } catch (err) {
    return {
      groupId: dep.groupId,
      artifactId: dep.artifactId,
      currentVersion: dep.currentVersion,
      availableVersions: [],
      likelySb3Compatible: false,
      recommendation: `Falha ao consultar registry: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function fetchNexus3Versions(
  groupId: string,
  artifactId: string,
  baseUrl: string,
): Promise<VersionInfo[]> {
  // Nexus 3 REST API: GET /service/rest/v1/search?group=...&name=...&sort=version&direction=desc
  const url = new URL('/service/rest/v1/search', baseUrl)
  url.searchParams.set('group', groupId)
  url.searchParams.set('name', artifactId)
  url.searchParams.set('sort', 'version')
  url.searchParams.set('direction', 'desc')

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`Nexus 3 retornou HTTP ${response.status} para ${groupId}:${artifactId}`)
  }

  const data = await response.json() as { items?: Array<{ version?: string; assets?: Array<{ lastModified?: string }> }> }
  const items = data.items ?? []

  return items.map(item => {
    const lastModified = item.assets?.[0]?.lastModified ?? null
    return {
      version: item.version ?? 'unknown',
      publishedAt: lastModified ?? null,
      likelySb3Compatible: lastModified ? new Date(lastModified) > SB3_RELEASE_DATE : false,
    }
  })
}

async function fetchArtifactoryVersions(
  groupId: string,
  artifactId: string,
  baseUrl: string,
): Promise<VersionInfo[]> {
  // Artifactory REST API: GET /artifactory/api/search/gavc?g=...&a=...
  const url = new URL('/artifactory/api/search/gavc', baseUrl)
  url.searchParams.set('g', groupId)
  url.searchParams.set('a', artifactId)

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`Artifactory retornou HTTP ${response.status} para ${groupId}:${artifactId}`)
  }

  const data = await response.json() as { results?: Array<{ uri?: string; created?: string }> }
  const results = data.results ?? []

  // Extract versions from URIs like .../artifactId/1.2.3/artifactId-1.2.3.jar
  const versionMap = new Map<string, string>()
  for (const r of results) {
    const uri = r.uri ?? ''
    const versionMatch = uri.match(new RegExp(`/${artifactId}/([^/]+)/`))
    if (versionMatch) {
      const ver = versionMatch[1]
      if (!versionMap.has(ver) || (r.created && r.created > (versionMap.get(ver) ?? ''))) {
        versionMap.set(ver, r.created ?? '')
      }
    }
  }

  return [...versionMap.entries()]
    .sort(([, a], [, b]) => b.localeCompare(a))
    .map(([version, created]) => ({
      version,
      publishedAt: created || null,
      likelySb3Compatible: created ? new Date(created) > SB3_RELEASE_DATE : false,
    }))
}
