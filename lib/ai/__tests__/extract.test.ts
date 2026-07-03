import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { facts: [{ subject: "felix's room", predicate: 'houses', object: 'zofia' }] } }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }) }
})

const { extractFacts } = await import('@/lib/ai/extract')

describe('extractFacts — speaker-aware (resolves first person)', () => {
  it('passes the SPEAKER into the prompt, and the system tells it to resolve "my"', async () => {
    await extractFacts('Zofia is staying in my room', 'Felix')
    expect(captured.prompt).toContain('SPEAKER: Felix')
    expect(captured.prompt).toContain('staying in my room')
    expect(captured.system).toContain('RESOLVE every first-person reference')
  })

  it('defaults the speaker label when unknown', async () => {
    await extractFacts('bins go out tuesday')
    expect(captured.prompt).toContain('SPEAKER: a housemate')
  })
})
