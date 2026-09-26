import { describe } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { listItems } from '@/db/schema'
import { scenario, say, expectWords, expectNoWords, expectReaction, expectDb, expectPrompt } from './dsl'
import { statement, question, request, chatter } from './shapes'
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
})
