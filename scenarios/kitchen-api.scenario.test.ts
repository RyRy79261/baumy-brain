import { afterEach, beforeEach, describe } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { listItems } from '@/db/schema'
import type { Database } from '@/db/client'
import { GET } from '@/app/api/kitchen/shopping/route'
import { POST as ADD } from '@/app/api/kitchen/shopping/add/route'
import { POST as CHECKOFF } from '@/app/api/kitchen/shopping/checkoff/route'
import { scenario, say, expectWords, check } from './dsl'
import { question, request } from './shapes'
import { HOUSE } from './house'

// One shopping list, two front doors (docs/spec/shopping-list.md §Kitchen API): what the kitchen
// kiosk adds through the API is what a housemate sees from Telegram, and what they tick off in a DM
// is gone from the kiosk. Also under the BAUMY_HOUSE_CHAT_ID pin, where the scope is the pinned id
// rather than the captured house_group_chat_id — the API and the Telegram lane must agree on it.

const TOKEN = 'kitchen-scenario-token-0123456789'
const PIN = '-100pinnedKitchenScope'

const call = (handler: (req: Request) => Promise<Response>, path: string, body?: unknown) =>
  handler(
    new Request(`http://local/api/kitchen/shopping${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )

const apiItems = async (): Promise<string[]> => {
  const res = await call(GET, '')
  if (res.status !== 200) throw new Error(`kitchen GET → ${res.status}`)
  return ((await res.json()) as { items: { item: string }[] }).items.map((i) => i.item).sort()
}

const openRows = async (db: Database, groupId: string) =>
  (await db.select().from(listItems).where(and(eq(listItems.groupId, groupId), eq(listItems.isActive, true), isNull(listItems.checkedAt))))
    .map((r) => r.item)
    .sort()

const fixtures = {
  triage: (t: string) =>
    /what's on/.test(t)
      ? question({ asksBaumy: true, list: 'query' })
      : /^got /.test(t)
        ? request({ asksBaumy: true, list: 'checkoff' })
        : request({ asksBaumy: true, list: 'add' }),
  list: (t: string) =>
    /what's on/.test(t)
      ? { op: 'query' as const, items: [] }
      : /got the oat milk/.test(t)
        ? { op: 'checkoff' as const, items: ['oat milk'] }
        : /add coffee/.test(t)
          ? { op: 'add' as const, items: ['coffee'] }
          : { op: 'none' as const, items: [] },
}

const steps = (scopeOf: (r: { sb: { houseChatId: string } }) => string) => [
  check('the kiosk adds oat milk and bin bags through the API', async (_r, e) => {
    const res = await call(ADD, '/add', { items: ['oat milk', 'bin bags'] })
    e(res.status).toBe(200)
  }),
  say('Marco', "what's on the shopping list?", { dm: true }),
  expectWords({ contains: /oat milk[\s\S]*bin bags|bin bags[\s\S]*oat milk/, judge: 'Lists the shopping list, which has oat milk and bin bags on it.' }),
  say('Ryan', 'add coffee to the list', { dm: true }),
  check('the kiosk sees the item Ryan added from Telegram, on the same scope', async (r, e) => {
    e(await apiItems()).toEqual(['bin bags', 'coffee', 'oat milk'])
    e(await openRows(r.db, scopeOf(r))).toEqual(['bin bags', 'coffee', 'oat milk'])
  }),
  say('Marco', 'got the oat milk', { dm: true }),
  check('what Marco ticked off in Telegram is gone from the kiosk; the kiosk ticks bin bags', async (r, e) => {
    e(await apiItems()).toEqual(['bin bags', 'coffee'])
    const off = await call(CHECKOFF, '/checkoff', { items: ['bin bags'], telegramUserId: 702 })
    e(((await off.json()) as { checkedOff: string[] }).checkedOff).toEqual(['bin bags'])
    e(await openRows(r.db, scopeOf(r))).toEqual(['coffee'])
  }),
  say('Chloe', "what's on the shopping list?", { dm: true }),
  expectWords({ contains: /coffee/, judge: 'Says the shopping list has coffee on it (and nothing else).' }),
  check('the Telegram DM and the API read the same rows', async (_r, e) => e(await apiItems()).toEqual(['coffee'])),
]

describe('scenario: kitchen shopping API shares the Telegram list', () => {
  beforeEach(() => {
    process.env.KITCHEN_API_TOKEN = TOKEN
  })
  afterEach(() => {
    delete process.env.KITCHEN_API_TOKEN
  })

  scenario('the kiosk and a housemate DM read and write one list', {
    people: HOUSE,
    startAt: '2026-09-27 18:00',
    fixtures,
    steps: steps((r) => r.sb.houseChatId),
  })

  scenario('the same, with BAUMY_HOUSE_CHAT_ID pinning the scope', {
    people: HOUSE,
    startAt: '2026-09-27 18:00',
    fixtures,
    steps: [
      // The harness restores BAUMY_HOUSE_CHAT_ID after the run.
      check('pin the house scope to an id other than the captured one', () => {
        process.env.BAUMY_HOUSE_CHAT_ID = PIN
      }),
      ...steps(() => PIN),
      check('nothing landed on the captured (un-pinned) id', async (r, e) => e(await openRows(r.db, r.sb.houseChatId)).toEqual([])),
    ],
  })
})
