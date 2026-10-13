import { describe, it, expect } from 'vitest'
import {
  renderLiveList,
  parseShopCallback,
  shopCallbackData,
  boardItem,
  clip,
  itemButton,
  toggleToast,
  tapWant,
  clearToast,
  mockLiveList,
  sortToast,
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
// The default order is Groups (issue #29): the footer leads with the order button, showing the current mode.
const footer = [
  { text: '🗂 Groups', callback_data: 'shop:sort:az' },
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
      [{ text: '── Not sorted ──', callback_data: 'shop:noop' }],
      [{ text: '☐ Ginger', callback_data: `shop:chk:${uuid(1)}` }],
      [{ text: '☐ bin bags', callback_data: `shop:chk:${uuid(3)}` }],
      [{ text: '☐ coffee', callback_data: `shop:chk:${uuid(4)}` }],
      [{ text: '── Done ──', callback_data: 'shop:noop' }],
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
      expect(view.keyboard).toHaveLength(32) // 30 items + their heading + footer (headings don't count as items)
      expect(allButtons(view.keyboard).some((b) => b.text === '◀' || b.text === '▶')).toBe(false)
      expect(view.text).not.toContain('Page')
    })

    it('31 items: page 1 has ▶ only, page 2 has ◀ only and the 31st item', () => {
      const p1 = renderLiveList({ rows: rows(31), updatedBy: null, updatedAt: null, tz: TZ })
      expect(p1).toMatchObject({ page: 1, pages: 2 })
      expect(p1.text.endsWith('Page 1 of 2')).toBe(true)
      expect(p1.keyboard.at(-2)).toEqual([{ text: '▶', callback_data: 'shop:page:2' }])
      expect(p1.keyboard.at(-1)).toEqual(footer)
      expect(p1.keyboard).toHaveLength(30 + 1 + 2)

      const p2 = renderLiveList({ rows: rows(31), page: 2, updatedBy: null, updatedAt: null, tz: TZ })
      // the group carries on from page 1, so its heading is repeated at the top
      expect(p2.keyboard[0]).toEqual([{ text: '── Not sorted ──', callback_data: 'shop:noop' }])
      expect(p2.keyboard[1]).toEqual([{ text: '☐ item 31', callback_data: `shop:chk:${uuid(31)}` }])
      expect(p2.keyboard.at(-2)).toEqual([{ text: '◀', callback_data: 'shop:page:1' }])
      expect(p2.keyboard).toHaveLength(1 + 1 + 2)
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
      const labels = p2.keyboard
        .slice(0, -2)
        .map((k) => k[0].text)
        .filter((t) => !t.startsWith('──'))
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
    expect(toggleToast('already_ticked', 'milk', 'Ryan')).toBe('milk is already ticked')
    expect(toggleToast('already_unticked', 'milk', 'Ryan')).toBe('milk is already on the list')
    expect(toggleToast('readded', 'milk', 'Ryan')).toBe('milk is already on the list')
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

describe('tapWant — what the tapped button showed, from the keyboard Telegram delivered', () => {
  const view = renderLiveList({ rows: [row(1, 'Ginger'), row(2, 'oat milk', true)], updatedBy: null, updatedAt: null, tz: TZ })
  const markup = { inline_keyboard: view.keyboard }

  it('☐ → tick, ☑ → untick, matched on the exact callback_data', () => {
    expect(tapWant(markup, `shop:chk:${uuid(1)}`)).toBe('tick')
    expect(tapWant(markup, `shop:chk:${uuid(2)}`)).toBe('untick')
  })

  it('unknown when it cannot be read: no markup (an inaccessible message), no matching button, not an item tap, odd shapes', () => {
    expect(tapWant(undefined, `shop:chk:${uuid(1)}`)).toBeNull()
    expect(tapWant(null, `shop:chk:${uuid(1)}`)).toBeNull()
    expect(tapWant({}, `shop:chk:${uuid(1)}`)).toBeNull()
    expect(tapWant({ inline_keyboard: 'x' }, `shop:chk:${uuid(1)}`)).toBeNull()
    expect(tapWant({ inline_keyboard: [null, 'row', [null, 5]] }, `shop:chk:${uuid(1)}`)).toBeNull()
    expect(tapWant(markup, `shop:chk:${uuid(9)}`)).toBeNull() // no button carries it
    expect(tapWant(markup, 'shop:clear')).toBeNull()
    expect(tapWant(markup, 'c:abc')).toBeNull()
    expect(tapWant(markup, undefined)).toBeNull()
    // a button whose label starts with neither mark
    expect(tapWant({ inline_keyboard: [[{ text: 'Ginger', callback_data: `shop:chk:${uuid(1)}` }]] }, `shop:chk:${uuid(1)}`)).toBeNull()
  })
})

// Issue #29: the order modes (Groups → A–Z → Added), heading buttons and pages that don't count them.
describe('renderLiveList — order modes and headings (issue #29)', () => {
  const NOW = new Date('2026-10-13T16:05:00Z') // Tue 13 Oct, 18:05 in Berlin
  const c = (n: number, item: string, category: LiveRow['category'], createdAt: string, done = false): LiveRow => ({ id: uuid(n), item, done, category, createdAt: new Date(createdAt) })
  // Added oldest first, as liveListRows returns them (open first, then done in tick order).
  const HOUSE_LIST: LiveRow[] = [
    c(1, 'bin bags', 'cleaning', '2026-10-11T09:00:00Z'),
    c(2, 'oat milk', 'coffee', '2026-10-12T08:00:00Z'),
    c(3, 'Pasta', 'pantry', '2026-10-12T10:00:00Z'),
    c(4, 'light bulbs', 'maintenance', '2026-10-12T21:59:00Z'), // 23:59 Berlin on the 12th → Earlier
    c(5, 'zorblax', null, '2026-10-12T22:30:00Z'), // 00:30 Berlin on the 13th → Today
    c(6, 'apples', 'fresh', '2026-10-13T07:00:00Z'),
    c(7, 'candles', 'household', '2026-10-13T15:00:00Z'),
    c(8, 'coffee beans', 'coffee', '2026-10-13T15:30:00Z'),
    c(9, 'sponges', 'cleaning', '2026-10-10T09:00:00Z', true),
  ]
  const render = (sort: 'groups' | 'az' | 'added', rows = HOUSE_LIST, page?: number) => renderLiveList({ rows, sort, now: NOW, page, updatedBy: 'Ryan', updatedAt: NOW, tz: TZ })
  const texts = (k: InlineButton[][]) => k.map((r) => r.map((b) => b.text).join(' | '))

  it('Groups (the default): a heading per category in the fixed order, Not sorted last, then Done; within a group oldest first', () => {
    const view = render('groups')
    expect(texts(view.keyboard)).toEqual([
      '── Pantry ──',
      '☐ Pasta',
      '── Fresh ──',
      '☐ apples',
      '── Coffee ──',
      '☐ oat milk',
      '☐ coffee beans',
      '── Cleaning ──',
      '☐ bin bags',
      '── Maintenance ──',
      '☐ light bulbs',
      '── Household ──',
      '☐ candles',
      '── Not sorted ──',
      '☐ zorblax',
      '── Done ──',
      '☑ sponges',
      '🗂 Groups | 🧹 Clear done | 🔄 Refresh',
    ])
    // every heading is a do-nothing button; the order button carries the NEXT mode
    for (const row of view.keyboard) for (const b of row) if (b.text.startsWith('──')) expect(b.callback_data).toBe('shop:noop')
    expect(view.keyboard.at(-1)![0]).toEqual({ text: '🗂 Groups', callback_data: 'shop:sort:az' })
    expect(renderLiveList({ rows: HOUSE_LIST, updatedBy: null, updatedAt: null, tz: TZ }).keyboard).toEqual(renderLiveList({ rows: HOUSE_LIST, sort: 'groups', updatedBy: null, updatedAt: null, tz: TZ }).keyboard)
    console.log(`\n[Groups]\n${mockLiveList(view)}\n`)
  })

  it('A–Z: open items alphabetically (case-insensitive), NO headings at all, done items still below', () => {
    const view = render('az')
    expect(texts(view.keyboard)).toEqual([
      '☐ apples',
      '☐ bin bags',
      '☐ candles',
      '☐ coffee beans',
      '☐ light bulbs',
      '☐ oat milk',
      '☐ Pasta',
      '☐ zorblax',
      '☑ sponges',
      '🔤 A–Z | 🧹 Clear done | 🔄 Refresh',
    ])
    expect(view.keyboard.at(-1)![0]).toEqual({ text: '🔤 A–Z', callback_data: 'shop:sort:added' })
    console.log(`\n[A–Z]\n${mockLiveList(view)}\n`)
  })

  it('Added: newest first under "Today" and "Earlier" — the day is Europe/Berlin, not UTC — then Done', () => {
    const view = render('added')
    expect(texts(view.keyboard)).toEqual([
      '── Today ──',
      '☐ coffee beans',
      '☐ candles',
      '☐ apples',
      '☐ zorblax', // 22:30 UTC on the 12th is 00:30 on the 13th in Berlin
      '── Earlier ──',
      '☐ light bulbs', // 21:59 UTC is 23:59 the day before in Berlin
      '☐ Pasta',
      '☐ oat milk',
      '☐ bin bags',
      '── Done ──',
      '☑ sponges',
      '🕒 Added | 🧹 Clear done | 🔄 Refresh',
    ])
    expect(view.keyboard.at(-1)![0]).toEqual({ text: '🕒 Added', callback_data: 'shop:sort:groups' })
    // only "Earlier" when nothing was added today; no "Done" when nothing is ticked
    const old = HOUSE_LIST.filter((r) => r.id === uuid(1) || r.id === uuid(2))
    expect(texts(render('added', old).keyboard).slice(0, -1)).toEqual(['── Earlier ──', '☐ oat milk', '☐ bin bags'])
    console.log(`\n[Added]\n${mockLiveList(view)}\n`)
  })

  it('the header is the same in every mode (counts, who, when)', () => {
    for (const m of ['groups', 'az', 'added'] as const) expect(render(m).text).toBe('🛒 Shopping list\n8 to buy · 1 done\nLast updated by Ryan, Tue 13 Oct, 18:05')
  })

  describe('pages: 30 ITEMS a page — headings do not count — and a group that carries on gets its heading again', () => {
    // 25 pantry, 10 fresh, 3 done: page 1 = 25 pantry + 5 fresh, page 2 = 5 fresh + 3 done.
    const big = [
      ...Array.from({ length: 25 }, (_, i) => c(100 + i, `pantry ${String(i + 1).padStart(2, '0')}`, 'pantry', '2026-10-01T10:00:00Z')),
      ...Array.from({ length: 10 }, (_, i) => c(200 + i, `fresh ${String(i + 1).padStart(2, '0')}`, 'fresh', '2026-10-01T10:00:00Z')),
      ...Array.from({ length: 3 }, (_, i) => c(300 + i, `done ${i + 1}`, 'coffee', '2026-10-01T10:00:00Z', true)),
    ]
    const items = (k: InlineButton[][]) => k.flat().filter((b) => b.callback_data.startsWith('shop:chk:'))

    it('page 1 holds exactly 30 items plus its headings; page 2 repeats the carried-over heading at the top', () => {
      const p1 = render('groups', big, 1)
      expect(p1).toMatchObject({ page: 1, pages: 2 })
      expect(items(p1.keyboard)).toHaveLength(SHOP_PAGE_SIZE)
      const t1 = texts(p1.keyboard)
      expect(t1[0]).toBe('── Pantry ──')
      expect(t1[26]).toBe('── Fresh ──')
      expect(t1.slice(-3)).toEqual(['☐ fresh 05', '▶', '🗂 Groups | 🧹 Clear done | 🔄 Refresh'])
      expect(p1.text.endsWith('Page 1 of 2')).toBe(true)

      const p2 = render('groups', big, 2)
      expect(texts(p2.keyboard)).toEqual([
        '── Fresh ──', // repeated: Fresh carried on from page 1
        '☐ fresh 06',
        '☐ fresh 07',
        '☐ fresh 08',
        '☐ fresh 09',
        '☐ fresh 10',
        '── Done ──',
        '☑ done 1',
        '☑ done 2',
        '☑ done 3',
        '◀',
        '🗂 Groups | 🧹 Clear done | 🔄 Refresh',
      ])
      console.log(`\n[Groups, page 2 of 2]\n${mockLiveList(p2)}\n`)
    })

    it('a heading that ends exactly at a page break is not repeated on the next page', () => {
      const exact = [...big.slice(0, 25), ...big.slice(25, 30)] // 25 pantry + 5 fresh = exactly one page
      const extra = [...exact, c(400, 'zz unsorted', null, '2026-10-01T10:00:00Z')]
      const p2 = render('groups', extra, 2)
      expect(texts(p2.keyboard)[0]).toBe('── Not sorted ──')
      expect(texts(p2.keyboard)).not.toContain('── Fresh ──')
    })

    it('A–Z pages are plain items, 30 a page', () => {
      const p1 = render('az', big, 1)
      expect(p1.keyboard).toHaveLength(SHOP_PAGE_SIZE + 2)
      expect(texts(p1.keyboard).some((t) => t.startsWith('──'))).toBe(false)
    })

    it('focus finds the tapped item in the MODE\'s order', () => {
      const lastFresh = uuid(209)
      expect(render('groups', big).page).toBe(1)
      expect(renderLiveList({ rows: big, sort: 'groups', focusItemId: lastFresh, updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(2)
      // in A–Z, "fresh 10" sorts before every "pantry …" item → page 1
      expect(renderLiveList({ rows: big, sort: 'az', focusItemId: lastFresh, updatedBy: null, updatedAt: null, tz: TZ }).page).toBe(1)
    })
  })

  it('every callback_data in every mode is ≤ 64 bytes and parses back (headings and the order button included)', () => {
    const rows = Array.from({ length: 120 }, (_, i) => c(i + 1, `${'ü'.repeat(80)} ${i}`, [null, 'pantry', 'fresh', 'coffee'][i % 4] as LiveRow['category'], '2026-10-13T10:00:00Z', i % 5 === 0))
    for (const m of ['groups', 'az', 'added'] as const)
      for (let page = 1; page <= 5; page++)
        for (const b of allButtons(render(m, rows, page).keyboard)) {
          expect(bytes(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
          expect(parseShopCallback(b.callback_data)).not.toBeNull()
        }
    expect(bytes(shopCallbackData({ kind: 'sort', mode: 'groups' }))).toBe(16)
    expect(bytes(shopCallbackData({ kind: 'noop' }))).toBe(9)
  })

  it('parses shop:noop and shop:sort:<mode> exactly; refuses a crafted mode', () => {
    expect(parseShopCallback('shop:noop')).toEqual({ kind: 'noop' })
    for (const m of ['groups', 'az', 'added'] as const) expect(parseShopCallback(`shop:sort:${m}`)).toEqual({ kind: 'sort', mode: m })
    for (const bad of ['shop:noop:1', 'shop:sort', 'shop:sort:', 'shop:sort:AZ', 'shop:sort:a-z', 'shop:sort:groups ', ' shop:sort:az', 'shop:sort:random', `shop:sort:${'a'.repeat(60)}`])
      expect(parseShopCallback(bad)).toBeNull()
    expect(sortToast('az')).toBe('Sorted: 🔤 A–Z')
  })
})
