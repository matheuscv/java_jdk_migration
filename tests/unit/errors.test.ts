import { describe, it, expect } from 'vitest'
import { MigrationError } from '../../src/lib/errors.js'

describe('MigrationError', () => {
  it('é instância de Error', () => {
    const err = new MigrationError('BUILD_FAILED', 'build falhou')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(MigrationError)
  })

  it('preserva code e message', () => {
    const err = new MigrationError('GATE_TOKEN_INVALID', 'token expirado')
    expect(err.code).toBe('GATE_TOKEN_INVALID')
    expect(err.message).toBe('token expirado')
  })

  it('aceita details opcionais', () => {
    const details = { phase: 2, token: 'abc' }
    const err = new MigrationError('GATE_TOKEN_INVALID', 'token inválido', details)
    expect(err.details).toEqual(details)
  })

  it('details é undefined quando não fornecido', () => {
    const err = new MigrationError('STACK_NOT_DETECTED', 'stack desconhecida')
    expect(err.details).toBeUndefined()
  })

  it('name é MigrationError', () => {
    const err = new MigrationError('GIT_DIRTY_WORKDIR', 'workdir sujo')
    expect(err.name).toBe('MigrationError')
  })

  it('stack trace está presente', () => {
    const err = new MigrationError('BUILD_FAILED', 'compilação falhou')
    expect(err.stack).toBeDefined()
  })
})
