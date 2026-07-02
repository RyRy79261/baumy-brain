import { describe, it, expect } from 'vitest'
import { isDirectedAtBaumy } from '@/lib/pipeline/directed'

describe('isDirectedAtBaumy', () => {
  it('true when addressed by name or @mention', () => {
    expect(isDirectedAtBaumy('hey baumy are you around?', false)).toBe(true)
    expect(isDirectedAtBaumy('@Baumy when is rent due', false)).toBe(true)
    expect(isDirectedAtBaumy('BAUMY, remember the code', false)).toBe(true)
  })

  it('true when replying to Baumy, regardless of text', () => {
    expect(isDirectedAtBaumy('ok thanks', true)).toBe(true)
  })

  it('false for undirected chatter', () => {
    expect(isDirectedAtBaumy('rent is due friday', false)).toBe(false)
    expect(isDirectedAtBaumy('baumyish vibes', false)).toBe(false) // substring, not a mention
    expect(isDirectedAtBaumy(null, false)).toBe(false)
  })
})
