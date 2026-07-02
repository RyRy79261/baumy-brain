import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next', 'db/migrations'],
    // Each DB test spins up an in-process PGlite (WASM) Postgres; under parallel
    // load first-instance init + pgvector work can exceed the 5s default. Raise
    // the timeout and cap workers so the suite is deterministic, not flaky.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: { threads: { minThreads: 1, maxThreads: 4 } },
  },
  resolve: {
    // Mirror tsconfig's "@/*" → "./*" path alias.
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
})
