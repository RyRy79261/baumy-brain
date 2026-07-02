// Run DB migrations during `vercel-build` ONLY when a database is configured.
// The first-ever Vercel deploy (before the Neon integration is added) has no
// DATABASE_URL — skip migrations so the build succeeds; later deploys migrate.
import { execSync } from 'node:child_process'

const hasDb = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
if (!hasDb) {
  console.log('[baumy] No DATABASE_URL(_UNPOOLED) set — skipping migrations (first deploy / no DB yet).')
  process.exit(0)
}

console.log('[baumy] Running drizzle migrations…')
execSync('pnpm db:migrate', { stdio: 'inherit' })
