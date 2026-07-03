import { describe, it, expect } from 'vitest'
import { isDirectedAtBaumy } from '@/lib/pipeline/directed'

const U = 'baumy_bot' // the bot's real @username (from getMe)

describe('isDirectedAtBaumy', () => {
  it('true for an @mention of the real username (incl. the _bot suffix)', () => {
    expect(isDirectedAtBaumy('@baumy_bot Are you alive', false, U)).toBe(true)
    expect(isDirectedAtBaumy('hey @Baumy_Bot when do the bins go out', false, U)).toBe(true)
  })

  it('true for the short name as a word, and for a reply to the bot', () => {
    expect(isDirectedAtBaumy('hey baumy are you around?', false, U)).toBe(true)
    expect(isDirectedAtBaumy('ok thanks', true, U)).toBe(true) // reply-to-bot
  })

  it('false for undirected chatter or substrings', () => {
    expect(isDirectedAtBaumy('the bins go out friday', false, U)).toBe(false)
    expect(isDirectedAtBaumy('baumyish vibes', false, U)).toBe(false)
    expect(isDirectedAtBaumy(null, false, U)).toBe(false)
    expect(isDirectedAtBaumy('@baumy_bot hi', false, '')).toBe(false) // no username known
  })
})
