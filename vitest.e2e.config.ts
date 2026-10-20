import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

// The end-to-end stack (e2e/README.md): a production build + Postgres + the Inngest dev server in
// Docker, real Claude + Voyage, fake Telegram and Olympics. `pnpm test:e2e`. Not part of `pnpm test`.
// Local secrets come from .env.e2e.local (git-ignored); CI passes them as env.
if (fs.existsSync('.env.e2e.local')) {
  for (const line of fs.readFileSync('.env.e2e.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    globalSetup: ['e2e/global-setup.ts'],
    // One house, one conversation at a time: files and tests run in order.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 5 * 60_000,
    hookTimeout: 25 * 60_000,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
})
