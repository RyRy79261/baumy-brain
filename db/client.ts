import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http'
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless'
import { neon, Pool } from '@neondatabase/serverless'
import * as schema from './schema'

// Lets `next build` collect page data without real DB secrets present.
const BUILD_PLACEHOLDER_URL = 'postgres://build:build@localhost:5432/build'

function url(): string {
  return process.env.DATABASE_URL ?? BUILD_PLACEHOLDER_URL
}

function makeHttpDb() {
  return drizzleHttp(neon(url()), { schema })
}

// Shared db type for the memory/retrieval helpers (tests inject a PGlite-backed
// instance cast to this — the drizzle query surface is structurally compatible).
export type Database = ReturnType<typeof makeHttpDb>

// PGlite test seam (architecture D2): tests inject an in-memory db here.
let override: Database | null = null

export function __setDbOverride(dbOverride: Database | null): void {
  override = dbOverride
}

// HTTP driver: stateless, NO transactions — route/edge reads + the fast path.
// Honours the test override above (the scenario suite runs the real pipeline on PGlite); unset in
// production, so this is always a fresh neon-http client there.
export function createHttpDb(): Database {
  return override ?? makeHttpDb()
}

// Pooled (WebSocket) driver: transactions + row locking — memory supersede,
// reminder claims (FOR UPDATE SKIP LOCKED), multi-row writes.
export function createPooledDb() {
  const pool = new Pool({ connectionString: url() })
  return { db: drizzlePool(pool, { schema }), pool }
}

export function db(): Database {
  return createHttpDb()
}
