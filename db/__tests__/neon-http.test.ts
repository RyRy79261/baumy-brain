import { describe, it, expect } from 'vitest'
import { neon } from '@neondatabase/serverless'

// Regression guard for the drizzle-orm ↔ @neondatabase/serverless version pairing.
// The rest of the suite runs on in-memory PGlite, which mimics the drizzle query
// SURFACE but never touches the real Neon HTTP driver — so a driver-API mismatch
// (Neon 1.x removed the plain function-call form that drizzle-orm 0.38 uses,
// requiring tagged templates / .query()) previously sailed through 100+ green
// tests and broke every production run. This asserts the client still accepts the
// call form drizzle-orm's neon-http session uses: client(sql, params, options).
describe('neon-http driver compatibility', () => {
  it('neon() sql accepts the function-call form drizzle-orm 0.38 relies on', () => {
    const sql = neon('postgres://u:p@localhost/db') as unknown as (
      q: string,
      params: unknown[],
      opts: object,
    ) => Promise<unknown>
    // Neon 1.x throws synchronously here ("can now be called only as a tagged-
    // template function"); the pinned 0.x returns a promise (which rejects async
    // when it tries to fetch — swallowed below).
    let threw: unknown
    try {
      const p = sql('select 1', [], { arrayMode: true, fullResults: true })
      if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {})
    } catch (e) {
      threw = e
    }
    expect(threw).toBeUndefined()
  })
})
