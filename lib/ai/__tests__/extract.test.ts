import { describe, it, expect, vi } from 'vitest'

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

  // Regression: an intro dump legitimately yields 12+ facts. A schema `.max(8)` made
  // generateObject THROW (AI_NoObjectGeneratedError), crash-looping capture so Baumy
  // learned nothing. Now the cap is a code-side slice and extraction is best-effort.
  it('keeps a rich message with many facts (no hard array cap) instead of throwing', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ subject: `s${i}`, predicate: 'p', object: `o${i}`, subjectKind: 'person' as const }))
    gen.mockResolvedValueOnce({ object: { facts: many } })
    const out = await extractFacts('big house intro with lots of facts')
    expect(out.facts).toHaveLength(14)
  })

  it('caps a runaway/adversarial spew at MAX_FACTS via slice (not a throw)', async () => {
    const spew = Array.from({ length: 50 }, (_, i) => ({ subject: `s${i}`, predicate: 'p', object: `o${i}` }))
    gen.mockResolvedValueOnce({ object: { facts: spew } })
    const out = await extractFacts('spam')
    expect(out.facts).toHaveLength(30)
  })

  it('is BEST-EFFORT: an extraction failure degrades to no facts and NEVER throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('schema mismatch / model hiccup'))
    await expect(extractFacts('anything at all')).resolves.toEqual({ facts: [] })
    err.mockRestore()
  })
})
