import type { LiveRow } from '@/lib/lists/store'
import { CATEGORIES, CATEGORY_LABELS, DEFAULT_SORT, NOT_SORTED_LABEL, SORT_LABELS, SORT_MODES, nextSortMode, type SortMode } from '@/lib/lists/categories'

// The live shopping list (issue #25, docs/spec/shopping-list.md §Live list) — the PURE half: the message
// text, its inline keyboard, its pages, and the callback data its buttons carry (built and parsed here,
// nowhere else). Everything that talks to Telegram or the database is in lib/lists/board.ts.
//
// The message is PLAIN TEXT (no parse_mode) and item names only ever appear as BUTTON labels, which
// Telegram never parses; they are still flattened and defanged (boardItem) so a name cannot fake a
// line, ping anyone or look like a /command.

/** Items per page of the live list; more than this and the ◀ / ▶ buttons appear. */
export const SHOP_PAGE_SIZE = 30
/** Telegram's limit on a button's callback_data, in bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64
/** The longest item name a button shows, in characters (longer ones end in "…"). */
export const BUTTON_ITEM_MAX = 40
/** The longest housemate name the header shows. */
const NAME_MAX = 32

export const LIST_TITLE = '🛒 Shopping list'
export const CLEAR_DONE_LABEL = '🧹 Clear done'
export const REFRESH_LABEL = '🔄 Refresh'
export const PREV_LABEL = '◀'
export const NEXT_LABEL = '▶'
export const OPEN_MARK = '☐'
export const DONE_MARK = '☑'

// C0/C1 controls, the soft hyphen, the Arabic letter mark, zero-width + bidi marks/overrides/isolates,
// the word joiner + invisible operators (U+2060–U+2064) and the BOM. Built from code points so no
// invisible character ever sits literally in this source file.
const INVISIBLE_RANGES: [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]
const hex = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`, 'g')

// An item (or a name) is untrusted text — a housemate's words or the kiosk's request body. Shown as plain
// text it still must not TRIGGER anything: Telegram auto-detects @mentions (a ping), #hashtags, $cashtags
// and /commands (tappable — a tap sends it as the tapper). The sigil that starts such a word is swapped
// for its look-alike, so nothing parses; control/bidi characters go, and a newline can't fake a line of
// its own. Readable as before.
export function boardItem(raw: string): string {
  return raw
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/@(?=\w)/g, '＠')
    .replace(/#(?=[\p{L}\p{N}_])/gu, '＃') // Telegram hashtags take any letter or digit, not only ASCII
    .replace(/\$(?=[A-Za-z])/g, '＄')
    .replace(/(?<!\w)\/(?=\w)/g, '∕')
}

// Cut to `max` characters (code points, so an emoji is never split in half), ending in "…" when cut.
export function clip(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

// ── Callback data ────────────────────────────────────────────────────────────────────────────────────

export type ShopCallback =
  | { kind: 'chk'; itemId: string }
  | { kind: 'clear' }
  | { kind: 'refresh' }
  | { kind: 'page'; page: number }
  /** A heading (issue #29): a button that does nothing — answered silently. */
  | { kind: 'noop' }
  /** The order button (issue #29): set the house's order to `mode` — the TARGET, so a double tap is idempotent. */
  | { kind: 'sort'; mode: SortMode }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_PAGE = 9999

export function shopCallbackData(cb: ShopCallback): string {
  switch (cb.kind) {
    case 'chk':
      return `shop:chk:${cb.itemId}`
    case 'page':
      return `shop:page:${cb.page}`
    case 'sort':
      return `shop:sort:${cb.mode}`
    default:
      return `shop:${cb.kind}`
  }
}

const byteLength = (s: string) => new TextEncoder().encode(s).length

// Parse a button's callback_data. It arrives from Telegram but is only as trustworthy as the client that
// sent it, so anything that is not EXACTLY one of the six shapes is refused (null): too long, an id that
// is not a uuid (it would reach a uuid column), a page that is not a small positive number.
export function parseShopCallback(data: unknown): ShopCallback | null {
  if (typeof data !== 'string' || byteLength(data) > CALLBACK_DATA_MAX_BYTES) return null
  if (data === 'shop:clear') return { kind: 'clear' }
  if (data === 'shop:refresh') return { kind: 'refresh' }
  if (data === 'shop:noop') return { kind: 'noop' }
  const sort = /^shop:sort:([a-z]+)$/.exec(data)
  if (sort) return (SORT_MODES as readonly string[]).includes(sort[1]) ? { kind: 'sort', mode: sort[1] as SortMode } : null
  const chk = /^shop:chk:(.+)$/.exec(data)
  if (chk) return UUID.test(chk[1]) ? { kind: 'chk', itemId: chk[1] } : null
  const page = /^shop:page:([1-9][0-9]{0,3})$/.exec(data)
  if (page) {
    const n = Number(page[1])
    return n <= MAX_PAGE ? { kind: 'page', page: n } : null
  }
  return null
}

/** What the tapper asked for: the state shown on the button they tapped (☐ → tick, ☑ → untick). */
export type TapWant = 'tick' | 'untick'

// The intent of an item tap, read from the keyboard Telegram delivered WITH the callback_query
// (`callback_query.message.reply_markup`): the button whose callback_data is the tapped data, and its
// leading ☐ / ☑. That payload comes over the secret-verified webhook, so it is Telegram's own record
// of the keyboard the tapper saw. Null when it cannot be read (an inaccessible message has no
// reply_markup, or no button carries that data) — the caller then falls back to a plain flip.
export function tapWant(replyMarkup: unknown, data: unknown): TapWant | null {
  if (typeof data !== 'string' || !data.startsWith('shop:chk:')) return null
  const rows = (replyMarkup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard
  if (!Array.isArray(rows)) return null
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const b of row) {
      const btn = b as { text?: unknown; callback_data?: unknown } | null
      if (btn?.callback_data !== data || typeof btn.text !== 'string') continue
      if (btn.text.startsWith(OPEN_MARK)) return 'tick'
      if (btn.text.startsWith(DONE_MARK)) return 'untick'
      return null
    }
  }
  return null
}

// ── The message ──────────────────────────────────────────────────────────────────────────────────────

export interface InlineButton {
  text: string
  callback_data: string
}

export interface LiveListView {
  text: string
  keyboard: InlineButton[][]
  /** The page shown (1-based, clamped), and how many there are. */
  page: number
  pages: number
}

export interface LiveListInput {
  rows: LiveRow[]
  /** The house's order (issue #29): groups (default) · az · added. */
  sort?: SortMode
  /** Now — the Added mode's "Today" is today in `tz`. Default: the rows' own dates are all "Earlier". */
  now?: Date
  /** The page asked for (1-based); clamped to the pages there are. Default 1. */
  page?: number
  /** Show the page holding this item instead (the item a housemate just tapped), when it is listed. */
  focusItemId?: string | null
  /** Who last changed the list (a display name, untrusted) and when; null when unknown. */
  updatedBy: string | null
  updatedAt: Date | null
  /** The house's timezone (Europe/Berlin), for the "Last updated" time. */
  tz: string
}

// "Tue 13 Oct, 18:05" in the house's timezone.
export function formatUpdatedAt(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

// ── Order modes and headings (issue #29) ──────────────────────────────────────────────────────────────

export const DONE_HEADING = 'Done'
export const TODAY_HEADING = 'Today'
export const EARLIER_HEADING = 'Earlier'
/** A heading is a button that does nothing (`shop:noop`), framed so it never reads as an item. */
export const headingButton = (label: string): InlineButton => ({ text: `── ${label} ──`, callback_data: shopCallbackData({ kind: 'noop' }) })
/** The footer's order button: shows the CURRENT mode, carries the NEXT one. */
export const sortButton = (mode: SortMode): InlineButton => ({ text: SORT_LABELS[mode], callback_data: shopCallbackData({ kind: 'sort', mode: nextSortMode(mode) }) })

/** One item in display order, with the heading it sits under (null = no headings in this mode). */
export interface OrderedRow {
  row: LiveRow
  heading: string | null
}

// "2026-10-13" in the house's timezone — the Added mode's day.
const dayKey = (at: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
const byName = (a: LiveRow, b: LiveRow) => a.item.localeCompare(b.item, 'en', { sensitivity: 'base' }) || a.item.localeCompare(b.item) || a.id.localeCompare(b.id)
const newestFirst = (a: LiveRow, b: LiveRow) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id)

// The rows in the order the mode shows them. Open items always come first; done (ticked, not cleared)
// items always below them, in the order they were ticked — under their own "Done" heading in the modes
// that have headings (so a ticked item never looks like part of the last group), with none in A–Z.
//   groups — open items under one heading per category, in the fixed order, "Not sorted" last; within a
//            group, oldest first (the order they were added).
//   az     — open items alphabetically (case-insensitive); no headings at all.
//   added  — open items newest first, under "Today" (added today, house time) and "Earlier".
export function orderRows(rows: LiveRow[], sort: SortMode, tz: string, now?: Date): OrderedRow[] {
  const open = rows.filter((r) => !r.done)
  const done = rows.filter((r) => r.done)
  let head: OrderedRow[]
  if (sort === 'az') {
    return [...[...open].sort(byName), ...done].map((row) => ({ row, heading: null }))
  } else if (sort === 'added') {
    const today = now ? dayKey(now, tz) : null
    const isToday = (r: LiveRow) => today != null && r.createdAt != null && dayKey(r.createdAt, tz) === today
    const sorted = [...open].sort(newestFirst)
    head = [...sorted.filter(isToday).map((row) => ({ row, heading: TODAY_HEADING })), ...sorted.filter((r) => !isToday(r)).map((row) => ({ row, heading: EARLIER_HEADING }))]
  } else {
    head = []
    for (const c of [...CATEGORIES, null]) {
      for (const row of open) if ((row.category ?? null) === c) head.push({ row, heading: c ? CATEGORY_LABELS[c] : NOT_SORTED_LABEL })
    }
  }
  return [...head, ...done.map((row) => ({ row, heading: DONE_HEADING }))]
}

export function itemButton(row: LiveRow): InlineButton {
  return { text: `${row.done ? DONE_MARK : OPEN_MARK} ${clip(boardItem(row.item), BUTTON_ITEM_MAX)}`, callback_data: shopCallbackData({ kind: 'chk', itemId: row.id }) }
}

// The live list as ONE message: a short header (title, counts, who changed it last and when, the page)
// and one button per item per row, in the house's order (orderRows) — open items (☐) first, then done
// ones (☑), which stay until someone taps "Clear done" — with heading buttons where the mode has them;
// then ◀ / ▶ when there is more than one page, then the footer row (order · Clear done · Refresh).
// A page holds SHOP_PAGE_SIZE ITEMS — headings don't count — and a group that carries on from the page
// before gets its heading again at the top.
export function renderLiveList(input: LiveListInput): LiveListView {
  const sort = input.sort ?? DEFAULT_SORT
  const open = input.rows.filter((r) => !r.done)
  const done = input.rows.filter((r) => r.done)
  const entries = orderRows(input.rows, sort, input.tz, input.now)
  const ordered = entries.map((e) => e.row)
  const pages = Math.max(1, Math.ceil(ordered.length / SHOP_PAGE_SIZE))
  const focus = input.focusItemId ? ordered.findIndex((r) => r.id === input.focusItemId) : -1
  const asked = focus >= 0 ? Math.floor(focus / SHOP_PAGE_SIZE) + 1 : (input.page ?? 1)
  const page = Math.min(Math.max(1, Number.isFinite(asked) ? Math.trunc(asked) : 1), pages)

  const lines = [LIST_TITLE]
  if (ordered.length === 0) lines.push('Nothing to buy.')
  else lines.push(`${open.length === 0 ? 'Nothing left to buy' : `${open.length} to buy`}${done.length ? ` · ${done.length} done` : ''}`)
  if (input.updatedAt) {
    const who = input.updatedBy ? clip(boardItem(input.updatedBy), NAME_MAX) : ''
    lines.push(`Last updated${who ? ` by ${who}` : ''}, ${formatUpdatedAt(input.updatedAt, input.tz)}`)
  }
  if (pages > 1) lines.push(`Page ${page} of ${pages}`)

  const keyboard: InlineButton[][] = []
  let heading: string | null = null
  for (const e of entries.slice((page - 1) * SHOP_PAGE_SIZE, page * SHOP_PAGE_SIZE)) {
    // A heading before the first item of each group on this page — so one carried over is repeated.
    if (e.heading != null && e.heading !== heading) keyboard.push([headingButton(e.heading)])
    heading = e.heading
    keyboard.push([itemButton(e.row)])
  }
  if (pages > 1) {
    const nav: InlineButton[] = []
    if (page > 1) nav.push({ text: PREV_LABEL, callback_data: shopCallbackData({ kind: 'page', page: page - 1 }) })
    if (page < pages) nav.push({ text: NEXT_LABEL, callback_data: shopCallbackData({ kind: 'page', page: page + 1 }) })
    keyboard.push(nav)
  }
  keyboard.push([
    sortButton(sort),
    { text: CLEAR_DONE_LABEL, callback_data: shopCallbackData({ kind: 'clear' }) },
    { text: REFRESH_LABEL, callback_data: shopCallbackData({ kind: 'refresh' }) },
  ])
  return { text: lines.join('\n'), keyboard, page, pages }
}

export type ToggleOutcome = 'ticked' | 'unticked' | 'already_ticked' | 'already_unticked' | 'readded' | 'gone'

// The answerCallbackQuery toast after a tap on an item ("✓ Ginger – ticked by Ryan"). Telegram caps a
// toast at 200 characters; names are clipped well under that.
export function toggleToast(outcome: ToggleOutcome, item: string | null, by: string | null): string {
  const name = item ? clip(boardItem(item), BUTTON_ITEM_MAX) : ''
  const who = by ? ` by ${clip(boardItem(by), NAME_MAX)}` : ''
  if (outcome === 'ticked') return `✓ ${name} – ticked${who}`
  if (outcome === 'unticked') return `↩ ${name} – back on the list${who}`
  if (outcome === 'already_ticked') return `${name} is already ticked`
  if (outcome === 'already_unticked' || outcome === 'readded') return `${name} is already on the list`
  return "That item isn't on the list any more."
}

/** The toast after the order button: the mode now shown. */
export function sortToast(mode: SortMode): string {
  return `Sorted: ${SORT_LABELS[mode]}`
}

export function clearToast(cleared: number): string {
  return cleared === 0 ? 'Nothing to clear.' : `🧹 Cleared ${cleared} done item${cleared === 1 ? '' : 's'}`
}

/** A plain-text picture of a rendered list (the message, then each keyboard row) — for tests, docs and logs. */
export function mockLiveList(view: LiveListView): string {
  const rows = view.keyboard.map((row) => row.map((b) => `[ ${b.text} ]`).join(' '))
  return `${view.text}\n${rows.join('\n')}`
}
