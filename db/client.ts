import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http'
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless'
import { neon, Pool } from '@neondatabase/serverless'
import * as schema from './schema'

// Lets `next build` collect page data without real DB secrets present.
const BUILD_PLACEHOLDER_URL = 'postgres://build:build@localhost:5432/build'

function url(): string {
  return process.env.DATABASE_URL ?? BUILD_PLACEHOLDER_URL
}

// HTTP driver: stateless, NO transactions — route/edge reads + the fast path.
export function createHttpDb() {
  return drizzleHttp(neon(url()), { schema })
}

// Pooled (WebSocket) driver: transactions + row locking — memory supersede,
// reminder claims (FOR UPDATE SKIP LOCKED), multi-row writes.
export function createPooledDb() {
  const pool = new Pool({ connectionString: url() })
  return { db: drizzlePool(pool, { schema }), pool }
}

// PGlite test seam (architecture D2): tests inject an in-memory db here.
type HttpDb = ReturnType<typeof createHttpDb>
let override: HttpDb | null = null

export function __setDbOverride(dbOverride: HttpDb | null): void {
  override = dbOverride
}

export function db(): HttpDb {
  return override ?? createHttpDb()
}
