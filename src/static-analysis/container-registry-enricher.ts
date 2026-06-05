/**
 * Enriquece ContainerFindings com informações de registry Docker (Nexus 3 / Artifactory).
 *
 * Quando um finding tem requiresHumanDecision:true por ser uma imagem privada corporativa,
 * tenta localizar automaticamente a imagem equivalente para o targetJdk no registry.
 * Se encontrar, preenche suggestedReplacement e baixa requiresHumanDecision para false.
 */
import type { ContainerFinding } from './container-ci-scanner.js'
import type { ArtifactRegistry } from '../lib/config.js'

export interface EnrichedContainerFinding extends ContainerFinding {
  /** Imagem sugerida como substituta (ex: "nexus.corp/jre-java-21:1.0.1") */
  suggestedReplacement: string | null
  /** true = foi consultado o registry e a sugestão veio de lá */
  replacementFromRegistry: boolean
}

/** Resultado da busca de imagem no registry */
interface DockerImageInfo {
  name: string
  tag: string
  lastModified: string | null
}

// ─── parser de imagem ─────────────────────────────────────────────────────────

/**
 * Extrai host, nome e tag de uma referência de imagem Docker.
 * Ex: "nexus:50002/jre-java-8:0.0.3-cielo" → { host: "nexus:50002", name: "jre-java-8", tag: "0.0.3-cielo" }
 */
function parseImageRef(imageRef: string): { host: string | null; name: string; tag: string | null } {
  // Separa tag
  const atIdx = imageRef.lastIndexOf(':')
  const slashIdx = imageRef.lastIndexOf('/')
  let nameWithHost = imageRef
  let tag: string | null = null

  if (atIdx > slashIdx) {
    tag = imageRef.slice(atIdx + 1)
    nameWithHost = imageRef.slice(0, atIdx)
  }

  // Separa host (contém ponto ou porta)
  const parts = nameWithHost.split('/')
  let host: string | null = null
  let name = nameWithHost

  if (parts.length >= 2 && (parts[0].includes('.') || parts[0].includes(':'))) {
    host = parts[0]
    name = parts.slice(1).join('/')
  }

  return { host, name, tag }
}

/**
 * Tenta construir o nome da imagem JDK 21 a partir do nome da imagem atual.
 * Ex: "jre-java-8" → "jre-java-21"
 *     "openjdk8"   → "openjdk21"
 *     "java-8-jre" → "java-21-jre"
 */
function guessJdk21ImageName(imageName: string, sourceJdk: string, targetJdk: string): string {
  return imageName.replace(new RegExp(`(?<![0-9])${sourceJdk}(?![0-9])`, 'g'), targetJdk)
}

// ─── consulta Nexus 3 Docker repository ───────────────────────────────────────

async function fetchNexus3DockerImages(
  imageName: string,
  nexusBaseUrl: string,
): Promise<DockerImageInfo[]> {
  // Nexus 3: GET /service/rest/v1/search?repository=docker*&name=<name>&sort=version&direction=desc
  // Tentamos múltiplos repositórios possíveis (docker-release, docker, docker-hosted)
  const repoNames = ['docker-release', 'docker', 'docker-hosted', 'docker-internal']
  const results: DockerImageInfo[] = []

  for (const repo of repoNames) {
    try {
      const url = new URL('/service/rest/v1/search', nexusBaseUrl)
      url.searchParams.set('repository', repo)
      url.searchParams.set('name', imageName)
      url.searchParams.set('sort', 'version')
      url.searchParams.set('direction', 'desc')

      const resp = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })

      if (!resp.ok) continue

      const data = await resp.json() as { items?: Array<{ name: string; version: string; assets?: Array<{ lastModified?: string }> }> }
      for (const item of data.items ?? []) {
        if (!results.some(r => r.name === item.name && r.tag === item.version)) {
          results.push({
            name: item.name,
            tag: item.version,
            lastModified: item.assets?.[0]?.lastModified ?? null,
          })
        }
      }

      if (results.length > 0) break  // achou no primeiro repo — para
    } catch {
      // repo não existe ou timeout — continua tentando
    }
  }

  return results
}

async function fetchArtifactoryDockerImages(
  imageName: string,
  artifactoryBaseUrl: string,
): Promise<DockerImageInfo[]> {
  try {
    const url = new URL(`/artifactory/api/docker/docker/v2/${imageName}/tags/list`, artifactoryBaseUrl)
    const resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!resp.ok) return []
    const data = await resp.json() as { tags?: string[] }
    return (data.tags ?? []).map(tag => ({ name: imageName, tag, lastModified: null }))
  } catch {
    return []
  }
}

// ─── ponto de entrada ─────────────────────────────────────────────────────────

/**
 * Enriquece os findings de container/CI consultando o registry configurado.
 * Findings sem requiresHumanDecision não são alterados (não são imagens privadas).
 * Apenas findings com requiresHumanDecision:true tentam a consulta ao registry.
 */
export async function enrichContainerFindings(
  findings: ContainerFinding[],
  registry: ArtifactRegistry,
  targetJdk: string,
): Promise<EnrichedContainerFinding[]> {
  const results: EnrichedContainerFinding[] = []

  for (const finding of findings) {
    // Se não é imagem privada, passa sem enriquecimento
    if (!finding.requiresHumanDecision || !finding.detectedImage) {
      results.push({ ...finding, suggestedReplacement: null, replacementFromRegistry: false })
      continue
    }

    let suggestedReplacement: string | null = null
    let replacementFromRegistry = false

    try {
      const { host, name, tag } = parseImageRef(finding.detectedImage)
      const detectedVersion = finding.detectedJdkVersion ?? '8'
      const candidate21Name = guessJdk21ImageName(name, detectedVersion, targetJdk)

      // Só consulta se o nome do candidate é diferente do original (houve substituição)
      if (candidate21Name !== name) {
        const images = registry.type === 'nexus3'
          ? await fetchNexus3DockerImages(candidate21Name, registry.url)
          : await fetchArtifactoryDockerImages(candidate21Name, registry.url)

        if (images.length > 0) {
          // Pega a versão mais recente
          const latest = images[0]
          const imageHost = host ?? new URL(registry.url).host
          suggestedReplacement = `${imageHost}/${latest.name}:${latest.tag}`
          replacementFromRegistry = true
        }
      }
    } catch {
      // Falha silenciosa — não quebra o fluxo, apenas não enriquece
    }

    results.push({
      ...finding,
      suggestedReplacement,
      replacementFromRegistry,
      // Se encontrou substituto no registry, não é mais necessário intervenção humana
      requiresHumanDecision: suggestedReplacement === null,
      // Atualiza a sugestão de correção com a imagem encontrada
      suggestion: suggestedReplacement
        ? `Substitua '${finding.detectedImage}' por '${suggestedReplacement}' ` +
          `(encontrado automaticamente no registry ${registry.url}).`
        : finding.suggestion,
    })
  }

  return results
}
