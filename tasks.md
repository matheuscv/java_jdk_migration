# tasks.md — Plano Técnico de Implementação

> **Projeto:** jdk-migration-mcp  
> **Escopo v1:** JDK 6 e JDK 8 → JDK 21  
> **Arquitetura:** MCP Server (TypeScript/Node.js) + Skill de instalação  
> **Proposta de referência:** `docs/Proposta_Tecnico_Funcional_Migracao_jdks8e9_jdk21_1.html`  
> **Gerado em:** 2026-05-29

---

## Índice

1. [Visão arquitetural](#1-visão-arquitetural)
2. [Convenções e padrões de código](#2-convenções-e-padrões-de-código)
3. [Etapa 1 — Fundação (Semanas 1–2)](#3-etapa-1--fundação-semanas-12)
4. [Etapa 2 — Diagnóstico real (Semanas 3–4)](#4-etapa-2--diagnóstico-real-semanas-34)
5. [Etapa 3 — Orchestrator (Semanas 5–6)](#5-etapa-3--orchestrator-semanas-56)
6. [Etapa 4 — Transform Engine (Semanas 7–8)](#6-etapa-4--transform-engine-semanas-78)
7. [Etapa 5 — Profilers críticos (Semanas 9–11)](#7-etapa-5--profilers-críticos-semanas-911)
8. [Etapa 6 — Stacks legadas (Semanas 12–13)](#8-etapa-6--stacks-legadas-semanas-1213)
9. [Etapa 7 — Endurecimento (Semana 14)](#9-etapa-7--endurecimento-semana-14)
10. [Contratos de tipos compartilhados](#10-contratos-de-tipos-compartilhados)
11. [Estratégia de testes](#11-estratégia-de-testes)
12. [Riscos técnicos e mitigações](#12-riscos-técnicos-e-mitigações)

---

## 1. Visão arquitetural

### 1.1 Diagrama de camadas

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP HOST  (Claude Code / VS Code / Cursor)                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │ MCP Protocol (stdio / SSE)
┌──────────────────────▼──────────────────────────────────────────┐
│  MCP SERVER  src/mcp-server/index.ts                            │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐│
│  │discover_     │  │build_migration_  │  │execute_phase       ││
│  │project       │  │plan              │  │                    ││
│  └──────┬───────┘  └────────┬─────────┘  └────────┬───────────┘│
│         │                   │                      │            │
│  ┌──────▼───────────────────▼──────────────────────▼───────────┐│
│  │              ORCHESTRATOR                                    ││
│  │  state-machine · gate-validator · git-checkpoint            ││
│  └──────────────────────────┬────────────────────────────────  ┘│
│         ┌────────────────────┼────────────────────┐             │
│  ┌──────▼──────┐  ┌─────────▼────────┐  ┌────────▼───────────┐ │
│  │STACK        │  │TRANSFORM ENGINE  │  │STATIC ANALYSIS     │ │
│  │PROFILERS    │  │OpenRewrite · SBM │  │jdeprscan · jdeps   │ │
│  │(6 módulos)  │  │Eclipse Transform │  │javac --release     │ │
│  └──────┬──────┘  └──────────────────┘  └────────────────────┘ │
│         │                                                        │
│  ┌──────▼─────────────────────────────────────────────────────┐ │
│  │              KNOWLEDGE BASE                                 │ │
│  │  APIs removidas · JEPs · compat-matrix · migration-guides  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

SKILL (instalação na app-alvo)  ←  roda no contexto do agente
  stack-detect → config-wizard → grava jdk-migration.config.json
```

### 1.2 Fluxo de dados principal

```
Agente invoca discover_project(projectPath)
  → Orchestrator verifica estado (fase 0 permitida sem gate)
  → StackDetector identifica build system + tecnologias
  → StaticAnalysis roda jdeprscan + jdeps
  → KnowledgeBase correlaciona APIs removidas com o código
  → StackProfiler(s) selecionado(s) analisam riscos específicos
  → retorna DiscoveryReport

Agente invoca build_migration_plan(projectPath)
  → lê DiscoveryReport
  → seleciona fases aplicáveis à stack detectada
  → mapeia recipes OpenRewrite por fase
  → estima esforço e sinaliza itens manuais
  → retorna MigrationPlan (persistido em jdk-migration.config.json)

Agente invoca execute_phase(projectPath, phaseNumber, gateToken, dryRun?)
  → Orchestrator valida gateToken
  → cria branch Git isolada
  → TransformEngine executa recipes da fase
  → roda build + testes
  → se falha: rollback automático da branch
  → se sucesso: commit + PR + emite token para próximo gate
  → retorna PhaseExecutionResult
```

---

## 2. Convenções e padrões de código

- **Linguagem:** TypeScript 5.x, `strict: true`, módulos ESM (`"type": "module"`)
- **Runtime:** Node.js ≥ 20
- **MCP SDK:** `@modelcontextprotocol/sdk` — usar `Server`, `StdioServerTransport`
- **Testes:** Vitest — arquivos `*.test.ts` em `tests/unit/` e `tests/integration/`
- **Sem comentários óbvios** — documentar apenas restrições não-óbvias ou invariantes
- **Sem try/catch genérico** — erros são tipados e propagados como `MigrationError`
- **Sem estado global mutável** — Orchestrator persiste estado em `jdk-migration.config.json`
- **Execução de processos externos** — sempre via `src/lib/process-runner.ts` (wrapper com timeout, sanitização de args, captura de stderr)

### 2.1 Estrutura de um módulo

```typescript
// Cada módulo exporta uma factory function, não uma classe singleton
export function createSpringBootProfiler(config: ProfilerConfig): StackProfiler {
  return { analyze, getRiskItems, getRecipes }
}
```

### 2.2 Tratamento de erros

```typescript
// src/lib/errors.ts  — criar na Etapa 1
export type MigrationErrorCode =
  | 'GATE_TOKEN_INVALID'
  | 'PHASE_OUT_OF_ORDER'
  | 'BUILD_FAILED'
  | 'STACK_NOT_DETECTED'
  | 'OPENREWRITE_NOT_FOUND'
  | 'GIT_DIRTY_WORKDIR'

export class MigrationError extends Error {
  constructor(
    public readonly code: MigrationErrorCode,
    message: string,
    public readonly details?: unknown
  ) { super(message) }
}
```

---

## 3. Etapa 1 — Fundação (Semanas 1–2)

**Objetivo:** MCP server registrável no agente, Skill de instalação operacional, as 3 tools principais com mocks que já validam o contrato de interface.

**Criticidade de implementação:** Baixa  
**Pré-requisito:** Node.js 20+, npm 10+ instalados

### 3.1 MCP Server — scaffolding

**Arquivo:** `src/mcp-server/index.ts`

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerDiscoverProject } from './tools/discover-project.js'
import { registerBuildMigrationPlan } from './tools/build-migration-plan.js'
import { registerExecutePhase } from './tools/execute-phase.js'
import { registerAuxiliaryTools } from './tools/auxiliary.js'

const server = new Server(
  { name: 'jdk-migration', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

registerDiscoverProject(server)
registerBuildMigrationPlan(server)
registerExecutePhase(server)
registerAuxiliaryTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)
```

**Arquivo:** `src/mcp-server/tools/discover-project.ts` (mock inicial)

```typescript
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { z } from 'zod'  // adicionar zod às dependências

const DiscoverProjectInput = z.object({
  projectPath: z.string().describe('Caminho absoluto da raiz do projeto Java')
})

export function registerDiscoverProject(server: Server): void {
  server.tool(
    'discover_project',
    'Escaneia a aplicação-alvo sem alterá-la. Identifica build system, stack, versão de JDK e pontos de incompatibilidade com JDK 21.',
    DiscoverProjectInput.shape,
    async ({ projectPath }) => {
      // MOCK — substituir na Etapa 2
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projectPath,
            status: 'mock',
            message: 'discover_project não implementado — use após Etapa 2'
          })
        }]
      }
    }
  )
}
```

> Repetir padrão para `build-migration-plan.ts` e `execute-phase.ts` com mocks equivalentes.

**Arquivo:** `src/mcp-server/tools/auxiliary.ts`

Registrar as 4 tools auxiliares com mocks:
- `get_phase_status(projectPath)` → retorna estado das 6 fases do `jdk-migration.config.json`
- `approve_gate(projectPath, phaseNumber, approverName)` → gera e persiste token
- `rollback_phase(projectPath, phaseNumber)` → mock
- `generate_report(projectPath)` → mock

### 3.2 Biblioteca de erros

**Arquivo:** `src/lib/errors.ts` — implementar conforme seção 2.2

### 3.3 Wrapper de processos externos

**Arquivo:** `src/lib/process-runner.ts`

```typescript
export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<ProcessResult>
```

- Usar `child_process.spawn` (não `exec` — evitar injection via shell)
- Timeout padrão: 5 minutos para builds, 30 segundos para jdeprscan
- Nunca interpolar args em string — sempre passar como array separado

### 3.4 Módulo de configuração

**Arquivo:** `src/lib/config.ts`

```typescript
export interface JdkMigrationConfig {
  sourceJdk: '6' | '8'
  targetJdk: '21'
  stack: StackType[]
  buildSystem: 'maven' | 'gradle' | 'ant'
  appServer: 'weblogic' | 'jboss' | 'tomcat' | 'liberty' | null
  multiModule: boolean
  modulePaths: string[]
  ciSystem: 'github-actions' | 'jenkins' | 'gitlab-ci' | null
  testCoverageThreshold: number
  dryRunBeforeExecute: boolean
  phases: Record<PhaseNumber, PhaseState>
}

export type PhaseNumber = 0 | 1 | 2 | 3 | 4 | 5
export type PhaseStatus = 'pending' | 'in_progress' | 'awaiting_gate' | 'approved' | 'completed' | 'failed' | 'rolled_back'

export interface PhaseState {
  status: PhaseStatus
  gateToken: string | null
  approvedBy: string | null
  approvedAt: string | null  // ISO 8601
  executedAt: string | null
  gitBranch: string | null
  gitCommit: string | null
}

export function readConfig(projectPath: string): JdkMigrationConfig
export function writeConfig(projectPath: string, config: JdkMigrationConfig): void
export function configExists(projectPath: string): boolean
```

### 3.5 Skill de instalação

**Arquivo:** `src/skill/install.ts`

A Skill é invocada pelo agente durante a instalação na aplicação-alvo. Ela:
1. Detecta build system (presença de `pom.xml`, `build.gradle`, `build.xml`)
2. Lê versão do JDK no build file (`<java.version>`, `sourceCompatibility`)
3. Detecta tecnologias (dependências no build file como `spring-boot-starter-*`, `ejb`, `jsf`)
4. Pergunta o que não puder inferir (via tool `approve_gate` ou resposta textual)
5. Grava `jdk-migration.config.json` na raiz da aplicação-alvo

```typescript
export interface StackDetectionResult {
  buildSystem: 'maven' | 'gradle' | 'ant' | 'unknown'
  detectedJdk: string | null
  detectedStacks: StackType[]
  confidence: 'high' | 'medium' | 'low'
  unresolved: string[]  // campos que precisam de input humano
}

export type StackType = 'rest' | 'spring-boot' | 'spring-batch' | 'ejb' | 'jsf' | 'weblogic'

export async function detectStack(projectPath: string): Promise<StackDetectionResult>
export async function writeInitialConfig(projectPath: string, answers: Partial<JdkMigrationConfig>): Promise<void>
```

**Lógica de detecção Maven (`pom.xml`):**
- `<artifactId>spring-boot-starter-*</artifactId>` → stack: spring-boot
- `<artifactId>spring-batch-core</artifactId>` → stack: spring-batch
- `<artifactId>javax.ejb*</artifactId>` ou `<packaging>ejb</packaging>` → stack: ejb
- `<artifactId>jsf-api</artifactId>` ou `primefaces` → stack: jsf
- `<artifactId>weblogic</artifactId>` ou `<artifactId>wls-api</artifactId>` → appServer: weblogic
- `<java.version>` ou `<maven.compiler.source>` → detectedJdk

**Lógica de detecção Gradle (`build.gradle` / `build.gradle.kts`):**
- `sourceCompatibility = '1.8'` ou `= JavaVersion.VERSION_1_8` → detectedJdk: 8
- `implementation 'org.springframework.boot:spring-boot-starter*'` → stack: spring-boot
- `implementation 'javax.ejb:javax.ejb-api'` → stack: ejb

**Gate da Skill:** se `confidence === 'low'` ou se `unresolved.length > 0`, a Skill retorna uma mensagem pedindo confirmação humana antes de gravar a config.

### 3.6 Registro no MCP host

**Arquivo:** `.claude/settings.json` — adicionar entrada de MCP server após build:

```json
{
  "mcpServers": {
    "jdk-migration": {
      "command": "node",
      "args": ["dist/mcp-server/index.js"]
    }
  }
}
```

> Durante desenvolvimento, usar `tsx src/mcp-server/index.ts` via `npm run dev`.

### 3.7 Tarefas desta etapa (checklist)

- [ ] `npm init` / instalar dependências (`@modelcontextprotocol/sdk`, `zod`, `tsx`, `vitest`, `typescript`)
- [ ] `src/lib/errors.ts` — tipos de erro
- [ ] `src/lib/process-runner.ts` — wrapper de spawn
- [ ] `src/lib/config.ts` — leitura/escrita de `jdk-migration.config.json`
- [ ] `src/mcp-server/index.ts` — server bootstrap
- [ ] `src/mcp-server/tools/discover-project.ts` — mock
- [ ] `src/mcp-server/tools/build-migration-plan.ts` — mock
- [ ] `src/mcp-server/tools/execute-phase.ts` — mock
- [ ] `src/mcp-server/tools/auxiliary.ts` — get_phase_status, approve_gate (funcional), rollback_phase (mock), generate_report (mock)
- [ ] `src/skill/install.ts` — detecção de stack + wizard
- [ ] `tests/unit/config.test.ts` — read/write config
- [ ] `tests/unit/skill-detect.test.ts` — detecção de stack para fixtures Maven e Gradle
- [ ] `.claude/settings.json` — registro do MCP server
- [ ] Validar: `npm run build` e `npm run typecheck` sem erros

**Gate de desenvolvimento E1:** Server registrável no Claude Code; tool `get_phase_status` retorna JSON correto para app-fixture; `approve_gate` grava token persistido; testes unitários passando.

---

## 4. Etapa 2 — Diagnóstico real (Semanas 3–4)

**Objetivo:** `discover_project` funcionando de verdade — detecta stack, roda jdeprscan/jdeps, mapeia APIs removidas, produz `DiscoveryReport` estruturado.

**Criticidade de implementação:** Baixa-Média

### 4.1 Módulo Static Analysis

**Arquivo:** `src/static-analysis/index.ts`

```typescript
export interface DeprecatedApiItem {
  className: string
  member: string | null
  removedInJdk: number
  replacement: string | null
  file: string | null
  line: number | null
}

export interface DependencyRisk {
  groupId: string
  artifactId: string
  version: string
  hasJakartaEquivalent: boolean
  jakartaVersion: string | null
  needsEclipseTransformer: boolean
  note: string | null
}

export interface StaticAnalysisResult {
  jdeprscanItems: DeprecatedApiItem[]
  unsupportedDependencies: DependencyRisk[]
  jdepsViolations: string[]      // acesso a internals JDK
  runtimeWarnings: string[]      // --add-opens, --add-exports legados
  analysisTimestamp: string
}

export async function runStaticAnalysis(
  projectPath: string,
  buildSystem: 'maven' | 'gradle',
  sourceJdk: '6' | '8',
  targetJdk: '21'
): Promise<StaticAnalysisResult>
```

**Implementação de `runStaticAnalysis`:**

1. Localizar JDK 21 instalado: verificar `JAVA_HOME`, fallback para `java --version` no PATH
2. Identificar classpath compilado: para Maven, rodar `mvn dependency:build-classpath -q -Dmdep.outputFile=.jdk-migration/classpath.txt`; para Gradle, `gradle dependencies --configuration runtimeClasspath`
3. Rodar `jdeprscan --release 21 --class-path <classpath> <compiled-dir>` — parsear saída texto
4. Rodar `jdeps --multi-release 21 --generate-module-info .jdk-migration/module-info/ <jar>` para detectar split packages e dependências de internals
5. Parsear cada item para `DeprecatedApiItem`

**APIs críticas a mapear (hardcoded no Knowledge Base — ver seção 4.2):**

| API removida | Removida em | Substituto |
|---|---|---|
| `Thread.stop()` / `Thread.suspend()` | JDK 19 | loop com flag |
| `SecurityManager` | JDK 17 (deprecated), JDK 21 (removido) | nenhum direto |
| `sun.misc.BASE64Encoder/Decoder` | JDK 9 | `java.util.Base64` |
| `javax.*` (Java EE) | JDK 11 | `jakarta.*` |
| `com.sun.image.codec.jpeg` | JDK 9 | `javax.imageio` |
| `PermGen` flags JVM | JDK 8 | Metaspace |
| `finalize()` override | JDK 18 (deprecated) | `Cleaner` |
| CORBA classes | JDK 11 | dependência externa |
| `javax.xml.bind (JAXB)` | JDK 11 | `jakarta.xml.bind` + dep |

### 4.2 Knowledge Base

**Arquivo:** `src/knowledge-base/index.ts`

```typescript
export interface KnowledgeEntry {
  apiPattern: string          // regex ou nome completo
  removedInJdk: number
  jep: string | null          // ex: "JEP-320"
  severity: 'critical' | 'high' | 'medium' | 'low'
  replacement: string | null
  recipe: string | null       // recipe OpenRewrite se existir
  affectsStacks: StackType[]
  migrationNote: string
}

export function getEntriesForJdk(sourceJdk: number, targetJdk: number): KnowledgeEntry[]
export function correlate(staticResult: StaticAnalysisResult): EnrichedIssue[]
```

**Arquivo:** `src/knowledge-base/data/jdk6-to-21.json`  
**Arquivo:** `src/knowledge-base/data/jdk8-to-21.json`

Estes arquivos JSON populam a base. Inicialmente com as entradas críticas catalogadas acima; expandir ao longo do projeto.

### 4.3 Stack Detector

**Arquivo:** `src/skill/stack-detector.ts` (extraído da Skill para uso no discover_project)

Expandir a detecção além dos arquivos de build:
- Verificar imports em arquivos `.java`: `import javax.ejb.`, `import javax.faces.`, `import org.springframework.batch.`
- Verificar `web.xml`, `faces-config.xml`, `ejb-jar.xml`, `weblogic.xml`, `weblogic-ejb-jar.xml`
- Verificar estrutura de diretórios: presença de `src/main/webapp/WEB-INF/`

### 4.4 Discovery Report

**Arquivo:** `src/mcp-server/tools/discover-project.ts` — substituir mock pela implementação real

```typescript
export interface DiscoveryReport {
  projectPath: string
  timestamp: string
  sourceJdk: string
  detectedStacks: StackType[]
  buildSystem: 'maven' | 'gradle' | 'ant' | 'unknown'
  isMultiModule: boolean
  moduleGraph: ModuleNode[] | null
  staticAnalysis: StaticAnalysisResult
  knowledgeCorrelation: EnrichedIssue[]
  testCoverageEstimate: number | null
  riskSummary: {
    critical: number
    high: number
    medium: number
    low: number
    manualReviewRequired: boolean
    estimatedEffortDays: number
  }
  savedReportPath: string   // .jdk-migration/discovery-report.json
}
```

O relatório é persistido em `<projectPath>/.jdk-migration/discovery-report.json` e referenciado pelo `build_migration_plan`.

### 4.5 Tarefas desta etapa (checklist)

- [ ] `src/knowledge-base/data/jdk8-to-21.json` — entradas críticas (mínimo 20 APIs)
- [ ] `src/knowledge-base/data/jdk6-to-21.json` — superconjunto do anterior
- [ ] `src/knowledge-base/index.ts` — getEntriesForJdk, correlate
- [ ] `src/static-analysis/jdeprscan-runner.ts` — executor + parser
- [ ] `src/static-analysis/jdeps-runner.ts` — executor + parser
- [ ] `src/static-analysis/index.ts` — orquestra os dois
- [ ] `src/skill/stack-detector.ts` — detecção profunda (imports Java + XML deployment descriptors)
- [ ] `src/mcp-server/tools/discover-project.ts` — substituir mock pela implementação
- [ ] `tests/unit/static-analysis.test.ts` — com fixtures Java pré-compiladas
- [ ] `tests/unit/knowledge-base.test.ts` — correlação de issues
- [ ] `tests/integration/discover-project.test.ts` — contra `tests/fixtures/jdk8-spring-boot`
- [ ] Criar `tests/fixtures/jdk8-spring-boot/` — app Spring Boot 2.x mínima com JDK 8 (pom.xml + 1 controller + 1 service com API deprecada)
- [ ] Criar `tests/fixtures/jdk6-app/` — app Maven básica com JDK 6

**Gate de desenvolvimento E2:** `discover_project` retorna relatório com riskSummary para a fixture `jdk8-spring-boot`; jdeprscan detecta pelo menos 1 API removida na fixture; knowledge base correlaciona corretamente.

---

## 5. Etapa 3 — Orchestrator (Semanas 5–6)

**Objetivo:** Máquina de estados completa para as 6 fases, gate-validator com tokens criptográficos, gerenciamento de branches Git, rollback automático.

**Criticidade de implementação:** Alta — é a camada que garante a governança

### 5.1 State Machine

**Arquivo:** `src/orchestrator/state-machine.ts`

**Transições de estado permitidas:**

```
pending → in_progress (ao iniciar execute_phase)
in_progress → awaiting_gate (ao concluir execução sem falha)
in_progress → failed (falha de build ou testes)
awaiting_gate → approved (após approve_gate com token válido)
approved → completed (confirmação pós-gate, antes da próxima fase)
failed → pending (após rollback)
awaiting_gate → rolled_back (rollback manual pelo humano)
```

**Regra crítica:** A transição de `phaseN.approved` para `phaseN+1.in_progress` SÓ ocorre se o token do gate N foi registrado. O Orchestrator não presume aprovação.

```typescript
export function canExecutePhase(config: JdkMigrationConfig, phase: PhaseNumber): boolean {
  if (phase === 0) return config.phases[0].status === 'pending'
  const previous = config.phases[(phase - 1) as PhaseNumber]
  return previous.status === 'approved' || previous.status === 'completed'
}

export function validateGateToken(config: JdkMigrationConfig, phase: PhaseNumber, token: string): boolean
```

### 5.2 Gate Validator e geração de tokens

**Arquivo:** `src/orchestrator/gate-validator.ts`

- Token = `HMAC-SHA256(projectPath + phaseNumber + timestamp, secret)` onde secret = hash SHA256 do `projectPath` (deterministicamente derivado, sem necessidade de chave externa)
- Token persistido no `phases[N].gateToken` do config
- Validade: 30 dias (para não bloquear projetos longos, mas evitar tokens esquecidos)
- Uma vez usado para avançar de fase, o token é marcado como `consumed`

```typescript
export function generateGateToken(projectPath: string, phase: PhaseNumber): string
export function validateGateToken(token: string, projectPath: string, phase: PhaseNumber): boolean
export function consumeGateToken(config: JdkMigrationConfig, phase: PhaseNumber): JdkMigrationConfig
```

### 5.3 Git Checkpoint

**Arquivo:** `src/orchestrator/git-checkpoint.ts`

```typescript
export interface GitCheckpoint {
  branchName: string   // jdk-migration/phase-N-YYYYMMDD-HHmmss
  baseCommit: string
  phaseCommit: string | null
}

export async function createPhaseBranch(projectPath: string, phase: PhaseNumber): Promise<GitCheckpoint>
export async function commitPhaseChanges(projectPath: string, phase: PhaseNumber, message: string): Promise<string>
export async function rollbackPhase(projectPath: string, checkpoint: GitCheckpoint): Promise<void>
export async function isWorkdirClean(projectPath: string): Promise<boolean>
export async function createPullRequest(projectPath: string, phase: PhaseNumber, report: string): Promise<string | null>
```

**Regras:**
- `execute_phase` falha imediatamente se `isWorkdirClean()` retorna `false` — o workdir da app-alvo deve estar limpo antes de qualquer fase
- Nome da branch: `jdk-migration/phase-{N}-{timestamp}` — nunca operar na branch principal
- `createPullRequest` usa `gh pr create` se `gh` estiver disponível; retorna `null` caso contrário, sem falhar
- Rollback: `git checkout {baseCommit} -- .` + `git stash drop` — nunca `git reset --hard` na branch principal

### 5.4 Build Validator

**Arquivo:** `src/orchestrator/build-validator.ts`

```typescript
export interface BuildResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  failureReason: 'compilation' | 'tests' | 'timeout' | null
  testsPassed: number | null
  testsFailed: number | null
}

export async function runBuild(projectPath: string, buildSystem: 'maven' | 'gradle'): Promise<BuildResult>
export async function runTests(projectPath: string, buildSystem: 'maven' | 'gradle'): Promise<BuildResult>
```

- Maven: `mvn clean verify -B -q` (com timeout 10 min)
- Gradle: `gradle build -q` (com timeout 10 min)
- Em caso de `failureReason === 'compilation'`: rollback imediato, sem rodar testes
- Em caso de `failureReason === 'tests'`: rollback imediato, preservar log de falhas no relatório

### 5.5 `execute_phase` — implementação real

**Arquivo:** `src/mcp-server/tools/execute-phase.ts` — substituir mock

```typescript
const ExecutePhaseInput = z.object({
  projectPath: z.string(),
  phaseNumber: z.number().int().min(0).max(5),
  gateToken: z.string().describe('Token gerado por approve_gate na fase anterior'),
  dryRun: z.boolean().default(false).describe('Se true, preview do diff sem aplicar mudanças')
})
```

**Fluxo de execute_phase:**

```
1. readConfig(projectPath)
2. canExecutePhase(config, phase) → MigrationError('PHASE_OUT_OF_ORDER') se false
3. validateGateToken(config, phase, gateToken) → MigrationError('GATE_TOKEN_INVALID') se false
4. isWorkdirClean(projectPath) → MigrationError('GIT_DIRTY_WORKDIR') se false
5. Se dryRun: TransformEngine.dryRun(phase) → retorna diff sem aplicar
6. createPhaseBranch(projectPath, phase)
7. updatePhaseStatus(config, phase, 'in_progress')
8. TransformEngine.execute(phase, config)
9. Se falha: rollbackPhase(...) + updatePhaseStatus('failed') + retorna erro
10. runBuild + runTests
11. Se falha: rollbackPhase(...) + updatePhaseStatus('failed') + retorna erro com log
12. commitPhaseChanges(...)
13. updatePhaseStatus(config, phase, 'awaiting_gate')
14. Emitir instrução para humano: "Execute approve_gate({phase}) para liberar fase seguinte"
15. createPullRequest(...)
16. retorna PhaseExecutionResult com diff summary + link PR + instrução de gate
```

### 5.6 Tarefas desta etapa (checklist)

- [ ] `src/orchestrator/state-machine.ts` — transições + canExecutePhase
- [ ] `src/orchestrator/gate-validator.ts` — geração, validação, consumo de tokens
- [ ] `src/orchestrator/git-checkpoint.ts` — createPhaseBranch, commit, rollback, isWorkdirClean
- [ ] `src/orchestrator/build-validator.ts` — runBuild, runTests para Maven e Gradle
- [ ] `src/mcp-server/tools/execute-phase.ts` — substituir mock pela implementação real (sem TransformEngine real ainda — usar mock de transform que toca apenas 1 arquivo de teste)
- [ ] `src/mcp-server/tools/auxiliary.ts` — rollback_phase e get_phase_status funcionais
- [ ] `tests/unit/state-machine.test.ts` — todas as transições válidas e inválidas
- [ ] `tests/unit/gate-validator.test.ts` — geração, validação e expiração de tokens
- [ ] `tests/unit/git-checkpoint.test.ts` — criar branch, commit, rollback em repo temporário
- [ ] `tests/integration/execute-phase-mock.test.ts` — fluxo completo com transform mock

**Gate de desenvolvimento E3:** Execute_phase com mock de transform completa um ciclo: cria branch → "transforma" → build → testes → gate token emitido → próxima fase liberada; rollback funciona em falha de build.

---

## 6. Etapa 4 — Transform Engine (Semanas 7–8)

**Objetivo:** Integração real com OpenRewrite; `execute_phase` aplica transformações verdadeiras; piloto validado com microservice REST stateless.

**Criticidade de implementação:** Média-Alta

### 6.1 OpenRewrite Runner

**Arquivo:** `src/transform-engine/openrewrite-runner.ts`

```typescript
export interface OpenRewriteResult {
  recipesApplied: string[]
  filesModified: number
  filesAdded: number
  filesDeleted: number
  diffSummary: string
  fullDiff: string
  warnings: string[]
}

export async function runRecipes(
  projectPath: string,
  recipes: string[],
  buildSystem: 'maven' | 'gradle',
  dryRun: boolean
): Promise<OpenRewriteResult>
```

**Para Maven:** OpenRewrite é executado como plugin. O runner injeta temporariamente o plugin no `pom.xml` se não estiver presente (ou usa o `rewrite-maven-plugin` via `-Dplugin=`):

```xml
<!-- Injetar via -Dplugin para não poluir o pom.xml original -->
mvn -U org.openrewrite.maven:rewrite-maven-plugin:run \
    -Drewrite.activeRecipes=org.openrewrite.java.migrate.UpgradeToJava21 \
    -Drewrite.exportDatatables=true
```

**Para dryRun:** usar `rewrite:dryRun` ao invés de `rewrite:run` — gera diff sem modificar arquivos.

**Recipes por fase:**

| Fase | Recipes OpenRewrite | Quando aplicar |
|---|---|---|
| 1 (Build) | `AddMavenPlugin` para compiler target 21, `ChangePluginConfiguration` | Sempre |
| 2 (Linguagem) | `org.openrewrite.java.migrate.UpgradeToJava21` | Sempre |
| 2 (Linguagem) | `org.openrewrite.java.migrate.Java8toJava11`, `Java11toJava17` | JDK 6 path |
| 3 (Jakarta) | `org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta` | Se stack tem jakarta |
| 3 (Spring Boot) | `org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_0` | Se stack tem spring-boot |
| 3 (Spring Batch) | `org.openrewrite.java.spring.batch.SpringBatch4To5Migration` | Se stack tem spring-batch |
| 3 (WebLogic) | Recipes do `oracle/rewrite-recipes` | Se appServer === weblogic |

**Arquivo:** `src/transform-engine/recipe-selector.ts`

```typescript
export function selectRecipes(phase: PhaseNumber, config: JdkMigrationConfig): string[]
```

Centraliza a lógica de seleção: qual recipe aplicar em qual fase para qual stack.

### 6.2 Spring Boot Migrator Runner

**Arquivo:** `src/transform-engine/sbm-runner.ts`

- Usado como complemento ao OpenRewrite para Spring Boot 2→3
- Verificar se `sbm` está disponível no PATH; se não, download automático do JAR do Maven Central
- Rodar: `java -jar sbm.jar apply --recipe upgrade-spring-boot-3.0`

```typescript
export async function runSpringBootMigrator(
  projectPath: string,
  recipe: string,
  dryRun: boolean
): Promise<OpenRewriteResult>
```

### 6.3 Eclipse Transformer Runner

**Arquivo:** `src/transform-engine/eclipse-transformer-runner.ts`

- Usado para JARs de dependências sem versão jakarta nativa
- Identificados pelo Stack Profiler como `needsEclipseTransformer: true`
- Transforma o JAR: `java -jar org.eclipse.transformer.jar <input.jar> <output.jar>`

```typescript
export async function transformJar(inputPath: string, outputPath: string): Promise<void>
```

### 6.4 Transform Engine — orquestrador

**Arquivo:** `src/transform-engine/index.ts`

```typescript
export async function executePhaseTransform(
  phase: PhaseNumber,
  config: JdkMigrationConfig,
  projectPath: string,
  dryRun: boolean
): Promise<TransformResult>
```

Seleciona qual runner usar (OpenRewrite / SBM / Eclipse Transformer) com base na fase e stack, e delega. Retorna `TransformResult` com diff consolidado.

### 6.5 Piloto: Microservice REST stateless

Criar `tests/fixtures/rest-microservice/` com:
- Spring Boot 2.7 + JDK 8
- 1 controller REST com `@RestController`
- 1 uso de `sun.misc.BASE64Encoder` (API removida)
- 1 dependência com `javax.servlet` (a ser migrada para `jakarta.servlet`)
- `pom.xml` com `java.version = 1.8`
- Testes unitários com JUnit 4 (a serem migrados para JUnit 5)

Validar que o fluxo completo Fase 0 → Fase 1 → Fase 2 → Fase 3 roda sem intervenção além dos gates.

### 6.6 Tarefas desta etapa (checklist)

- [ ] `src/transform-engine/recipe-selector.ts` — seleção por fase + stack
- [ ] `src/transform-engine/openrewrite-runner.ts` — Maven + dryRun
- [ ] `src/transform-engine/openrewrite-runner.ts` — suporte a Gradle
- [ ] `src/transform-engine/sbm-runner.ts` — download automático + execução
- [ ] `src/transform-engine/eclipse-transformer-runner.ts`
- [ ] `src/transform-engine/index.ts` — orquestrador
- [ ] `src/mcp-server/tools/execute-phase.ts` — conectar TransformEngine real
- [ ] `tests/fixtures/rest-microservice/` — app fixture para piloto
- [ ] `tests/integration/full-flow-rest.test.ts` — ciclo completo fases 0–3 na fixture
- [ ] Atualizar `tests/fixtures/jdk8-spring-boot/` com mais casos de borda

**Gate de desenvolvimento E4:** Fixture `rest-microservice` passa pelo ciclo fases 0–3 com transformações reais do OpenRewrite; `dryRun: true` mostra diff correto sem modificar arquivos; build da fixture fica verde no JDK 21 após fases 1–2.

---

## 7. Etapa 5 — Profilers críticos (Semanas 9–11)

**Objetivo:** Stack Profilers para Spring Boot, Spring Batch e Jakarta (os de maior cobertura no portfólio típico).

**Criticidade de implementação:** Alta

### 7.1 Interface comum dos Profilers

**Arquivo:** `src/profilers/types.ts`

```typescript
export interface StackProfiler {
  stackType: StackType
  analyze(projectPath: string, config: JdkMigrationConfig): Promise<ProfilerReport>
  getRiskItems(report: ProfilerReport): RiskItem[]
  getRecipes(phase: PhaseNumber, report: ProfilerReport): string[]
  getManualReviewItems(report: ProfilerReport): ManualReviewItem[]
}

export interface RiskItem {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  description: string
  file: string | null
  line: number | null
  automationAvailable: boolean
  recipe: string | null
}

export interface ManualReviewItem {
  id: string
  category: 'semantic' | 'security' | 'behavioral' | 'ui'
  title: string
  description: string
  suggestedApproach: string
  files: string[]
}

export interface ProfilerReport {
  stackType: StackType
  riskItems: RiskItem[]
  manualReviewItems: ManualReviewItem[]
  estimatedEffortDays: number
  prerequisiteChecks: PrerequisiteCheck[]
}
```

### 7.2 Spring Boot Profiler

**Arquivo:** `src/profilers/spring-boot/index.ts`

**O que detecta e reporta:**

| Item | Severidade | Automação |
|---|---|---|
| Spring Boot 2.x → 3.x (exige JDK 17+) | Alta | OpenRewrite recipe |
| `javax.*` → `jakarta.*` em imports | Alta | Recipe JakartaEE9 |
| Spring Security 5 → 6 (mudanças de config) | Alta | Parcial — revisar SecurityFilterChain |
| `WebSecurityConfigurerAdapter` removido | Alta | Recipe disponível |
| `spring.security.oauth2` propriedades mudadas | Média | Manual |
| `RestTemplate` → `WebClient` (recomendado, não obrigatório) | Baixa | Manual |
| `@SpringBootTest` sem webEnvironment explícito | Baixa | Recipe disponível |
| Atuadores (`/actuator`) com auth mudada | Alta | Manual — validar endpoints |
| `spring.datasource.*` legado | Média | Recipe disponível |

**Análise de `pom.xml`:**
- Versão do `spring-boot-starter-parent` ou `spring-boot-dependencies` BOM
- Se `< 3.0.0`: sinalizar necessidade de upgrade (via SBM)
- Listar dependências com conflito de versão após o upgrade

### 7.3 Spring Batch Profiler

**Arquivo:** `src/profilers/spring-batch/index.ts`

**O que detecta:**

| Item | Severidade | Automação |
|---|---|---|
| `@EnableBatchProcessing` com `dataSource` bean | Alta | Recipe Spring Batch 4→5 |
| `JobBuilderFactory` / `StepBuilderFactory` (removidos no Batch 5) | Alta | Recipe disponível |
| `JobRepository` configuration via `JobRepositoryFactoryBean` | Alta | Parcial |
| `MapJobRepositoryFactoryBean` (removido no Batch 5) | Crítica | Manual |
| Chunk-oriented processing com `ItemProcessor<I,O>` legado | Média | Manual |
| `JobLauncher.run()` com `JobParameters` legado | Média | Recipe parcial |
| Configuração de `DataSourceTransactionManager` implícita | Alta | Manual |

**Scan de código Java:**
- Buscar por `JobBuilderFactory`, `StepBuilderFactory` via grep em `src/**/*.java`
- Buscar por `@EnableBatchProcessing`
- Identificar padrão de configuração (XML vs annotation)

### 7.4 Jakarta Namespace Profiler (transversal)

**Arquivo:** `src/profilers/jakarta/index.ts`

Usado por spring-boot, jsf e ejb — centraliza a lógica de detecção `javax → jakarta`.

**O que detecta:**

| Pacote javax | Substituto jakarta | Recipe |
|---|---|---|
| `javax.persistence.*` | `jakarta.persistence.*` | Recipe JPA |
| `javax.servlet.*` | `jakarta.servlet.*` | Recipe Servlet |
| `javax.validation.*` | `jakarta.validation.*` | Recipe Bean Validation |
| `javax.transaction.*` | `jakarta.transaction.*` | Recipe JTA |
| `javax.faces.*` | `jakarta.faces.*` | Recipe Faces |
| `javax.ejb.*` | `jakarta.ejb.*` | Recipe EJB |
| `javax.xml.bind.*` (JAXB) | `jakarta.xml.bind.*` + dep | Recipe JAXB |
| `javax.ws.rs.*` (JAX-RS) | `jakarta.ws.rs.*` | Recipe JAX-RS |

**Scan:** grep recursivo em `src/**/*.java` e `src/**/*.xml` para padrões `import javax\.`.

### 7.5 Tarefas desta etapa (checklist)

- [ ] `src/profilers/types.ts` — interfaces comuns
- [ ] `src/profilers/spring-boot/index.ts` — profiler completo
- [ ] `src/profilers/spring-batch/index.ts` — profiler completo
- [ ] `src/profilers/jakarta/index.ts` — profiler transversal
- [ ] `src/profilers/rest/index.ts` — profiler REST (simples: apenas corrobora que não tem EJB/JSF)
- [ ] `src/orchestrator/profiler-registry.ts` — mapeia StackType → StackProfiler
- [ ] Integrar profilers no `discover_project` (incluir ProfilerReport no DiscoveryReport)
- [ ] Integrar profilers no `build_migration_plan` (incluir ManualReviewItems no plano)
- [ ] Atualizar `recipe-selector.ts` para usar getRecipes() dos profilers
- [ ] `tests/unit/spring-boot-profiler.test.ts`
- [ ] `tests/unit/spring-batch-profiler.test.ts`
- [ ] `tests/integration/discover-spring-boot.test.ts` — usando fixture `jdk8-spring-boot`
- [ ] Criar `tests/fixtures/jdk8-spring-boot/` detalhada: Spring Boot 2.7, Spring Batch 4, JUnit 4, `@EnableBatchProcessing`, `javax.*` imports

**Gate de desenvolvimento E5:** Profiler Spring Boot detecta `WebSecurityConfigurerAdapter` e `javax.security` na fixture; `build_migration_plan` lista esses itens como manuais; Spring Batch detecta `JobBuilderFactory` como item crítico.

---

## 8. Etapa 6 — Stacks legadas (Semanas 12–13)

**Objetivo:** Profilers para EJB, JSF/PrimeFaces e WebLogic. Estes têm automação limitada — o foco é na qualidade do diagnóstico e da lista de revisão manual.

**Criticidade de implementação:** Crítica — erros aqui podem passar despercebidos e causar regressões em produção

### 8.1 EJB Profiler

**Arquivo:** `src/profilers/ejb/index.ts`

**Regra principal:** O profiler EJB NUNCA marca itens como `automationAvailable: true` para:
- `@Stateful` beans com `@Remove` e `@PreDestroy`
- `javax.ejb.SessionContext` usage
- `javax.transaction.UserTransaction` direto
- Chamadas remotas via `@Remote` interface
- `@EJB` injection em contextos não-gerenciados
- JNDI lookups manuais (`new InitialContext().lookup(...)`)

**O que detecta:**

| Item | Automação | Ação |
|---|---|---|
| `@Stateless` beans sem estado compartilhado | Parcial | Recipe jakarta namespace |
| `@Stateful` beans com estado | Nenhuma | ManualReviewItem — redesenho necessário |
| `@MessageDriven` (JMS) | Parcial | Recipe namespace; validar broker config |
| `@TransactionAttribute` CMA | Nenhuma | ManualReviewItem — validar semanticamente |
| `ejb-jar.xml` deployment descriptor | Parcial | Eclipse Transformer para namespace |
| RMI/IIOP remote interfaces | Nenhuma | ManualReviewItem — considerar REST/gRPC |
| `TimerService` legado | Parcial | Recipe namespace |

**Scan de código:**
- Grep por `@Stateful`, `@Stateless`, `@MessageDriven`, `@TransactionAttribute`
- Grep por `InitialContext`, `EJBHome`, `EJBLocalHome`
- Verificar `ejb-jar.xml`, `weblogic-ejb-jar.xml`

### 8.2 JSF / PrimeFaces Profiler

**Arquivo:** `src/profilers/jsf/index.ts`

**O que detecta:**

| Item | Automação | Ação |
|---|---|---|
| `@ManagedBean` (javax.faces.bean) | Parcial | Migrar para CDI `@Named` |
| `@ManagedProperty` | Parcial | Migrar para `@Inject` |
| Namespace `xmlns:h="http://java.sun.com/jsf"` em XHTML | Alta | Recipe Eclipse Transformer + sed |
| Namespace `xmlns:p="http://primefaces.org/ui"` — versão | Média | Atualizar para versão com classifier jakarta |
| `faces-config.xml` com beans gerenciados | Parcial | Migrar para beans.xml CDI |
| `PhaseListener` legado | Baixa | Recipe disponível |
| `ExternalContext.getRequest()` sem cast | Baixa | Ajuste manual |
| Client-ID rules mudadas no Faces 4 | Alta | **Manual** — podem quebrar JS/CSS |

**Scan de XHTML:**
- Verificar `src/main/webapp/**/*.xhtml` para namespaces legados
- Identificar `#{bean.property}` para mapear beans gerenciados
- Verificar `src/main/webapp/WEB-INF/faces-config.xml`

**Atenção especial — Client-ID Faces 4:**  
No JSF/Faces 4, o separador de client ID mudou de `:` para `_` por padrão em alguns casos, e o comportamento de componentes NamingContainer mudou. JavaScript que usa `document.getElementById('form:component')` pode quebrar silenciosamente. O profiler deve sinalizar TODOS os arquivos `.xhtml` com `<h:form>` como ManualReviewItem de categoria `ui`.

### 8.3 WebLogic Profiler

**Arquivo:** `src/profilers/weblogic/index.ts`

**Regra oficial Oracle:** Recipe de JDK ANTES do recipe de WebLogic. O profiler deve validar e reforçar essa ordem.

**O que detecta:**

| Item | Automação | Ação |
|---|---|---|
| `weblogic.xml` deployment descriptor | Alta | Recipe oracle/rewrite-recipes |
| `weblogic-ejb-jar.xml` | Alta | Recipe oracle/rewrite-recipes |
| Conectores JCA proprietários | Nenhuma | ManualReviewItem |
| Realms de segurança WebLogic | Nenhuma | ManualReviewItem |
| `weblogic.management.*` APIs proprietárias | Baixa | ManualReviewItem |
| T3 protocol usage | Nenhuma | ManualReviewItem — considerar REST |
| WLST scripts (.py) de deploy | Nenhuma | ManualReviewItem — validar compatibilidade |
| `weblogic-application.xml` | Alta | Recipe oracle/rewrite-recipes |

**Integração recipes Oracle:**  
O runner OpenRewrite precisa de acesso ao repositório `oracle/rewrite-recipes`. Adicionar ao `pom.xml` temporário da execução:

```xml
<plugin>
  <groupId>org.openrewrite.maven</groupId>
  <artifactId>rewrite-maven-plugin</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.oracle.weblogic.rewrite</groupId>
      <artifactId>rewrite-weblogic</artifactId>
      <version>LATEST</version>
    </dependency>
  </dependencies>
</plugin>
```

### 8.4 build_migration_plan — implementação real

**Arquivo:** `src/mcp-server/tools/build-migration-plan.ts` — substituir mock

```typescript
export interface MigrationPlan {
  projectPath: string
  generatedAt: string
  sourceJdk: string
  targetJdk: string
  detectedStacks: StackType[]
  phases: PhasePlan[]
  totalEstimatedDays: number
  manualReviewRequired: boolean
  summary: string  // texto em pt-BR para apresentar ao humano
}

export interface PhasePlan {
  number: PhaseNumber
  name: string
  criticality: 'low' | 'medium' | 'high' | 'critical'
  applicable: boolean   // false = fase pulada para esta stack
  estimatedDays: number
  automationLevel: 'high' | 'medium' | 'low' | 'none'
  recipes: string[]
  riskItems: RiskItem[]
  manualItems: ManualReviewItem[]
  gateDescription: string
  prerequisitesForHuman: string[]
}
```

O plano é persistido em `<projectPath>/.jdk-migration/migration-plan.json`.

### 8.5 Suporte a Gradle

**Arquivo:** `src/transform-engine/openrewrite-runner.ts` — adicionar suporte Gradle

Para Gradle, OpenRewrite é aplicado via plugin. O runner:
1. Verifica se `build.gradle` ou `build.gradle.kts` já tem o plugin
2. Se não: injeta via `settings.gradle` usando `pluginManagement` temporariamente (sem modificar o build file do usuário permanentemente)
3. Rodar: `gradle rewriteRun` / `gradle rewriteDryRun`

### 8.6 Módulo de Grafo de Dependências (multi-módulo)

**Arquivo:** `src/orchestrator/module-graph.ts`

Para projetos multi-módulo Maven (detectado por `<modules>` no pom.xml raiz):

```typescript
export interface ModuleNode {
  name: string
  path: string
  dependsOn: string[]  // outros módulos neste projeto
}

export function buildModuleGraph(projectPath: string): ModuleNode[]
export function getTopologicalOrder(graph: ModuleNode[]): string[]
```

A migração deve seguir a ordem topológica: módulos sem dependências internas primeiro.

### 8.7 Tarefas desta etapa (checklist)

- [ ] `src/profilers/ejb/index.ts` — profiler EJB com foco em ManualReviewItems
- [ ] `src/profilers/jsf/index.ts` — profiler JSF/PrimeFaces com scan de XHTML
- [ ] `src/profilers/weblogic/index.ts` — profiler WebLogic + validação de ordem de recipes
- [ ] `src/transform-engine/openrewrite-runner.ts` — suporte a Gradle
- [ ] `src/orchestrator/module-graph.ts` — suporte a projetos multi-módulo
- [ ] `src/mcp-server/tools/build-migration-plan.ts` — substituir mock pela implementação real
- [ ] `tests/fixtures/jdk8-ejb/` — app EJB mínima: `@Stateless`, `@Stateful`, `ejb-jar.xml`
- [ ] Criar `tests/fixtures/jdk8-jsf/` — app JSF: XHTML com namespace legado, `@ManagedBean`
- [ ] Criar `tests/fixtures/jdk8-weblogic/` — app com `weblogic.xml`, descritor de deploy
- [ ] `tests/unit/ejb-profiler.test.ts`
- [ ] `tests/unit/jsf-profiler.test.ts`
- [ ] `tests/unit/weblogic-profiler.test.ts`
- [ ] `tests/unit/module-graph.test.ts`
- [ ] `tests/integration/build-migration-plan.test.ts` — plano gerado para cada fixture

**Gate de desenvolvimento E6:** `build_migration_plan` para fixture EJB marca todos os `@Stateful` como ManualReviewItem de criticidade Crítica; fixture JSF sinaliza todos os XHTML com `<h:form>` para revisão de client-ID; WebLogic valida ordem JDK recipe before WebLogic recipe.

---

## 9. Etapa 7 — Endurecimento (Semana 14)

**Objetivo:** Documentação completa, trilha de auditoria, generate_report funcional, refino dos gates, release interno para pilotos controlados.

**Criticidade de implementação:** Média

### 9.1 generate_report — implementação real

**Arquivo:** `src/report-generator/index.ts`

```typescript
export interface AuditReport {
  projectPath: string
  reportGeneratedAt: string
  migrationSummary: {
    startedAt: string | null
    completedAt: string | null
    sourceJdk: string
    targetJdk: string
    stacks: StackType[]
    totalFilesModified: number
    totalPhasesCompleted: number
    totalPhasesRolledBack: number
  }
  phaseAudit: PhaseAuditEntry[]
  manualReviewsCompleted: ManualReviewCompletion[]
  openIssues: RiskItem[]
}

export interface PhaseAuditEntry {
  phase: PhaseNumber
  name: string
  status: PhaseStatus
  executedAt: string | null
  approvedBy: string | null
  approvedAt: string | null
  gitBranch: string | null
  gitCommit: string | null
  prUrl: string | null
  buildResult: 'passed' | 'failed' | null
  recipesApplied: string[]
  filesModified: number
}
```

O relatório é gerado em HTML (template simples) + JSON, salvo em `.jdk-migration/audit-report-{timestamp}.html`.

### 9.2 Trilha de auditoria imutável

Cada ação relevante (execute_phase, approve_gate, rollback_phase) deve append-only em `.jdk-migration/audit-log.jsonl` — uma entrada JSON por linha, nunca deletada.

```typescript
export function appendAuditEntry(projectPath: string, entry: AuditLogEntry): void
```

### 9.3 Validações de segurança da ferramenta

Antes de qualquer `execute_phase`:
- Verificar que o `projectPath` não é o próprio repositório da ferramenta (evitar auto-modificação)
- Verificar que não há secrets óbvios no diff gerado (`.env`, `application.properties` com `password=`, `secret=`)
- Verificar que as branches de migração anteriores foram mergeadas antes de criar nova (não acumular branches esquecidas)

**Arquivo:** `src/orchestrator/safety-checks.ts`

### 9.4 Documentação

**Arquivo:** `docs/GUIA_DE_USO.md` — guia de instalação e uso passo a passo

**Arquivo:** `docs/PERFIS_DE_STACK.md` — documento de referência para cada Stack Profiler (o que detecta, o que automatiza, o que é manual e por quê)

### 9.5 Tarefas desta etapa (checklist)

- [ ] `src/report-generator/index.ts` — geração de AuditReport em JSON
- [ ] `src/report-generator/html-renderer.ts` — template HTML do relatório
- [ ] `src/orchestrator/audit-log.ts` — append-only audit log (.jsonl)
- [ ] `src/orchestrator/safety-checks.ts` — validações de segurança pré-execução
- [ ] `src/mcp-server/tools/auxiliary.ts` — generate_report funcional
- [ ] Revisar todos os `ManualReviewItem` de EJB e JSF — garantir que `automationAvailable: false`
- [ ] `tests/unit/report-generator.test.ts`
- [ ] `tests/unit/audit-log.test.ts`
- [ ] `tests/integration/full-flow-spring-boot.test.ts` — ciclo completo fases 0–3 em Spring Boot
- [ ] `docs/GUIA_DE_USO.md`
- [ ] `docs/PERFIS_DE_STACK.md`
- [ ] Teste manual end-to-end em app piloto real (não-crítica)

**Gate de desenvolvimento E7 (release interno):** Ciclos completos de Fase 0–3 passam para REST e Spring Boot; generate_report produz HTML com trilha de auditoria; nenhum `@Stateful` ou `<h:form>` sem ManualReviewItem; release tag `v0.1.0-pilot`.

---

## 10. Contratos de tipos compartilhados

Todos os tipos abaixo devem estar em `src/types.ts` (ou `src/types/` se crescer):

```typescript
export type StackType = 'rest' | 'spring-boot' | 'spring-batch' | 'ejb' | 'jsf' | 'weblogic'
export type PhaseNumber = 0 | 1 | 2 | 3 | 4 | 5
export type PhaseStatus = 'pending' | 'in_progress' | 'awaiting_gate' | 'approved' | 'completed' | 'failed' | 'rolled_back'
export type BuildSystem = 'maven' | 'gradle' | 'ant'
export type AppServer = 'weblogic' | 'jboss' | 'tomcat' | 'liberty' | null
export type CiSystem = 'github-actions' | 'jenkins' | 'gitlab-ci' | null
export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low'
export type ManualReviewCategory = 'semantic' | 'security' | 'behavioral' | 'ui'
```

---

## 11. Estratégia de testes

### 11.1 Pirâmide de testes

```
           ┌─────────────┐
           │ integration │  3 testes (REST, Spring Boot, EJB)
          ┌┴─────────────┴┐
          │     unit      │  1 teste por módulo (≥ 12 arquivos)
         ┌┴───────────────┴┐
         │    fixtures     │  apps Java mínimas usadas pelos testes
         └─────────────────┘
```

### 11.2 Fixtures necessárias

| Fixture | JDK | Stack | Usado por |
|---|---|---|---|
| `tests/fixtures/jdk6-app/` | 6 | Maven básico | E2, E4 |
| `tests/fixtures/jdk8-spring-boot/` | 8 | Spring Boot 2.7, Batch 4 | E2, E5 |
| `tests/fixtures/jdk8-ejb/` | 8 | EJB 3, JTA, `ejb-jar.xml` | E6 |
| `tests/fixtures/jdk8-jsf/` | 8 | JSF 2.3, PrimeFaces 8 | E6 |
| `tests/fixtures/jdk8-weblogic/` | 8 | WebLogic descriptors | E6 |
| `tests/fixtures/rest-microservice/` | 8 | Spring Boot 2.7 REST stateless | E4 |

Cada fixture deve ter:
- `pom.xml` ou `build.gradle` com versão correta
- Código Java mínimo que exercita os casos detectados pelo profiler
- `README.md` descrevendo o que a fixture representa e quais issues deve disparar

### 11.3 Testes de contrato MCP

Verificar que todas as tools registradas no servidor:
1. Aceitam inputs inválidos com erro tipado (não crash)
2. Retornam estrutura `{ content: [{ type: 'text', text: string }] }`
3. Nunca retornam dados sensíveis (senhas, tokens de ambiente)

---

## 12. Riscos técnicos e mitigações

| Risco | Etapa afetada | Mitigação |
|---|---|---|
| JDK 21 não instalado no sistema onde roda o MCP | E2+ | `discover_project` verifica JAVA_HOME e falha com mensagem clara antes de qualquer análise |
| OpenRewrite recipe desatualizado quebra código | E4 | Sempre rodar `dryRun` primeiro; validar com build antes de commit |
| `git` não disponível no PATH da app-alvo | E3 | Verificar na Skill de instalação; bloquear `execute_phase` com mensagem |
| Projeto Maven com `<distributionManagement>` publica ao buildar | E3 | Injetar `-Dmaven.deploy.skip=true` em todos os builds da ferramenta |
| Race condition: múltiplas invocações paralelas de `execute_phase` | E3+ | Lock file `.jdk-migration/lock` criado no início de `execute_phase` e removido ao final |
| Classpath de 500+ JARs torna jdeprscan lento (> 10 min) | E2 | Timeout configurável; rodar jdeprscan em paralelo por módulo em projetos multi-módulo |
| Stack Profiler classifica incorretamente (false positive EJB) | E5, E6 | Score de confiança por item; threshold configurável antes de sinalizar ManualReviewItem |
| `approve_gate` chamado por automação (CI) sem humano real | E3 | Log de audit com IP/agente; `approverName` obrigatório e não pode ser string vazia ou "bot" |
| Projeto com submodules Git quebra `createPhaseBranch` | E3 | Detectar `.gitmodules` e avisar; não operar em submodules automaticamente |
| Eclipse Transformer produz JAR com bytecode inválido | E6 | Rodar `java -jar <transformedJar>` como smoke test após transformação |

---

> **Próximo passo imediato:** Implementar a **Etapa 1 — Fundação**.  
> Começar por: `npm install` → `src/lib/errors.ts` → `src/lib/config.ts` → `src/mcp-server/index.ts`  
> Validar com: `npm run build && npm run typecheck`
