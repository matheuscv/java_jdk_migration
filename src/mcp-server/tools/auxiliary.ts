import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readConfig, writeConfig, configExists, readPinStore, writePinStore, deletePinEntry } from '../../lib/config.js'
import type { MigrationStep } from '../../lib/config.js'
import { MigrationError } from '../../lib/errors.js'
import { generateGateToken, getTokenIssuedAt } from '../../orchestrator/gate-validator.js'
import { rollbackPhase, syncMigrationBranch } from '../../orchestrator/git-checkpoint.js'
import { updatePhaseStatus } from '../../orchestrator/state-machine.js'
import { generateAuditReport, generateAuditReportSilent, generateFinalReport } from '../../report-generator/index.js'
import { runMigrationAudit } from '../../static-analysis/migration-audit.js'
import { computePhaseRoi } from '../../roi-tracker/index.js'
import type { PhaseNumber } from '../../types.js'
import { randomInt } from 'node:crypto'

// Nomes que identificam sistemas automatizados — bloqueados em approve_gate
const FORBIDDEN_APPROVER_NAMES = new Set([
  'bot', 'automation', 'ci', 'cd', 'system', 'auto',
  'claude', 'claude code', 'assistant', 'ai', 'agent', 'robot',
  'openai', 'anthropic', 'gpt', 'llm', 'copilot',
])

const PIN_VALIDITY_MS = 30 * 60 * 1000 // 30 minutos

export function registerAuxiliaryTools(server: McpServer): void {
  server.registerTool(
    'get_phase_status',
    {
      title: 'Get Phase Status',
      description:
        'Retorna o status atual de todas as 6 fases de migração do projeto, ' +
        'incluindo tokens de gate, datas de aprovação e branches Git associadas.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
      },
    },
    async ({ projectPath }) => {
      if (!configExists(projectPath)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'not_initialized',
                  projectPath,
                  message:
                    'jdk-migration.config.json não encontrado. Execute a Skill de instalação primeiro.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      const config = readConfig(projectPath)
      const phaseSummary = (Object.entries(config.phases) as [string, (typeof config.phases)[PhaseNumber]][]).map(
        ([num, phase]) => ({
          phase: Number(num),
          status: phase.status,
          approvedBy: phase.approvedBy,
          approvedAt: phase.approvedAt,
          executedAt: phase.executedAt,
          gitBranch: phase.gitBranch,
          gitCommit: phase.gitCommit,
          hasGateToken: phase.gateToken !== null,
        }),
      )

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projectPath,
                sourceJdk: config.sourceJdk,
                targetJdk: config.targetJdk,
                stack: config.stack,
                buildSystem: config.buildSystem,
                phases: phaseSummary,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.registerTool(
    'request_gate_approval',
    {
      title: 'Request Gate Approval',
      description:
        'Solicita a aprovação humana para uma fase. Gera um PIN de 6 dígitos que é ' +
        'exibido ao responsável técnico. O PIN deve ser informado de volta pelo humano ' +
        'na chamada de approve_gate. SEMPRE chame esta tool ANTES de approve_gate e ' +
        'AGUARDE o humano fornecer o PIN — nunca tente adivinhar ou reutilizar PINs anteriores. ' +
        'IMPORTANTE — fase 0: se o retorno incluir o campo pendingHumanDecisions, você DEVE ' +
        'apresentar CADA pergunta listada ao usuário e registrar as respostas ANTES de revelar ' +
        'o PIN. Só mostre o PIN após coletar todas as respostas ou após o usuário decidir ' +
        'explicitamente seguir sem respondê-las.',
      inputSchema: {
        projectPath: z.string().describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z.number().int().min(0).max(5).describe('Número da fase a aprovar (0–5)'),
      },
    },
    async ({ projectPath, phaseNumber }) => {
      const config = readConfig(projectPath)
      const phase = phaseNumber as PhaseNumber
      const phaseState = config.phases[phase]

      if (phaseState.status !== 'awaiting_gate') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} está com status '${phaseState.status}'. ` +
                `Só é possível solicitar aprovação de fases no estado awaiting_gate.`,
            }, null, 2),
          }],
        }
      }

      const pin = String(randomInt(100000, 999999))
      const expiresAt = new Date(Date.now() + PIN_VALIDITY_MS).toISOString()

      // Salva o PIN em disco — Claude não tem acesso a este arquivo
      const pinStore = readPinStore(projectPath)
      pinStore[phase] = { pin, expiresAt, phaseNumber: phase }
      writePinStore(projectPath, pinStore)

      // ── Fase 0: coletar perguntas abertas com requiresHumanDecision ───────────
      // Lê o plano de migração para identificar todos os itens que precisam de
      // informação humana antes que as fases seguintes possam executar com sucesso.
      // O campo pendingHumanDecisions instrui o agente a apresentar cada pergunta
      // ao usuário ANTES de revelar o PIN (ver description da tool).
      let pendingHumanDecisions: Array<{
        id: string
        phase: number
        category: string
        title: string
        question: string
        files: string[]
        blocking: boolean  // true = bloqueia execução da fase sem resposta
      }> | undefined

      if (phase === 0) {
        const migDir = join(projectPath, '.jdk-migration')
        const planPath = join(migDir, 'migration-plan.json')
        const discoveryPath = join(migDir, 'discovery-report.json')

        try {
          const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf-8')) : null
          const discovery = existsSync(discoveryPath) ? JSON.parse(readFileSync(discoveryPath, 'utf-8')) : null

          const decisions: typeof pendingHumanDecisions = []

          // 1. ManualReviewItems com requiresHumanDecision de todas as fases do plano
          if (plan?.phases) {
            for (const phasePlan of plan.phases) {
              for (const item of (phasePlan.manualItems ?? [])) {
                if (!item.requiresHumanDecision) continue
                decisions.push({
                  id: item.id,
                  phase: phasePlan.number,
                  category: item.category ?? 'infrastructure',
                  title: item.title,
                  question: item.suggestedApproach
                    ? `${item.description} — ${item.suggestedApproach}`
                    : item.description,
                  files: item.files ?? [],
                  blocking: phasePlan.number <= 1,
                })
              }
            }
          }

          // 2. ContainerCi findings com requiresHumanDecision (imagens privadas)
          const containerFindings: any[] = discovery?.containerCi?.findings ?? []
          for (const f of containerFindings) {
            if (!f.requiresHumanDecision) continue
            const alreadyAdded = decisions.some(d => d.files.includes(f.file))
            if (alreadyAdded) continue
            decisions.push({
              id: `container-ci-${f.fileType}-${f.line}`,
              phase: 1,
              category: 'infrastructure',
              title: `Atualizar imagem JDK em ${f.file}`,
              question: `${f.description} ${f.suggestion}`,
              files: [f.file],
              blocking: true,
            })
          }

          if (decisions.length > 0) pendingHumanDecisions = decisions
        } catch { /* plano ainda não gerado — não bloqueia */ }
      }

      // ── Gate 1: perguntas após Fase 1 (Infrastructure) ──────────────────────
      // A4: dependências internas não validadas
      // C6: --add-opens presentes que precisam de revisão humana
      // D4: Maven profiles neutralizados que precisam de confirmação
      // Infra: arquivos com Helm templates não editáveis automaticamente
      if (phase === 1) {
        try {
          const decisions: typeof pendingHumanDecisions = []
          const phase1Details = (config.phases[1] as any)?.runnerDetails?.['infrastructure-transformer'] as any

          // A4 — dependências internas: varre pom.xml em busca de groupIds não-públicos
          const pomContent = existsSync(join(projectPath, 'pom.xml'))
            ? readFileSync(join(projectPath, 'pom.xml'), 'utf-8') : null
          if (pomContent) {
            const KNOWN_PUBLIC = ['org.springframework', 'org.hibernate', 'org.apache', 'com.fasterxml',
              'io.micrometer', 'io.netty', 'io.projectreactor', 'jakarta.', 'javax.', 'com.google',
              'org.slf4j', 'ch.qos.logback', 'org.junit', 'junit', 'org.mockito', 'org.assertj',
              'com.h2database', 'org.liquibase', 'org.flywaydb', 'mysql', 'org.postgresql',
              'com.oracle', 'com.zaxxer', 'io.swagger', 'org.springdoc', 'org.mapstruct',
              'org.projectlombok', 'org.quartz-scheduler', 'org.ehcache', 'net.sf.ehcache',
              'com.github.ben-manes', 'org.testcontainers', 'org.jacoco', 'io.cucumber',
              'com.amazonaws', 'software.amazon', 'io.awspring', 'org.redisson', 'redis.clients',
              'org.apache.kafka', 'io.confluent', 'org.springframework.kafka']
            const depRe = /<groupId>([\w.\-]+)<\/groupId>/g
            const internalGroupIds = new Set<string>()
            let dm: RegExpExecArray | null
            // eslint-disable-next-line no-cond-assign
            while ((dm = depRe.exec(pomContent)) !== null) {
              const g = dm[1]
              if (!KNOWN_PUBLIC.some(p => g.startsWith(p))) internalGroupIds.add(g)
            }
            if (internalGroupIds.size > 0) {
              const list = [...internalGroupIds].slice(0, 8).join(', ')
              decisions.push({
                id: 'A4-internal-deps',
                phase: 1,
                category: 'dependencies',
                title: 'Dependências internas / groupIds não validados para JDK 21',
                question: `Foram encontradas dependências de groupId(s) não-público(s): ${list}. ` +
                  `Confirme com o time responsável por cada lib que elas foram testadas e funcionam corretamente com JDK 21. ` +
                  `Dependências não validadas podem causar ClassFormatError ou NoSuchMethodError em runtime.`,
                files: ['pom.xml'],
                blocking: false,
              })
            }
          }

          // C6 — --add-opens presentes: exige revisão se ainda são necessários
          const addOpensSources = [
            join(projectPath, '.mvn', 'jvm.config'),
            join(projectPath, 'pom.xml'),
          ]
          const addOpensFiles: string[] = []
          for (const src of addOpensSources) {
            const content = existsSync(src) ? readFileSync(src, 'utf-8') : null
            if (content && /--add-opens|--add-exports/.test(content)) {
              addOpensFiles.push(join(projectPath, '.mvn', 'jvm.config') === src ? '.mvn/jvm.config' : 'pom.xml')
            }
          }
          if (addOpensFiles.length > 0) {
            decisions.push({
              id: 'C6-add-opens',
              phase: 1,
              category: 'jvm-flags',
              title: 'Flags --add-opens / --add-exports presentes',
              question: `Os arquivos ${addOpensFiles.join(', ')} contêm flags --add-opens ou --add-exports. ` +
                `Essas flags indicam dependência de acesso a módulos internos do JDK. ` +
                `Revise cada flag: se for necessária para frameworks (ex: Spring, Hibernate), mantenha. ` +
                `Se era workaround para código próprio que já foi migrado, remova.`,
              files: addOpensFiles,
              blocking: false,
            })
          }

          // D4 — profiles Maven neutralizados
          if (phase1Details?.mavenProfilesNeutralized > 0) {
            decisions.push({
              id: 'D4-maven-profiles',
              phase: 1,
              category: 'build',
              title: `${phase1Details.mavenProfilesNeutralized} Maven profile(s) com ativação por JDK desativado(s)`,
              question: `A Fase 1 desativou a ativação automática por versão de JDK em ${phase1Details.mavenProfilesNeutralized} profile(s) do pom.xml. ` +
                `Revise os profiles afetados: se o conteúdo deles (dependências, plugins, propriedades) ainda é necessário para a build JDK 21, mantenha o profile sem a ativação automática. ` +
                `Se o profile era exclusivo para JDK antigo, pode ser removido completamente.`,
              files: ['pom.xml'],
              blocking: false,
            })
          }

          // Infra: arquivos com templates Helm não editados automaticamente
          const helmItems: string[] = phase1Details?.humanConfirmationNeeded
            ?.filter((h: any) => h.id?.includes('helm') || h.id?.includes('dockerfile'))
            ?.map((h: any) => h.file) ?? []
          if (helmItems.length > 0) {
            decisions.push({
              id: 'D5-helm-templates',
              phase: 1,
              category: 'infrastructure',
              title: 'Helm templates / Dockerfiles com imagem JDK não atualizados automaticamente',
              question: `Os seguintes arquivos contêm templates parametrizados que não puderam ser atualizados automaticamente: ${helmItems.join(', ')}. ` +
                `Atualize manualmente a variável de imagem JDK para eclipse-temurin:21-jre (ou equivalente) antes de avançar para a Fase 2.`,
              files: helmItems,
              blocking: true,
            })
          }

          if (decisions.length > 0) pendingHumanDecisions = decisions
        } catch { /* não bloqueia */ }
      }

      // ── Gate 2: perguntas após Fase 2 (Language Modernization) ───────────────
      // D1: Thread.stop/destroy/countStackFrames — bloqueante, requer refatoração manual
      // C12: acesso reflexivo a internos — warning, requer revisão
      if (phase === 2) {
        try {
          const decisions: typeof pendingHumanDecisions = []
          const phase2Details = (config.phases[2] as any)?.runnerDetails?.['source-cleaner'] as any
          const humanDecisions: any[] = phase2Details?.humanDecisionsNeeded ?? []

          for (const hd of humanDecisions) {
            const files = [...new Set((hd.occurrences ?? []).map((o: any) => o.file))] as string[]
            const locations = (hd.occurrences ?? []).slice(0, 5)
              .map((o: any) => `${o.file}:${o.line}`).join(', ')
            decisions.push({
              id: hd.id,
              phase: 2,
              category: 'removed-apis',
              title: hd.title,
              question: `${hd.description}\n\nOcorrências (${hd.occurrences?.length ?? 0}): ${locations}`,
              files,
              blocking: hd.blocking ?? true,
            })
          }

          // C12 — acesso reflexivo a internos: verificação estática rápida
          const srcDirsToScan = ['src/main/java', 'src/test/java']
          const reflectiveFiles: string[] = []
          for (const sd of srcDirsToScan) {
            const sdPath = join(projectPath, sd)
            if (!existsSync(sdPath)) continue
            const javaFiles: string[] = []
            const walkForReflective = (d: string) => {
              let entries: string[]
              try { entries = readdirSync(d) } catch { return }
              for (const e of entries) {
                if (e === 'target' || e === '.git') continue
                const full = join(d, e)
                let st: ReturnType<typeof statSync> | null = null
                try { st = statSync(full) } catch { continue }
                if (st.isDirectory()) walkForReflective(full)
                else if (e.endsWith('.java')) javaFiles.push(full)
              }
            }
            walkForReflective(sdPath)
            for (const f of javaFiles.slice(0, 200)) {
              let content: string | null = null
              try { content = readFileSync(f, 'utf-8') } catch { continue }
              if (!content) continue
              if (/Class\.forName\s*\(\s*["'](?:sun|com\.sun)\./.test(content) ||
                  (/setAccessible\s*\(\s*true\s*\)/.test(content) && /(sun|com\.sun|internal)/.test(content))) {
                reflectiveFiles.push(relative(projectPath, f).replace(/\\/g, '/'))
              }
            }
          }
          if (reflectiveFiles.length > 0) {
            decisions.push({
              id: 'C12-reflective-internal',
              phase: 2,
              category: 'jvm-internals',
              title: 'Acesso reflexivo a APIs internas do JDK detectado',
              question: `Foram detectados padrões de acesso reflexivo a classes internas do JDK (sun.*, com.sun.*) em ${reflectiveFiles.length} arquivo(s). ` +
                `O módulo system do JDK 9+ bloqueia esses acessos por padrão — em JDK 21 lançam InaccessibleObjectException. ` +
                `Revise cada ocorrência: se for necessária, adicione --add-opens específico; se for possível, substitua pela API pública equivalente.`,
              files: reflectiveFiles.slice(0, 5),
              blocking: false,
            })
          }

          if (decisions.length > 0) pendingHumanDecisions = decisions
        } catch { /* não bloqueia */ }
      }

      // ── Gate 3: perguntas após Fase 3 (Jakarta + Frameworks) ─────────────────
      // A2: dependências Jakarta injetadas — confirmar runtime smoke test
      // C1: versão Spring Boot validada (se stack spring-boot)
      if (phase === 3) {
        try {
          const decisions: typeof pendingHumanDecisions = []
          const phase3Details = (config.phases[3] as any)?.runnerDetails?.['jakarta-deps'] as any
          const injected: any[] = phase3Details?.injected ?? []
          const alreadyPresent: any[] = phase3Details?.alreadyPresent ?? []

          if (injected.length > 0 || alreadyPresent.length > 0) {
            const injectedList = injected.map((d: any) => d.coords).join(', ')
            const alreadyList = alreadyPresent.map((d: any) => d.coords).join(', ')
            const detail = [
              injected.length > 0 ? `Injetadas: ${injectedList}.` : '',
              alreadyPresent.length > 0 ? `Já presentes: ${alreadyList}.` : '',
            ].filter(Boolean).join(' ')
            decisions.push({
              id: 'A2-jakarta-removed-apis',
              phase: 3,
              category: 'dependencies',
              title: 'Dependências Jakarta para APIs removidas do JDK — confirmar smoke test',
              question: `${detail} ` +
                `Confirme que a aplicação sobe sem NoClassDefFoundError ou ClassNotFoundException ` +
                `relacionados a javax.xml.ws, javax.xml.soap, javax.jws ou javax.activation. ` +
                `Execute um smoke test de endpoints que usam essas APIs antes de aprovar este gate.`,
              files: ['pom.xml'],
              blocking: false,
            })
          }

          // C1: Spring Boot version check
          if (config.stack.includes('spring-boot')) {
            const pomPath = join(projectPath, 'pom.xml')
            const pomContent = existsSync(pomPath) ? readFileSync(pomPath, 'utf-8') : null
            const sb3Present = pomContent && /spring-boot[^<]*[23]\.[0-9]/.test(pomContent)
            if (sb3Present && /<spring-boot[^>]*>[^<]*[23]\.[0-9]/.test(pomContent ?? '')) {
              // Found Spring Boot 3+ parent/dep — good sign but verify
            }
            decisions.push({
              id: 'C1-spring-boot-version',
              phase: 3,
              category: 'frameworks',
              title: 'Spring Boot: confirmar versão 3.x e compatibilidade de segurança',
              question: `O SBM foi executado para migrar Spring Boot 2→3. ` +
                `Confirme no pom.xml que a versão do spring-boot-starter-parent está em 3.x. ` +
                `Se o projeto usa Spring Security, revise a configuração: SecurityFilterChain é obrigatório em SB3 ` +
                `(WebSecurityConfigurerAdapter foi removido). Verifique também o auto-configure de DataSource e actuator.`,
              files: ['pom.xml'],
              blocking: false,
            })
          }

          if (decisions.length > 0) pendingHumanDecisions = decisions
        } catch { /* não bloqueia */ }
      }

      // ── Gate 4: perguntas antes da revisão semântica (Fase 4) ────────────────
      // C3: SecurityManager (bloqueante — não pode ficar sem resolução)
      // C8: finalize() override (warning)
      // C5/C11: Nashorn/ScriptEngine (info — dep já injetada)
      // sun.* problemáticos: sun.misc.Unsafe, sun.misc.Signal, com.sun.image.codec (bloqueantes)
      if (phase === 4) {
        try {
          const decisions: typeof pendingHumanDecisions = []
          // Source-cleaner findings são do phase 2
          const phase2SourceCleaner = (config.phases[2] as any)?.runnerDetails?.['source-cleaner'] as any
          const humanDecisions: any[] = phase2SourceCleaner?.humanDecisionsNeeded ?? []

          // Filtra apenas os IDs relevantes para o gate 4 (os não-bloqueantes do gate 2 também chegam aqui)
          const gate4Ids = new Set([
            'security-manager',
            'finalize-override',
            'nashorn-scriptengine',
            'sun-unsafe',
            'sun-signal',
            'com-sun-image-codec',
            'sun-base64',
          ])

          for (const hd of humanDecisions) {
            if (!gate4Ids.has(hd.id)) continue
            const files = [...new Set((hd.occurrences ?? []).map((o: any) => o.file))] as string[]
            const locations = (hd.occurrences ?? []).slice(0, 5)
              .map((o: any) => `${o.file}:${o.line}`).join(', ')
            decisions.push({
              id: hd.id,
              phase: 4,
              category: hd.id.startsWith('sun') || hd.id.startsWith('com-sun') ? 'jvm-internals' : 'removed-apis',
              title: hd.title,
              question: `${hd.description}\n\nOcorrências (${hd.occurrences?.length ?? 0}): ${locations}`,
              files,
              blocking: hd.blocking ?? false,
            })
          }

          // Se não houve source-cleaner (fase 2 manual), verifica estaticamente SecurityManager
          if (decisions.length === 0) {
            const srcDirsGate4 = ['src/main/java', 'src/test/java']
            const smFiles: string[] = []
            for (const sd of srcDirsGate4) {
              const sdPath = join(projectPath, sd)
              if (!existsSync(sdPath)) continue
              const walkG4 = (d: string) => {
                let entries: string[]
                try { entries = readdirSync(d) } catch { return }
                for (const e of entries) {
                  if (e === 'target' || e === '.git') continue
                  const full = join(d, e)
                  let st: ReturnType<typeof statSync> | null = null
                  try { st = statSync(full) } catch { continue }
                  if (st.isDirectory()) walkG4(full)
                  else if (e.endsWith('.java')) {
                    try {
                      const c = readFileSync(full, 'utf-8')
                      if (/extends\s+SecurityManager\b|System\.setSecurityManager\s*\(|new\s+SecurityManager\s*\(/.test(c)) {
                        smFiles.push(relative(projectPath, full).replace(/\\/g, '/'))
                      }
                    } catch { /* ignore */ }
                  }
                }
              }
              walkG4(sdPath)
            }
            if (smFiles.length > 0) {
              decisions.push({
                id: 'security-manager',
                phase: 4,
                category: 'removed-apis',
                title: 'SecurityManager — removido no JDK 17 (detectado na análise estática)',
                question: `SecurityManager foi removido no JDK 17 (JEP 411) e qualquer uso lança UnsupportedOperationException no JDK 21. ` +
                  `Arquivos: ${smFiles.slice(0, 5).join(', ')}. ` +
                  `Avalie a necessidade real da restrição de segurança. Alternativas:\n` +
                  `  1. Módulos JPMS para controle de acesso a pacotes.\n` +
                  `  2. Políticas de container (seccomp, AppArmor, OPA/Gatekeeper em K8s).\n` +
                  `  3. Remover se a restrição não era mais efetiva (SecurityManager era bypassável).`,
                files: smFiles.slice(0, 5),
                blocking: true,
              })
            }
          }

          if (decisions.length > 0) pendingHumanDecisions = decisions
        } catch { /* não bloqueia */ }
      }

      // ── Gate 5: perguntas antes do sign-off final ─────────────────────────────
      // A6: evidência de runtime — confirmar que a aplicação iniciou com JDK 21
      // K8s: confirmar que manifests atualizados foram validados
      if (phase === 5) {
        try {
          const decisions: typeof pendingHumanDecisions = []

          // A6 — runtime evidence: sempre obrigatório no gate final
          decisions.push({
            id: 'A6-runtime-evidence',
            phase: 5,
            category: 'runtime',
            title: 'Evidência de startup com JDK 21 — confirmação obrigatória',
            question: `Antes de aprovar o gate final, confirme que a aplicação foi iniciada com JDK 21 e o startup completou sem erros. ` +
              `Cole a linha de log de startup (ex: "Started XxxApplication in 4.3 seconds (JVM running for 5.1)") ` +
              `ou descreva o resultado do smoke test realizado em ambiente com JDK 21.`,
            files: [],
            blocking: true,
          })

          // D5 — K8s/Helm: verificar se há diretórios k8s que foram atualizados
          const K8S_DIRS_CHECK = ['k8s', 'kubernetes', 'manifests', 'helm', 'charts', 'deploy', 'infra']
          const k8sDirsFound = K8S_DIRS_CHECK.filter(d => existsSync(join(projectPath, d)))
          if (k8sDirsFound.length > 0) {
            decisions.push({
              id: 'D5-k8s-validation',
              phase: 5,
              category: 'infrastructure',
              title: 'Validação de manifests Kubernetes/Helm em ambiente com JDK 21',
              question: `O projeto possui diretórios de infraestrutura Kubernetes/Helm (${k8sDirsFound.join(', ')}). ` +
                `Confirme que os manifests atualizados foram aplicados e validados em ambiente de homologação com JDK 21. ` +
                `Verifique especialmente: imagens base dos pods, variáveis de ambiente JAVA_VERSION/JAVA_OPTS, e health checks.`,
              files: k8sDirsFound,
              blocking: false,
            })
          }

          if (decisions.length > 0) pendingHumanDecisions = decisions
        } catch { /* não bloqueia */ }
      }

      const blockingCount = pendingHumanDecisions?.filter(d => d.blocking).length ?? 0

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'awaiting_human_pin',
            phase,
            pinExpiresAt: expiresAt,
            ...(pendingHumanDecisions && pendingHumanDecisions.length > 0 ? {
              pendingHumanDecisions,
              pendingHumanDecisionsNote:
                `⚠️ ${pendingHumanDecisions.length} item(ns) requerem informação humana antes que as fases seguintes executem com sucesso` +
                (blockingCount > 0 ? ` (${blockingCount} bloqueante(s) — fases falharão sem resposta)` : '') +
                '. Apresente cada pergunta ao usuário e registre as respostas ANTES de revelar o PIN abaixo.',
            } : {}),
            instructions: [
              '══════════════════════════════════════════════════',
              `  PIN DE APROVAÇÃO — FASE ${phase}`,
              `  ➜  ${pin}`,
              '══════════════════════════════════════════════════',
              '',
              `Digite este PIN ao confirmar a aprovação.`,
              `O PIN expira em 30 minutos (${expiresAt}).`,
              'NÃO compartilhe este PIN com sistemas automatizados.',
            ].join('\n'),
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'approve_gate',
    {
      title: 'Approve Gate',
      description:
        'Registra a aprovação humana para uma fase e emite o token que libera a fase ' +
        'seguinte. REQUER que request_gate_approval tenha sido chamado antes e que o ' +
        'humano forneça o PIN gerado. NUNCA deve ser chamado por automação — ' +
        'approverName não pode identificar um sistema automatizado e humanPin deve ser ' +
        'o código de 6 dígitos que o humano digitou explicitamente nesta conversa.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase a aprovar (0–5)'),
        approverName: z
          .string()
          .min(2)
          .describe('Nome completo do responsável humano pela aprovação'),
        humanPin: z
          .string()
          .length(6)
          .regex(/^\d{6}$/)
          .describe(
            'PIN de 6 dígitos gerado por request_gate_approval e informado pelo humano. ' +
            'NUNCA inferir, reutilizar ou adivinhar este valor — deve vir explicitamente do responsável técnico.',
          ),
      },
    },
    async ({ projectPath, phaseNumber, approverName, humanPin }) => {
      // ── Bloquear nomes de sistemas automatizados ──────────────────────────────
      const normalizedName = approverName.trim().toLowerCase()
      if (FORBIDDEN_APPROVER_NAMES.has(normalizedName)) {
        throw new MigrationError(
          'GATE_TOKEN_INVALID',
          `approverName "${approverName}" não é permitido — approve_gate deve ser chamado por um humano.`,
        )
      }

      // ── Validar PIN ───────────────────────────────────────────────────────────
      const pinStore = readPinStore(projectPath)
      const pinEntry = pinStore[phaseNumber as PhaseNumber]

      if (!pinEntry) {
        throw new MigrationError(
          'GATE_TOKEN_INVALID',
          `Nenhum PIN foi gerado para a Fase ${phaseNumber}. ` +
            `Chame request_gate_approval primeiro e aguarde o responsável técnico fornecer o PIN.`,
        )
      }

      if (new Date(pinEntry.expiresAt) < new Date()) {
        deletePinEntry(projectPath, phaseNumber as PhaseNumber)
        throw new MigrationError(
          'GATE_TOKEN_INVALID',
          `O PIN da Fase ${phaseNumber} expirou (${pinEntry.expiresAt}). ` +
            `Chame request_gate_approval novamente para gerar um novo PIN.`,
        )
      }

      if (pinEntry.pin !== humanPin) {
        throw new MigrationError(
          'GATE_TOKEN_INVALID',
          `PIN incorreto para a Fase ${phaseNumber}. ` +
            `Verifique o código exibido por request_gate_approval e tente novamente.`,
        )
      }

      // PIN válido — consumir (uso único)
      deletePinEntry(projectPath, phaseNumber as PhaseNumber)

      const config = readConfig(projectPath)
      const phase = config.phases[phaseNumber as PhaseNumber]

      const token = generateGateToken(projectPath, phaseNumber as PhaseNumber)
      const now = new Date().toISOString()

      config.phases[phaseNumber as PhaseNumber] = {
        ...phase,
        status: 'approved',
        gateToken: token,
        approvedBy: approverName.trim(),
        approvedAt: now,
        completedAt: now,
      }

      // Atualiza completedAt no ROI desta fase
      if (config.roi) {
        const phaseRoiIdx = config.roi.findIndex(r => r.phaseNumber === phaseNumber)
        if (phaseRoiIdx >= 0) {
          config.roi[phaseRoiIdx] = { ...config.roi[phaseRoiIdx], completedAt: now }
        }
      }

      writeConfig(projectPath, config)

      // Fase 5 (última): gera report incremental + audit-report-final.html fixo
      // Demais fases: apenas report incremental com timestamp
      let autoReportPath: string | null = null
      let finalReportPath: string | null = null

      let syncResult: import('../../orchestrator/git-checkpoint.js').SyncMigrationBranchResult | null = null

      if (phaseNumber === 5) {
        const finalResult = await generateFinalReport(projectPath)
        autoReportPath = finalResult.timestamped
        finalReportPath = finalResult.final

        // ── Sincronizar branch migrate/* com o tip da fase 5 ─────────────────
        // A branch migrate/* é o baseBranch da fase 1 (ponto de partida do projeto).
        // O tip é a branch da fase 5, que já contém toda a cadeia de fases via
        // fast-forward linear. Nenhum push é feito — apenas sincronização local.
        const phases = config.phases
        const migrationBranch = (
          phases[1]?.baseBranch ??
          phases[0]?.baseBranch ??
          null
        )
        const tipBranch = phases[5]?.gitBranch ?? null

        if (migrationBranch && tipBranch) {
          syncResult = await syncMigrationBranch(projectPath, migrationBranch, tipBranch)
        } else {
          syncResult = {
            synced: false,
            migrationBranch,
            tipBranch,
            error: !migrationBranch
              ? 'Branch migrate/* não encontrada no config (phases[1].baseBranch ausente).'
              : 'Branch da fase 5 não encontrada no config (phases[5].gitBranch ausente).',
          }
        }
      } else {
        autoReportPath = await generateAuditReportSilent(projectPath)
      }

      const isFinalPhase = phaseNumber === 5

      const syncMessage = syncResult?.synced
        ? `Branch local '${syncResult.migrationBranch}' sincronizada via fast-forward com '${syncResult.tipBranch}'. Quando quiser, execute manualmente: git push origin ${syncResult.migrationBranch}`
        : syncResult
          ? `Sincronização automática não foi possível: ${syncResult.error} — execute manualmente: git checkout ${syncResult.migrationBranch} && git merge ${syncResult.tipBranch}`
          : undefined

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'approved',
                phaseNumber,
                approvedBy: approverName.trim(),
                approvedAt: now,
                tokenIssuedAt: getTokenIssuedAt(token)?.toISOString(),
                gateToken: token,
                auditReport: autoReportPath ?? null,
                ...(isFinalPhase ? { finalReport: finalReportPath ?? null } : {}),
                ...(isFinalPhase && syncResult ? {
                  migrationBranchSync: {
                    synced: syncResult.synced,
                    migrationBranch: syncResult.migrationBranch,
                    tipBranch: syncResult.tipBranch,
                    ...(syncResult.error ? { error: syncResult.error } : {}),
                  },
                } : {}),
                message: isFinalPhase
                  ? [
                      `Migracao concluida! Gate da Fase 5 aprovado por ${approverName.trim()}. Relatorio final salvo em audit-report-final.html.`,
                      ...(syncMessage ? [syncMessage] : []),
                    ].join(' ')
                  : `Gate da Fase ${phaseNumber} aprovado. Use o gateToken para liberar a Fase ${phaseNumber + 1} via execute_phase.`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.registerTool(
    'rollback_phase',
    {
      title: 'Rollback Phase',
      description:
        'Reverte uma fase aplicada via Git, restaurando o projeto ao estado anterior ' +
        'à execução da fase. Não requer token de gate.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase a reverter'),
      },
    },
    async ({ projectPath, phaseNumber }) => {
      const config = readConfig(projectPath)
      const phase = phaseNumber as PhaseNumber
      const phaseState = config.phases[phase]

      if (phaseState.status !== 'in_progress' && phaseState.status !== 'awaiting_gate' && phaseState.status !== 'failed') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} está com status '${phaseState.status}'. Só é possível reverter fases in_progress, awaiting_gate ou failed.`,
            }, null, 2),
          }],
        }
      }

      if (!phaseState.baseBranch || !phaseState.baseCommit) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} não possui informação de branch/commit base para rollback. A fase pode não ter sido iniciada via execute_phase.`,
            }, null, 2),
          }],
        }
      }

      await rollbackPhase(projectPath, {
        branchName: phaseState.gitBranch ?? '',
        baseBranch: phaseState.baseBranch,
        baseCommit: phaseState.baseCommit,
        phaseCommit: phaseState.gitCommit,
      })

      const updated = updatePhaseStatus(config, phase, 'rolled_back')
      writeConfig(projectPath, updated)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'rolled_back',
            phase,
            restoredBranch: phaseState.baseBranch,
            message: `Fase ${phase} revertida. Branch '${phaseState.gitBranch}' preservada como histórico.`,
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'update_step_status',
    {
      title: 'Update Step Status',
      description:
        'Registra ou atualiza o progresso de um step individual dentro da fase ativa de migração. ' +
        'Persiste os dados em jdk-migration.config.json para que generate_report inclua ' +
        'automaticamente o progresso dos steps no relatório HTML de auditoria. ' +
        'Chame este tool sempre que um step for concluído, iniciado ou pulado. ' +
        'Se reportMode="phase-gate-step" estiver configurado, gera um novo audit-report-<timestamp>.html ' +
        'automaticamente após cada chamada, refletindo o progresso atualizado dos steps.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        stepNum: z
          .number()
          .int()
          .min(1)
          .describe('Número sequencial do step (1, 2, 3…)'),
        owner: z
          .enum(['claude', 'you'])
          .describe('Responsável: "claude" para Claude Code, "you" para o usuário humano'),
        phase: z
          .enum(['A', 'B', 'C', 'D'])
          .describe('Fase do plano de execução — A: Verificações/Decisões, B: Implementação, C: Validação, D: Limpeza'),
        task: z
          .string()
          .describe('Descrição curta da tarefa do step'),
        status: z
          .enum(['done', 'pending', 'skipped'])
          .describe('Status atual: done=concluído, pending=pendente, skipped=pulado intencionalmente'),
        commit: z
          .string()
          .optional()
          .describe('Hash curto do commit Git associado (ex: "235acc2"). Opcional.'),
        note: z
          .string()
          .optional()
          .describe('Nota adicional: arquivos afetados, decisão tomada, motivo do skip. Opcional.'),
      },
    },
    async ({ projectPath, stepNum, owner, phase, task, status, commit, note }) => {
      const config = readConfig(projectPath)

      const steps: MigrationStep[] = config.steps ?? []
      const existingIdx = steps.findIndex(s => s.num === stepNum)

      const updatedStep: MigrationStep = {
        id: `step-${stepNum}`,
        num: stepNum,
        owner,
        phase,
        task,
        status,
        ...(commit ? { commit } : {}),
        ...(note ? { note } : {}),
        ...(status === 'done' ? { completedAt: new Date().toISOString() } : {}),
      }

      if (existingIdx >= 0) {
        steps[existingIdx] = updatedStep
      } else {
        steps.push(updatedStep)
        steps.sort((a, b) => a.num - b.num)
      }

      config.steps = steps
      writeConfig(projectPath, config)

      // Gera audit report automaticamente se reportMode === 'phase-gate-step'
      let autoReportPath: string | null = null
      if (config.reportMode === 'phase-gate-step') {
        autoReportPath = await generateAuditReportSilent(projectPath)
      }

      const doneCount = steps.filter(s => s.status === 'done').length

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'ok',
            step: updatedStep,
            totalSteps: steps.length,
            doneSteps: doneCount,
            message: `Step ${stepNum} registrado como "${status}". ${doneCount}/${steps.length} steps concluídos.`,
            ...(autoReportPath ? { auditReport: autoReportPath } : {}),
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'record_manual_phase',
    {
      title: 'Record Manual Phase',
      description:
        'Registra uma fase que foi executada manualmente fora do MCP — por exemplo, quando ' +
        'o execute_phase falhou por problema ambiental (EINVAL, ENOENT) e o trabalho foi ' +
        'realizado diretamente na linha de comando. Avança a fase para awaiting_gate, ' +
        'preservando a trilha de auditoria, e permite que approve_gate seja chamado ' +
        'normalmente. NÃO aplica nenhuma transformação — apenas registra o estado. ' +
        'Use o parâmetro steps para registrar todos os steps do trabalho manual em uma ' +
        'única chamada atômica — isso garante que a seção "Progresso dos Steps" do ' +
        'relatório HTML fique completa sem precisar chamar update_step_status N vezes. ' +
        'IMPORTANTE — isolamento Git: ANTES de iniciar qualquer trabalho manual, crie uma ' +
        'branch isolada com o padrão oficial: ' +
        'git checkout -b jdk-migration/phase-N-YYYYMMDDHHMMSS ' +
        '(ex: git checkout -b jdk-migration/phase-3-20260605170000). ' +
        'Isso garante que cada fase tenha sua própria branch no repositório, mantendo o ' +
        'histórico auditável e permitindo rollback independente. Só omita se a branch já ' +
        'foi criada por uma tentativa anterior de execute_phase.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase que foi executada manualmente (0–5)'),
        gitBranch: z
          .string()
          .describe(
            'Nome da branch Git onde as alterações manuais foram commitadas. ' +
            'Pode ser a branch da fase (jdk-migration/phase-N-...) ou a branch principal de migração.',
          ),
        gitCommit: z
          .string()
          .describe('Hash (curto ou completo) do commit que representa o trabalho realizado.'),
        recipesApplied: z
          .array(z.string())
          .optional()
          .default([])
          .describe('Lista das recipes/transformações aplicadas manualmente (para auditoria).'),
        note: z
          .string()
          .describe(
            'Descrição do que foi feito manualmente e o motivo pelo qual o execute_phase ' +
            'não pôde ser usado (ex: "spawn EINVAL — mvn.cmd executado diretamente via CLI").',
          ),
        steps: z
          .array(z.object({
            num:    z.number().int().min(1).describe('Número sequencial do step (1, 2, 3…)'),
            owner:  z.enum(['claude', 'you']).describe('"claude" ou "you"'),
            phase:  z.enum(['A', 'B', 'C', 'D']).describe('A=Verificações, B=Implementação, C=Validação, D=Limpeza'),
            task:   z.string().describe('Descrição curta da tarefa'),
            status: z.enum(['done', 'pending', 'skipped']),
            commit: z.string().optional().describe('Hash curto do commit Git associado'),
            note:   z.string().optional().describe('Nota adicional ou decisão tomada'),
          }))
          .optional()
          .default([])
          .describe(
            'Steps detalhados do trabalho realizado. Quando fornecidos, são mesclados com ' +
            'os steps existentes no config (upsert por num), garantindo que a seção ' +
            '"Progresso dos Steps" do relatório fique completa em uma única chamada. ' +
            'Se omitido, apenas um step de auditoria genérico [MANUAL] é registrado.',
          ),
      },
    },
    async ({ projectPath, phaseNumber, gitBranch, gitCommit, recipesApplied = [], note, steps: incomingSteps = [] }) => {
      const config = readConfig(projectPath)
      const phase = phaseNumber as PhaseNumber
      const phaseState = config.phases[phase]

      // Permite registrar a partir de pending, in_progress ou failed
      const allowedFromStatuses = ['pending', 'in_progress', 'failed']
      if (!allowedFromStatuses.includes(phaseState.status)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'PHASE_OUT_OF_ORDER',
              message: `Fase ${phase} está com status '${phaseState.status}'. ` +
                `record_manual_phase só pode ser chamado em fases com status: ${allowedFromStatuses.join(', ')}.`,
            }, null, 2),
          }],
        }
      }

      const now = new Date().toISOString()

      // Grava diretamente no config sem passar pela state machine (é um override manual).
      // gitBranch e gitCommit só sobrescrevem se execute_phase ainda não tiver gravado
      // uma branch real — evita apagar a branch criada pelo execute_phase caso
      // record_manual_phase seja chamado em seguida para complementar o registro.
      config.phases[phase] = {
        ...phaseState,
        status: 'awaiting_gate',
        executedAt: phaseState.executedAt ?? now,
        gitBranch:   phaseState.gitBranch  ?? gitBranch,
        gitCommit:   phaseState.gitCommit  ?? gitCommit,
        baseBranch:  phaseState.baseBranch ?? gitBranch,
        baseCommit:  phaseState.baseCommit ?? gitCommit,
      }

      // ── Merge de steps: upsert por num ────────────────────────────────────────
      const existingSteps: MigrationStep[] = config.steps ?? []

      let stepsToMerge: MigrationStep[]
      if (incomingSteps.length > 0) {
        // O agente forneceu steps detalhados — usa-os diretamente
        stepsToMerge = incomingSteps.map(s => ({
          id: `step-${s.num}`,
          num: s.num,
          owner: s.owner,
          phase: s.phase,
          task: s.task,
          status: s.status,
          ...(s.commit ? { commit: s.commit } : {}),
          ...(s.note   ? { note: s.note }     : {}),
          ...(s.status === 'done' ? { completedAt: now } : {}),
        }))
      } else {
        // Fallback: registra um único step genérico de auditoria
        const nextNum = existingSteps.length > 0
          ? Math.max(...existingSteps.map(s => s.num)) + 1
          : 1
        stepsToMerge = [{
          id: `manual-phase-${phase}-${Date.now()}`,
          num: nextNum,
          owner: 'claude',
          phase: 'B',
          task: `[MANUAL] Fase ${phase} executada fora do MCP`,
          status: 'done',
          commit: gitCommit.slice(0, 8),
          note: `${note}${recipesApplied.length > 0 ? ` | Recipes: ${recipesApplied.join(', ')}` : ''}`,
          completedAt: now,
        }]
      }

      // Upsert: substitui step existente de mesmo num, adiciona os novos
      const mergedSteps = [...existingSteps]
      for (const incoming of stepsToMerge) {
        const idx = mergedSteps.findIndex(s => s.num === incoming.num)
        if (idx >= 0) {
          mergedSteps[idx] = incoming
        } else {
          mergedSteps.push(incoming)
        }
      }
      mergedSteps.sort((a, b) => a.num - b.num)
      config.steps = mergedSteps

      writeConfig(projectPath, config)

      const autoReportPath = await generateAuditReportSilent(projectPath)

      const doneCount  = mergedSteps.filter(s => s.status === 'done').length
      const totalCount = mergedSteps.length

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'awaiting_gate',
            phase,
            gitBranch,
            gitCommit,
            recipesApplied,
            note,
            stepsRegistered: stepsToMerge.length,
            stepsSummary: `${doneCount}/${totalCount} steps concluídos`,
            auditReport: autoReportPath ?? null,
            message:
              `Fase ${phase} registrada como concluída manualmente (awaiting_gate). ` +
              `${stepsToMerge.length} step(s) gravados. ` +
              `Execute approve_gate(projectPath, ${phase}, "<seu nome>") para liberar a Fase ${phase + 1}.`,
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'update_phase_costs',
    {
      title: 'Update Phase Costs',
      description:
        'Atualiza o custo real de tokens de uma fase já executada, recalculando o ROI ' +
        'com os valores reais da API Claude e regenerando o relatório de auditoria. ' +
        'Use quando os tokens reais são conhecidos — por exemplo, extraindo-os do transcript ' +
        'JSONL em ~/.claude/projects/<slug>/<session-id>.jsonl e somando os campos ' +
        '"usage.input_tokens", "usage.cache_creation_input_tokens", ' +
        '"usage.cache_read_input_tokens" e "usage.output_tokens" de cada turno da fase. ' +
        'Os campos de cache são dominantes no custo real do Claude Code e devem ser ' +
        'incluídos para um cálculo de ROI preciso.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
        phaseNumber: z
          .number()
          .int()
          .min(0)
          .max(5)
          .describe('Número da fase cujos custos serão atualizados (0–5)'),
        tokenUsage: z
          .object({
            inputTokens: z
              .number()
              .int()
              .nonnegative()
              .describe('Soma de input_tokens (tokens fresh, não-cache) de todos os turnos da fase'),
            outputTokens: z
              .number()
              .int()
              .nonnegative()
              .describe('Soma de output_tokens de todos os turnos da fase'),
            cacheCreationTokens: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe('Soma de cache_creation_input_tokens — $3,75/MTok. Tokens gerados ao escrever no cache.'),
            cacheReadTokens: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe(
                'Soma de cache_read_input_tokens — $0,30/MTok. ' +
                'Dominante em sessões longas do Claude Code (pode representar 95%+ do custo total). ' +
                'Extraia do transcript JSONL somando o campo "usage.cache_read_input_tokens" de cada linha de resposta.',
              ),
          })
          .describe(
            'Tokens reais da fase. Para obter os valores: ' +
            '(1) localize o arquivo ~/.claude/projects/<slug>/<session-id>.jsonl; ' +
            '(2) filtre as linhas com "usage" no JSON; ' +
            '(3) some cada campo de token para o período correspondente à fase.',
          ),
      },
    },
    async ({ projectPath, phaseNumber, tokenUsage }) => {
      const config = readConfig(projectPath)
      const phase = phaseNumber as PhaseNumber
      const phaseState = config.phases[phase]

      const phaseRoi = await computePhaseRoi(
        {
          phaseNumber: phase,
          startedAt:   phaseState.executedAt ?? null,
          completedAt: phaseState.completedAt ?? null,
          tokenUsage,
        },
        config.stack,
        config.multiModule,
        config.discoveryEffortDays ?? 0,
      )

      const existingRoi = config.roi ?? []
      writeConfig(projectPath, {
        ...config,
        roi: [...existingRoi.filter(r => r.phaseNumber !== phase), phaseRoi],
      })

      const autoReportPath = await generateAuditReportSilent(projectPath)

      const totalTok = phaseRoi.estimatedInputTokens +
        phaseRoi.estimatedCacheCreationTokens +
        phaseRoi.estimatedCacheReadTokens +
        phaseRoi.estimatedOutputTokens

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'ok',
            phaseNumber: phase,
            roi: phaseRoi,
            totalTokens: totalTok,
            auditReport: autoReportPath ?? null,
            message:
              `Custo da Fase ${phase} atualizado: ` +
              `$${phaseRoi.claudeCostUsd.toFixed(4)} USD | R$${phaseRoi.claudeCostBrl.toFixed(2)} BRL. ` +
              `Tokens: ${totalTok.toLocaleString()} (cache read: ${phaseRoi.estimatedCacheReadTokens.toLocaleString()}). ` +
              `Relatório regenerado.`,
          }, null, 2),
        }],
      }
    },
  )

  server.registerTool(
    'generate_report',
    {
      title: 'Generate Report',
      description:
        'Gera o relatório consolidado de auditoria da migração, com trilha completa de ' +
        'decisões, aprovações por fase, arquivos modificados e issues em aberto. ' +
        'Salvo em .jdk-migration/audit-report-{timestamp}.html.',
      inputSchema: {
        projectPath: z
          .string()
          .describe('Caminho absoluto da raiz do projeto Java'),
      },
    },
    async ({ projectPath }) => {
      try {
        // Executa a auditoria de migração sempre que a Fase 5 estiver em andamento
        // ou concluída, garantindo que a seção "🔍 Auditoria de Migração JDK 21"
        // seja gerada independentemente de quais campos do config foram alterados
        // (ex: adição de dados de ROI entre duas chamadas a generate_report).
        let migrationAudit: import('../../static-analysis/migration-audit.js').MigrationAuditResult | undefined
        try {
          const cfg = configExists(projectPath) ? readConfig(projectPath) : null
          const phase5Status = cfg?.phases?.[5]?.status ?? 'pending'
          if (['in_progress', 'awaiting_gate', 'approved', 'completed'].includes(phase5Status)) {
            migrationAudit = await runMigrationAudit(projectPath, cfg?.targetJdk ?? '21')
          }
        } catch { /* auditoria não bloqueia a geração do relatório */ }

        const result = await generateAuditReport(projectPath, migrationAudit)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              reportPath: result.reportPath,
              phasesCompleted: result.phasesCompleted,
              phasesTotal: result.phasesTotal,
              openManualItems: result.openManualItems,
              criticalRisks: result.criticalRisks,
              message: `Relatório HTML gerado em ${result.reportPath}`,
            }, null, 2),
          }],
        }
      } catch (err) {
        if (err instanceof MigrationError) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
            }],
          }
        }
        throw err
      }
    },
  )
}

