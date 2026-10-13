import { describe } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { listCategories, listItems } from '@/db/schema'
import { scenario, say, advance, check, expectDb, expectReaction, expectWords, expectPrompt, expectNoPrompt, expectSilent, tapList, type Run } from './dsl'
import { statement, request, chatter } from './shapes'
import { HOUSE } from './house'
import type { TranscriptEntry } from '@/lib/sandbox/harness'

// Shopping categories (issue #29, docs/spec/shopping-list.md §Categories): every add is sorted AFTER it
// commits — the house's remembered pick, else the nearest sorted item, else the model's guess — and a
// housemate's pick ("put oat milk under coffee") teaches the house. The live list shows the groups, and
// its footer button cycles the order: Groups → A–Z → Added.

const TOPIC = 61
type Db = Parameters<Parameters<typeof expectDb>[0]>[0]
const all = (r: Run): TranscriptEntry[] => r.turns.flatMap((t) => t.entries)
const edits = (r: Run) => all(r).filter((e) => e.kind === 'edit')
const last = (r: Run) => r.turns.at(-1)!.entries
const labels = (e: TranscriptEntry | undefined) => (e?.keyboard ?? []).flat().map((b) => b.text)
const toast = (r: Run) => last(r).find((e) => e.kind === 'callback-answer')?.text ?? null
const lastEdit = (r: Run) => last(r).find((e) => e.kind === 'edit')
const oatMilk = async (db: Db, groupId: string) =>
  (await db.select().from(listItems).where(and(eq(listItems.groupId, groupId), eq(listItems.itemNormalized, 'oat milk')))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

const fixtures = {
  triage: (t: string) =>
    /out of/.test(t)
      ? statement({ worthRemembering: false, list: 'add' })
      : /^put .* under/.test(t)
        ? request({ asksBaumy: true, worthRemembering: false, list: 'categorize' })
        : /^put the (milk|bins|pasta)|^put pasta in the cupboard/.test(t)
          ? // Offline the triage MISROUTES these on purpose (the worst case the code must survive); live, the
            // real classifier should say list "none" (its prompt names them as counter-examples).
            statement({ worthRemembering: false, list: 'categorize' })
        : /^got /.test(t)
          ? statement({ worthRemembering: false, list: 'checkoff' })
          : chatter(),
  list: (t: string) =>
    /out of oat milk/.test(t)
      ? { op: 'add' as const, items: ['oat milk'] }
      : /out of pasta/.test(t)
        ? { op: 'add' as const, items: ['pasta'] }
        : /put oat milk under coffee/.test(t)
          ? { op: 'categorize' as const, items: [], categories: [{ item: 'oat milk', category: 'coffee' }] }
          : /put pasta under snacks/.test(t)
            ? { op: 'categorize' as const, items: [], categories: [{ item: 'pasta', category: 'snacks' }] }
            : /put (the )?pasta in the cupboard/.test(t)
              ? { op: 'categorize' as const, items: [], categories: [{ item: 'pasta', category: 'cupboard' }] }
            : /put the milk in the fridge/.test(t)
              ? { op: 'categorize' as const, items: [], categories: [{ item: 'milk', category: 'fridge' }] }
              : /put the bins out/.test(t)
                ? { op: 'categorize' as const, items: [], categories: [{ item: 'bins', category: 'out' }] }
            : /got the oat milk/.test(t)
              ? { op: 'checkoff' as const, items: ['oat milk'] }
              : { op: 'none' as const, items: [] },
  // The model's guess (Sonnet): plant milk is Fresh, pasta is Pantry.
  category: (item: string) => (/oat milk/.test(item) ? 'fresh' : /pasta/.test(item) ? 'pantry' : 'unknown'),
}

describe('scenario: shopping categories (issue #29)', () => {
  scenario('oat milk is guessed Fresh → a housemate moves it to Coffee → added again days later it is remembered as Coffee; the order button cycles Groups → A–Z → Added', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', '/list', { topic: TOPIC }),

      // 1. The add commits; the guess runs after it.
      say('Marco', "we're out of oat milk"),
      expectReaction('✍'),
      expectPrompt('category', /<<<\noat milk\n>>>/, 'the model was asked to sort the item — fenced as data, nothing else'),
      expectDb(async (db, r) => {
        const [row] = await oatMilk(db, r.sb.houseChatId)
        return row.category === 'fresh' && row.categorySource === 'guessed'
      }, 'oat milk is on the list, guessed Fresh'),
      say('Chloe', "we're out of pasta"),
      advance({ seconds: 10 }),
      check('ONE debounced edit shows both items under their group headings', (r, e) => {
        e(edits(r)).toHaveLength(1)
        e(labels(edits(r)[0])).toEqual(['── Pantry ──', '☐ pasta', '── Fresh ──', '☐ oat milk', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
      }),

      // 2. A housemate corrects it from Telegram — the pick teaches the house.
      say('Ryan', 'put oat milk under coffee', { dm: true }),
      expectWords({
        contains: /Coffee/,
        judge: 'Confirms oat milk is now under Coffee on the shopping list, and that Baumy will remember it. Short. Must not say anything was added or bought.',
      }),
      expectDb(async (db, r) => {
        const [row] = await oatMilk(db, r.sb.houseChatId)
        const mem = await db.select().from(listCategories).where(eq(listCategories.groupId, r.sb.houseChatId))
        return row.category === 'coffee' && row.categorySource === 'picked' && row.categorizedBy === '703' && mem.length === 1 && mem[0].category === 'coffee'
      }, 'oat milk is picked Coffee by Ryan, and the house remembers oat milk → Coffee'),
      say('Ryan', 'put pasta under snacks', { dm: true }),
      expectWords({
        contains: /isn't a section/,
        judge: 'Says "snacks" is not one of the shopping sections and lists the real ones (Pantry, Fresh, Coffee, Cleaning, Maintenance, Household). Must not say pasta was moved.',
      }),
      expectDb(async (db, r) => {
        const [pasta] = await db.select().from(listItems).where(and(eq(listItems.groupId, r.sb.houseChatId), eq(listItems.item, 'pasta')))
        return pasta.category === 'pantry' && pasta.categorySource === 'guessed'
      }, 'pasta is unchanged'),
      advance({ seconds: 10 }),
      check('the live list moved oat milk under Coffee', (r, e) => {
        e(labels(edits(r).at(-1))).toEqual(['── Pantry ──', '☐ pasta', '── Coffee ──', '☐ oat milk', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
      }),

      // 3. Bought, cleared — and days later added again: remembered, no model call.
      say('Marco', 'got the oat milk'),
      tapList('Marco', 'Clear done'),
      advance({ days: 3 }),
      say('Chloe', "we're out of oat milk"),
      expectReaction('✍'),
      expectNoPrompt('category', 'the remembered pick wins — the model is not asked'),
      expectDb(async (db, r) => {
        const rows = await oatMilk(db, r.sb.houseChatId)
        const fresh = rows.at(-1)!
        return rows.length === 2 && fresh.checkedAt === null && fresh.category === 'coffee' && fresh.categorySource === 'remembered'
      }, 'the new oat milk row is Coffee, remembered'),

      // 4. The order button cycles the whole house's order; each tap renders at once.
      tapList('Ryan', '🗂 Groups'),
      check('A–Z: no headings, the button now reads A–Z', (r, e) => {
        e(toast(r)).toBe('Sorted: 🔤 A–Z')
        e(labels(lastEdit(r))).toEqual(['☐ oat milk', '☐ pasta', '🔤 A–Z', '🧹 Clear done', '🔄 Refresh'])
      }),
      tapList('Chloe', '🔤 A–Z'),
      check('Added: newest first under Today / Earlier (Berlin days)', (r, e) => {
        e(toast(r)).toBe('Sorted: 🕒 Added')
        e(labels(lastEdit(r))).toEqual(['── Today ──', '☐ oat milk', '── Earlier ──', '☐ pasta', '🕒 Added', '🧹 Clear done', '🔄 Refresh'])
      }),
      tapList('Marco', '── Today ──'),
      check('a heading does nothing: a silent answer, no edit', (r, e) => {
        e(toast(r)).toBeNull()
        e(last(r).filter((x) => x.kind === 'edit')).toHaveLength(0)
      }),
      tapList('Marco', '🕒 Added'),
      check('back to Groups', (r, e) => {
        e(toast(r)).toBe('Sorted: 🗂 Groups')
        e(labels(lastEdit(r))).toEqual(['── Pantry ──', '☐ pasta', '── Coffee ──', '☐ oat milk', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
      }),
    ],
  })

  // Review of PR #30: "put X in/out …" is about the house, not the list. The item is matched first: when it
  // is NOT on the list and the section is not one of the six, it is not a list op at all — silence.
  scenario('"put the milk in the fridge" / "put the bins out" in the group never get a "not a section" reply', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Chloe', "we're out of pasta"),
      expectReaction('✍'),
      say('Marco', 'put the milk in the fridge'),
      expectSilent(),
      say('Ryan', 'put the bins out'),
      expectSilent(),
      // two signals: the add, and its auto-sort re-render — none from the two "put" messages
      check('no list change was signalled by the "put" messages', (r, e) => e(r.events.filter((x) => x.name === 'lists/shopping.changed')).toHaveLength(2)),
      expectDb(async (db, r) => {
        const rows = await db.select().from(listItems).where(eq(listItems.groupId, r.sb.houseChatId))
        return rows.length === 1 && rows[0].item === 'pasta' && rows[0].categorySource !== 'picked'
      }, 'the list is just pasta, untouched'),
      check('no list change was signalled by any of it', (r, e) => e(r.events.filter((x) => x.name === 'lists/shopping.changed')).toHaveLength(2)),
      // pasta IS on the list — but said to the group, not to Baumy, it is still about the cupboard: silence
      say('Marco', 'put pasta in the cupboard'),
      expectSilent(),
      // directly addressed (an @mention), the same thing is answered: the section word is not a section
      say('Marco', 'put pasta in the cupboard', { mention: true }),
      expectWords({
        contains: /isn't a section/,
        judge: 'Says "cupboard" is not one of the shopping sections and lists the real ones. Must not say pasta was moved.',
      }),
      // and in a DM
      say('Ryan', 'put pasta under snacks', { dm: true }),
      expectWords({
        contains: /isn't a section/,
        judge: 'Says "snacks" is not one of the shopping sections and lists the real ones. Must not say pasta was moved.',
      }),
    ],
  })
})
