import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { houseConfig } from '@/db/schema'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_SOURCES,
  NOT_SORTED_LABEL,
  SORT_MODES,
  SORT_LABELS,
  asCategory,
  categoryLabel,
  isCategory,
  isSortMode,
  nextSortMode,
} from '@/lib/lists/categories'

// The fixed category enum (issue #29, owner ruling 2026-10-11) and the live list's order modes.

describe('shopping categories — the fixed enum', () => {
  it('is exactly the six groups, in the owner\'s order, with their labels; null is "Not sorted"', () => {
    expect([...CATEGORIES]).toEqual(['pantry', 'fresh', 'coffee', 'cleaning', 'maintenance', 'household'])
    expect(CATEGORIES.map((c) => CATEGORY_LABELS[c])).toEqual(['Pantry', 'Fresh', 'Coffee', 'Cleaning', 'Maintenance', 'Household'])
    expect(categoryLabel(null)).toBe(NOT_SORTED_LABEL)
    expect(NOT_SORTED_LABEL).toBe('Not sorted')
    expect([...CATEGORY_SOURCES]).toEqual(['picked', 'remembered', 'similar', 'guessed'])
  })

  it('isCategory / asCategory accept only the keys — never a label, another case, or junk', () => {
    for (const c of CATEGORIES) expect(isCategory(c)).toBe(true)
    for (const bad of ['Coffee', 'COFFEE', ' coffee', 'drinks', '', null, undefined, 3, {}]) {
      expect(isCategory(bad)).toBe(false)
      expect(asCategory(bad)).toBeNull()
    }
    expect(asCategory('fresh')).toBe('fresh')
  })

  it('sort modes cycle Groups → A–Z → Added → Groups; the label is the current mode', () => {
    expect([...SORT_MODES]).toEqual(['groups', 'az', 'added'])
    expect(nextSortMode('groups')).toBe('az')
    expect(nextSortMode('az')).toBe('added')
    expect(nextSortMode('added')).toBe('groups')
    expect(SORT_LABELS).toEqual({ groups: '🗂 Groups', az: '🔤 A–Z', added: '🕒 Added' })
    expect(isSortMode('az')).toBe(true)
    expect(isSortMode('AZ')).toBe(false)
  })
})

describe('the database holds only the enum (CHECK constraints, PGlite DDL)', () => {
  const G = '-100cats'
  it('a list row takes a known category + source or null; anything else is refused', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, G, null)
    const ins = (cat: string | null, src: string | null) =>
      db.execute(sql`INSERT INTO baumy_list_items (group_id, item, item_normalized, category, category_source) VALUES (${G}, 'x', ${`x${Math.random()}`}, ${cat}, ${src})`)
    // present: every key and source goes in
    for (const c of CATEGORIES) await ins(c, 'guessed')
    await ins(null, null)
    // absent: a label, a typo, an unknown source
    await expect(ins('Coffee', 'picked')).rejects.toThrow()
    await expect(ins('drinks', 'picked')).rejects.toThrow()
    await expect(ins('coffee', 'vibes')).rejects.toThrow()
    await expect(db.execute(sql`INSERT INTO baumy_list_categories (group_id, item_normalized, category) VALUES (${G}, 'milk', 'dairy')`)).rejects.toThrow()
    await db.execute(sql`INSERT INTO baumy_list_categories (group_id, item_normalized, category) VALUES (${G}, 'milk', 'fresh')`)
  })

  it('the house sort mode defaults to groups and takes only the three modes', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: G })
    const [cfg] = await db.select({ s: houseConfig.shoppingSort }).from(houseConfig)
    expect(cfg.s).toBe('groups')
    await db.update(houseConfig).set({ shoppingSort: 'az' })
    await expect(db.update(houseConfig).set({ shoppingSort: 'random' })).rejects.toThrow()
  })
})
