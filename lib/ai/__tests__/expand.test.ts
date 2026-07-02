import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { variants: ['  when is the sink fixed  ', 'tap repair status', ''], hypothetical: 'the kitchen sink was fixed on tuesday' } }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }) }
})

const { expandQuery } = await import('@/lib/ai/expand')

describe('expandQuery — paraphrases + HyDE probes', () => {
  it('flattens variants + hypothetical, trims, and drops blanks', async () => {
    const probes = await expandQuery('is the sink sorted')
    expect(probes).toEqual(['when is the sink fixed', 'tap repair status', 'the kitchen sink was fixed on tuesday'])
    expect(captured.prompt).toContain('is the sink sorted')
    expect(captured.system).toContain('HyDE')
  })
})
