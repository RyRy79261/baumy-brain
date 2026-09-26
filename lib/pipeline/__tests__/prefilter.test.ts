import { describe, it, expect } from 'vitest'
import { prefilter } from '@/lib/pipeline/prefilter'

describe('prefilter — high-precision noise drop', () => {
  it('drops pure noise', () => {
    for (const n of ['ok', 'okay', 'lol', 'haha', 'thanks', 'ty', 'yep', 'nope', '👍', '🔥', '.']) {
      expect(prefilter(n).keep, n).toBe(false)
    }
  })

  it('KEEPS memory-worthy short messages (never over-drops)', () => {
    for (const m of ['recycling fri', 'code 4821', 'wifi is baumy123', 'Tom arrives sat', 'bins thursday']) {
      expect(prefilter(m).keep, m).toBe(true)
    }
  })

  it('always keeps bot commands', () => {
    expect(prefilter('/dashboard').keep).toBe(true)
    expect(prefilter('/dashboard').reason).toBe('command')
  })

  it('drops empty / whitespace / null', () => {
    expect(prefilter('').keep).toBe(false)
    expect(prefilter('   ').keep).toBe(false)
    expect(prefilter(null).keep).toBe(false)
    expect(prefilter(undefined).keep).toBe(false)
  })
})

describe('prefilter — an answer TO Baumy is never noise (C7)', () => {
  it('keeps "yes"/"no"/"ok"/👍 when the message is directed at Baumy (a reply to it, @-addressed, console topic)', () => {
    for (const n of ['yes', 'no', 'ok', 'nope', '👍']) {
      expect(prefilter(n, { directed: true }).keep, n).toBe(true)
      expect(prefilter(n, { directed: true }).reason).toBe('answer')
    }
  })
  it('keeps them in a member DM (a 1:1 chat is addressed to Baumy)', () => {
    for (const n of ['yes', 'ok', 'thanks']) expect(prefilter(n, { dm: true }).keep, n).toBe(true)
  })
  it('still drops them as undirected group chatter, and still drops empty text everywhere', () => {
    expect(prefilter('yes', { directed: false, dm: false }).keep).toBe(false)
    expect(prefilter('   ', { directed: true }).keep).toBe(false)
  })
})
