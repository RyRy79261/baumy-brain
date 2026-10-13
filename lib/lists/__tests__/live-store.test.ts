import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig, listItems } from '@/db/schema'
import type { Database } from '@/db/client'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { withSimulatedTime } from '@/lib/core/clock'
import {
  addListItems,
  checkOffItems,
  clearDoneItems,
  currentList,
  liveListRows,
  markShoppingUpdated,
  removeItems,
  toggleListItem,
} from '@/lib/lists/store'

// The live list's store half (issue #25, docs/spec/shopping-list.md §Live list): a ticked item stays on
// the list until "Clear done"; a tap toggles ONE row by id, scoped to the house; the "last updated by"
// stamp; and migration 0027's backfill.

const A = '-100liveA'
const B = '-100liveB'
const RYAN = '111'

async function house(): Promise<Database> {
  const db = await makeTestDb()
  await ensureRegistered(db, A, null)
  await ensureRegistered(db, B, null)
  await upsertMember(db, A, RYAN, 'Ryan')
  return db
}
const idOf = async (db: Database, groupId: string, item: string) =>
  (await db.select({ id: listItems.id, item: listItems.item, g: listItems.groupId }).from(listItems)).find((r) => r.item === item && r.g === groupId)!.id

describe('liveListRows — what the live list shows', () => {
  it('open items first (oldest first), then done ones in the order they were ticked; removed and cleared rows are not shown', async () => {
    const db = await house()
    await withSimulatedTime(new Date('2026-10-13T10:00:00Z'), () => addListItems(db, { groupId: A, items: ['milk'], addedBy: null }))
    await withSimulatedTime(new Date('2026-10-13T10:01:00Z'), () => addListItems(db, { groupId: A, items: ['eggs'], addedBy: null }))
    await withSimulatedTime(new Date('2026-10-13T10:02:00Z'), () => addListItems(db, { groupId: A, items: ['ginger', 'soap', 'tea'], addedBy: null }))
    await withSimulatedTime(new Date('2026-10-13T11:00:00Z'), () => checkOffItems(db, { groupId: A, items: ['tea'], checkedBy: null }))
    await withSimulatedTime(new Date('2026-10-13T11:05:00Z'), () => checkOffItems(db, { groupId: A, items: ['milk'], checkedBy: null }))
    await removeItems(db, { groupId: A, items: ['soap'], removedBy: null })
    await addListItems(db, { groupId: B, items: ['other house'], addedBy: null })

    const rows = await liveListRows(db, A)
    expect(rows.map((r) => [r.item, r.done])).toEqual([
      ['eggs', false],
      ['ginger', false],
      ['tea', true],
      ['milk', true],
    ])
    expect(await clearDoneItems(db, { groupId: A })).toBe(2)
    expect((await liveListRows(db, A)).map((r) => r.item)).toEqual(['eggs', 'ginger'])
    // what to buy is unchanged by the done rows
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['eggs', 'ginger'])
  })
})

describe('toggleListItem — one tap, one atomic UPDATE keyed on id + house', () => {
  it('ticks an open item (with who), then unticks it', async () => {
    const db = await house()
    await addListItems(db, { groupId: A, items: ['Ginger'], addedBy: null })
    const id = await idOf(db, A, 'Ginger')

    expect(await toggleListItem(db, { groupId: A, itemId: id, by: RYAN })).toEqual({ outcome: 'ticked', item: 'Ginger' })
    const [ticked] = await db.select().from(listItems).where(eq(listItems.id, id))
    expect(ticked.checkedAt).not.toBeNull()
    expect(ticked.checkedBy).toBe(RYAN)
    expect(await currentList(db, A)).toEqual([]) // no longer to buy…
    expect((await liveListRows(db, A)).map((r) => [r.item, r.done])).toEqual([['Ginger', true]]) // …but still shown

    expect(await toggleListItem(db, { groupId: A, itemId: id, by: RYAN })).toEqual({ outcome: 'unticked', item: 'Ginger' })
    const [open] = await db.select().from(listItems).where(eq(listItems.id, id))
    expect(open.checkedAt).toBeNull()
    expect(open.checkedBy).toBeNull()
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['Ginger'])
  })

  it('never touches another house’s row: the id alone is not enough', async () => {
    const db = await house()
    await addListItems(db, { groupId: B, items: ['milk'], addedBy: null })
    const id = await idOf(db, B, 'milk')
    expect(await toggleListItem(db, { groupId: A, itemId: id, by: RYAN })).toEqual({ outcome: 'gone', item: null })
    const [row] = await db.select().from(listItems).where(eq(listItems.id, id))
    expect(row.item).toBe('milk') // present…
    expect(row.checkedAt).toBeNull() // …and untouched
  })

  it('a removed or cleared row is gone (a stale button changes nothing)', async () => {
    const db = await house()
    await addListItems(db, { groupId: A, items: ['milk', 'eggs'], addedBy: null })
    const milk = await idOf(db, A, 'milk')
    const eggs = await idOf(db, A, 'eggs')
    await removeItems(db, { groupId: A, items: ['milk'], removedBy: null })
    expect((await toggleListItem(db, { groupId: A, itemId: milk, by: RYAN })).outcome).toBe('gone')
    await toggleListItem(db, { groupId: A, itemId: eggs, by: RYAN })
    expect(await clearDoneItems(db, { groupId: A })).toBe(1)
    expect((await toggleListItem(db, { groupId: A, itemId: eggs, by: RYAN })).outcome).toBe('gone')
    const [row] = await db.select().from(listItems).where(eq(listItems.id, eggs))
    expect(row.checkedAt).not.toBeNull() // the bought record stays
  })

  it('re-opening a done item that was re-added since clears the done row instead (never two open copies)', async () => {
    const db = await house()
    await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })
    const first = await idOf(db, A, 'milk')
    await toggleListItem(db, { groupId: A, itemId: first, by: RYAN })
    // someone adds milk again while the ticked one is still shown
    expect((await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })).added).toEqual(['milk'])
    expect((await liveListRows(db, A)).map((r) => [r.item, r.done])).toEqual([
      ['milk', false],
      ['milk', true],
    ])
    expect(await toggleListItem(db, { groupId: A, itemId: first, by: RYAN })).toEqual({ outcome: 'already_open', item: 'milk' })
    const rows = await liveListRows(db, A)
    expect(rows.map((r) => [r.item, r.done])).toEqual([['milk', false]])
    expect(rows[0].id).not.toBe(first)
  })

  it('two taps on the same item, back to back: each flips the state it finds (serialised by the row lock)', async () => {
    const db = await house()
    await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })
    const id = await idOf(db, A, 'milk')
    const both = await Promise.all([toggleListItem(db, { groupId: A, itemId: id, by: RYAN }), toggleListItem(db, { groupId: A, itemId: id, by: RYAN })])
    expect(both.map((r) => r.outcome).sort()).toEqual(['ticked', 'unticked'])
    const [row] = await db.select().from(listItems).where(eq(listItems.id, id))
    expect(row.checkedAt).toBeNull()
    expect(row.checkedBy).toBeNull()
  })
})

describe('clearDoneItems', () => {
  it('clears only done rows of THIS house; open rows and the other house stay', async () => {
    const db = await house()
    await addListItems(db, { groupId: A, items: ['milk', 'eggs'], addedBy: null })
    await addListItems(db, { groupId: B, items: ['milk'], addedBy: null })
    await checkOffItems(db, { groupId: A, items: ['milk'], checkedBy: null })
    await checkOffItems(db, { groupId: B, items: ['milk'], checkedBy: null })
    expect(await clearDoneItems(db, { groupId: A })).toBe(1)
    expect(await clearDoneItems(db, { groupId: A })).toBe(0) // nothing left to clear
    expect((await liveListRows(db, A)).map((r) => r.item)).toEqual(['eggs'])
    expect((await liveListRows(db, B)).map((r) => [r.item, r.done])).toEqual([['milk', true]])
  })
})

describe('markShoppingUpdated — the "Last updated by" stamp', () => {
  it('stores a member id and the time; an id that is not a member is stored as nobody', async () => {
    const db = await house()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: A })
    const at = new Date('2026-10-13T16:05:00Z')
    await withSimulatedTime(at, () => markShoppingUpdated(db, RYAN))
    let [cfg] = await db.select({ by: houseConfig.shoppingUpdatedBy, at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg).toEqual({ by: RYAN, at })
    await markShoppingUpdated(db, '999') // not a member row
    ;[cfg] = await db.select({ by: houseConfig.shoppingUpdatedBy, at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg.by).toBeNull()
    await markShoppingUpdated(db, null)
    ;[cfg] = await db.select({ by: houseConfig.shoppingUpdatedBy, at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg.by).toBeNull()
  })
})

describe('migration 0027 — rows bought before the live list are cleared, idempotently', () => {
  it('sets cleared_at = checked_at on bought rows only, and a re-run changes nothing', async () => {
    const db = await house()
    await addListItems(db, { groupId: A, items: ['milk', 'eggs', 'soap'], addedBy: null })
    const bought = new Date('2026-10-01T09:00:00Z')
    await withSimulatedTime(bought, () => checkOffItems(db, { groupId: A, items: ['milk'], checkedBy: null }))
    await removeItems(db, { groupId: A, items: ['soap'], removedBy: null })
    const migration = readFileSync(join(process.cwd(), 'db/migrations/0027_backfill_list_cleared_at.sql'), 'utf8')

    await db.execute(sql.raw(migration))
    const rows = async () => Object.fromEntries((await db.select().from(listItems)).map((r) => [r.item, r.clearedAt]))
    expect(await rows()).toEqual({ milk: bought, eggs: null, soap: null })
    expect((await liveListRows(db, A)).map((r) => r.item)).toEqual(['eggs'])

    // re-run: a row cleared since keeps its own cleared_at
    await addListItems(db, { groupId: A, items: ['tea'], addedBy: null })
    await withSimulatedTime(new Date('2026-10-13T12:00:00Z'), async () => {
      await checkOffItems(db, { groupId: A, items: ['tea'], checkedBy: null })
    })
    const later = new Date('2026-10-13T13:00:00Z')
    await withSimulatedTime(later, () => clearDoneItems(db, { groupId: A }))
    await db.execute(sql.raw(migration))
    const after = await rows()
    expect(after.milk).toEqual(bought)
    expect(after.tea).toEqual(later)
    expect(after.eggs).toBeNull()
  })
})
