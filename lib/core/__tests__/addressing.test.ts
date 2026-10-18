import { describe, it, expect } from 'vitest'
import { addressingFor, resolveOriginParts, type OriginParts, type Roster } from '@/lib/core/origin'

// Scope, destination and identity — produced once from the authenticated origin (lib/core/origin.ts).
const HOUSE = '-100scope'
const LIVE = '-100live' // the supergroup id after a migration — also the house
const roster: Roster = { isOwner: (id) => id === 1, isMember: (id) => id === 1 || id === 2 }
const house = { scopeId: HOUSE, acceptIds: [HOUSE, LIVE] }
const addr = (p: Partial<OriginParts>, thread: number | null = null) => {
  const parts: OriginParts = { chatId: HOUSE, fromId: 2, text: 'x', isPrivate: false, ...p }
  return addressingFor(resolveOriginParts(parts, roster, HOUSE, house.acceptIds), house, roster, thread)
}

describe('addressingFor', () => {
  it('a house message: scope = the house, reply into the SAME chat and topic, author = sender', () => {
    expect(addr({}, 42)).toEqual({ scope: HOUSE, reply: { to: 'chat', chatId: HOUSE, threadId: 42 }, authorId: '2', forwarderId: null, windowable: true })
  })

  it('after a migration a message from the live id replies to the live id, scope stays put', () => {
    const a = addr({ chatId: LIVE })
    expect(a.scope).toBe(HOUSE)
    expect(a.reply).toEqual({ to: 'chat', chatId: LIVE, threadId: null })
  })

  it('a member DM: scope = the house, reply = their own DM (no topic, even if one was sent)', () => {
    const a = addr({ chatId: '2', isPrivate: true }, 9)
    expect(a.scope).toBe(HOUSE)
    expect(a.reply).toEqual({ to: 'chat', chatId: '2', threadId: null })
  })

  it('out of scope (unknown DM, foreign group): no scope, no destination, nothing windowed', () => {
    for (const a of [addr({ chatId: '99', fromId: 99, isPrivate: true }), addr({ chatId: '-100other' })]) {
      expect(a.scope).toBe('')
      expect(a.reply).toBeNull()
      expect(a.windowable).toBe(false)
    }
  })

  it('a member-forwarded message: no author, the forwarder recorded beside it (D4)', () => {
    const a = addr({ isForwarded: true })
    expect(a.authorId).toBeNull()
    expect(a.forwarderId).toBe('2')
    expect(a.windowable).toBe(true)
  })

  it("another bot's post: quarantined — never attributed, never windowed (it still has a scope)", () => {
    const a = addr({ fromId: 777, isBot: true })
    expect(a).toMatchObject({ scope: HOUSE, authorId: null, forwarderId: null, windowable: false })
  })

  it('an anonymous-admin post: house text, windowed, never attributed to the shared bot id (I8)', () => {
    const a = addr({ fromId: 1087968824, isBot: true, senderChatId: HOUSE })
    expect(a).toMatchObject({ scope: HOUSE, authorId: null, forwarderId: null, windowable: true })
    expect(addr({ fromId: 1087968824, isBot: true, senderChatId: HOUSE, isForwarded: true })).toMatchObject({ authorId: null, forwarderId: null })
  })
})
