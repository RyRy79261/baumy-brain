// Shopping categories (issue #29, docs/spec/shopping-list.md §Categories). A FIXED set — owner ruling of
// 2026-10-11: six groups plus "Not sorted" (a null category). Pure constants and guards, no I/O, so the
// schema (db/schema.ts — its CHECK constraints), the store, the renderer and the kitchen API all agree.
//
// The stored value is the lower-case key; the label is what people see. A model, a kiosk body or a
// Telegram message only ever NAMES a category: code checks it against this list (isCategory) and
// anything else is null — "Not sorted".

export const CATEGORIES = ['pantry', 'fresh', 'coffee', 'cleaning', 'maintenance', 'household'] as const
export type Category = (typeof CATEGORIES)[number]

/** What people see, in the fixed order the Groups mode shows them. */
export const CATEGORY_LABELS: Record<Category, string> = {
  pantry: 'Pantry',
  fresh: 'Fresh',
  coffee: 'Coffee',
  cleaning: 'Cleaning',
  maintenance: 'Maintenance',
  household: 'Household',
}
/** The label of a null category. Always shown last. */
export const NOT_SORTED_LABEL = 'Not sorted'

/**
 * Where an item's category came from:
 * - `picked`     — a housemate set it (the kiosk, or "put coffee filters under coffee" in Telegram);
 * - `remembered` — the house picked a category for this exact item before (baumy_list_categories);
 * - `similar`    — the nearest item the house has already sorted, by Voyage embedding, above the floor;
 * - `guessed`    — Sonnet named one of the six (schema-checked).
 * Null with a null category = not sorted yet (or every tier came up empty).
 */
export const CATEGORY_SOURCES = ['picked', 'remembered', 'similar', 'guessed'] as const
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

export function isCategory(x: unknown): x is Category {
  return typeof x === 'string' && (CATEGORIES as readonly string[]).includes(x)
}

export function categoryLabel(c: Category | null): string {
  return c ? CATEGORY_LABELS[c] : NOT_SORTED_LABEL
}

/** A stored value read back from the database: anything not in the list reads as Not sorted. */
export function asCategory(x: unknown): Category | null {
  return isCategory(x) ? x : null
}

// ── The live list's order modes (stored per house: baumy_house_config.shopping_sort) ──────────────────

export const SORT_MODES = ['groups', 'az', 'added'] as const
export type SortMode = (typeof SORT_MODES)[number]
export const DEFAULT_SORT: SortMode = 'groups'

export function isSortMode(x: unknown): x is SortMode {
  return typeof x === 'string' && (SORT_MODES as readonly string[]).includes(x)
}

/** The footer button cycles Groups → A–Z → Added → Groups. */
export function nextSortMode(m: SortMode): SortMode {
  return SORT_MODES[(SORT_MODES.indexOf(m) + 1) % SORT_MODES.length]
}

/** The footer button's label: the CURRENT mode. */
export const SORT_LABELS: Record<SortMode, string> = {
  groups: '🗂 Groups',
  az: '🔤 A–Z',
  added: '🕒 Added',
}

// SQL for the CHECK constraints (db/schema.ts): `'a', 'b', …`. The values are the constants above,
// never input.
export const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ')
