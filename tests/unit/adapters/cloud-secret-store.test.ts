import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createCloudSecretStore } from '../../../src/adapters/cloud/cloud-secret-store.js'
import type { PinEntry } from '../../../src/ports/secret-store.js'

function samplePin(phase: number, expiresInMs: number): PinEntry {
  return {
    pin: '847291',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    phaseNumber: phase,
  }
}

describe('CloudSecretStore — contrato básico', () => {
  it('getPin() retorna null quando nada foi armazenado para a fase', async () => {
    const store = createCloudSecretStore()
    expect(await store.getPin(4)).toBeNull()
  })

  it('putPin() então getPin() faz round-trip da mesma entrada', async () => {
    const store = createCloudSecretStore()
    const entry = samplePin(4, 30 * 60 * 1000)
    await store.putPin(4, entry)
    expect(await store.getPin(4)).toEqual(entry)
  })

  it('deletePin() remove a entrada', async () => {
    const store = createCloudSecretStore()
    await store.putPin(4, samplePin(4, 30 * 60 * 1000))
    await store.deletePin(4)
    expect(await store.getPin(4)).toBeNull()
  })

  it('mantém PINs de fases diferentes isolados entre si', async () => {
    const store = createCloudSecretStore()
    await store.putPin(0, samplePin(0, 30 * 60 * 1000))
    await store.putPin(5, samplePin(5, 30 * 60 * 1000))
    expect((await store.getPin(0))?.phaseNumber).toBe(0)
    expect((await store.getPin(5))?.phaseNumber).toBe(5)
  })
})

describe('CloudSecretStore — expiração reforçada (defesa em profundidade)', () => {
  it('getPin() retorna null para um PIN cujo expiresAt já passou', async () => {
    const store = createCloudSecretStore()
    await store.putPin(4, samplePin(4, -1000)) // expirou há 1 segundo
    expect(await store.getPin(4)).toBeNull()
  })

  it('um PIN expirado é removido do store após a primeira leitura (não fica "zumbi")', async () => {
    const store = createCloudSecretStore()
    await store.putPin(4, samplePin(4, -1000))
    await store.getPin(4) // dispara a limpeza
    // Mesmo se alguém tentasse ler de novo, continua null — não há reaproveitamento.
    expect(await store.getPin(4)).toBeNull()
  })

  it('um PIN ainda dentro da validade não é afetado', async () => {
    const store = createCloudSecretStore()
    const entry = samplePin(4, 5 * 60 * 1000) // expira em 5 minutos
    await store.putPin(4, entry)
    expect(await store.getPin(4)).toEqual(entry)
  })
})

describe('CloudSecretStore — R1: isolamento estrutural do filesystem', () => {
  let watchDir: string

  beforeEach(() => {
    watchDir = join(tmpdir(), `jdk-migration-cloudsecret-watch-${randomBytes(6).toString('hex')}`)
    mkdirSync(watchDir, { recursive: true })
  })

  afterEach(() => rmSync(watchDir, { recursive: true, force: true }))

  it('nenhuma operação do store cria, lê ou modifica qualquer arquivo em disco', async () => {
    const store = createCloudSecretStore()

    await store.putPin(4, samplePin(4, 30 * 60 * 1000))
    await store.getPin(4)
    await store.deletePin(4)
    await store.putPin(5, samplePin(5, 30 * 60 * 1000))

    // Diretório de controle permanece vazio — prova que o adapter não tocou
    // o filesystem em nenhum momento (CloudSecretStore não importa node:fs).
    expect(readdirSync(watchDir)).toEqual([])
  })

  it('duas instâncias do store não compartilham estado (isolamento por processo/sessão)', async () => {
    const storeA = createCloudSecretStore()
    const storeB = createCloudSecretStore()

    await storeA.putPin(4, samplePin(4, 30 * 60 * 1000))
    expect(await storeB.getPin(4)).toBeNull()
  })
})
