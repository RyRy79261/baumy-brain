import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '@/db/schema'
import { makeTestDb } from './pglite'

// The PGlite DDL (./pglite.ts) is hand-maintained and silently drifted once (three tables missing
// with nothing noticing). This pins it to db/schema.ts: every drizzle table exists in the test DB
// with the same columns and the same nullability. Add the table/column to pglite.ts in the same
// change as the schema (AGENTS.md "Testing").
describe('PGlite DDL ↔ db/schema.ts', () => {
  it('has every schema table, with matching columns and nullability', async () => {
    const db = await makeTestDb()
    const res = (await db.execute(sql`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`)) as unknown as
      | { rows?: { table_name: string; column_name: string; is_nullable: string }[] }
      | { table_name: string; column_name: string; is_nullable: string }[]
    const rows = Array.isArray(res) ? res : (res.rows ?? [])
    const actual = new Map<string, Map<string, boolean>>()
    for (const r of rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Map())
      actual.get(r.table_name)!.set(r.column_name, r.is_nullable === 'YES')
    }

    const problems: string[] = []
    const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable)
    expect(tables.length).toBeGreaterThan(15)
    for (const t of tables) {
      const cfg = getTableConfig(t)
      const cols = actual.get(cfg.name)
      if (!cols) {
        problems.push(`MISSING TABLE ${cfg.name}`)
        continue
      }
      for (const c of cfg.columns) {
        if (!cols.has(c.name)) problems.push(`MISSING COLUMN ${cfg.name}.${c.name}`)
        // A primary key is NOT NULL whatever the column config says.
        else if (cols.get(c.name) !== (!c.notNull && !c.primary)) problems.push(`NULLABILITY ${cfg.name}.${c.name}: schema ${c.notNull || c.primary ? 'NOT NULL' : 'nullable'}`)
      }
      for (const name of cols.keys()) if (!cfg.columns.some((c) => c.name === name)) problems.push(`EXTRA COLUMN ${cfg.name}.${name}`)
    }
    expect(problems).toEqual([])
  })
})
