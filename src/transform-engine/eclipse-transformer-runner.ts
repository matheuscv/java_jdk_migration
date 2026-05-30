import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../lib/process-runner.js'

const ET_VERSION = '0.5.0'
const ET_TIMEOUT_MS = 5 * 60_000

export interface EclipseTransformResult {
  inputJar: string
  outputJar: string
  success: boolean
  warnings: string[]
}

// Localiza o JAR do Eclipse Transformer em .jdk-migration/tools/
// ou tenta baixar via Maven.
export async function findOrDownloadEclipseTransformer(
  projectPath: string,
): Promise<string | null> {
  const localJar = join(projectPath, '.jdk-migration', 'tools', `eclipse-transformer-${ET_VERSION}.jar`)
  if (existsSync(localJar)) return localJar

  const toolsDir = join(projectPath, '.jdk-migration', 'tools')
  const downloadResult = await runProcess('mvn', [
    'dependency:copy',
    `-Dartifact=org.eclipse.transformer:org.eclipse.transformer.cli:${ET_VERSION}:jar:all`,
    `-DoutputDirectory=${toolsDir}`,
    '-q',
  ], { cwd: projectPath, timeoutMs: 5 * 60_000 })

  if (downloadResult.exitCode === 0 && existsSync(localJar)) return localJar

  return null
}

// Transforma um JAR individual: javax.* → jakarta.*
// Usado para dependências sem versão jakarta nativa (needsEclipseTransformer: true)
export async function transformJar(
  projectPath: string,
  inputPath: string,
  outputPath: string,
): Promise<EclipseTransformResult> {
  const jar = await findOrDownloadEclipseTransformer(projectPath)

  if (!jar) {
    return {
      inputJar: inputPath,
      outputJar: outputPath,
      success: false,
      warnings: [
        `Eclipse Transformer não encontrado. ` +
          `Coloque eclipse-transformer-${ET_VERSION}-all.jar em .jdk-migration/tools/.`,
      ],
    }
  }

  const result = await runProcess('java', ['-jar', jar, inputPath, outputPath], {
    cwd: projectPath,
    timeoutMs: ET_TIMEOUT_MS,
  })

  if (result.timedOut) {
    return { inputJar: inputPath, outputJar: outputPath, success: false, warnings: ['Eclipse Transformer timed out'] }
  }

  // Smoke test: verifica se o JAR resultante é válido
  if (result.exitCode === 0 && existsSync(outputPath)) {
    const smokeTest = await runProcess('java', ['-jar', outputPath, '--help'], {
      cwd: projectPath,
      timeoutMs: 10_000,
    })
    if (smokeTest.exitCode !== 0 && !smokeTest.stderr.includes('Usage')) {
      return {
        inputJar: inputPath, outputJar: outputPath, success: false,
        warnings: [`JAR transformado pode estar inválido — smoke test falhou: ${smokeTest.stderr.slice(0, 200)}`],
      }
    }
  }

  return {
    inputJar: inputPath,
    outputJar: outputPath,
    success: result.exitCode === 0,
    warnings: result.exitCode !== 0 ? [result.stderr.slice(0, 500)] : [],
  }
}
