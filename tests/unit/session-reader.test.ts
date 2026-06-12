import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { projectPathToSlug, readTokensForPhase } from '../../src/roi-tracker/session-reader.js'

describe('projectPathToSlug', () => {
  it('converte backslashes e underscores em hífens', () => {
    expect(projectPathToSlug('C:\\devtools\\workspace\\java_jdk_migration'))
      .toBe('C--devtools-workspace-java-jdk-migration')
  })

  it('converte forward slashes', () => {
    expect(projectPathToSlug('/home/user/my.project')).toBe('-home-user-my-project')
  })

  it('converte underscore em hífen', () => {
    expect(projectPathToSlug('abc_123')).toBe('abc-123')
  })

  it('converte dois-pontos em hífen', () => {
    expect(projectPathToSlug('C:/path')).toBe('C--path')
  })
})

describe('readTokensForPhase', () => {
  it('retorna null quando startedAt é null', () => {
    const result = readTokensForPhase('/any/path', null, null)
    expect(result).toBeNull()
  })

  it('retorna null quando diretório de projetos não existe', () => {
    // Usa um projectPath cujo slug não vai existir em ~/.claude/projects
    const result = readTokensForPhase('/non-existent-x7k3q/project', '2026-01-01T00:00:00Z', null)
    expect(result).toBeNull()
  })

  describe('com diretório de sessão temporário', () => {
    let fakeProjectPath: string
    let fakeSlugDir: string

    beforeEach(() => {
      // Cria slug temporário dentro de ~/.claude/projects
      fakeProjectPath = join(tmpdir(), `fake-proj-${randomBytes(4).toString('hex')}`)
      const slug = fakeProjectPath.replace(/[^a-zA-Z0-9]/g, '-')
      fakeSlugDir = join(homedir(), '.claude', 'projects', slug)
      mkdirSync(fakeSlugDir, { recursive: true })
    })

    afterEach(() => {
      try { rmSync(fakeSlugDir, { recursive: true, force: true }) } catch { /* ok */ }
    })

    it('retorna null quando nenhum arquivo .jsonl existe', () => {
      const result = readTokensForPhase(fakeProjectPath, '2026-01-01T00:00:00Z', null)
      expect(result).toBeNull()
    })

    it('retorna null quando nenhuma entrada cai no intervalo', () => {
      const entry = JSON.stringify({
        type: 'assistant',
        timestamp: '2025-01-01T00:00:00.000Z',
        message: { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
      writeFileSync(join(fakeSlugDir, 'session.jsonl'), entry + '\n', 'utf-8')

      // Intervalo bem no futuro — não deve capturar a entrada de 2025
      const result = readTokensForPhase(fakeProjectPath, '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z')
      expect(result).toBeNull()
    })

    it('soma tokens de entradas dentro do intervalo', () => {
      const now = new Date()
      const ts = new Date(now.getTime() - 60_000).toISOString() // 1 minuto atrás

      const entry = JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
          },
        },
      })
      writeFileSync(join(fakeSlugDir, 'session.jsonl'), entry + '\n', 'utf-8')

      // startedAt = 10 minutos atrás, completedAt = agora
      const startedAt = new Date(now.getTime() - 10 * 60_000).toISOString()
      const result = readTokensForPhase(fakeProjectPath, startedAt, now.toISOString())

      expect(result).not.toBeNull()
      expect(result!.inputTokens).toBe(200)
      expect(result!.outputTokens).toBe(80)
      expect(result!.cacheCreationTokens).toBe(10)
      expect(result!.cacheReadTokens).toBe(5)
    })

    it('soma tokens de múltiplos arquivos .jsonl', () => {
      const now = new Date()
      const ts = new Date(now.getTime() - 60_000).toISOString()

      const makeEntry = (input: number) => JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: { usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })

      writeFileSync(join(fakeSlugDir, 'session1.jsonl'), makeEntry(100) + '\n', 'utf-8')
      writeFileSync(join(fakeSlugDir, 'session2.jsonl'), makeEntry(150) + '\n', 'utf-8')

      const startedAt = new Date(now.getTime() - 10 * 60_000).toISOString()
      const result = readTokensForPhase(fakeProjectPath, startedAt, now.toISOString())

      expect(result).not.toBeNull()
      expect(result!.inputTokens).toBe(250)
    })

    it('ignora linhas não-assistant', () => {
      const now = new Date()
      const ts = new Date(now.getTime() - 60_000).toISOString()

      const lines = [
        JSON.stringify({ type: 'user', timestamp: ts, message: {} }),
        JSON.stringify({ type: 'system', timestamp: ts }),
        JSON.stringify({
          type: 'assistant', timestamp: ts,
          message: { usage: { input_tokens: 77, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }),
      ].join('\n')

      writeFileSync(join(fakeSlugDir, 'session.jsonl'), lines + '\n', 'utf-8')

      const startedAt = new Date(now.getTime() - 10 * 60_000).toISOString()
      const result = readTokensForPhase(fakeProjectPath, startedAt, now.toISOString())

      expect(result!.inputTokens).toBe(77)
    })

    it('ignora entradas com JSON inválido', () => {
      const now = new Date()
      const ts = new Date(now.getTime() - 60_000).toISOString()
      const lines = [
        'not-json-at-all',
        JSON.stringify({
          type: 'assistant', timestamp: ts,
          message: { usage: { input_tokens: 33, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }),
      ].join('\n')

      writeFileSync(join(fakeSlugDir, 'session.jsonl'), lines + '\n', 'utf-8')

      const startedAt = new Date(now.getTime() - 10 * 60_000).toISOString()
      const result = readTokensForPhase(fakeProjectPath, startedAt, now.toISOString())

      expect(result!.inputTokens).toBe(33)
    })

    it('ignora entradas sem campo usage', () => {
      const now = new Date()
      const ts = new Date(now.getTime() - 60_000).toISOString()
      const entry = JSON.stringify({ type: 'assistant', timestamp: ts, message: {} })
      writeFileSync(join(fakeSlugDir, 'session.jsonl'), entry + '\n', 'utf-8')

      const startedAt = new Date(now.getTime() - 10 * 60_000).toISOString()
      const result = readTokensForPhase(fakeProjectPath, startedAt, now.toISOString())
      expect(result).toBeNull()
    })

    it('aplica margem de 5 min antes do startedAt', () => {
      // Entrada criada 4 minutos antes do startedAt — deve ser capturada pela margem
      const now = new Date()
      const startedAt = now.toISOString()
      const ts = new Date(now.getTime() - 4 * 60_000).toISOString()

      const entry = JSON.stringify({
        type: 'assistant', timestamp: ts,
        message: { usage: { input_tokens: 55, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      })
      writeFileSync(join(fakeSlugDir, 'session.jsonl'), entry + '\n', 'utf-8')

      const result = readTokensForPhase(fakeProjectPath, startedAt, null)
      expect(result).not.toBeNull()
      expect(result!.inputTokens).toBe(55)
    })
  })
})
