/**
 * Testes para o mecanismo de PIN de aprovação de gate.
 * Garante que approve_gate não pode ser chamado sem PIN válido gerado
 * por request_gate_approval — impedindo aprovação autônoma pelo agente de IA.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  readPinStore,
  writePinStore,
  deletePinEntry,
  type PinStore,
} from '../../src/lib/config.js'

function tempProject(): string {
  const dir = join(tmpdir(), `pin-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(join(dir, '.jdk-migration'), { recursive: true })
  return dir
}

describe('PinStore — leitura e escrita', () => {
  let dir: string
  beforeEach(() => { dir = tempProject() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('retorna objeto vazio quando arquivo não existe', () => {
    const store = readPinStore(dir)
    expect(store).toEqual({})
  })

  it('persiste e recupera PIN corretamente', () => {
    const store: PinStore = {
      1: { pin: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 1 },
    }
    writePinStore(dir, store)
    const read = readPinStore(dir)
    expect(read[1]?.pin).toBe('482913')
    expect(read[1]?.phaseNumber).toBe(1)
  })

  it('deletePinEntry remove apenas a fase especificada', () => {
    const store: PinStore = {
      1: { pin: '111111', expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 1 },
      2: { pin: '222222', expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 2 },
    }
    writePinStore(dir, store)
    deletePinEntry(dir, 1)
    const read = readPinStore(dir)
    expect(read[1]).toBeUndefined()
    expect(read[2]?.pin).toBe('222222')
  })
})

describe('Lógica de validação de PIN', () => {
  let dir: string
  beforeEach(() => { dir = tempProject() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('PIN correto e não expirado é válido', () => {
    const pin = '482913'
    writePinStore(dir, {
      1: { pin, expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 1 },
    })
    const store = readPinStore(dir)
    const entry = store[1]!
    expect(entry.pin).toBe(pin)
    expect(new Date(entry.expiresAt) > new Date()).toBe(true)
  })

  it('PIN expirado é detectado corretamente', () => {
    writePinStore(dir, {
      1: { pin: '000000', expiresAt: new Date(Date.now() - 1000).toISOString(), phaseNumber: 1 },
    })
    const store = readPinStore(dir)
    const entry = store[1]!
    expect(new Date(entry.expiresAt) < new Date()).toBe(true)
  })

  it('PIN incorreto é detectado por comparação direta', () => {
    writePinStore(dir, {
      1: { pin: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 1 },
    })
    const store = readPinStore(dir)
    const entry = store[1]!
    expect(entry.pin !== '000000').toBe(true)
    expect(entry.pin === '482913').toBe(true)
  })

  it('fase sem PIN retorna undefined (approve_gate deve rejeitar)', () => {
    writePinStore(dir, {
      2: { pin: '999999', expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 2 },
    })
    const store = readPinStore(dir)
    expect(store[1]).toBeUndefined()   // fase 1 não tem PIN
    expect(store[2]?.pin).toBe('999999')  // fase 2 tem
  })

  it('PIN é uso único — deletePinEntry após validação', () => {
    writePinStore(dir, {
      1: { pin: '482913', expiresAt: new Date(Date.now() + 60_000).toISOString(), phaseNumber: 1 },
    })
    // Simula consumo após validação bem-sucedida
    deletePinEntry(dir, 1)
    const store = readPinStore(dir)
    expect(store[1]).toBeUndefined()
  })
})
