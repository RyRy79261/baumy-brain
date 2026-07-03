import { describe, it, expect, vi, beforeEach } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { facts: [{ subject: "charl's room", predicate: 'houses', object: 'zuzana' }] } }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }) }
})

const { extractFacts } = await import('@/lib/ai/extract')

beforeEach(() => gen.mockClear()) // call counts are asserted per-test

describe('extractFacts — speaker-aware (resolves first person)', () => {
  it('passes the SPEAKER into the prompt, and the system tells it to resolve "my"', async () => {
    await extractFacts('Zuzana is staying in my room', 'Charl')
    expect(captured.prompt).toContain('SPEAKER: Charl')
    expect(captured.prompt).toContain('staying in my room')
    expect(captured.system).toContain('RESOLVE every first-person reference')
  })

  it('defaults the speaker label when unknown', async () => {
    await extractFacts('bins go out tuesday')
    expect(captured.prompt).toContain('SPEAKER: a housemate')
  })

  const facts = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ subject: `${prefix}${i}`, predicate: 'p', object: `o${i}` }))

  it('an ordinary message finishes in ONE pass (no needless probe)', async () => {
    gen.mockResolvedValueOnce({ object: { facts: facts('s', 3) } })
    const out = await extractFacts('rent due friday')
    expect(out.facts).toHaveLength(3)
    expect(gen).toHaveBeenCalledTimes(1) // 3 < PROBE_AGAIN → drained immediately
  })

  // Regression + the real ask: NO cap. A schema `.max(8)` once made generateObject THROW
  // (AI_NoObjectGeneratedError) and crash-looped capture. Now a dense message paginates
  // until drained and EVERY fact is kept — no ceiling.
  it('learns EVERYTHING from a dense message — paginates until drained, no cap', async () => {
    gen
      .mockResolvedValueOnce({ object: { facts: facts('a', 14) } }) // full page → probe again
      .mockResolvedValueOnce({ object: { facts: [] } }) // nothing left → drained
    const out = await extractFacts('a huge house-intro dump with lots of facts')
    expect(out.facts).toHaveLength(14)
    expect(gen).toHaveBeenCalledTimes(2)
  })

  it('accumulates across many full pages and dedups repeats', async () => {
    gen
      .mockResolvedValueOnce({ object: { facts: facts('a', 12) } }) // full → probe
      .mockResolvedValueOnce({ object: { facts: facts('b', 12) } }) // full → probe
      .mockResolvedValueOnce({ object: { facts: [{ subject: 'a0', predicate: 'p', object: 'o0' }, { subject: 'c1', predicate: 'p', object: 'o1' }] } }) // a0 dup + 1 new, short → stop
    const out = await extractFacts('50-fact monster message')
    expect(out.facts).toHaveLength(25) // 12 + 12 + 1 fresh (a0 deduped)
    expect(gen).toHaveBeenCalledTimes(3)
  })

  it('is BEST-EFFORT: keeps partial progress if a later page fails, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen
      .mockResolvedValueOnce({ object: { facts: facts('s', 12) } }) // full → probe
      .mockRejectedValueOnce(new Error('model hiccup mid-pagination'))
    const out = await extractFacts('dense then a hiccup')
    expect(out.facts).toHaveLength(12) // pass 1 kept despite pass 2 failing
    err.mockRestore()
  })

  it('degrades to no facts if the very first pass fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('schema mismatch / model hiccup'))
    await expect(extractFacts('anything at all')).resolves.toEqual({ facts: [] })
    err.mockRestore()
  })
})
