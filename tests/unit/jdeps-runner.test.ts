import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJdepsOutput, runJdeps } from '../../src/static-analysis/jdeps-runner.js'

describe('parseJdepsOutput', () => {
  it('parseia violação interna JDK', () => {
    const out = 'com.example.App -> sun.misc.Unsafe  JDK internal API (java.base)'
    const result = parseJdepsOutput(out)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toEqual({
      sourceClass: 'com.example.App',
      targetPackage: 'sun.misc.Unsafe',
      internalModule: 'java.base',
    })
  })

  it('parseia múltiplas violações', () => {
    const out = [
      'com.example.A -> sun.misc.Unsafe  JDK internal API (java.base)',
      'com.example.B -> com.sun.crypto.provider.AESCipher  JDK internal API (java.base)',
    ].join('\n')
    const result = parseJdepsOutput(out)
    expect(result.violations).toHaveLength(2)
  })

  it('parseia split package warning', () => {
    const out = 'Warning: split package: javax.xml.bind [java.xml.bind, unnamed module]'
    const result = parseJdepsOutput(out)
    expect(result.splitPackages).toContain('javax.xml.bind')
  })

  it('parseia múltiplos split packages', () => {
    const out = [
      'Warning: split package: javax.xml.bind [mod-a]',
      'Warning: split package: javax.activation [mod-b]',
    ].join('\n')
    const result = parseJdepsOutput(out)
    expect(result.splitPackages).toHaveLength(2)
  })

  it('parseia --add-opens runtime warning', () => {
    const out = '  Use --add-opens java.base/java.lang=ALL-UNNAMED to allow access'
    const result = parseJdepsOutput(out)
    expect(result.runtimeWarnings).toHaveLength(1)
    expect(result.runtimeWarnings[0]).toContain('--add-opens')
  })

  it('parseia --add-exports runtime warning', () => {
    const out = '  --add-exports java.base/sun.util.locale.provider=ALL-UNNAMED'
    const result = parseJdepsOutput(out)
    expect(result.runtimeWarnings).toHaveLength(1)
    expect(result.runtimeWarnings[0]).toContain('--add-exports')
  })

  it('retorna vazio para output limpo', () => {
    const result = parseJdepsOutput('')
    expect(result.violations).toHaveLength(0)
    expect(result.splitPackages).toHaveLength(0)
    expect(result.runtimeWarnings).toHaveLength(0)
  })

  it('ignora linhas em branco e irrelevantes', () => {
    const out = '\n   \nsome info line\n'
    const result = parseJdepsOutput(out)
    expect(result.violations).toHaveLength(0)
    expect(result.splitPackages).toHaveLength(0)
  })

  it('parseia violation com class aninhada ($)', () => {
    const out = 'com.example.Outer$Inner -> sun.reflect.Reflection  JDK internal API (java.base)'
    const result = parseJdepsOutput(out)
    expect(result.violations[0].sourceClass).toBe('com.example.Outer$Inner')
  })
})

describe('runJdeps', () => {
  it('retorna resultado vazio quando jdepsBin não existe', async () => {
    const result = await runJdeps('/non-existent-jdk', '/tmp/project', '/tmp/project/target/classes')
    expect(result.violations).toHaveLength(0)
    expect(result.splitPackages).toHaveLength(0)
    expect(result.runtimeWarnings).toHaveLength(0)
  })

  it('retorna resultado vazio quando classesDir não existe', async () => {
    // javaHome existe (process.execPath directory) mas classesDir não
    const result = await runJdeps(process.execPath, '/tmp/project', '/non-existent/classes')
    expect(result.violations).toHaveLength(0)
  })
})
