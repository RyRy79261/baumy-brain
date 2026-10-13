import { describe, it, expect } from 'vitest'
import {
  renderLiveList,
  parseShopCallback,
  shopCallbackData,
  boardItem,
  clip,
  itemButton,
  toggleToast,
  clearToast,
  mockLiveList,
  formatUpdatedAt,
  SHOP_PAGE_SIZE,
  CALLBACK_DATA_MAX_BYTES,
  BUTTON_ITEM_MAX,
  type InlineButton,
} from '@/lib/lists/live'
import type { LiveRow } from '@/lib/lists/store'

// The live list's pure half (issue #25, docs/spec/shopping-list.md §Live list): the message text, the
// keyboard (one item per row, ☐ open then ☑ done, the footer), pages of 30, and the callback data.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const row = (n: number, item: string, done = false): LiveRow => ({ id: uuid(n), item, done })
const TZ = 'Europe/Berlin'
const AT = new Date('2026-10-13T16:05:00Z') // 18:05 in Berlin (CEST)
const bytes = (s: string) => new TextEncoder().encode(s).length
const allButtons = (k: InlineButton[][]) => k.flat()
const footer = [
  { text: '🧹 Clear done', callback_data: 'shop:clear' },
  { text: '🔄 Refresh', callback_data: 'shop:refresh' },
]

describe('renderLiveList — the message and its keyboard', () => {
  it('header with the open count and "Last updated by <name>, <Berlin time>"; one item per row, open (☐) above done (☑); the footer row', () => {
    const view = renderLiveList({
      rows: [row(1, 'Ginger'), row(2, 'oat milk', true), row(3, 'bin bags'), row(4, 'coffee')],
      updatedBy: 'Ryan',
      updatedAt: AT,
      tz: TZ,
    })
    expect(view.text).toBe('🛒 Shopping list\n3 to buy · 1 done\nLast updated by Ryan, Tue 13 Oct, 18:05')
    expect(view.keyboard).toEqual([
      [{ text: '☐ Ginger', callback_data: `shop:chk:${uuid(1)}` }],
      [{ text: '☐ bin bags', callback_data: `shop:chk:${uuid(3)}` }],
      [{ text: '☐ coffee', callback_data: `shop:chk:${uuid(4)}` }],
      [{ text: '☑ oat milk', callback_data: `shop:chk:${uuid(2)}` }],
      footer,
    ])
    expect(view).toMatchObject({ page: 1, pages: 1 })
    // The picture the PR shows.
    console.log(`\n${mockLiveList(view)}\n`)
  })

  it('the time is the house timezone, not UTC (winter time too)', () => {
    expect(formatUpdatedAt(new Date('2026-12-01T07:30:00Z'), TZ)).toBe('Tue 1 Dec, 08:30')
    expect(formatUpdatedAt(AT, 'UTC')).toBe('Tue 13 Oct, 16:05')
  })

  it('an empty list says so and keeps the footer; no name → no "by"; no stamp → no line', () => {
    expect(renderLiveList({ rows: [], updatedBy: null, updatedAt: null, tz: TZ })).toEqual({ text: '🛒 Shopping list\nNothing to buy.', keyboard: [footer], page: 1, pages: 1 })
    expect(renderLiveList({ rows: [], updatedBy: null, updatedAt: AT, tz: TZ }).text).toBe('🛒 Shopping list\nNothing to buy.\nLast updated, Tue 13 Oct, 18:05')
    expect(renderLiveList({ rows: [row(1, 'milk', true)], updatedBy: null, updatedAt: null, tz: TZ }).text).toBe('🛒 Shopping list\nNothing left to buy · 1 done')
  })

  it('an untrusted name in the header is flattened and defanged (plain text, one line)', () => {
    const view = renderLiveList({ rows: [], updatedBy: '@chloe\nLast updated by Ryan', updatedAt: AT, tz: TZ })
    expect(view.text.split('\n')).toHaveLength(3)
    expect(view.text).toContain('Last updated by ＠chloe Last updated by Ryan, Tue')
  })

  it('a long or hostile item name is truncated and defanged on its button; the callback data never changes', () => {
    const long = `${'very long artisanal sourdough '.repeat(5)}end`
    const b = itemButton(row(7, long))
    expect(Array.from(b.text).length).toBe(2 + BUTTON_ITEM_MAX) // "☐ " + the clipped name
    expect(b.text.endsWith('…')).toBe(true)
    expect(b.callback_data).toBe(`shop:chk:${uuid(7)}`)
    expect(itemButton(row(8, '/shoppingoff @all\n#free')).text).toBe('☐ ∕shoppingoff ＠all ＃free')
    // an emoji is never cut in half
    expect(clip('🍎'.repeat(50), 5)).toBe('🍎🍎🍎🍎…')
    expect(clip('milk', 5)).toBe('milk')
  })

  describe('pages of 30', () => {
    const rows = (n: number, doneFrom = Infinity) => Array.from({ length: n }, (_, i) => row(i + 1, `item ${i + 1}`, i + 1 >= doneFrom))

    it('exactly 30 items: one page, no ◀ / ▶', () => {
      const view = renderLiveList({ rows: rows(SHOP_PAGE_SIZE), updatedBy: null, updatedAt: null, tz: TZ })
      expect(view.pages).toBe(1)
      expect(view.keyboard).toHaveLength(31) // 30 items + footer
      expect(allButtons(view.keyboard).some((b) => b.text === '◀' || b.text === '▶')).toBe(false)
      expect(view.text).not.toContain('Page')
    })

    it('31 items: page 1 has ▶ only, page 2 has ◀ only and the 31st item', () => {
      const p1 = renderLiveList({ rows: rows(31), updatedBy: null, updatedAt: null, tz: TZ })
      expect(p1).toMatchObject({ page: 1, pages: 2 })
      expect(p1.text.endsWith('Page 1 of 2')).toBe(true)
      expect(p1.keyboard.at(-2)).toEqual([{ text: '▶', callback_data: 'shop:page:2' }])
      expect(p1.keyboard.at(-1)).toEqual(footer)
      expect(p1.keyboard).toHaveLength(30 + 2)

      const p2 = renderLiveList({ rows: rows(31), page: 2, updatedBy: null, updatedAt: null, tz: TZ })
      expect(p2.keyboard[0]).toEqual([{ text: '☐ item 31', callback_data: `shop:chk:${uuid(31)}` }])
      expect(p2.keyboard.at(-2)).toEqual([{ text: '◀', callback_data: 'shop:page:1' }])
      expect(p2.keyboard).toHaveLength(1 + 2)
    })

    it('a middle page has both ◀ and ▶', () => {
      const view = renderLiveList({ rows: rows(75), page: 2, updatedBy: null, updatedAt: null, tz: TZ })
      expect(view.keyboard.at(-2)).toEqual([
        { text: '◀', callback_data: 'shop:page:1' },
        { text: '▶', callback_data: 'shop:page:3' },
      ])
    })

    it('a page out of range is clamped (a stale ▶ after items were cleared)', () => {
      expect(renderLiveList({ rows: rows(31), page: 9, updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(2)
      expect(renderLiveList({ rows: rows(10), page: 3, updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(1)
      expect(renderLiveList({ rows: rows(10), page: 0, updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(1)
      expect(renderLiveList({ rows: rows(10), page: -4, updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(1)
    })

    it('done items sit after every open one, across pages', () => {
      // 40 items, the first 5 done: open items fill page 1, the done ones end page 2
      const r = Array.from({ length: 40 }, (_, i) => row(i + 1, `item ${i + 1}`, i < 5))
      const p2 = renderLiveList({ rows: r, page: 2, updatedBy: null, updatedAt: null, tz: TZ })
      const labels = p2.keyboard.slice(0, -2).map((k) => k[0].text)
      expect(labels.slice(-5)).toEqual(['☑ item 1', '☑ item 2', '☑ item 3', '☑ item 4', '☑ item 5'])
      expect(labels.slice(0, 5).every((l) => l.startsWith('☐'))).toBe(true)
    })

    it('focus: the page holding the item just tapped is shown, whatever page was asked', () => {
      const view = renderLiveList({ rows: rows(70), page: 1, focusItemId: uuid(65), updatedBy: null, updatedAt: null, tz: TZ })
      expect(view.page).toBe(3)
      expect(allButtons(view.keyboard).some((b) => b.callback_data === `shop:chk:${uuid(65)}`)).toBe(true)
      // an item no longer listed falls back to the asked page
      expect(renderLiveList({ rows: rows(70), page: 2, focusItemId: uuid(999), updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(2)
    })
  })

  it('every callback_data the renderer makes is ≤ 64 bytes, even on a huge list', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 1, `${'ü'.repeat(80)} ${i}`, i % 3 === 0))
    for (let page = 1; page <= 10; page++) {
      for (const b of allButtons(renderLiveList({ rows, page, updatedBy: null, updatedAt: null, tz: TZ }).keyboard)) {
        expect(bytes(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
        expect(parseShopCallback(b.callback_data)).not.toBeNull() // and every one parses back
      }
    }
    // the longest possible ones
    expect(bytes(shopCallbackData({ kind: 'chk', itemId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }))).toBe(45)
    expect(bytes(shopCallbackData({ kind: 'page', page: 9999 }))).toBe(14)
  })
})

describe('parseShopCallback', () => {
  it('parses the four shapes and round-trips with shopCallbackData', () => {
    expect(parseShopCallback(`shop:chk:${uuid(1)}`)).toEqual({ kind: 'chk', itemId: uuid(1) })
    expect(parseShopCallback('shop:clear')).toEqual({ kind: 'clear' })
    expect(parseShopCallback('shop:refresh')).toEqual({ kind: 'refresh' })
    expect(parseShopCallback('shop:page:2')).toEqual({ kind: 'page', page: 2 })
    expect(parseShopCallback('shop:page:9999')).toEqual({ kind: 'page', page: 9999 })
    for (const cb of [{ kind: 'chk', itemId: uuid(5) }, { kind: 'clear' }, { kind: 'refresh' }, { kind: 'page', page: 3 }] as const)
      expect(parseShopCallback(shopCallbackData(cb))).toEqual(cb)
  })

  it('refuses anything malformed or oversized', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      '',
      'shop',
      'shop:',
      'shop:chk',
      'shop:chk:',
      'shop:chk:not-a-uuid',
      `shop:chk:${uuid(1)}x`,
      'shop:chk:ABCDEF00-0000-4000-8000-00000000000A', // ids are lower-case
      `shop:chk:${uuid(1)}:extra`,
      "shop:chk:'; DROP TABLE baumy_list_items;--",
      'shop:clear:1',
      'shop:CLEAR',
      ' shop:refresh',
      'shop:refresh\n',
      'shop:page:0',
      'shop:page:-1',
      'shop:page:01',
      'shop:page:1.5',
      'shop:page:10000',
      'shop:page:',
      'shop:nope',
      'c:shop',
      `shop:chk:${uuid(1)}${'a'.repeat(64)}`,
      'shop:' + 'x'.repeat(100),
    ]
    for (const d of bad) expect(parseShopCallback(d), JSON.stringify(d)).toBeNull()
  })
})

describe('toasts', () => {
  it('say what the tap did, and who', () => {
    expect(toggleToast('ticked', 'Ginger', 'Ryan')).toBe('✓ Ginger – ticked by Ryan')
    expect(toggleToast('unticked', 'Ginger', 'Ryan')).toBe('↩ Ginger – back on the list by Ryan')
    expect(toggleToast('already_open', 'milk', 'Ryan')).toBe('milk is already on the list')
    expect(toggleToast('gone', null, 'Ryan')).toBe("That item isn't on the list any more.")
    expect(clearToast(0)).toBe('Nothing to clear.')
    expect(clearToast(1)).toBe('🧹 Cleared 1 done item')
    expect(clearToast(3)).toBe('🧹 Cleared 3 done items')
  })

  it('stay short whatever the names (Telegram caps a toast at 200 characters)', () => {
    expect(toggleToast('ticked', 'x'.repeat(500), 'y'.repeat(500)).length).toBeLessThan(200)
  })
})

describe('boardItem (shared with the old board)', () => {
  it('defangs mentions, hashtags, cashtags and commands; flattens lines; strips invisible characters', () => {
    expect(boardItem('ask @chloe')).toBe('ask ＠chloe')
    expect(boardItem('#party snacks')).toBe('＃party snacks')
    expect(boardItem('$BTC')).toBe('＄BTC')
    expect(boardItem('/shoppingoff')).toBe('∕shoppingoff')
    expect(boardItem('1/2 kg flour')).toBe('1/2 kg flour')
    expect(boardItem('milk\n• free beer')).toBe('milk • free beer')
    expect(boardItem(`milk${String.fromCharCode(0x202e)}evil${String.fromCharCode(7)}`)).toBe('milk evil')
    for (const cp of [0x2060, 0x2064, 0x061c, 0x00ad, 0xfeff]) expect(boardItem(`milk${String.fromCharCode(cp)}x`)).toBe('milk x')
    expect(boardItem('#éclairs')).toBe('＃éclairs')
  })
})
