import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { listItems } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { addListItems, checkOffItems, currentList, normalizeItem } from '@/lib/lists/store'

const A = '-100listA'
const B = '-100listB'
const sorted = (xs: string[]) => [...xs].sort()

describe('house shopping list — store (group-scoped, precision-first)', () => {
  it('adds items and de-dupes an item that is already open', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    const r1 = await addListItems(db, { groupId: A, items: ['milk', 'eggs', 'bin bags'], addedBy: null })
    expect(sorted(r1.added)).toEqual(['bin bags', 'eggs', 'milk'])
    expect(r1.already).toEqual([])

    // re-add milk (already open, different case) + a genuinely new item.
    const r2 = await addListItems(db, { groupId: A, items: ['MILK', 'coffee'], addedBy: null })
    expect(r2.added).toEqual(['coffee'])
    expect(r2.already).toEqual(['MILK']) // normalized match; display string preserved

    const open = await currentList(db, A)
    expect(sorted(open.map((r) => r.item))).toEqual(['bin bags', 'coffee', 'eggs', 'milk'])
    // the dedup held: exactly ONE open 'milk' row, not two.
    expect(open.filter((r) => normalizeItem(r.item) === 'milk')).toHaveLength(1)
  })

  it('de-dupes repeats WITHIN a single add', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    const r = await addListItems(db, { groupId: A, items: ['milk', 'Milk', '  milk '], addedBy: null })
    expect(r.added).toEqual(['milk']) // three spellings collapse to one row
    expect((await currentList(db, A)).length).toBe(1)
  })

  it('checks items off (bought) so they leave the open list; reports what was not on it', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await addListItems(db, { groupId: A, items: ['milk', 'eggs', 'bin bags'], addedBy: null })
    const res = await checkOffItems(db, { groupId: A, items: ['milk', 'eggs', 'nutmeg'], checkedBy: null })
    expect(sorted(res.checkedOff)).toEqual(['eggs', 'milk'])
    expect(res.notFound).toEqual(['nutmeg']) // never was on the list
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['bin bags'])
  })

  it('a bought item can be re-added as a fresh open row (partial-unique allows it)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })
    await checkOffItems(db, { groupId: A, items: ['milk'], checkedBy: null })
    expect(await currentList(db, A)).toHaveLength(0)
    const re = await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })
    expect(re.added).toEqual(['milk']) // NOT blocked as a dup — the checked-off row left the open predicate
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['milk'])
  })

  it('is group-scoped: one house can neither see nor check off another house list', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await ensureRegistered(db, B, null)
    await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })
    // house B's list is (and stays) empty
    expect(await currentList(db, B)).toHaveLength(0)
    // house B checking off "milk" finds nothing — it's A's row, in a different scope
    const res = await checkOffItems(db, { groupId: B, items: ['milk'], checkedBy: null })
    expect(res.checkedOff).toEqual([])
    expect(res.notFound).toEqual(['milk'])
    // A's milk is untouched
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['milk'])
  })

  it('attributes add + check-off to the authenticated member', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await upsertMember(db, A, '810', 'Ryan', 'member')
    await upsertMember(db, A, '820', 'Marco', 'member')
    await addListItems(db, { groupId: A, items: ['milk'], addedBy: '810' })
    await checkOffItems(db, { groupId: A, items: ['milk'], checkedBy: '820' })
    const [row] = await db.select().from(listItems).where(and(eq(listItems.groupId, A), eq(listItems.itemNormalized, 'milk')))
    expect(row.addedBy).toBe('810')
    expect(row.checkedBy).toBe('820')
    expect(row.checkedAt).not.toBeNull()
  })

  it('a blank/whitespace-only add is a no-op', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    const r = await addListItems(db, { groupId: A, items: ['', '   '], addedBy: null })
    expect(r.added).toEqual([])
    expect(await currentList(db, A)).toHaveLength(0)
  })

  it('sanitizes a malformed batch (drops blanks, clamps length, caps count) instead of failing', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    const long = 'x'.repeat(200)
    const many = Array.from({ length: 50 }, (_, i) => `item${i}`)
    const r = await addListItems(db, { groupId: A, items: ['milk', '', long, ...many], addedBy: null })
    expect(r.added).toContain('milk') // a valid item alongside garbage still lands
    expect(r.added.some((x) => x.length === 80)).toBe(true) // the over-long item was clamped, not rejected
    expect(r.added.length).toBeLessThanOrEqual(30) // runaway batch capped
    expect((await currentList(db, A)).length).toBeLessThanOrEqual(30)
  })
})
