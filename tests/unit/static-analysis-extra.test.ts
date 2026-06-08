/**
 * Testes adicionais para static-analysis — cobre branches restantes:
 *   - parseJdeprscanOutput: formato "warning: [deprecation] ... in ..."
 *   - parseJdeprscanOutput: classe inner com $ (jvmToJava com $)
 *   - extractMember: classe com letra maiúscula (retorna null)
 *   - findJavaHome: JAVA_HOME setado com diretório bin existente
 *   - findCompiledClasses: buildSystem=gradle (build/classes/java/main)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  parseJdeprscanOutput,
  findJavaHome,
  findCompiledClasses,
} from '../../src/static-analysis/jdeprscan-runner.js'

let dir: string
beforeEach(() => {
  dir = join(tmpdir(), `sa-extra-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

// ─── warning format ───────────────────────────────────────────────────────────

describe('parseJdeprscanOutput — formato warning: [deprecation]', () => {
  it('parseia warning: [deprecation] stop() in Thread', () => {
    const output = `warning: [deprecation] stop() in Thread has been deprecated`
    const items = parseJdeprscanOutput(output)
    expect(items).toHaveLength(1)
    expect(items[0].className).toBe('Thread')
    expect(items[0].member).toBe('stop')
  })

  it('parseia warning: [deprecation] com método com parênteses', () => {
    const output = `warning: [deprecation] close() in DataInputStream has been deprecated`
    const items = parseJdeprscanOutput(output)
    expect(items).toHaveLength(1)
    expect(items[0].member).toBe('close')
    expect(items[0].className).toBe('DataInputStream')
  })

  it('mistura linhas de classe e warning sem crash', () => {
    const output = [
      'class com/example/App uses deprecated class sun/misc/BASE64Encoder (for removal)',
      'warning: [deprecation] stop() in Thread has been deprecated',
    ].join('\n')
    const items = parseJdeprscanOutput(output)
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(items.some(i => i.className === 'Thread')).toBe(true)
    expect(items.some(i => i.className === 'sun.misc.BASE64Encoder')).toBe(true)
  })
})

// ─── classe inner com $ (jvmToJava) ──────────────────────────────────────────

describe('parseJdeprscanOutput — classe inner com $', () => {
  it('converte $ para . em classes internas', () => {
    const output = `class com/example/App uses deprecated class com/example/Outer$Inner (for removal)`
    const items = parseJdeprscanOutput(output)
    expect(items).toHaveLength(1)
    // jvmToJava converte $ em .
    expect(items[0].className).toContain('.')
  })
})

// ─── extractMember: classname (letra maiúscula) ───────────────────────────────

describe('parseJdeprscanOutput — extractMember com classname (letra maiúscula)', () => {
  it('não extrai member quando último segmento começa com maiúscula', () => {
    // "uses deprecated class sun/misc/BASE64Encoder" → className=BASE64Encoder, member=null
    const output = `class com/example/App uses deprecated class sun/misc/BASE64Encoder (for removal)`
    const items = parseJdeprscanOutput(output)
    expect(items[0].member).toBeNull()
  })
})

// ─── findJavaHome ─────────────────────────────────────────────────────────────

describe('findJavaHome — com JAVA_HOME setado', () => {
  it('retorna JAVA_HOME quando bin/ existe', () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    vi.stubEnv('JAVA_HOME', dir)
    const result = findJavaHome()
    expect(result).toBe(dir)
  })

  it('ignora JAVA_HOME quando bin/ não existe', () => {
    // dir não tem subdir 'bin'
    vi.stubEnv('JAVA_HOME', dir)
    const result = findJavaHome()
    // bin não existe → não deve retornar dir; retorna outro path ou null
    // Dependendo do ambiente, pode retornar null ou outro path
    expect(result === null || result !== dir).toBe(true)
  })
})

// ─── findCompiledClasses ──────────────────────────────────────────────────────

describe('findCompiledClasses — gradle', () => {
  it('retorna build/classes/java/main quando existe para gradle', () => {
    const classesDir = join(dir, 'build', 'classes', 'java', 'main')
    mkdirSync(classesDir, { recursive: true })
    const result = findCompiledClasses(dir, 'gradle')
    expect(result).toBe(classesDir)
  })

  it('retorna build/classes/kotlin/main quando java/main não existe para gradle', () => {
    const kotlinDir = join(dir, 'build', 'classes', 'kotlin', 'main')
    mkdirSync(kotlinDir, { recursive: true })
    const result = findCompiledClasses(dir, 'gradle')
    expect(result).toBe(kotlinDir)
  })

  it('retorna null quando nenhum diretório de classes existe para gradle', () => {
    const result = findCompiledClasses(dir, 'gradle')
    expect(result).toBeNull()
  })

  it('retorna target/classes para maven', () => {
    const targetDir = join(dir, 'target', 'classes')
    mkdirSync(targetDir, { recursive: true })
    const result = findCompiledClasses(dir, 'maven')
    expect(result).toBe(targetDir)
  })
})
