import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { listItems } from '@/db/schema'

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
    // RETURNING gives the rows ACTUALLY inserted, so the ack never over-counts a raced dup.
    const inserted = await db.insert(listItems).values(rows).onConflictDoNothing().returning({ item: listItems.item })
    added = inserted.map((r) => r.item)
  }
  return { added, already }
}

// Check items off (bought/done): flip checked_at/checked_by on the OPEN rows in this scope whose
// normalized text matches. This is the "LLM proposes a description, code disposes on exact scoped
// rows" half — the model never names a row id, and only rows in THIS group are ever touched.
// Exact-normalized match only (precision-first); an item that isn't open is reported as notFound
// rather than guessed at.
export async function checkOffItems(
  db: Database,
  input: { groupId: string; items: string[]; checkedBy: string | null; listName?: string },
): Promise<{ checkedOff: string[]; notFound: string[] }> {
  const listName = input.listName ?? DEFAULT_LIST
  const wanted = dedupeInput(input.items)
  if (wanted.size === 0) return { checkedOff: [], notFound: [] }

  const norms = [...wanted.keys()]
  const updated = await db
    .update(listItems)
    .set({ checkedAt: new Date(), checkedBy: input.checkedBy })
    .where(
      and(
        eq(listItems.groupId, input.groupId),
        eq(listItems.listName, listName),
        eq(listItems.isActive, true),
        isNull(listItems.checkedAt),
        inArray(listItems.itemNormalized, norms),
      ),
    )
    .returning({ item: listItems.item, n: listItems.itemNormalized })

  const found = new Set(updated.map((r) => r.n))
  const checkedOff = updated.map((r) => r.item)
  const notFound: string[] = []
  for (const [norm, display] of wanted) if (!found.has(norm)) notFound.push(display)
  return { checkedOff, notFound }
}

// The current OPEN list for a scope (unbought items), oldest first.
export async function currentList(db: Database, groupId: string, listName: string = DEFAULT_LIST): Promise<ListRow[]> {
  return db
    .select({ id: listItems.id, item: listItems.item, addedBy: listItems.addedBy, createdAt: listItems.createdAt })
    .from(listItems)
    .where(
      and(eq(listItems.groupId, groupId), eq(listItems.listName, listName), eq(listItems.isActive, true), isNull(listItems.checkedAt)),
    )
    .orderBy(asc(listItems.createdAt))
}
