import { describe } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { listItems } from '@/db/schema'
import { EMPTY_BOARD } from '@/lib/lists/board'
import { scenario, say, advance, check, expectDb, expectReaction, expectWords, expectNoWords, expectNoPrompt, type Run } from './dsl'
import { request, statement, chatter } from './shapes'
import { HOUSE } from './house'

// Issue #23 (docs/spec/shopping-list.md): take an item off the list WITHOUT buying it ("remove milk"),
// and fix a name ("change mlik to milk"). The model only names text; the store matches it to ONE open
// row, merges a rename onto an open copy of the new name, and a miss changes nothing.

const TOPIC = 77
type Db = Parameters<Parameters<typeof expectDb>[0]>[0]
const openItems = async (db: Db, groupId: string) =>
  (await db.select().from(listItems).where(and(eq(listItems.groupId, groupId), eq(listItems.isActive, true), isNull(listItems.checkedAt)))).map(
    (r) => r.item,
  )
const boards = (r: Run) => r.turns.flatMap((t) => t.entries).filter((e) => e.kind === 'message' && e.meta === 'board')
const changes = (r: Run) => r.events.filter((x) => x.name === 'lists/shopping.changed').length

const fixtures = {
  triage: (t: string) =>
    /calendar|chore|wifi|reminder/.test(t)
      ? request({ asksBaumy: true, worthRemembering: false }) // not a shopping item: list 'none'
      : /^add /.test(t)
      ? request({ asksBaumy: true, worthRemembering: false, list: 'add' })
      : /^change /.test(t)
        ? request({ asksBaumy: true, worthRemembering: false, list: 'rename' })
        : /^remove |take .* off/.test(t)
          ? request({ asksBaumy: true, worthRemembering: false, list: 'remove' })
          : /^we need/.test(t)
            ? statement({ worthRemembering: false, list: 'add' })
            : chatter(),
  list: (t: string) =>
    /^add milk, mlik/.test(t)
      ? { op: 'add' as const, items: ['milk', 'mlik'] }
      : /^we need bread/.test(t)
        ? { op: 'add' as const, items: ['bread', 'egg', 'eggs'] }
        : /remove the eggs/.test(t)
          ? { op: 'remove' as const, items: ['the eggs'] }
        : /change mlik to milk/.test(t)
          ? { op: 'rename' as const, items: [], renames: [{ from: 'mlik', to: 'milk' }] }
          : /change bred to bread/.test(t)
            ? { op: 'rename' as const, items: [], renames: [{ from: 'bred', to: 'bread' }] }
            : /remove milk/.test(t)
              ? { op: 'remove' as const, items: ['milk'] }
              : /remove the cheese/.test(t)
                ? { op: 'remove' as const, items: ['the cheese'] }
                : /take bread off/.test(t)
                  ? { op: 'remove' as const, items: ['bread'] }
                  : { op: 'none' as const, items: [] },
}

describe('scenario: removing and renaming list items (issue #23)', () => {
  scenario('add milk + mlik → change mlik to milk (merge) → remove milk → empty list, ONE repost after the burst', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', '/shoppinghere', { topic: TOPIC }),
      advance({ minutes: 3 }), // /shoppinghere's own post goes out first
      check('the topic has its first (empty) post', (r, e) => e(boards(r)).toHaveLength(1)),

      say('Marco', 'add milk, mlik', { mention: true }),
      expectReaction('✍'),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).sort().join() === 'milk,mlik', 'milk and mlik are both on the list'),
      // In the GROUP a merge is still said in words (a bare 👍 would hide that "mlik" is gone).
      say('Ryan', 'change mlik to milk', { mention: true }),
      expectReaction({ not: '👍' }),
      expectWords({
        contains: /Merged "mlik" into "milk"/,
        judge: 'Says "mlik" was merged into "milk" because milk was already on the list. Short. Must not say anything was bought, and must not say milk is on the list twice.',
      }),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).join() === 'milk', 'one milk, no mlik'),
      say('Chloe', 'remove milk', { mention: true }),
      expectReaction('👍'),
      expectNoWords(),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).length === 0, 'the list is empty'),
      expectDb(async (db, r) => {
        const rows = await db.select().from(listItems).where(eq(listItems.groupId, r.sb.houseChatId))
        // nothing was bought: both rows left the list as REMOVED, never checked off
        return rows.length === 2 && rows.every((x) => !x.isActive && x.checkedAt === null && x.removedBy !== null)
      }, 'milk and mlik were removed, not bought, and who did it is recorded'),
      check('every change asked for a repost (add, merge, remove — after /shoppinghere\'s own)', (r, e) => e(changes(r)).toBe(1 + 3)),

      advance({ minutes: 3 }),
      check('ONE repost after the burst: the empty list, in the topic', (r, e) => {
        const all = boards(r)
        e(all).toHaveLength(2)
        e(all[1].text).toBe(EMPTY_BOARD)
        e(all[1].threadId).toBe(TOPIC)
      }),
    ],
  })

  scenario('a miss changes nothing and says what was not found; a forwarded "remove" never edits the list (I3)', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', 'we need bread'),
      expectReaction('✍'),
      say('Ryan', 'remove the cheese', { dm: true }),
      expectWords({
        contains: /cheese/,
        judge: 'Says the cheese was not on the shopping list, so nothing was taken off. Must not say anything was removed or bought.',
      }),
      // "the eggs" loosely fits two items (egg, eggs): nothing changes, and Baumy says which it could mean
      say('Ryan', 'remove the eggs', { dm: true }),
      expectWords({
        contains: /more than one item/,
        judge: 'Says "the eggs" matches more than one item on the list (egg and eggs) and asks which one; says nothing was taken off. Must not say the eggs were not found.',
      }),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).length === 3, 'nothing was removed'),
      say('Ryan', 'change bred to bread', { dm: true }),
      expectWords({ contains: /bred/, judge: 'Says "bred" is not on the shopping list, so nothing was changed.' }),
      // A forwarded message is someone else's words: it can never take anything off the list.
      say('Chloe', 'take bread off the list', { dm: true, forwarded: true }),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).includes('bread'), 'bread is still on the list'),
      check('nothing changed, so no repost was asked for after the add', (r, e) => e(changes(r)).toBe(1)),
    ],
  })

  // Remove / rename are for SHOPPING items only (TRIAGE_SYSTEM): editing the calendar, a chore, a house
  // fact or a reminder never routes to the list. Offline the triage fixture says so (chatter); the point
  // of these steps is LIVE mode (pnpm test:scenarios:live), where the real classifier must route them away.
  scenario('removing or renaming something that is not a shopping item never touches the list', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', 'we need bread'),
      expectReaction('✍'),
      say('Ryan', 'remove dinner from the calendar', { dm: true }),
      expectNoPrompt('list', 'a calendar edit is not a list op'),
      say('Ryan', 'rename the chore', { dm: true }),
      expectNoPrompt('list', 'a chore edit is not a list op'),
      say('Ryan', 'rename the wifi to BaumyNet', { dm: true }),
      expectNoPrompt('list', 'a house fact / setting is not a list op'),
      say('Ryan', 'remove the reminder', { dm: true }),
      expectNoPrompt('list', 'a reminder is not a list op'),
      expectDb(async (db, r) => (await openItems(db, r.sb.houseChatId)).sort().join() === 'bread,egg,eggs', 'the list is unchanged'),
      check('no list change was signalled after the add', (r, e) => e(changes(r)).toBe(1)),
    ],
  })
})
