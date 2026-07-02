import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/db/schema'
import type { Database } from '@/db/client'

export function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface PgHarness {
  db: Database
  pool: Pool
  container: StartedPostgreSqlContainer
  stop: () => Promise<void>
}

// Representative-infrastructure harness: a REAL pgvector Postgres with the REAL
// migration files applied in order (the exact SQL that runs in prod), fronted by
// a real drizzle instance. NOT an in-memory double and NOT a hand-maintained DDL
// that can drift from the migrations — this is what catches schema/migration/SQL
// bugs the PGlite unit tests never could.
export async function startPgHarness(): Promise<PgHarness> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start()
  const pool = new Pool({ connectionString: container.getConnectionUri() })

  const dir = join(process.cwd(), 'db', 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    await pool.query(readFileSync(join(dir, f), 'utf8'))
  }

  const db = drizzle(pool, { schema }) as unknown as Database
  return {
    db,
    pool,
    container,
    stop: async () => {
      await pool.end()
      await container.stop()
    },
  }
}
