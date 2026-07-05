import { describe, it, expect } from 'vitest'
import { resolveOriginParts, type Roster } from '@/lib/core/origin'
import { houseScopeForOrigin } from '@/lib/identity/house'

// The scope seam that lets a member DM read/write the HOUSE's shared memory while the reply
// goes to the private chat. The load-bearing security property: scope is derived from the
// authenticated LANE, never from the inbound chat id — so a DM can't be pointed elsewhere.
const HOUSE = '-1001234567890'
const roster: Roster = { isOwner: (id) => id === 100, isMember: (id) => id === 100 || id === 200 }

describe('houseScopeForOrigin', () => {
  it('house-group message scopes to the house', () => {
    const o = resolveOriginParts({ chatId: HOUSE, fromId: 100, text: 'x', isPrivate: false }, roster, HOUSE)
    expect(o.lane).toBe('house')
    expect(houseScopeForOrigin(o, HOUSE)).toBe(HOUSE)
  })

  it('member DM scopes to the HOUSE, not the private chat (reads/writes shared memory)', () => {
    const o = resolveOriginParts({ chatId: '200', fromId: 200, text: 'when is bin day', isPrivate: true }, roster, HOUSE)
    expect(o.lane).toBe('member_dm')
    expect(o.chatId).toBe('200') // the DM chat — where a reply is SENT
    // ...but the SCOPE is the house, never the DM chat id. This decoupling is the feature.
    expect(houseScopeForOrigin(o, HOUSE)).toBe(HOUSE)
    expect(houseScopeForOrigin(o, HOUSE)).not.toBe(o.chatId)
  })

  it('an out-of-scope origin (unknown DM sender) has NO house scope — reads/writes nothing', () => {
    const o = resolveOriginParts({ chatId: '999', fromId: 999, text: 'x', isPrivate: true }, roster, HOUSE)
    expect(o.lane).toBe('ignore')
    expect(houseScopeForOrigin(o, HOUSE)).toBe('')
  })
})
