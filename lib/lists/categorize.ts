import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { listItemEmbeddings, listItems } from '@/db/schema'
import { embed as voyageEmbed, EMBED_MODEL } from '@/lib/ai/embed'
import { guessCategory } from '@/lib/ai/category-guess'
import { inngest } from '@/lib/inngest/client'
import { now as clockNow } from '@/lib/core/clock'
import { asCategory, type Category, type CategorySource } from '@/lib/lists/categories'
import { DEFAULT_LIST, rememberedCategory } from '@/lib/lists/store'
import { requestShoppingRefresh } from '@/lib/lists/board'
import type { TurnStep } from '@/lib/turn/step'

// Auto-sorting a newly added shopping item into a category (issue #29, docs/spec/shopping-list.md
// §Categories). It runs AFTER the add, never inside it: the add commits first (as "Not sorted"), then a
// `lists/shopping.categorize` event names the new rows and this fills them in, tier by tier:
//
//   1. remembered — the house picked a category for this exact item name before (baumy_list_categories);
//   2. similar    — the nearest item name the house has already sorted, by Voyage embedding, ONLY at or
//                   above SIMILAR_FLOOR, and only among vectors of the CURRENT model (EMBED_MODEL);
//   3. guessed    — Sonnet names one of the six (lib/ai/category-guess.ts, schema-checked; else null).
//
// The write is compare-and-set on `category_source IS NULL`, so a housemate's pick that lands first is
// never overwritten. Nothing here can fail the add: the event is best-effort, and a row every tier
// passes on simply stays "Not sorted". The LLM proposes (an enum value); code disposes.

/**
 * The cosine similarity an already-sorted item must reach before its category is copied (tier 2).
 *
 * Why 0.80: this is precision-first, like the rest of the list. Falling through costs one Sonnet call; a
 * wrong copy is a visible mistake that a housemate has to fix. The other two thresholds in brain bracket
 * it: retrieval keeps anything above 0.2 (recall — "is this note about the question at all?") and
 * consolidation folds at 0.97 (the same statement restated). Copying a category sits between "related"
 * and "the same": short item names in one embedding space share a high baseline (two unrelated grocery
 * words are far closer than two unrelated sentences), so a floor near the retrieval end would copy
 * across sections ("dish soap" → "soy sauce"). 0.80 keeps name variants and close kin ("oat milk" /
 * "oatly barista", "bin bags" / "bin liners") and sends anything looser to the model. The number is a
 * named constant so a live calibration run can move it; the tests pin both sides of it.
 */
export const SIMILAR_FLOOR = 0.8

export const SHOPPING_CATEGORIZE = 'lists/shopping.categorize' as const

/** At most this many rows per event — one add is at most 30 items (the store's cap). */
const MAX_IDS = 30

// Ask for auto-sorting of the rows an add just inserted. Best-effort: false (logged) when Inngest could
// not be reached — the items stay "Not sorted" and the add stands.
export async function requestCategorize(groupId: string, itemIds: string[]): Promise<boolean> {
  if (!groupId || itemIds.length === 0) return false
  try {
    await inngest.send({ name: SHOPPING_CATEGORIZE, data: { groupId, itemIds: itemIds.slice(0, MAX_IDS) } })
    return true
  } catch (err) {
    console.warn('[baumy/lists] categorize request failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export interface CategorizeDeps {
  /** Text → vector in the CURRENT model's space (Voyage in production). */
  embed?: (text: string) => Promise<number[]>
  /** The model's guess (Sonnet in production): an enum value or null. */
  guess?: (item: string) => Promise<Category | null>
}

export type CategorizeResult =
  | { outcome: 'categorized'; id: string; category: Category; source: Exclude<CategorySource, 'picked'>; similarTo?: string; similarity?: number }
  | { outcome: 'unsorted'; id: string }
  /** Already sorted (a pick landed first), or no longer on this house's list. */
  | { outcome: 'skipped'; id: string }

type Row = { id: string; item: string; n: string; listName: string }

// The row to sort: this house's, active, and not sorted by anyone yet.
async function loadUnsorted(db: Database, groupId: string, id: string): Promise<Row | null> {
  const [row] = await db
    .select({ id: listItems.id, item: listItems.item, n: listItems.itemNormalized, listName: listItems.listName })
    .from(listItems)
    .where(and(eq(listItems.id, id), eq(listItems.groupId, groupId), eq(listItems.isActive, true), isNull(listItems.categorySource)))
  return row ?? null
}

// Compare-and-set: only a row still unsorted gets the auto category.
async function writeAuto(db: Database, groupId: string, id: string, category: Category, source: Exclude<CategorySource, 'picked'>): Promise<boolean> {
  const rows = await db
    .update(listItems)
    .set({ category, categorySource: source, categorizedAt: clockNow(), categorizedBy: null })
    .where(and(eq(listItems.id, id), eq(listItems.groupId, groupId), isNull(listItems.categorySource)))
    .returning({ id: listItems.id })
  return rows.length > 0
}

// The item name's vector in the CURRENT model, stored once per house + list + name. Reuses a stored one;
// otherwise embeds and stores it (a concurrent store of the same name is a no-op). Null when the embedder
// failed — tier 2 is then skipped, never the whole sort.
export async function itemVector(db: Database, row: { groupId: string; listName: string; n: string }, embedFn: (t: string) => Promise<number[]>): Promise<number[] | null> {
  const [have] = await db
    .select({ v: listItemEmbeddings.embedding })
    .from(listItemEmbeddings)
    .where(
      and(
        eq(listItemEmbeddings.groupId, row.groupId),
        eq(listItemEmbeddings.listName, row.listName),
        eq(listItemEmbeddings.itemNormalized, row.n),
        eq(listItemEmbeddings.model, EMBED_MODEL),
      ),
    )
  if (have?.v) return have.v
  let v: number[]
  try {
    v = await embedFn(row.n)
  } catch (err) {
    console.warn('[baumy/lists] item embedding failed — skipping the similar-item tier:', err instanceof Error ? err.message : err)
    return null
  }
  await db
    .insert(listItemEmbeddings)
    .values({ groupId: row.groupId, listName: row.listName, itemNormalized: row.n, model: EMBED_MODEL, embedding: v })
    .onConflictDoNothing()
  return v
}

/**
 * The nearest item NAME this house has already sorted, by cosine over vectors of the CURRENT model only.
 * A name's category is the house's remembered pick when there is one, else the category its most recently
 * sorted row got. Group- and list-scoped. Null when nothing is sorted yet; the caller applies the floor.
 */
export async function nearestSorted(
  db: Database,
  input: { groupId: string; listName?: string; vector: number[] },
): Promise<{ item: string; category: Category; similarity: number } | null> {
  const listName = input.listName ?? DEFAULT_LIST
  const v = `[${input.vector.join(',')}]`
  const res = await db.execute(sql`
    WITH mem AS (
      SELECT item_normalized AS n, category FROM baumy_list_categories
      WHERE group_id = ${input.groupId} AND list_name = ${listName}
    ), rows AS (
      SELECT DISTINCT ON (item_normalized) item_normalized AS n, category FROM baumy_list_items
      WHERE group_id = ${input.groupId} AND list_name = ${listName} AND category_source IS NOT NULL
      ORDER BY item_normalized, categorized_at DESC NULLS LAST, created_at DESC
    ), known AS (
      SELECT n, category FROM mem
      UNION ALL
      -- a name whose latest sort was a housemate's "Not sorted" pick is no anchor
      SELECT n, category FROM rows WHERE category IS NOT NULL AND n NOT IN (SELECT n FROM mem)
    )
    SELECT known.n AS n, known.category AS category, 1 - (e.embedding <=> ${v}::vector) AS sim
    FROM known
    JOIN baumy_list_item_embeddings e
      ON e.group_id = ${input.groupId} AND e.list_name = ${listName} AND e.item_normalized = known.n AND e.model = ${EMBED_MODEL}
    ORDER BY e.embedding <=> ${v}::vector
    LIMIT 1`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  const top = rows[0]
  const category = asCategory(top?.category)
  return top && category ? { item: String(top.n), category, similarity: Number(top.sim) } : null
}

// Sort ONE newly added row, tier by tier. Errors from the database rethrow (the step retries); an embedder
// failure skips tier 2; a malformed model answer is null (unsorted); a transient model error rethrows (I2).
export async function autoCategorizeItem(db: Database, input: { groupId: string; itemId: string }, deps: CategorizeDeps = {}): Promise<CategorizeResult> {
  const embedFn = deps.embed ?? voyageEmbed
  const guessFn = deps.guess ?? guessCategory
  const row = await loadUnsorted(db, input.groupId, input.itemId)
  if (!row) return { outcome: 'skipped', id: input.itemId }
  const done = async (category: Category, source: Exclude<CategorySource, 'picked'>, extra: { similarTo?: string; similarity?: number } = {}): Promise<CategorizeResult> =>
    (await writeAuto(db, input.groupId, row.id, category, source)) ? { outcome: 'categorized', id: row.id, category, source, ...extra } : { outcome: 'skipped', id: row.id }

  // 1. The house's own pick for this exact item.
  const remembered = await rememberedCategory(db, input.groupId, row.n, row.listName)
  // The vector is stored whatever tier wins, so this item can be the "similar" anchor for the next one.
  const vector = await itemVector(db, { groupId: input.groupId, listName: row.listName, n: row.n }, embedFn)
  if (remembered) return done(remembered, 'remembered')

  // 2. The nearest item the house has already sorted — only at or above the floor.
  if (vector) {
    const near = await nearestSorted(db, { groupId: input.groupId, listName: row.listName, vector })
    if (near && near.similarity >= SIMILAR_FLOOR) return done(near.category, 'similar', { similarTo: near.item, similarity: near.similarity })
  }

  // 3. The model's guess, constrained to the enum.
  const guessed = asCategory(await guessFn(row.item))
  if (guessed) return done(guessed, 'guessed')
  return { outcome: 'unsorted', id: row.id }
}

// The Inngest body (function shopping-categorize; the sandbox drives it inline): one memoized step per
// item, so a retry never re-asks the model for an item already sorted; then, if anything was sorted, the
// debounced change signal — the live list re-renders with the new groups (no "last updated by" stamp:
// nobody changed the list).
export async function runCategorize(step: TurnStep, db: () => Database, data: { groupId: string; itemIds: string[] }, deps: CategorizeDeps = {}): Promise<CategorizeResult[]> {
  const out: CategorizeResult[] = []
  for (const id of data.itemIds.slice(0, MAX_IDS)) {
    out.push((await step.run(`categorize-${id}`, () => autoCategorizeItem(db(), { groupId: data.groupId, itemId: id }, deps))) as CategorizeResult)
  }
  if (out.some((r) => r.outcome === 'categorized')) await step.run('categorize-render', () => requestShoppingRefresh(data.groupId))
  return out
}
