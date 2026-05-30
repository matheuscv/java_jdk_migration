import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

export interface ScanHit {
  file: string   // caminho relativo ao projectPath
  line: number
  content: string
}

// Vasculha recursivamente todos os arquivos .java abaixo de src/ (main e test)
export function findJavaFiles(projectPath: string): string[] {
  return findByExt(join(projectPath, 'src'), '.java')
}

// Vasculha apenas src/main/java (sem testes)
export function findMainJavaFiles(projectPath: string): string[] {
  return findByExt(join(projectPath, 'src', 'main', 'java'), '.java')
}

// Vasculha recursivamente todos os arquivos .xml abaixo de src/
export function findXmlFiles(projectPath: string): string[] {
  return findByExt(join(projectPath, 'src'), '.xml')
}

// Vasculha arquivos .properties e .yml / .yaml abaixo de src/main/resources/
export function findPropertyFiles(projectPath: string): string[] {
  const resourcesDir = join(projectPath, 'src', 'main', 'resources')
  return [
    ...findByExt(resourcesDir, '.properties'),
    ...findByExt(resourcesDir, '.yml'),
    ...findByExt(resourcesDir, '.yaml'),
  ]
}

// Retorna todos os hits de um padrão num conjunto de arquivos
export function scanFiles(
  files: string[],
  projectPath: string,
  pattern: RegExp,
): ScanHit[] {
  const hits: ScanHit[] = []
  for (const file of files) {
    try {
      const lines = readFileSync(file, 'utf-8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          hits.push({
            file: relative(projectPath, file),
            line: i + 1,
            content: lines[i].trim(),
          })
        }
      }
    } catch { /* ignora arquivos ilegíveis */ }
  }
  return hits
}

// Lê pom.xml como string (retorna '' se não existir)
export function readPom(projectPath: string): string {
  const pomPath = join(projectPath, 'pom.xml')
  return existsSync(pomPath) ? readFileSync(pomPath, 'utf-8') : ''
}

// Extrai versão de uma dependência no pom.xml
// ex: extractPomVersion(pom, 'spring-batch-core') → '4.3.9'
export function extractPomVersion(pom: string, artifactId: string): string | null {
  const pattern = new RegExp(
    `<artifactId>${artifactId}<\\/artifactId>[\\s\\S]*?<version>([^<]+)<\\/version>`,
    'i',
  )
  return pom.match(pattern)?.[1] ?? null
}

// Verifica se uma dependência existe no pom.xml
export function hasPomDependency(pom: string, artifactId: string): boolean {
  return new RegExp(`<artifactId>${artifactId}<\/artifactId>`).test(pom)
}

// ─── utilitário interno ────────────────────────────────────────────────────

function findByExt(dir: string, ext: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) results.push(...findByExt(full, ext))
        else if (extname(full).toLowerCase() === ext) results.push(full)
      } catch { /* ignora */ }
    }
  } catch { /* ignora */ }
  return results
}
