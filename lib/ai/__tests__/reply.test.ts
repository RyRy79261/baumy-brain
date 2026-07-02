import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { reply: 'MOCK REPLY', needsStrongerModel: false } }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }) }
})

const { groundedReply, answer } = await import('@/lib/ai/reply')

const mem = (content: string, authoredBy: string | null) => ({
  id: '1',
  content,
  memoryType: 'fact',
  authoredBy,
  similarity: 0.9,
  isSecure: false,
  contentEncrypted: null,
})

describe('groundedReply — retrieval-grounded, tool-less, self-assessing', () => {
  it('feeds retrieved memory into the prompt + returns text and escalate', async () => {
    const out = await groundedReply('when is rent due', [mem('rent is due friday', '100')])
    expect(out.text).toBe('MOCK REPLY')
    expect(out.escalate).toBe(false)
    expect(captured.prompt).toContain('rent is due friday')
    expect(captured.prompt).toContain('from 100')
    expect(captured.system).toContain('NEVER invent')
  })

  it('honest-miss: empty memory yields an explicit no-memory block', async () => {
    await groundedReply('anything on the landlord?', [])
    expect(captured.prompt).toContain('(no relevant memory found)')
  })
})

describe('answer — self-advising escalation ladder (Haiku → Sonnet → Opus)', () => {
  it('bumps to a stronger model when a model asks for one', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'over my head', needsStrongerModel: true } }) // Haiku
    gen.mockResolvedValueOnce({ object: { reply: 'FINAL', needsStrongerModel: false } }) // Sonnet
    const r = await answer('a hard one', [], 'quick')
    expect(r.text).toBe('FINAL')
    expect(r.usedTier).toBe('assess') // escalated Haiku → Sonnet
  })

  it('caps at Opus even if it keeps asking', async () => {
    gen.mockResolvedValue({ object: { reply: 'still want more', needsStrongerModel: true } })
    const r = await answer('impossible', [], 'quick')
    expect(r.usedTier).toBe('advisor') // Haiku → Sonnet → Opus, then stop
    gen.mockReset()
  })
})
