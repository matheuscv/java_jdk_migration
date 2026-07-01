/**
 * Flag extra do Maven para usar um repositório local persistente entre chamadas,
 * quando MAVEN_LOCAL_REPO estiver configurada (ex: disco persistente montado no
 * Render — "/var/data/m2-repo"). Sem essa env var, mvn usa o padrão (~/.m2/repository),
 * que é recriado do zero a cada clone efêmero, tornando a primeira execução lenta
 * o suficiente para estourar timeouts de requisição HTTP.
 *
 * Gradle não precisa de flag equivalente: já respeita nativamente a env var
 * GRADLE_USER_HOME, herdada automaticamente pelos processos filhos via process.env.
 */
export function mavenLocalRepoArgs(): string[] {
  const localRepo = process.env['MAVEN_LOCAL_REPO']
  return localRepo ? [`-Dmaven.repo.local=${localRepo}`] : []
}
