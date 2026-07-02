import { describe, it, expect } from 'vitest'
import { prefilter } from '@/lib/pipeline/prefilter'

describe('prefilter — high-precision noise drop', () => {
  it('drops pure noise', () => {
    for (const n of ['ok', 'okay', 'lol', 'haha', 'thanks', 'ty', 'yep', 'nope', '👍', '🔥', '.']) {
      expect(prefilter(n).keep, n).toBe(false)
    }
  })

  it('KEEPS memory-worthy short messages (never over-drops)', () => {
    for (const m of ['rent fri', 'code 4821', 'wifi is baumy123', 'Tom arrives sat', 'bins thursday']) {
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
