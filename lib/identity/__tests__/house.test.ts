import { describe, it, expect } from 'vitest'
import { resolveOriginParts, addressingFor, type Roster } from '@/lib/core/origin'
import { resolveHouseIds, parseNotifyCommand, parseShoppingCommand, setShoppingThread } from '@/lib/identity/house'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig } from '@/db/schema'

// The scope seam that lets a member DM read/write the HOUSE's shared memory while the reply
// goes to the private chat. The load-bearing security property: scope is derived from the
// authenticated LANE, never from the inbound chat id — so a DM can't be pointed elsewhere.
const HOUSE = '-1001234567890'
const roster: Roster = { isOwner: (id) => id === 100, isMember: (id) => id === 100 || id === 200 }

const ADDR = { scopeId: HOUSE, acceptIds: [HOUSE] }
const scopeOf = (o: ReturnType<typeof resolveOriginParts>) => addressingFor(o, ADDR, roster, null).scope

describe('addressingFor — the scope', () => {
  it('house-group message scopes to the house', () => {
    const o = resolveOriginParts({ chatId: HOUSE, fromId: 100, text: 'x', isPrivate: false }, roster, HOUSE)
    expect(o.lane).toBe('house')
    expect(scopeOf(o)).toBe(HOUSE)
  })

  it('member DM scopes to the HOUSE, not the private chat (reads/writes shared memory)', () => {
    const o = resolveOriginParts({ chatId: '200', fromId: 200, text: 'when is bin day', isPrivate: true }, roster, HOUSE)
    expect(o.lane).toBe('member_dm')
    expect(o.chatId).toBe('200') // the DM chat — where a reply is SENT
    // ...but the SCOPE is the house, never the DM chat id. This decoupling is the feature.
    expect(scopeOf(o)).toBe(HOUSE)
    expect(scopeOf(o)).not.toBe(o.chatId)
  })

  it('an out-of-scope origin (unknown DM sender) has NO house scope — reads/writes nothing', () => {
    const o = resolveOriginParts({ chatId: '999', fromId: 999, text: 'x', isPrivate: true }, roster, HOUSE)
    expect(o.lane).toBe('ignore')
    expect(scopeOf(o)).toBe('')
  })
})

// Alias seam (docs/spec/telegram.md D9): a group→supergroup upgrade moves the TRANSPORT id but
// must never move the SCOPE id (that orphans all memory). resolveHouseIds keeps them distinct.
describe('resolveHouseIds (alias seam)', () => {
  it('scope stays put; sendId + acceptIds follow the live transport id after migration', async () => {
    delete process.env.BAUMY_HOUSE_CHAT_ID
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: '-100old', liveChatId: '-1002222222222' })
    const ids = await resolveHouseIds(db)
    expect(ids.scopeId).toBe('-100old') // memory scope never moves
    expect(ids.sendId).toBe('-1002222222222') // sends land in the live supergroup
    expect([...ids.acceptIds].sort()).toEqual(['-1002222222222', '-100old'].sort())
  })

  it('no live id → sendId falls back to the scope (pre-migration)', async () => {
    delete process.env.BAUMY_HOUSE_CHAT_ID
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: '-100old' })
    const ids = await resolveHouseIds(db)
    expect(ids.sendId).toBe('-100old')
    expect(ids.acceptIds).toEqual(['-100old'])
  })

  it('env pin overrides the SCOPE only; live transport stays DB-driven (no redeploy to follow a migration)', async () => {
    process.env.BAUMY_HOUSE_CHAT_ID = '-100pin'
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: '-100dbscope', liveChatId: '-1003333333333' })
    const ids = await resolveHouseIds(db)
    expect(ids.scopeId).toBe('-100pin')
    expect(ids.sendId).toBe('-1003333333333')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })
})

describe('parseNotifyCommand', () => {
  it('matches /notifyhere and /notifyoff (incl. a @botname suffix), rejects near-misses', () => {
    expect(parseNotifyCommand('/notifyhere')).toBe('here')
    expect(parseNotifyCommand('  /notifyhere  ')).toBe('here')
    expect(parseNotifyCommand('/notifyhere@BaumyBot')).toBe('here')
    expect(parseNotifyCommand('/notifyoff')).toBe('off')
    expect(parseNotifyCommand('/NotifyOff@BaumyBot please')).toBe('off')
    expect(parseNotifyCommand('/notify')).toBeNull()
    expect(parseNotifyCommand('notify here')).toBeNull()
    expect(parseNotifyCommand('/notifyherenow')).toBeNull() // whole-word only
    expect(parseNotifyCommand(null)).toBeNull()
  })
})

describe('parseShoppingCommand (docs/spec/shopping-list.md §Shopping topic)', () => {
  it('matches /shoppinghere and /shoppingoff (incl. a @botname suffix), rejects near-misses', () => {
    expect(parseShoppingCommand('/shoppinghere')).toBe('here')
    expect(parseShoppingCommand('  /shoppinghere  ')).toBe('here')
    expect(parseShoppingCommand('/ShoppingHere@BaumyBot')).toBe('here')
    expect(parseShoppingCommand('/shoppingoff')).toBe('off')
    expect(parseShoppingCommand('/shopping')).toBeNull()
    expect(parseShoppingCommand('shopping here')).toBeNull()
    expect(parseShoppingCommand('please /shoppinghere')).toBeNull() // must lead the message
    expect(parseShoppingCommand('/shoppingherenow')).toBeNull() // whole-word only
    expect(parseShoppingCommand(null)).toBeNull()
  })

  it('setShoppingThread stores / clears the topic, read back through resolveHouseIds', async () => {
    const db = await makeTestDb()
    expect((await resolveHouseIds(db)).shoppingThreadId).toBeNull()
    await setShoppingThread(db, 42)
    expect((await resolveHouseIds(db)).shoppingThreadId).toBe(42)
    await setShoppingThread(db, null)
    expect((await resolveHouseIds(db)).shoppingThreadId).toBeNull()
  })
})
