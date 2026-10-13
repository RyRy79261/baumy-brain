import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { listItems } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { addListItems, checkOffItems, currentList, normalizeItem, looseItemKey, removeItems, renameItem, isUniqueViolation } from '@/lib/lists/store'

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

  // K4 (the "consider" half of the fix): a check-off tolerates an article and a plain plural — but only
  // when exactly one open item fits, so a near-miss is still reported, never guessed at.
  it('check-off tolerates articles and plain plurals, for an unambiguous single item only (K4)', async () => {
    expect(looseItemKey('the eggs')).toBe('egg')
    expect(looseItemKey('Bin Bag')).toBe(looseItemKey('bin bags'))
    expect(looseItemKey('glass')).toBe('glass') // a word that ends in s is not a plural
    expect(looseItemKey('almond milk')).not.toBe(looseItemKey('milk'))
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await addListItems(db, { groupId: A, items: ['egg', 'bin bags', 'almond milk', 'sponge', 'sponges'], addedBy: null })
    const res = await checkOffItems(db, { groupId: A, items: ['the eggs', 'bin bag', 'milk', 'a sponge'], checkedBy: null })
    expect(sorted(res.checkedOff)).toEqual(['bin bags', 'egg'])
    // "milk" never ticks "almond milk"; "a sponge" loosely fits TWO open rows ("sponge" exactly
    // failed only because of the article) → ambiguous, left alone
    expect(sorted(res.notFound)).toEqual(['a sponge', 'milk'])
    expect(sorted((await currentList(db, A)).map((r) => r.item))).toEqual(['almond milk', 'sponge', 'sponges'])
    // the loose pass stays inside the scope: another house's identical item is untouched
    await ensureRegistered(db, B, null)
    await addListItems(db, { groupId: B, items: ['cheese'], addedBy: null })
    expect((await checkOffItems(db, { groupId: A, items: ['the cheeses'], checkedBy: null })).notFound).toEqual(['the cheeses'])
    expect((await currentList(db, B)).map((r) => r.item)).toEqual(['cheese'])
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

// Issue #23: remove WITHOUT buying, and rename. Same group scope, same exact-then-unambiguous match.
describe('house shopping list — remove and rename (issue #23)', () => {
  const row = async (db: Awaited<ReturnType<typeof makeTestDb>>, groupId: string, n: string) =>
    db.select().from(listItems).where(and(eq(listItems.groupId, groupId), eq(listItems.itemNormalized, n)))

  it('remove is a SOFT remove — is_active=false, attributed, and never a bought record', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await upsertMember(db, A, '810', 'Ryan', 'member')
    await addListItems(db, { groupId: A, items: ['milk', 'eggs', 'bin bags'], addedBy: null })
    const res = await removeItems(db, { groupId: A, items: ['milk', 'the eggs', 'nutmeg'], removedBy: '810' })
    expect(sorted(res.removed)).toEqual(['eggs', 'milk'])
    expect(res.notFound).toEqual(['nutmeg'])
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['bin bags'])
    const [milk] = await row(db, A, 'milk')
    expect(milk).toBeDefined() // still there — soft
    expect(milk.isActive).toBe(false)
    expect(milk.removedBy).toBe('810')
    expect(milk.removedAt).not.toBeNull()
    expect(milk.checkedAt).toBeNull() // NOT bought
    expect(milk.checkedBy).toBeNull()
    // a removed item can go back on as a fresh open row
    expect((await addListItems(db, { groupId: A, items: ['milk'], addedBy: null })).added).toEqual(['milk'])
  })

  it('remove leaves an ambiguous loose match alone, and never touches another house', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await ensureRegistered(db, B, null)
    await addListItems(db, { groupId: A, items: ['sponge', 'sponges', 'almond milk'], addedBy: null })
    await addListItems(db, { groupId: B, items: ['cheese'], addedBy: null })
    const res = await removeItems(db, { groupId: A, items: ['a sponge', 'milk', 'cheese'], removedBy: null })
    expect(res.removed).toEqual([])
    expect(sorted(res.notFound)).toEqual(['cheese', 'milk'])
    // ambiguous is reported apart from not-found, naming what it could mean
    expect(res.ambiguous).toHaveLength(1)
    expect(res.ambiguous[0].item).toBe('a sponge')
    expect(sorted(res.ambiguous[0].matches)).toEqual(['sponge', 'sponges'])
    // a check-off keeps folding an ambiguous name into notFound (K4 ack unchanged)
    expect((await checkOffItems(db, { groupId: A, items: ['a sponge'], checkedBy: null })).notFound).toEqual(['a sponge'])
    expect(sorted((await currentList(db, A)).map((r) => r.item))).toEqual(['almond milk', 'sponge', 'sponges'])
    expect((await currentList(db, B)).map((r) => r.item)).toEqual(['cheese'])
  })

  it('rename keeps the row (id, added_by), changes item + its key, and is attributed', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await upsertMember(db, A, '810', 'Ryan', 'member')
    await upsertMember(db, A, '820', 'Marco', 'member')
    await addListItems(db, { groupId: A, items: ['mlik', 'eggs'], addedBy: '810' })
    const [before] = await row(db, A, 'mlik')
    expect(await renameItem(db, { groupId: A, from: 'mlik', to: 'Milk', renamedBy: '820' })).toEqual({ outcome: 'renamed', from: 'mlik', to: 'Milk', resortId: expect.any(String) })
    const [after] = await row(db, A, 'milk')
    expect(after.id).toBe(before.id)
    expect(after.item).toBe('Milk')
    expect(after.addedBy).toBe('810')
    expect(after.renamedBy).toBe('820')
    expect(after.renamedAt).not.toBeNull()
    expect(await row(db, A, 'mlik')).toHaveLength(0)
    expect(sorted((await currentList(db, A)).map((r) => r.item))).toEqual(['Milk', 'eggs'])
    // a display-only fix (same key) renames in place; the very same text changes nothing
    expect(await renameItem(db, { groupId: A, from: 'milk', to: 'milk', renamedBy: null })).toEqual({ outcome: 'renamed', from: 'Milk', to: 'milk' })
    expect(await renameItem(db, { groupId: A, from: 'milk', to: 'milk', renamedBy: null })).toEqual({ outcome: 'unchanged', from: 'milk', to: 'milk' })
  })

  it('rename onto a name that is already open MERGES: the old row is removed, never a second copy', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await upsertMember(db, A, '810', 'Ryan', 'member')
    await addListItems(db, { groupId: A, items: ['milk', 'mlik'], addedBy: null })
    const res = await renameItem(db, { groupId: A, from: 'mlik', to: 'MILK', renamedBy: '810' })
    expect(res).toEqual({ outcome: 'merged', from: 'mlik', to: 'milk' })
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['milk'])
    const [old] = await row(db, A, 'mlik')
    expect(old.isActive).toBe(false)
    expect(old.removedBy).toBe('810')
    expect(old.checkedAt).toBeNull() // a merge is not a purchase
  })

  it('rename changes nothing for a missing or ambiguous match, and stays inside the scope', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await ensureRegistered(db, B, null)
    await addListItems(db, { groupId: A, items: ['sponge', 'sponges', 'egg'], addedBy: null })
    await addListItems(db, { groupId: B, items: ['cheese'], addedBy: null })
    const amb = await renameItem(db, { groupId: A, from: 'a sponge', to: 'scourer', renamedBy: null })
    expect(amb).toMatchObject({ outcome: 'ambiguous', from: 'a sponge', to: 'scourer' })
    expect(sorted(amb.matches ?? [])).toEqual(['sponge', 'sponges'])
    expect(await renameItem(db, { groupId: A, from: 'nutmeg', to: 'mace', renamedBy: null })).toMatchObject({ outcome: 'not_found' })
    expect(await renameItem(db, { groupId: A, from: 'cheese', to: 'brie', renamedBy: null })).toMatchObject({ outcome: 'not_found' })
    expect(await renameItem(db, { groupId: A, from: 'egg', to: '   ', renamedBy: null })).toMatchObject({ outcome: 'not_found' })
    expect(sorted((await currentList(db, A)).map((r) => r.item))).toEqual(['egg', 'sponge', 'sponges'])
    expect((await currentList(db, B)).map((r) => r.item)).toEqual(['cheese'])
    // the unambiguous loose match does rename: "the eggs" → the one open "egg"
    expect(await renameItem(db, { groupId: A, from: 'the eggs', to: 'free-range eggs', renamedBy: null })).toEqual({
      outcome: 'renamed',
      from: 'egg',
      to: 'free-range eggs',
      resortId: expect.any(String), // a new name is sorted again (issue #29)
    })
  })

  it('a checked-off or removed row is never renamed or removed again', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await addListItems(db, { groupId: A, items: ['milk', 'tea'], addedBy: null })
    await checkOffItems(db, { groupId: A, items: ['milk'], checkedBy: null })
    await removeItems(db, { groupId: A, items: ['tea'], removedBy: null })
    expect(await renameItem(db, { groupId: A, from: 'milk', to: 'oat milk', renamedBy: null })).toMatchObject({ outcome: 'not_found' })
    expect((await removeItems(db, { groupId: A, items: ['tea', 'milk'], removedBy: null })).removed).toEqual([])
    const [milk] = await row(db, A, 'milk')
    expect(milk.isActive).toBe(true) // still the bought record, untouched
    expect(milk.checkedAt).not.toBeNull()
  })

  // renameItem's race fallback (a concurrent add of the new name wins the partial-unique index between
  // its check and its write → merge) hinges on recognising the driver's unique_violation.
  it('recognises the partial-unique violation a raced rename would hit', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await addListItems(db, { groupId: A, items: ['milk', 'mlik'], addedBy: null })
    const err = await db
      .update(listItems)
      .set({ itemNormalized: 'milk' })
      .where(eq(listItems.itemNormalized, 'mlik'))
      .then(() => null, (e: unknown) => e)
    expect(err).not.toBeNull()
    expect(isUniqueViolation(err)).toBe(true)
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
  })

  // The concurrent-add race: between renameItem's "is `to` already open?" check and its UPDATE, someone
  // adds `to`, so the UPDATE hits the partial-unique index (23505). It must become a merge, not throw.
  it('a rename that loses the race to a concurrent add of the new name becomes a merge', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, A, null)
    await addListItems(db, { groupId: A, items: ['mlik'], addedBy: null })
    let raced = false
    // A db whose rename UPDATE (the one that sets item_normalized) first lets a "concurrent" add of
    // "milk" land, then runs for real — so PGlite throws a genuine unique_violation.
    const racy = new Proxy(db, {
      get(target, key, recv) {
        if (key !== 'update') return Reflect.get(target, key, recv)
        return (table: typeof listItems) => ({
          set: (values: Record<string, unknown>) => ({
            where: (w: Parameters<ReturnType<ReturnType<typeof db.update>['set']>['where']>[0]) => {
              const real = () => target.update(table).set(values).where(w)
              if (!('itemNormalized' in values) || raced) return real()
              return {
                returning: (cols: Parameters<ReturnType<typeof real>['returning']>[0]) =>
                  (async () => {
                    raced = true
                    await addListItems(target, { groupId: A, items: ['milk'], addedBy: null })
                    return real().returning(cols)
                  })(),
              }
            },
          }),
        })
      },
    }) as typeof db
    expect(await renameItem(racy, { groupId: A, from: 'mlik', to: 'milk', renamedBy: null })).toEqual({ outcome: 'merged', from: 'mlik', to: 'milk' })
    expect(raced).toBe(true)
    expect((await currentList(db, A)).map((r) => r.item)).toEqual(['milk'])
    const [old] = await db.select().from(listItems).where(eq(listItems.itemNormalized, 'mlik'))
    expect(old.isActive).toBe(false)
  })
})
