import { describe, it, expect } from 'vitest'
import { reminderIsPersonal, nameRequester, pickedCategory, listChanged } from '@/lib/turn/actions'

// A4 (phase 3, enforced in code in phase 5): whose reminder is it, and the requester's name comes from
// the authenticated sender — never the model's wording.
describe('reminderIsPersonal', () => {
  const house = (text: string) => ({ text, lane: 'house' as const })
  const dm = (text: string) => ({ text, lane: 'member_dm' as const })
  it("the model's per-entry forWhom decides when given (one message can hold both)", () => {
    expect(reminderIsPersonal('speaker', house('remind us all'))).toBe(true)
    expect(reminderIsPersonal('house', house('remind me at 6 and remind everyone at 7'))).toBe(false)
  })
  it('without it: a literal "remind me" is personal, and anything asked in a DM', () => {
    expect(reminderIsPersonal(undefined, house('@baumy remind me to call the plumber'))).toBe(true)
    expect(reminderIsPersonal(undefined, house('@baumy remind us to pay rent'))).toBe(false)
    expect(reminderIsPersonal(undefined, dm('call mum at 6'))).toBe(true)
  })
  it('nameRequester prefixes the first name once', () => {
    expect(nameRequester('call mum', 'Chloe')).toBe('Chloe: call mum')
    expect(nameRequester('Chloe to call mum', 'Chloe')).toBe('Chloe to call mum')
  })
})

// Issue #29: the section a "put X under Y" message named is checked against the FIXED enum by code.
describe('pickedCategory', () => {
  it('a key (any case, trimmed) → that category; "unsorted" → null; anything else → undefined (not a section)', () => {
    expect(pickedCategory('coffee')).toBe('coffee')
    expect(pickedCategory(' Cleaning ')).toBe('cleaning')
    expect(pickedCategory('unsorted')).toBeNull()
    expect(pickedCategory('Not sorted')).toBeNull()
    for (const bad of ['drinks', 'coffees', '', 'pantry, fresh']) expect(pickedCategory(bad)).toBeUndefined()
  })
  it('a category pick counts as a list change (the live list re-renders)', () => {
    const none = { added: [], checkedOff: [], removed: [], renamed: [] }
    expect(listChanged({ ...none, categorized: [{ item: 'x', category: 'coffee' }] })).toBe(true)
    expect(listChanged({ ...none, categorized: [] })).toBe(false)
  })
})
