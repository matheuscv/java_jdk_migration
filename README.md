# jdk-migration-mcp

MCP server that orchestrates **Java JDK 6/8 → 21 migrations** with human-in-the-loop approval gates.

## What it does

- Scans your Java project and identifies all incompatibilities with JDK 21
- Generates a phased migration plan (6 phases) with risk classification
- Guides each phase with automated analysis and manual review gates
- Tracks approvals, generates an HTML audit report

## Requirements

- Node.js >= 20
- Java project using Maven or Gradle
- Git available in PATH

## Installation

### Claude Code (recommended)

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "jdk-migration": {
      "command": "npx",
      "args": ["-y", "jdk-migration-mcp"]
    }
  }
}
```

Or install globally:

```bash
npm install -g jdk-migration-mcp
```

Then configure:

```json
{
  "mcpServers": {
    "jdk-migration": {
      "command": "jdk-migration-mcp"
    }
  }
}
```

## Usage

With the MCP active in Claude Code, use natural language:

```
Execute a descoberta do projeto neste diretório.
Construa o plano de migração.
Aprovar gate 0 como <Seu Nome>.
Executar fase 1.
```

## Available tools

| Tool | Description |
|---|---|
| `discover_project` | Scans the Java project — run this first |
| `build_migration_plan` | Generates the phased migration plan |
| `execute_phase` | Applies a migration phase (requires gate token) |
| `approve_gate` | Records human approval and issues the next gate token |
| `get_phase_status` | Returns current status of all 6 phases |
| `rollback_phase` | Rolls back a phase via Git |
| `generate_report` | Generates an HTML audit report |

## Migration phases

| Phase | Name | Automation |
|---|---|---|
| 0 | Discovery & Baseline | High |
| 1 | Infrastructure & Build | High |
| 2 | Language Modernization | High |
| 3 | Jakarta Namespace & Frameworks | Conditional |
| 4 | Assisted Semantic Refactoring | Conditional |
| 5 | Final Validation & Cutover | High |

## Detected incompatibilities

- `javax.xml.bind` → `jakarta.xml.bind` (removed in JDK 11, JEP-320)
- `Thread.stop()` → `interrupt()` (removed in JDK 20)
- `Object.finalize()` → `Cleaner` / try-with-resources (JEP-421)
- Nashorn ScriptEngine (removed in JDK 15, JEP-372)
- `SecurityManager` (removed in JDK 24, JEP-486)
- `java.util.Observable/Observer` (deprecated JDK 9)

## License

MIT — [Matheus Vieira](https://github.com/matheuscv)
