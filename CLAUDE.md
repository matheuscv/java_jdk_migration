# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Visão geral do projeto

Ferramenta MCP (Model Context Protocol) que orquestra a migração de aplicações Java legadas de **JDK 6 e JDK 8 para JDK 21**. Não reimplementa transformações — ela orquestra ferramentas maduras do ecossistema (OpenRewrite, Spring Boot Migrator, Eclipse Transformer) e impõe governança human-in-the-loop com gates obrigatórios entre fases.

**Proposta técnica completa:** `docs/Proposta_Tecnico_Funcional_Migracao_jdks8e9_jdk21_1.html`

## Arquitetura em camadas

```
MCP Surface          ← tools expostas ao agente de IA
Install Skill        ← parametriza a ferramenta para a aplicação-alvo
Orchestrator         ← máquina de estados, gates, branches Git
Stack Profilers      ← módulos especializados por tecnologia
Transform Engine     ← orquestra OpenRewrite / SBM / Eclipse Transformer
Static Analysis      ← jdeprscan, jdeps, javac --release
Knowledge Base       ← APIs removidas, JEPs, matrizes de compatibilidade
```

## Estrutura de diretórios

```
src/
  mcp-server/        ← servidor MCP (entry point, registro de tools)
    tools/           ← implementação de cada MCP tool
    resources/       ← recursos MCP expostos
  skill/             ← Skill de instalação e parametrização
  orchestrator/      ← máquina de estados, gate-validator, git-checkpoint
  profilers/
    rest/            ← microservices REST stateless (baixa complexidade)
    spring-boot/     ← Spring Boot 2→3, javax→jakarta, Security 6
    spring-batch/    ← Spring Batch 5, novo modelo de jobs
    ejb/             ← EJB stateful/stateless, JTA (crítico — sem automação total)
    jsf/             ← JSF/PrimeFaces, CDI, Faces 4 (crítico)
    weblogic/        ← recipes Oracle oficiais (rewrite-weblogic)
  transform-engine/  ← integração com OpenRewrite, SBM, Eclipse Transformer
  static-analysis/   ← wrapper de jdeprscan/jdeps
  knowledge-base/    ← índice de APIs removidas por versão, JEPs
  report-generator/  ← relatórios de diagnóstico e auditoria
config/
  templates/         ← templates de jdk-migration.config.json por stack
tests/
  unit/
  integration/
  fixtures/          ← apps Java de exemplo para testes (jdk6-app, jdk8-spring-boot, jdk8-ejb)
docs/                ← proposta técnica e documentação de referência
```

## MCP Tools principais

| Tool | Propósito |
|---|---|
| `discover_project` | Escaneia a app sem alterá-la; classifica stack; roda jdeprscan/jdeps |
| `build_migration_plan` | Consolida diagnóstico em plano faseado com gates; gera documento revisável |
| `execute_phase` | Aplica uma fase aprovada; exige token do gate; dryRun disponível |
| `get_phase_status` | Situação atual de cada fase |
| `approve_gate` | Registra aprovação humana e emite token para a fase seguinte |
| `rollback_phase` | Reverte uma fase aplicada via Git |
| `generate_report` | Relatório consolidado com trilha de auditoria |

## Fluxo de uso (ponta a ponta)

```
1. Skill instala → detecta stack → grava jdk-migration.config.json
2. discover_project → inventário de riscos (sem alterar código)
3. build_migration_plan → proposta faseada (documento revisável)
4. Gate 0: humano aprova plano e confirma cobertura de testes adequada
5. execute_phase (loop por fase, Gate antes de cada uma)
6. Validação final + cutover para produção
```

## Fases e criticidade

| Fase | Nome | Criticidade | Gate |
|---|---|---|---|
| 0 | Descoberta & Baseline | Baixa | Aprova plano e cobertura de testes |
| 1 | Infraestrutura & Build | Baixa | Build verde no JDK 21 |
| 2 | Modernização de Linguagem | Média | Diff revisado + testes verdes |
| 3 | Namespace Jakarta & Frameworks | Alta | App sobe no servidor; smoke tests |
| 4 | Refatoração Semântica Assistida | **Crítica** | Paridade funcional item a item |
| 5 | Validação Final & Cutover | Média | Sign-off liderança técnica e funcional |

## Arquivo de configuração da aplicação-alvo

A Skill grava `jdk-migration.config.json` na raiz da aplicação-alvo. Campos principais:

```json
{
  "sourceJdk": "8",
  "targetJdk": "21",
  "stack": ["spring-boot", "spring-batch"],
  "buildSystem": "maven",
  "appServer": null,
  "multiModule": false,
  "ciSystem": "github-actions"
}
```

## Stacks suportadas e nível de automação

| Stack | Complexidade | Automação |
|---|---|---|
| Microservices REST stateless | Baixa | Alta — recipe JDK OpenRewrite |
| Spring Boot 2.x | Alta | Alta (mecânico) + revisão em Security |
| Spring Batch | Alta | Alta + validação funcional de jobs |
| EJB | **Crítica** | Baixa — apenas sinaliza; refatoração é manual |
| JSF / PrimeFaces | **Crítica** | Parcial — namespace automático; UI manual |
| WebLogic | Alta | Alta via recipes Oracle oficiais |

## Execução manual de fases (quando execute_phase falha)

Quando `execute_phase` falhar por problema ambiental (ex: `spawn EINVAL` no Windows, `ENOENT`, timeout de Maven), siga este protocolo **antes de iniciar qualquer trabalho manual**:

```bash
# 1. Crie a branch isolada da fase ANTES de qualquer alteração
git checkout -b jdk-migration/phase-N-YYYYMMDDHHMMSS
# Exemplo: git checkout -b jdk-migration/phase-3-20260605170000

# 2. Realize o trabalho manualmente (mvn, edições, etc.)
# 3. Commit na branch criada
git add -A && git commit -m "chore(jdk-migration): fase N -- <descricao>"

# 4. Registre no MCP com record_manual_phase, passando a branch criada
```

**Por que isso importa:** sem a branch isolada, o trabalho fica na branch da fase anterior, o relatório mostra a branch errada e o rollback fica inviável de forma independente. Com a branch criada antes, cada fase tem sua própria trilha auditável no GitHub — igual ao comportamento automático do `execute_phase`.

**Resumo:** `execute_phase` cria a branch automaticamente. Quando for manual, você/Claude criam antes com `git checkout -b`.

## Princípios inegociáveis

- **Nunca avançar de fase sem token de gate aprovado** — token único por fase, registrado explicitamente.
- **Nunca aplicar transformações semânticas automaticamente** em EJB/JTA — apenas sinalizar e organizar revisão humana.
- **Cada fase em branch Git isolada** — rollback automático em falha de build; nunca commit direto na branch principal. Em execução manual, criar a branch ANTES de iniciar o trabalho.
- **dryRun obrigatório antes de qualquer execute_phase** em stacks de alta/crítica complexidade.
- **Ordem de recipes importa:** recipe JDK antes do recipe WebLogic (ordem oficial Oracle).

## Ferramentas externas integradas

- **OpenRewrite** — recipe `UpgradeToJava21`, recipes Jakarta, recipes WebLogic (`oracle/rewrite-recipes`)
- **Spring Boot Migrator (SBM)** — migração Spring Boot 2→3
- **Eclipse Transformer** — conversão de JARs individuais sem equivalente jakarta
- **jdeprscan / jdeps** — análise estática nativa do JDK
