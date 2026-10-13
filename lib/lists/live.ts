import type { LiveRow } from '@/lib/lists/store'

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

export type ShopCallback = { kind: 'chk'; itemId: string } | { kind: 'clear' } | { kind: 'refresh' } | { kind: 'page'; page: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_PAGE = 9999

export function shopCallbackData(cb: ShopCallback): string {
  switch (cb.kind) {
    case 'chk':
      return `shop:chk:${cb.itemId}`
    case 'page':
      return `shop:page:${cb.page}`
    default:
      return `shop:${cb.kind}`
  }
}

const byteLength = (s: string) => new TextEncoder().encode(s).length

// Parse a button's callback_data. It arrives from Telegram but is only as trustworthy as the client that
// sent it, so anything that is not EXACTLY one of the four shapes is refused (null): too long, an id that
// is not a uuid (it would reach a uuid column), a page that is not a small positive number.
export function parseShopCallback(data: unknown): ShopCallback | null {
  if (typeof data !== 'string' || byteLength(data) > CALLBACK_DATA_MAX_BYTES) return null
  if (data === 'shop:clear') return { kind: 'clear' }
  if (data === 'shop:refresh') return { kind: 'refresh' }
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

export function itemButton(row: LiveRow): InlineButton {
  return { text: `${row.done ? DONE_MARK : OPEN_MARK} ${clip(boardItem(row.item), BUTTON_ITEM_MAX)}`, callback_data: shopCallbackData({ kind: 'chk', itemId: row.id }) }
}

// The live list as ONE message: a short header (title, counts, who changed it last and when, the page)
// and one button per item per row — open items (☐) first, then done ones (☑), which stay until someone
// taps "Clear done" — then ◀ / ▶ when there is more than one page, then the footer row.
export function renderLiveList(input: LiveListInput): LiveListView {
  const open = input.rows.filter((r) => !r.done)
  const done = input.rows.filter((r) => r.done)
  const ordered = [...open, ...done]
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

  const keyboard: InlineButton[][] = ordered.slice((page - 1) * SHOP_PAGE_SIZE, page * SHOP_PAGE_SIZE).map((r) => [itemButton(r)])
  if (pages > 1) {
    const nav: InlineButton[] = []
    if (page > 1) nav.push({ text: PREV_LABEL, callback_data: shopCallbackData({ kind: 'page', page: page - 1 }) })
    if (page < pages) nav.push({ text: NEXT_LABEL, callback_data: shopCallbackData({ kind: 'page', page: page + 1 }) })
    keyboard.push(nav)
  }
  keyboard.push([
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

export function clearToast(cleared: number): string {
  return cleared === 0 ? 'Nothing to clear.' : `🧹 Cleared ${cleared} done item${cleared === 1 ? '' : 's'}`
}

/** A plain-text picture of a rendered list (the message, then each keyboard row) — for tests, docs and logs. */
export function mockLiveList(view: LiveListView): string {
  const rows = view.keyboard.map((row) => row.map((b) => `[ ${b.text} ]`).join(' '))
  return `${view.text}\n${rows.join('\n')}`
}
