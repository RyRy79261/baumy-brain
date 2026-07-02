import { describe, it, expect, vi } from 'vitest'

// Mock the AI SDK's generateObject so no live model call / API key is needed.
const gen = vi.fn(async (_args?: unknown) => ({
  object: {
    worthRemembering: true,
    intent: 'fact',
    needsReply: false,
    confidence: 0.88,
    respond: 'react',
    reaction: '👍',
    tier: 'quick',
  },
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as never) }
})

const { classify } = await import('@/lib/ai/classify')

describe('classify (triage + router)', () => {
  it('returns the validated verdict incl. the response plan + model tier', async () => {
    const v = await classify('rent is due friday')
    expect(v.intent).toBe('fact')
    expect(v.worthRemembering).toBe(true)
    expect(v.confidence).toBeCloseTo(0.88)
    expect(v.respond).toBe('react')
    expect(v.tier).toBe('quick')
  })

  it('never blackholes the pipeline: a malformed object degrades to a safe capture verdict', async () => {
    gen.mockRejectedValueOnce(new Error('No object generated: response did not match schema'))
    const v = await classify('someone might be visiting next week')
    // captured (memory preserved), but silent — a directed message answers via the
    // `directed` path regardless of this verdict.
    expect(v.worthRemembering).toBe(true)
    expect(v.confidence).toBe(0.5)
    expect(v.respond).toBe('ignore')
    expect(v.needsReply).toBe(false)
  })
})
