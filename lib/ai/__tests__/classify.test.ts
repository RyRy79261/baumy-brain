import { describe, it, expect, vi } from 'vitest'

// Mock the AI SDK's generateObject so no live model call / API key is needed.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: vi.fn(async () => ({
      object: {
        worthRemembering: true,
        intent: 'fact',
        needsReply: false,
        confidence: 0.88,
        respond: 'react',
        reaction: '👍',
        tier: 'quick',
      },
    })),
  }
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
})
