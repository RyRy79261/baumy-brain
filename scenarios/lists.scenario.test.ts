import { describe } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { listItems, memoryItems } from '@/db/schema'
import { scenario, say, expectWords, expectNoWords, expectReaction, expectDb, expectPrompt, expectFact } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, request, chatter, fact } from './shapes'
import { HOUSE } from './house'

// The shared shopping list (docs/spec/shopping-list.md): group acks come from the STORE OUTCOME
// (K4), not from the op alone.

const openItems = async (db: Parameters<Parameters<typeof expectDb>[0]>[0], groupId: string) =>
  (await db.select().from(listItems).where(and(eq(listItems.groupId, groupId), eq(listItems.isActive, true), isNull(listItems.checkedAt)))).map(
    (r) => r.item,
  )

const fixtures = {
  triage: (t: string) =>
    /out of/.test(t)
      ? statement({ worthRemembering: false, list: 'add' })
      : /^got /.test(t)
        ? statement({ worthRemembering: false, list: 'checkoff' })
        : /plumber/.test(t)
          ? question({ asksBaumy: true, list: 'add' }) // a list change AND an unrelated question (TRIAGE_SYSTEM)
          : /add coffee/.test(t)
            ? request({ asksBaumy: true, list: 'add' })
            : chatter(),
  list: (t: string) =>
    /out of oat milk/.test(t)
      ? { op: 'add' as const, items: ['oat milk'] }
      : /got the bin bags/.test(t)
        ? { op: 'checkoff' as const, items: ['bin bags'] }
        : /add coffee/.test(t)
          ? { op: 'add' as const, items: ['coffee'] }
          : { op: 'none' as const, items: [] },
}

describe('scenario: shopping list', () => {
  scenario('an add in the group is ✍; checking off something not on the list is words, not 👍', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures,
    steps: [
      say('Marco', "we're out of oat milk"),
      expectReaction('✍'),
      expectNoWords(),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).includes('oat milk'), 'oat milk is on the list'),
      say('Ryan', 'got the bin bags'),
      expectReaction({ not: '👍' }),
      expectWords({ contains: /bin bags/, judge: 'Says bin bags were not on the list (and may mention oat milk is still on it). Must not say bin bags were ticked off.' }),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).includes('oat milk'), 'oat milk is still on the list'),
    ],
  })

  scenario('a list op that also asks something still gets the question answered', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    // A10: the list op is acked from the store outcome AND the question half is answered (spec §3
    // "list op handled … if the message ALSO asks something → continue to the question row").
    fixtures,
    steps: [
      say('Marco', "add coffee — and when's the plumber coming?", { mention: true }),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).includes('coffee'), 'coffee is on the list'),
      expectPrompt('reply', /plumber/, 'the question half reached the reply model'),
    ],
  })

  scenario('a statement triage wrongly flags as a list op is still remembered when the list step finds nothing (A11)', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    // The classifier's `list` flag only PROPOSES; the list extractor disposes. When it answers "none",
    // the message was not a list op after all, and must be captured like any statement — only a list op
    // that actually happened skips capture.
    fixtures: {
      triage: (t: string) => (/plumber comes/.test(t) ? statement({ worthRemembering: true, list: 'add' }) : /plumber/.test(t) ? question({ asksBaumy: true }) : chatter()),
      list: () => ({ op: 'none' as const, items: [] }),
      extract: (t: string) => (/plumber comes/.test(t) ? [fact({ subject: 'plumber', predicate: 'arrives_on', object: 'thursday' })] : []),
    },
    steps: [
      say('Charli', 'the plumber comes thursday'),
      expectPrompt('list', /plumber comes thursday/, 'the list step ran (the flag was set)'),
      expectReaction('✍'),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).length === 0, 'nothing went on the list'),
      expectDb(async (db) => (await db.select().from(memoryItems)).some((m) => m.content === 'the plumber comes thursday'), 'the statement is a memory note'),
      expectFact({ subject: /plumber/, predicate: 'arrives_on', object: 'thursday', current: true }),
      say('Marco', 'when is the plumber coming?', { mention: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /thursday/.test(l)), 'it grounds the answer'),
      expectWords({ judge: 'Says the plumber comes on Thursday (per Charli).' }),
    ],
  })
})
