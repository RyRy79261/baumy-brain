import { afterEach, beforeEach, describe } from 'vitest'
import { eq } from 'drizzle-orm'
import { messages } from '@/db/schema'
import { POST as ADD } from '@/app/api/kitchen/shopping/add/route'
import { scenario, say, advance, check, expectDb, expectReaction, expectWords, tapList, type Run } from './dsl'
import { statement, request, chatter } from './shapes'
import { HOUSE } from './house'
import type { TranscriptEntry } from '@/lib/sandbox/harness'
import { withSimulatedTime } from '@/lib/core/clock'

// The live shopping list (docs/spec/shopping-list.md §Live list, issue #25): ONE message per house,
// posted by /list (or /shoppinghere), pinned silently, and EDITED in place — 5 seconds after the last
// change (at most 30 after the first), or at once after a tap on one of its buttons. The debounce is
// Inngest's, played by the sandbox on its own clock; a render request runs at once, like shopping-render.

const TOPIC = 55
const TOKEN = 'live-list-scenario-token-0123456789'

const all = (r: Run): TranscriptEntry[] => r.turns.flatMap((t) => t.entries)
const lists = (r: Run) => all(r).filter((e) => e.kind === 'message' && e.meta === 'live-list')
const edits = (r: Run) => all(r).filter((e) => e.kind === 'edit')
const last = (r: Run) => r.turns.at(-1)!.entries
const labels = (e: TranscriptEntry | undefined) => (e?.keyboard ?? []).flat().map((b) => b.text)
const toast = (r: Run) => last(r).find((e) => e.kind === 'callback-answer')?.text ?? null

const fixtures = {
  triage: (t: string) =>
    /out of/.test(t) ? statement({ worthRemembering: false, list: 'add' }) : /add coffee/.test(t) ? request({ asksBaumy: true, list: 'add' }) : chatter(),
  list: (t: string) =>
    /out of oat milk/.test(t)
      ? { op: 'add' as const, items: ['oat milk'] }
      : /out of bin bags/.test(t)
        ? { op: 'add' as const, items: ['bin bags'] }
        : /add coffee/.test(t)
          ? { op: 'add' as const, items: ['coffee'] }
          : { op: 'none' as const, items: [] },
}

const kioskAdd = (r: Run, items: string[]) =>
  withSimulatedTime(r.sb.now, () => ADD(
    new Request('http://local/api/kitchen/shopping/add', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
  ))

const THIRTEEN = ['apples', 'bananas', 'bread', 'butter', 'cheese', 'coffee', 'eggs', 'flour', 'ginger', 'honey', 'lemons', 'milk', 'oats']

describe('scenario: the live shopping list', () => {
  beforeEach(() => {
    process.env.KITCHEN_API_TOKEN = TOKEN
  })
  afterEach(() => {
    delete process.env.KITCHEN_API_TOKEN
  })

  scenario('/list in a topic posts it pinned; a burst of adds is ONE edit; a tap ticks (toast + edit); Clear done; /shoppingoff takes it down', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', '/list', { topic: TOPIC }),
      check('the live list is posted in the topic at once, with its buttons, and pinned silently', (r, e) => {
        e(lists(r)).toHaveLength(1)
        const post = lists(r)[0]
        e(post.threadId).toBe(TOPIC)
        e(post.text).toBe('🛒 Shopping list\nNothing to buy.')
        e(labels(post)).toEqual(['🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
        e(last(r).find((x) => x.kind === 'pin')?.meta).toBe(String(post.messageId))
      }),

      // A burst of changes from the group AND a DM (which writes through to the house list).
      say('Marco', "we're out of oat milk"),
      expectReaction('✍'),
      say('Ryan', 'add coffee to the list', { dm: true }),
      expectWords({ contains: /coffee/, judge: 'Confirms coffee was added to the shopping list.' }),
      say('Chloe', "we're out of bin bags"),
      expectReaction('✍'),
      check('nothing edited yet — the debounce waits 5 seconds after the LAST change', (r, e) => e(edits(r)).toHaveLength(0)),
      advance({ seconds: 10 }),
      check('ONE edit with every item, open ones as ☐ buttons; never a new post', (r, e) => {
        e(lists(r)).toHaveLength(1)
        e(edits(r)).toHaveLength(1)
        const ed = edits(r)[0]
        e(ed.meta).toBe(String(lists(r)[0].messageId))
        e(ed.text).toBe('🛒 Shopping list\n3 to buy\nLast updated by Chloe, Tue 13 Oct, 18:00')
        e(labels(ed)).toEqual(['── Not sorted ──', '☐ oat milk', '☐ coffee', '☐ bin bags', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
      }),

      tapList('Ryan', 'coffee'),
      check('the tap: a toast, then the list edited at once with coffee ticked (below the open items)', (r, e) => {
        e(toast(r)).toBe('✓ coffee – ticked by Ryan')
        const ed = last(r).filter((x) => x.kind === 'edit')
        e(ed).toHaveLength(1)
        e(ed[0].text).toBe('🛒 Shopping list\n2 to buy · 1 done\nLast updated by Ryan, Tue 13 Oct, 18:00')
        e(labels(ed[0])).toEqual(['── Not sorted ──', '☐ oat milk', '☐ bin bags', '── Done ──', '☑ coffee', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
        e(last(r).filter((x) => x.kind === 'message')).toHaveLength(0)
      }),
      // Marco's screen still showed ☐ coffee and he tapped it a moment after Ryan: it stays ticked.
      tapList('Marco', 'coffee', { want: 'tick' }),
      check('a second tap on the same ☐ is a no-op: "already ticked", still ticked, the list re-rendered', (r, e) => {
        e(toast(r)).toBe('coffee is already ticked')
        e(labels(last(r).find((x) => x.kind === 'edit'))).toContain('☑ coffee')
      }),
      tapList('Marco', 'Clear done'),
      check('Clear done: the ticked item leaves the list', (r, e) => {
        e(toast(r)).toBe('🧹 Cleared 1 done item')
        e(labels(last(r).find((x) => x.kind === 'edit'))).toEqual(['── Not sorted ──', '☐ oat milk', '☐ bin bags', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
      }),
      expectDb(async (db, r) => {
        // A status board, not conversation: the live list never enters the 48h window.
        const rows = await db.select({ text: messages.textRedacted, kind: messages.authorKind }).from(messages).where(eq(messages.chatId, r.sb.houseChatId))
        // present: the housemates' own messages are windowed…  absent: no copy of the list ever is
        return rows.some((x) => /out of bin bags/.test(x.text)) && !rows.some((x) => /Shopping list|Nothing to buy|to buy/.test(x.text))
      }, 'the live list is not in the conversation window (the housemates\' messages are)'),

      say('Chloe', '/shoppingoff', { topic: TOPIC }),
      expectWords({ contains: /stop/i, judge: 'Says Baumy will stop updating the shopping list. Short; does not list any items.' }),
      check('the live list is unpinned and deleted', (r, e) => {
        const id = String(lists(r)[0].messageId)
        e(last(r).filter((x) => x.kind === 'unpin' || x.kind === 'delete').map((x) => [x.kind, x.meta])).toEqual([
          ['unpin', id],
          ['delete', id],
        ])
      }),
      say('Marco', "we're out of oat milk"),
      advance({ minutes: 1 }),
      check('after /shoppingoff a change edits and posts nothing', (r, e) => {
        e(last(r).filter((x) => x.kind === 'edit' || x.kind === 'message')).toHaveLength(0)
      }),
    ],
  })

  scenario('13 adds through the kitchen API are ONE edit; a tap is a toast + an edit; Clear done', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Ryan', '/list'),
      check('posted in General (no topic)', (r, e) => {
        e(lists(r)).toHaveLength(1)
        e(lists(r)[0].threadId).toBeUndefined()
      }),
      check('the kiosk adds 13 items, one request each', async (r, e) => {
        for (const item of THIRTEEN) e((await kioskAdd(r, [item])).status).toBe(200)
      }),
      check('13 change signals, no edit yet', (r, e) => {
        e(r.events.filter((x) => x.name === 'lists/shopping.changed')).toHaveLength(13)
        e(edits(r)).toHaveLength(0)
      }),
      advance({ seconds: 10 }),
      check('ONE edit, with all 13 items', (r, e) => {
        e(edits(r)).toHaveLength(1)
        e(edits(r)[0].text).toBe('🛒 Shopping list\n13 to buy\nLast updated, Tue 13 Oct, 18:00') // the kiosk named nobody
        e(labels(edits(r)[0])).toEqual(['── Not sorted ──', ...THIRTEEN.map((i) => `☐ ${i}`), '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
        e(lists(r)).toHaveLength(1)
      }),
      tapList('Chloe', 'ginger'),
      check('a toast, then the edit with ginger ticked', (r, e) => {
        e(toast(r)).toBe('✓ ginger – ticked by Chloe')
        const ed = last(r).filter((x) => x.kind === 'edit')
        e(ed).toHaveLength(1)
        e(labels(ed[0]).slice(-5)).toEqual(['── Done ──', '☑ ginger', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
        e(ed[0].text).toBe('🛒 Shopping list\n12 to buy · 1 done\nLast updated by Chloe, Tue 13 Oct, 18:00')
      }),
      tapList('Ryan', 'Clear done'),
      check('Clear done: ginger is gone, 12 left', (r, e) => {
        e(toast(r)).toBe('🧹 Cleared 1 done item')
        const ed = last(r).find((x) => x.kind === 'edit')
        e(labels(ed)).not.toContain('☑ ginger')
        e(labels(ed)).toHaveLength(1 + 12 + 3) // the Not sorted heading, 12 items, the footer
      }),
    ],
  })

  scenario('a long burst still shows: the edit lands 30 seconds after the first change, not 5 after the last', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Ryan', '/list'),
      ...THIRTEEN.slice(0, 10).flatMap((item) => [check(`the kiosk adds ${item}`, async (r) => void (await kioskAdd(r, [item]))), advance({ seconds: 4 })]),
      check('one edit, at the 30-second mark of the burst', (r, e) => {
        const ed = edits(r)
        e(ed.length).toBeGreaterThanOrEqual(1)
        const first = r.turns.find((t) => t.kind === 'say')!.entries[0].at.getTime()
        e(ed[0].at.getTime() - first).toBe(30_000)
      }),
    ],
  })

  scenario('no live list → list changes edit and post nothing', {
    people: HOUSE,
    startAt: '2026-10-13 18:00',
    fixtures,
    steps: [
      say('Marco', "we're out of oat milk"),
      expectReaction('✍'),
      advance({ minutes: 5 }),
      check('no list post and no edit', (r, e) => {
        e(r.events.some((x) => x.name === 'lists/shopping.changed')).toBe(true) // the change WAS signalled…
        e(lists(r)).toHaveLength(0) // …but with no live list there is nothing to edit
        e(edits(r)).toHaveLength(0)
      }),
    ],
  })
})
