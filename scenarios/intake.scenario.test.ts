import { describe } from 'vitest'
import { sql } from 'drizzle-orm'
import { scenario, say, advance, expectPrompt, expectNoPrompt, expectFact, expectDb } from './dsl'
import { memoryLines, transientError } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE } from './house'

// Intake: what gets in, at what trust, and what happens when the model is down.

const LANDLORD = 'Landlord here: the plumber is coming Thursday 9am to fix the boiler'

const forwarded = {
  triage: (t: string) => (t.startsWith('Landlord') ? statement() : /plumber/.test(t) ? question({ asksBaumy: true }) : chatter()),
  // What extraction WOULD return if forwarded text ever reached it — the wall must stop it first.
  extract: (t: string) => (t.startsWith('Landlord') ? [fact({ subject: 'plumber', predicate: 'visits_on', object: 'thursday 9am', when: 'Thursday 9am' })] : []),
  reply: () => 'The landlord says the plumber comes Thursday at 9 (Marco forwarded it) 🔧',
}

describe('scenario: intake', () => {
  scenario('a forwarded landlord message never writes a fact (the relayed-content wall)', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: forwarded,
    steps: [
      say('Marco', LANDLORD, { forwarded: true }),
      expectNoPrompt('extract', 'forwarded content never reaches fact extraction'),
      expectFact({ count: 0 }),
    ],
  })

  scenario('a forwarded landlord message is recallable later, labelled as forwarded by Marco', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    // D4/I5 (phase 5): forwarded-by-member content has trust `forwarded` — stored and recallable with a
    // "forwarded by X" label, never facts or actions.
    fixtures: forwarded,
    steps: [
      say('Marco', LANDLORD, { forwarded: true }),
      expectFact({ count: 0 }),
      advance({ hours: 2 }),
      say('Chloe', 'when is the plumber coming?', { mention: true }),
      expectPrompt(
        'reply',
        (c) => memoryLines(c.prompt).some((l) => /plumber/i.test(l) && /forward/i.test(l) && /Marco/.test(l)),
        'the forwarded message grounds the reply, labelled as forwarded by Marco',
      ),
    ],
  })

  scenario('a transient model error on triage fails the ingest (retryable) instead of degrading', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    offlineOnly: 'scripts a provider outage',
    fixtures: {
      triage: () => {
        throw transientError()
      },
    },
    steps: [
      say('Chloe', 'the wifi is down again', { throws: /Overloaded|529|Failed after/ }),
      expectDb(async (db) => {
        const res = (await db.execute(sql`SELECT count(*)::int AS n FROM baumy_memory_items`)) as unknown as { rows?: { n: number }[] } | { n: number }[]
        const rows = Array.isArray(res) ? res : (res.rows ?? [])
        return rows[0]?.n === 0
      }, 'nothing was half-captured before the retry'),
    ],
  })
})
