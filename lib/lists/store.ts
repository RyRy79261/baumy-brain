import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { houseConfig, listCategories, listItems, members } from '@/db/schema'
import { now as clockNow } from '@/lib/core/clock'
import { asCategory, DEFAULT_SORT, isSortMode, type Category, type SortMode } from '@/lib/lists/categories'

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
  /** Its shopping category (issue #29), or null = "Not sorted". */
  category: Category | null
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
): Promise<{ added: string[]; already: string[]; addedIds: string[] }> {
  const listName = input.listName ?? DEFAULT_LIST
  const wanted = dedupeInput(input.items)
  if (wanted.size === 0) return { added: [], already: [], addedIds: [] }

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
  // created_at from the clock seam, not Postgres now(): the live list's Added mode ("Today" / "Earlier")
  // reads it, and a sandbox runs at a simulated instant.
  const at = clockNow()
  const rows: { groupId: string; listName: string; item: string; itemNormalized: string; addedBy: string | null; createdAt: Date }[] = []
  for (const [norm, display] of wanted) {
    if (open.has(norm)) already.push(display)
    else rows.push({ groupId: input.groupId, listName, item: display, itemNormalized: norm, addedBy: input.addedBy, createdAt: at })
  }

  let added: string[] = []
  let addedIds: string[] = []
  if (rows.length) {
    // onConflictDoNothing backstops a concurrent double-add against the partial-unique index;
    // RETURNING gives the rows ACTUALLY inserted, so the ack never over-counts a raced dup — and a
    // row a concurrent add won is on the list all the same, so it is reported as already there.
    const inserted = await db
      .insert(listItems)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: listItems.id, item: listItems.item, n: listItems.itemNormalized })
    added = inserted.map((r) => r.item)
    // The new rows' ids — auto-sorting (lib/lists/categorize.ts) runs on exactly these, after the add.
    addedIds = inserted.map((r) => r.id)
    const won = new Set(inserted.map((r) => r.n))
    for (const r of rows) if (!won.has(r.itemNormalized)) already.push(r.item)
  }
  return { added, already, addedIds }
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
// reported rather than guessed at: notFound (nothing fits) or ambiguous (more than one open item fits —
// `matches` names them, so the ack can say which).
async function closeItems(
  db: Database,
  input: { groupId: string; items: string[]; by: string | null; listName?: string },
  close: Close,
): Promise<{ closed: string[]; notFound: string[]; ambiguous: Ambiguous[] }> {
  const listName = input.listName ?? DEFAULT_LIST
  const wanted = dedupeInput(input.items)
  if (wanted.size === 0) return { closed: [], notFound: [], ambiguous: [] }

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
  const ambiguous: Ambiguous[] = []
  if (missing.length) {
    // Second pass, loose key (articles / plain plurals — K4): an open item counts only when it is the
    // ONE open item with that key, so a near-miss is never guessed at.
    const byKey = await openByLooseKey(db, input.groupId, listName)
    const done = new Set<string>()
    for (const [, display] of missing) {
      const hits = (byKey.get(looseItemKey(display)) ?? []).filter((r) => !done.has(r.id))
      if (hits.length > 1) {
        ambiguous.push({ item: display, matches: hits.map((h) => h.item) })
        continue
      }
      if (hits.length === 0) {
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
  return { closed, notFound, ambiguous }
}

/** A named item that fits more than one open item (loosely) — nothing was changed for it. */
export interface Ambiguous {
  item: string
  matches: string[]
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
  // A check-off still folds an ambiguous name into notFound (its K4 ack wording, unchanged).
  return { checkedOff: res.closed, notFound: [...res.notFound, ...res.ambiguous.map((a) => a.item)] }
}

// Remove items WITHOUT buying them (issue #23): a SOFT remove — is_active=false, removed_at /
// removed_by — on the matched open rows, by the same exact-then-unambiguous-loose rule as check-off.
// Never a "bought" record: checked_at stays NULL.
export async function removeItems(
  db: Database,
  input: { groupId: string; items: string[]; removedBy: string | null; listName?: string },
): Promise<{ removed: string[]; notFound: string[]; ambiguous: Ambiguous[] }> {
  const res = await closeItems(db, { groupId: input.groupId, items: input.items, by: input.removedBy, listName: input.listName }, { kind: 'remove' })
  return { removed: res.closed, notFound: res.notFound, ambiguous: res.ambiguous }
}

/**
 * What a rename did (issue #23). `from` is the open item it matched (its display text), or what was
 * asked for when nothing matched; `to` is the item as it now reads on the list.
 * - `renamed`   — the row now reads `to` (same row: its id and added_by are kept).
 * - `merged`    — `to` was ALREADY open, so the old row was removed (is_active=false), not duplicated.
 * - `unchanged` — the new name is exactly the old one: nothing to do.
 * - `not_found` — no open item matches `from`: nothing changed.
 * - `ambiguous` — `from` fits more than one open item (`matches` names them): nothing changed.
 */
export interface RenameResult {
  outcome: 'renamed' | 'merged' | 'unchanged' | 'not_found' | 'ambiguous'
  from: string
  to: string
  /** Only for `ambiguous`: the open items `from` fits. */
  matches?: string[]
  /** `renamed` only: the row, when its AUTOMATIC category was reset by the rename (issue #29) — the
   *  caller asks for it to be sorted again (requestCategorize). A housemate's pick is kept. */
  resortId?: string
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
  if (hits.length > 1) return { outcome: 'ambiguous', from: fromDisplay, to: toDisplay, matches: hits.map((h) => h.item) }
  if (hits.length === 0) return { outcome: 'not_found', from: fromDisplay, to: toDisplay }
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
    // A NEW name (not a case-only fix) drops an AUTOMATIC category (remembered / similar / guessed — it was
    // worked out for the old name) so the row is sorted again; a housemate's pick (`picked`) stays.
    const newName = toNorm !== normalizeItem(row.item)
    const auto = sql`${listItems.categorySource} IS DISTINCT FROM 'picked'`
    const [renamed] = await db
      .update(listItems)
      .set({
        item: toDisplay,
        itemNormalized: toNorm,
        renamedBy: input.renamedBy,
        renamedAt: clockNow(),
        ...(newName
          ? {
              category: sql`CASE WHEN ${auto} THEN NULL ELSE ${listItems.category} END`,
              categorySource: sql`CASE WHEN ${auto} THEN NULL ELSE ${listItems.categorySource} END`,
              categorizedAt: sql`CASE WHEN ${auto} THEN NULL ELSE ${listItems.categorizedAt} END`,
            }
          : {}),
      } as Record<string, unknown>)
      .where(and(eq(listItems.id, row.id), openWhere(input.groupId, listName)))
      .returning({ id: listItems.id, item: listItems.item, source: listItems.categorySource })
    // The row left the open list between the read and the write (ticked / removed concurrently).
    if (!renamed) return { outcome: 'not_found', from: row.item, to: toDisplay }
    return { outcome: 'renamed', from: row.item, to: renamed.item, ...(newName && renamed.source == null ? { resortId: renamed.id } : {}) }
  } catch (err) {
    // A concurrent add of `to` won the partial-unique index between the check and the write → merge.
    if (isUniqueViolation(err)) return merge()
    throw err
  }
}

// The current OPEN list for a scope (unbought items), oldest first.
export async function currentList(db: Database, groupId: string, listName: string = DEFAULT_LIST): Promise<ListRow[]> {
  const rows = await db
    .select({ id: listItems.id, item: listItems.item, addedBy: listItems.addedBy, createdAt: listItems.createdAt, category: listItems.category })
    .from(listItems)
    .where(openWhere(groupId, listName))
    .orderBy(asc(listItems.createdAt))
  return rows.map((r) => ({ ...r, category: asCategory(r.category) }))
}

// ── The live list (issue #25, docs/spec/shopping-list.md §Live list) ─────────────────────────────────
// A bought item stays on the live list, ticked, until someone taps "Clear done": the list shows every
// active row with cleared_at NULL — open (checked_at NULL) first, oldest first, then done, in the order
// they were ticked. `currentList` above (the OPEN items) is unchanged: it is what to buy.

export interface LiveRow {
  id: string
  item: string
  done: boolean
  /** Its shopping category (issue #29), or null = "Not sorted". */
  category?: Category | null
  /** When it was added — the Added mode's "Today" / "Earlier". */
  createdAt?: Date
}

// Every row still SHOWN on the live list (open + done-not-cleared), group-scoped (I4).
const shownWhere = (groupId: string, listName: string) =>
  and(eq(listItems.groupId, groupId), eq(listItems.listName, listName), eq(listItems.isActive, true), isNull(listItems.clearedAt))

export async function liveListRows(db: Database, groupId: string, listName: string = DEFAULT_LIST): Promise<LiveRow[]> {
  const rows = await db
    .select({ id: listItems.id, item: listItems.item, checkedAt: listItems.checkedAt, createdAt: listItems.createdAt, category: listItems.category })
    .from(listItems)
    .where(shownWhere(groupId, listName))
    .orderBy(sql`${listItems.checkedAt} IS NOT NULL`, asc(listItems.checkedAt), asc(listItems.createdAt), asc(listItems.id))
  return rows.map((r) => ({ id: r.id, item: r.item, done: r.checkedAt != null, category: asCategory(r.category), createdAt: r.createdAt }))
}

/**
 * What a tap on an item did (`shop:chk:<id>`).
 * - `ticked`           — it was open; now it is done (checked_at / checked_by set).
 * - `unticked`         — it was done; now it is open again (checked_at / checked_by cleared).
 * - `already_ticked`   — a tick asked for (☐ tapped) but it was already done: nothing changed.
 * - `already_unticked` — an untick asked for (☑ tapped) but it was already open: nothing changed.
 * - `readded`          — it was done, but the same item has been re-added since, so re-opening it would
 *                        make a second open copy (the partial-unique index): the done row was cleared
 *                        instead, and the open copy stays.
 * - `gone`             — no such row on THIS house's live list (removed, cleared, another house, a bad id).
 */
export interface ToggleResult {
  outcome: 'ticked' | 'unticked' | 'already_ticked' | 'already_unticked' | 'readded' | 'gone'
  item: string | null
}

// Set ONE item's state by id — keyed on the id AND the house scope (I4), so a tap can never reach another
// house's row. `want` is what the tapped button showed (☐ → tick, ☑ → untick; lib/lists/live.ts tapWant):
// the UPDATE SETS that state outright, guarded by `checked_at IS NULL` (tick) / `IS NOT NULL` (untick), so
// it is IDEMPOTENT — two people tapping the same ☐ at once tick it once; the second finds nothing to do
// and reports `already_ticked`. Only when the tapped keyboard could not be read (`want` null) does it fall
// back to a flip computed by Postgres under the row lock (each tap flips the state it finds). `by` is the
// tapper's authenticated id.
export async function toggleListItem(
  db: Database,
  input: { groupId: string; itemId: string; by: string | null; want?: 'tick' | 'untick' | null; listName?: string },
): Promise<ToggleResult> {
  const listName = input.listName ?? DEFAULT_LIST
  const at = clockNow().toISOString()
  const where = and(eq(listItems.id, input.itemId), shownWhere(input.groupId, listName))
  const want = input.want ?? null
  try {
    const set =
      want === 'tick'
        ? { checkedAt: sql`${at}::timestamptz`, checkedBy: sql`${input.by}::text` }
        : want === 'untick'
          ? { checkedAt: sql`NULL`, checkedBy: sql`NULL` }
          : {
              checkedAt: sql`CASE WHEN ${listItems.checkedAt} IS NULL THEN ${at}::timestamptz ELSE NULL END`,
              checkedBy: sql`CASE WHEN ${listItems.checkedAt} IS NULL THEN ${input.by}::text ELSE NULL END`,
            }
    const guard = want === 'tick' ? isNull(listItems.checkedAt) : want === 'untick' ? isNotNull(listItems.checkedAt) : undefined
    const [row] = await db
      .update(listItems)
      .set(set as Record<string, unknown>)
      .where(and(where, guard))
      .returning({ item: listItems.item, checkedAt: listItems.checkedAt })
    if (row) return { outcome: row.checkedAt != null ? 'ticked' : 'unticked', item: row.item }
    if (!want) return { outcome: 'gone', item: null }
    // Nothing to do: the row is already in the asked state — or it is not on this house's list at all.
    const [now] = await db.select({ item: listItems.item, checkedAt: listItems.checkedAt }).from(listItems).where(where)
    if (!now) return { outcome: 'gone', item: null }
    return { outcome: now.checkedAt != null ? 'already_ticked' : 'already_unticked', item: now.item }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Re-opening collided with an open copy of the same item (re-added since it was ticked): the list
    // must never hold two open copies, so the done row leaves the list instead.
    const [row] = await db
      .update(listItems)
      .set({ clearedAt: clockNow() })
      .where(and(where, isNotNull(listItems.checkedAt)))
      .returning({ item: listItems.item })
    return row ? { outcome: 'readded', item: row.item } : { outcome: 'gone', item: null }
  }
}

// "🧹 Clear done": every done row on this house's live list leaves it (cleared_at). The rows stay as the
// bought record (checked_at / checked_by untouched). Returns how many were cleared.
export async function clearDoneItems(db: Database, input: { groupId: string; listName?: string }): Promise<number> {
  const listName = input.listName ?? DEFAULT_LIST
  const rows = await db
    .update(listItems)
    .set({ clearedAt: clockNow() })
    .where(and(shownWhere(input.groupId, listName), isNotNull(listItems.checkedAt)))
    .returning({ id: listItems.id })
  return rows.length
}

// Record who changed the list and when — the live list's "Last updated by X" line. `by` is an
// authenticated id (a tapper, a chat sender, the kiosk's mapped member) or null; one that is not a
// member row is stored as null (the FK), never guessed at.
export async function markShoppingUpdated(db: Database, by: string | null): Promise<void> {
  const known = by ? sql`(SELECT ${members.telegramUserId} FROM ${members} WHERE ${members.telegramUserId} = ${by})` : sql`NULL`
  await db
    .update(houseConfig)
    .set({ shoppingUpdatedBy: sql`${known}`, shoppingUpdatedAt: clockNow(), updatedAt: clockNow() })
    .where(sql`${houseConfig.id}`)
}

// ── Categories (issue #29, docs/spec/shopping-list.md §Categories) ─────────────────────────────────────

/**
 * What setting an item's category did.
 * - `set`       — the row now has `category` (source `picked`), and the house remembers it for this item
 *                 (a null category — "Not sorted" — forgets the remembered pick instead).
 * - `not_found` — no item on THIS house's list matches: nothing changed (and nothing was remembered).
 * - `ambiguous` — the text loosely fits more than one open item (`matches` names them): nothing changed.
 */
export interface SetCategoryResult {
  outcome: 'set' | 'not_found' | 'ambiguous'
  /** The item as it reads on the list (or the text asked for, when nothing matched; null for an id that matched nothing). */
  item: string | null
  category: Category | null
  id?: string
  matches?: string[]
}

// Which OPEN item a text names, matched like a check-off: exact normalized, then the ONE open item with
// that loose key. `found` carries the row; `ambiguous` the items it could mean; `not_found` nothing.
export async function findOpenItem(
  db: Database,
  input: { groupId: string; item: string; listName?: string },
): Promise<{ outcome: 'found'; id: string; item: string; n: string } | { outcome: 'ambiguous'; matches: string[] } | { outcome: 'not_found' }> {
  const listName = input.listName ?? DEFAULT_LIST
  const norm = normalizeItem(input.item.trim().slice(0, MAX_ITEM_LEN))
  if (!norm) return { outcome: 'not_found' }
  const exact = await db
    .select({ id: listItems.id, item: listItems.item, n: listItems.itemNormalized })
    .from(listItems)
    .where(and(openWhere(input.groupId, listName), eq(listItems.itemNormalized, norm)))
  const hits = exact.length ? exact : ((await openByLooseKey(db, input.groupId, listName)).get(looseItemKey(input.item)) ?? []).map((h) => ({ ...h, n: normalizeItem(h.item) }))
  if (hits.length > 1) return { outcome: 'ambiguous', matches: hits.map((h) => h.item) }
  return hits[0] ? { outcome: 'found', ...hits[0] } : { outcome: 'not_found' }
}

// A housemate PICKS an item's category (the kiosk's category call, or "put coffee filters under coffee"
// in Telegram). The row is named by `id` (a row still SHOWN on this house's live list — open, or ticked
// and not cleared) or by `item` text (an OPEN item, matched like a check-off: exact normalized, then the
// ONE open item with that loose key). Group-scoped (I4) — an id from another house matches nothing. The
// row gets source `picked` (auto-sorting never overwrites it), and the house memory for that item name is
// upserted, so a later add of the same item is `remembered`. `by` is an authenticated id or null.
export async function setItemCategory(
  db: Database,
  input: { groupId: string; id?: string; item?: string; category: Category | null; by: string | null; listName?: string },
): Promise<SetCategoryResult> {
  const listName = input.listName ?? DEFAULT_LIST
  const asked = (input.item ?? '').trim().slice(0, MAX_ITEM_LEN)
  let hit: { id: string; item: string; n: string } | null = null
  if (input.id) {
    const [row] = await db
      .select({ id: listItems.id, item: listItems.item, n: listItems.itemNormalized })
      .from(listItems)
      .where(and(eq(listItems.id, input.id), shownWhere(input.groupId, listName)))
    hit = row ?? null
  } else {
    const found = await findOpenItem(db, { groupId: input.groupId, item: asked, listName })
    if (found.outcome === 'ambiguous') return { outcome: 'ambiguous', item: asked, category: input.category, matches: found.matches }
    hit = found.outcome === 'found' ? { id: found.id, item: found.item, n: found.n } : null
  }
  if (!hit) return { outcome: 'not_found', item: input.id ? null : asked, category: input.category }

  const at = clockNow()
  const [row] = await db
    .update(listItems)
    .set({ category: input.category, categorySource: 'picked', categorizedBy: input.by, categorizedAt: at })
    .where(and(eq(listItems.id, hit.id), shownWhere(input.groupId, listName)))
    .returning({ id: listItems.id, item: listItems.item })
  if (!row) return { outcome: 'not_found', item: hit.item, category: input.category } // left the list meanwhile
  await rememberCategory(db, { groupId: input.groupId, listName, itemNormalized: hit.n, category: input.category, by: input.by })
  return { outcome: 'set', item: row.item, category: input.category, id: row.id }
}

// Teach the house memory: item name → category (upsert), or forget it for a null ("Not sorted") pick.
export async function rememberCategory(
  db: Database,
  input: { groupId: string; listName?: string; itemNormalized: string; category: Category | null; by: string | null },
): Promise<void> {
  const listName = input.listName ?? DEFAULT_LIST
  const key = and(eq(listCategories.groupId, input.groupId), eq(listCategories.listName, listName), eq(listCategories.itemNormalized, input.itemNormalized))
  if (input.category == null) {
    await db.delete(listCategories).where(key)
    return
  }
  const at = clockNow()
  await db
    .insert(listCategories)
    .values({ groupId: input.groupId, listName, itemNormalized: input.itemNormalized, category: input.category, pickedBy: input.by, updatedAt: at })
    .onConflictDoUpdate({
      target: [listCategories.groupId, listCategories.listName, listCategories.itemNormalized],
      set: { category: input.category, pickedBy: input.by, updatedAt: at },
    })
}

// The house's remembered pick for an item name (exact-normalized), or null.
export async function rememberedCategory(db: Database, groupId: string, itemNormalized: string, listName: string = DEFAULT_LIST): Promise<Category | null> {
  const [row] = await db
    .select({ c: listCategories.category })
    .from(listCategories)
    .where(and(eq(listCategories.groupId, groupId), eq(listCategories.listName, listName), eq(listCategories.itemNormalized, itemNormalized)))
  return asCategory(row?.c)
}

// ── The live list's order (issue #29): one mode for the whole house ────────────────────────────────

export async function loadShoppingSort(db: Database): Promise<SortMode> {
  const [cfg] = await db.select({ s: houseConfig.shoppingSort }).from(houseConfig).limit(1)
  return isSortMode(cfg?.s) ? cfg.s : DEFAULT_SORT
}

// Set the house's order mode. Idempotent: setting the mode it already has changes nothing (false).
export async function setShoppingSort(db: Database, mode: SortMode): Promise<boolean> {
  const rows = await db
    .update(houseConfig)
    .set({ shoppingSort: mode, updatedAt: clockNow() })
    .where(sql`${houseConfig.id} AND ${houseConfig.shoppingSort} <> ${mode}`)
    .returning({ id: houseConfig.id })
  return rows.length > 0
}
