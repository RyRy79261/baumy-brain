import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { listItems } from '@/db/schema'
import { now as clockNow } from '@/lib/core/clock'

// A house list is a first-class, group-scoped, stateful table (docs/spec/shopping-list.md) —
// distinct from fuzzy fact-memory. Every read/write here is keyed on `groupId` (= the house
// SCOPE from houseScopeForOrigin, never the inbound chat) so a member DM writes THROUGH to the
// shared house list. Quarantine + attribution are enforced by the CALLER (ingest), the same as
// captureMemory: this layer trusts its inputs are already lane-gated.

export const DEFAULT_LIST = 'shopping'
const MAX_ITEM_LEN = 80 // clamp a runaway item string (the extractor is intentionally loose)
const MAX_ITEMS = 30 // cap a garbage/runaway batch — this layer is the precision gate

// Precision-first dedupe key: lower-case + collapse whitespace, nothing more. It backs an EXACT
// UNIQUE index, so it must NEVER trigram/alias-merge — "milk" and "almond milk" are different
// items and must stay distinct (write side is precision-first; the read side fuzzes elsewhere).
export function normalizeItem(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

// The READ-side key for check-off only (K4): a leading article/quantifier and a plain plural are
// dropped, so "got the eggs" ticks "egg" and "bought bin bag" ticks "bin bags". Never used for the
// UNIQUE add key above; a loose match only counts when exactly ONE open item has that key, so
// "milk" still never ticks "almond milk" (different key) and an ambiguous pair is left alone.
export function looseItemKey(s: string): string {
  const words = normalizeItem(s)
    .replace(/[.!?,;:]+$/, '')
    .replace(/^(?:the|a|an|some|more|our|the last|any)\s+/, '')
    .split(' ')
  const last = words[words.length - 1] ?? ''
  if (last.length > 3) words[words.length - 1] = last.replace(/(?:(?<=[sxz]|ch|sh)es|(?<!s)s)$/, '')
  return words.join(' ')
}

export interface ListRow {
  id: string
  item: string
  addedBy: string | null
  createdAt: Date
}

// Collapse a batch of raw item strings to unique {normalized → first-seen display}, dropping
// blanks. First spelling wins for display ("Oat Milk" then "oat milk" → shows "Oat Milk").
function dedupeInput(items: string[]): Map<string, string> {
  const seen = new Map<string, string>()
  for (const raw of items) {
    if (seen.size >= MAX_ITEMS) break // cap a runaway/garbage batch
    const display = raw.trim().slice(0, MAX_ITEM_LEN)
    if (!display) continue // drop blanks — never fatal
    const norm = normalizeItem(display)
    if (!norm) continue
    if (!seen.has(norm)) seen.set(norm, display)
  }
  return seen
}

// Add items to a house list. A re-add of something already OPEN is a no-op (reported as
// `already`, never a duplicate row) — the partial-unique index backstops a concurrent race.
// Returns the display names ACTUALLY added vs. already present, for the ack.
export async function addListItems(
  db: Database,
  input: { groupId: string; items: string[]; addedBy: string | null; listName?: string },
): Promise<{ added: string[]; already: string[] }> {
  const listName = input.listName ?? DEFAULT_LIST
  const wanted = dedupeInput(input.items)
  if (wanted.size === 0) return { added: [], already: [] }

  const norms = [...wanted.keys()]
  const openRows = await db
    .select({ n: listItems.itemNormalized })
    .from(listItems)
    .where(
      and(
        eq(listItems.groupId, input.groupId),
        eq(listItems.listName, listName),
        eq(listItems.isActive, true),
        isNull(listItems.checkedAt),
        inArray(listItems.itemNormalized, norms),
      ),
    )
  const open = new Set(openRows.map((r) => r.n))

  const already: string[] = []
  const rows: { groupId: string; listName: string; item: string; itemNormalized: string; addedBy: string | null }[] = []
  for (const [norm, display] of wanted) {
    if (open.has(norm)) already.push(display)
    else rows.push({ groupId: input.groupId, listName, item: display, itemNormalized: norm, addedBy: input.addedBy })
  }

  let added: string[] = []
  if (rows.length) {
    // onConflictDoNothing backstops a concurrent double-add against the partial-unique index;
    // RETURNING gives the rows ACTUALLY inserted, so the ack never over-counts a raced dup — and a
    // row a concurrent add won is on the list all the same, so it is reported as already there.
    const inserted = await db
      .insert(listItems)
      .values(rows)
      .onConflictDoNothing()
      .returning({ item: listItems.item, n: listItems.itemNormalized })
    added = inserted.map((r) => r.item)
    const won = new Set(inserted.map((r) => r.n))
    for (const r of rows) if (!won.has(r.itemNormalized)) already.push(r.item)
  }
  return { added, already }
}

// The two ways an open item LEAVES the list. Check-off = bought (checked_at / checked_by). Remove =
// taken off WITHOUT being bought (is_active=false, removed_at / removed_by — issue #23): it is never
// a "bought" record, so nothing that reads checked_at counts it.
type Close = { kind: 'checkoff' } | { kind: 'remove' }
function closeSet(close: Close, by: string | null) {
  return close.kind === 'checkoff' ? { checkedAt: clockNow(), checkedBy: by } : { isActive: false, removedAt: clockNow(), removedBy: by }
}

// Every OPEN row of one house list — the WHERE every match/close below starts from (I4: group-scoped).
const openWhere = (groupId: string, listName: string) =>
  and(eq(listItems.groupId, groupId), eq(listItems.listName, listName), eq(listItems.isActive, true), isNull(listItems.checkedAt))

// Close (check off / remove) the OPEN rows in this scope that the named items match. This is the "LLM
// proposes a description, code disposes on exact scoped rows" half — the model never names a row id,
// and only rows in THIS group are ever touched. Exact-normalized match first; then an article/plural-
// tolerant key, but only for an unambiguous single open item (looseItemKey). Anything else is
// reported as notFound rather than guessed at.
async function closeItems(
  db: Database,
  input: { groupId: string; items: string[]; by: string | null; listName?: string },
  close: Close,
): Promise<{ closed: string[]; notFound: string[] }> {
  const listName = input.listName ?? DEFAULT_LIST
  const wanted = dedupeInput(input.items)
  if (wanted.size === 0) return { closed: [], notFound: [] }

  const norms = [...wanted.keys()]
  const updated = await db
    .update(listItems)
    .set(closeSet(close, input.by))
    .where(and(openWhere(input.groupId, listName), inArray(listItems.itemNormalized, norms)))
    .returning({ item: listItems.item, n: listItems.itemNormalized })

  const found = new Set(updated.map((r) => r.n))
  const closed = updated.map((r) => r.item)
  const missing = [...wanted].filter(([norm]) => !found.has(norm))
  const notFound: string[] = []
  if (missing.length) {
    // Second pass, loose key (articles / plain plurals — K4): an open item counts only when it is the
    // ONE open item with that key, so a near-miss is never guessed at.
    const byKey = await openByLooseKey(db, input.groupId, listName)
    const done = new Set<string>()
    for (const [, display] of missing) {
      const hits = (byKey.get(looseItemKey(display)) ?? []).filter((r) => !done.has(r.id))
      if (hits.length !== 1) {
        notFound.push(display)
        continue
      }
      const [row] = await db
        .update(listItems)
        .set(closeSet(close, input.by))
        .where(and(eq(listItems.id, hits[0].id), openWhere(input.groupId, listName)))
        .returning({ item: listItems.item })
      if (row) {
        done.add(hits[0].id)
        closed.push(row.item)
      } else notFound.push(display)
    }
  }
  return { closed, notFound }
}

async function openByLooseKey(db: Database, groupId: string, listName: string): Promise<Map<string, { id: string; item: string }[]>> {
  const open = await db.select({ id: listItems.id, item: listItems.item }).from(listItems).where(openWhere(groupId, listName))
  const byKey = new Map<string, { id: string; item: string }[]>()
  for (const r of open) byKey.set(looseItemKey(r.item), [...(byKey.get(looseItemKey(r.item)) ?? []), r])
  return byKey
}

// Check items off (bought/done): checked_at / checked_by on the matched open rows (closeItems).
export async function checkOffItems(
  db: Database,
  input: { groupId: string; items: string[]; checkedBy: string | null; listName?: string },
): Promise<{ checkedOff: string[]; notFound: string[] }> {
  const res = await closeItems(db, { groupId: input.groupId, items: input.items, by: input.checkedBy, listName: input.listName }, { kind: 'checkoff' })
  return { checkedOff: res.closed, notFound: res.notFound }
}

// Remove items WITHOUT buying them (issue #23): a SOFT remove — is_active=false, removed_at /
// removed_by — on the matched open rows, by the same exact-then-unambiguous-loose rule as check-off.
// Never a "bought" record: checked_at stays NULL.
export async function removeItems(
  db: Database,
  input: { groupId: string; items: string[]; removedBy: string | null; listName?: string },
): Promise<{ removed: string[]; notFound: string[] }> {
  const res = await closeItems(db, { groupId: input.groupId, items: input.items, by: input.removedBy, listName: input.listName }, { kind: 'remove' })
  return { removed: res.closed, notFound: res.notFound }
}

/**
 * What a rename did (issue #23). `from` is the open item it matched (its display text), or what was
 * asked for when nothing matched; `to` is the item as it now reads on the list.
 * - `renamed`   — the row now reads `to` (same row: its id and added_by are kept).
 * - `merged`    — `to` was ALREADY open, so the old row was removed (is_active=false), not duplicated.
 * - `unchanged` — the new name is exactly the old one: nothing to do.
 * - `not_found` — no open item matches `from`, or it matches more than one: nothing changed.
 */
export interface RenameResult {
  outcome: 'renamed' | 'merged' | 'unchanged' | 'not_found'
  from: string
  to: string
}

// Postgres unique_violation — a concurrent add of the new name won the partial-unique index.
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null
  return e?.code === '23505' || e?.cause?.code === '23505'
}

// Rename ONE open item ("change mlik to milk"). `from` is matched like a check-off (exact, then the
// ONE open item with that loose key — an ambiguous or missing match changes nothing). `to` is the new
// display text, clamped like an add. If `to` (exact-normalized, the add/dedupe key) is ALREADY open,
// the old row is removed instead — the list never holds two copies. Group-scoped; attributed.
export async function renameItem(
  db: Database,
  input: { groupId: string; from: string; to: string; renamedBy: string | null; listName?: string },
): Promise<RenameResult> {
  const listName = input.listName ?? DEFAULT_LIST
  const fromDisplay = input.from.trim().slice(0, MAX_ITEM_LEN)
  const toDisplay = input.to.trim().slice(0, MAX_ITEM_LEN)
  const toNorm = normalizeItem(toDisplay)
  const fromNorm = normalizeItem(fromDisplay)
  if (!fromNorm || !toNorm) return { outcome: 'not_found', from: fromDisplay, to: toDisplay }

  // Find the ONE open row `from` names.
  const exact = await db
    .select({ id: listItems.id, item: listItems.item })
    .from(listItems)
    .where(and(openWhere(input.groupId, listName), eq(listItems.itemNormalized, fromNorm)))
  const hits = exact.length ? exact : ((await openByLooseKey(db, input.groupId, listName)).get(looseItemKey(fromDisplay)) ?? [])
  if (hits.length !== 1) return { outcome: 'not_found', from: fromDisplay, to: toDisplay }
  const row = hits[0]
  if (row.item === toDisplay) return { outcome: 'unchanged', from: row.item, to: row.item }

  const merge = async (): Promise<RenameResult> => {
    const [kept] = await db
      .select({ item: listItems.item })
      .from(listItems)
      .where(and(openWhere(input.groupId, listName), eq(listItems.itemNormalized, toNorm)))
    if (!kept) return { outcome: 'not_found', from: row.item, to: toDisplay } // the open copy left meanwhile
    const [gone] = await db
      .update(listItems)
      .set(closeSet({ kind: 'remove' }, input.renamedBy))
      .where(and(eq(listItems.id, row.id), openWhere(input.groupId, listName)))
      .returning({ id: listItems.id })
    return gone ? { outcome: 'merged', from: row.item, to: kept.item } : { outcome: 'not_found', from: row.item, to: toDisplay }
  }

  // A DIFFERENT open row already reads `to` → merge. (Same normalized key = a display-only fix, e.g.
  // "Milk" → "milk": the row itself is the open copy, so it is renamed in place.)
  if (toNorm !== normalizeItem(row.item)) {
    const [other] = await db
      .select({ id: listItems.id })
      .from(listItems)
      .where(and(openWhere(input.groupId, listName), eq(listItems.itemNormalized, toNorm)))
    if (other) return merge()
  }
  try {
    const [renamed] = await db
      .update(listItems)
      .set({ item: toDisplay, itemNormalized: toNorm, renamedBy: input.renamedBy, renamedAt: clockNow() })
      .where(and(eq(listItems.id, row.id), openWhere(input.groupId, listName)))
      .returning({ item: listItems.item })
    // The row left the open list between the read and the write (ticked / removed concurrently).
    return renamed ? { outcome: 'renamed', from: row.item, to: renamed.item } : { outcome: 'not_found', from: row.item, to: toDisplay }
  } catch (err) {
    // A concurrent add of `to` won the partial-unique index between the check and the write → merge.
    if (isUniqueViolation(err)) return merge()
    throw err
  }
}

// The current OPEN list for a scope (unbought items), oldest first.
export async function currentList(db: Database, groupId: string, listName: string = DEFAULT_LIST): Promise<ListRow[]> {
  return db
    .select({ id: listItems.id, item: listItems.item, addedBy: listItems.addedBy, createdAt: listItems.createdAt })
    .from(listItems)
    .where(openWhere(groupId, listName))
    .orderBy(asc(listItems.createdAt))
}
