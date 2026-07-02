import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next', 'db/migrations'],
  },
  resolve: {
    // Mirror tsconfig's "@/*" → "./*" path alias.
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
})
