import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    // Vários arquivos de teste spawnam processos reais (git, javac, mvn detection).
    // No Windows, paralelismo igual ao número de cores (default) causa contenção de
    // I/O — rmSync intermitentemente falha com EBUSY/EPERM em diretórios temporários
    // ainda sendo liberados por antivírus/handles do SO. Limitar forks reduz a pressão
    // concorrente; retry absorve a flakiness residual de timing do SO sem mascarar
    // falhas de lógica reais (que falham de forma consistente, não 1 em N execuções).
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
    retry: 1,
  },
})
