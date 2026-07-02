import { defineConfig } from 'drizzle-kit'

// Migrations run against the UNPOOLED (direct) connection — Neon's pooled
// PgBouncer endpoint breaks `drizzle-kit migrate` (prepared-statement discard).
export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
})
