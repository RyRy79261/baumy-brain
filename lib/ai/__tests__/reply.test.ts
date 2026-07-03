import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { reply: 'MOCK REPLY', answered: true, needsStrongerModel: false } }
})
const genText = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { text: 'PLAIN FALLBACK' }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }),
    generateText: (...a: unknown[]) => genText(a[0] as { prompt?: string; system?: string }),
  }
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
    const out = await groundedReply('when do the bins go out', [mem('the bins go out friday', '100')])
    expect(out.text).toBe('MOCK REPLY')
    expect(out.escalate).toBe(false)
    expect(captured.prompt).toContain('the bins go out friday')
    expect(captured.prompt).toContain('from 100')
    expect(captured.system).toContain('NEVER invent')
  })

  it('honest-miss: empty memory yields an explicit no-memory block', async () => {
    await groundedReply('anything on the landlord?', [])
    expect(captured.prompt).toContain('(no relevant memory found)')
  })

  it('surfaces the answered signal (knows vs. miss)', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'friday', answered: true, needsStrongerModel: false } })
    expect((await groundedReply('when are the bins out', [mem('bins friday', '1')])).answered).toBe(true)
    gen.mockResolvedValueOnce({ object: { reply: 'no idea, never come up', answered: false, needsStrongerModel: false } })
    expect((await groundedReply('what is the door code', [])).answered).toBe(false)
  })

  it('never drops the reply: malformed object → plain-text fallback', async () => {
    // the exact prod failure — the model wraps the object, so schema validation throws.
    gen.mockRejectedValueOnce(new Error('No object generated: response did not match schema'))
    const out = await groundedReply('who is coming to visit', [mem('jessie oct 13-20', '100')])
    expect(out.text).toBe('PLAIN FALLBACK')
    expect(out.escalate).toBe(false)
    expect(genText).toHaveBeenCalled()
    expect(captured.system).not.toContain('"reply"') // text-mode system, no object fields
  })
})

describe('answer — self-advising escalation ladder (Sonnet → Opus)', () => {
  it('starts on Sonnet and bumps to Opus when the model asks for one', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'over my head', answered: false, needsStrongerModel: true } }) // Sonnet
    gen.mockResolvedValueOnce({ object: { reply: 'FINAL', answered: true, needsStrongerModel: false } }) // Opus
    const r = await answer('a hard one', [])
    expect(r.text).toBe('FINAL')
    expect(r.usedTier).toBe('advisor') // escalated Sonnet → Opus
  })

  it('answers on Sonnet without escalating when it does not need to', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'got it', answered: true, needsStrongerModel: false } })
    const r = await answer('an easy one', [])
    expect(r.text).toBe('got it')
    expect(r.usedTier).toBe('reply') // stayed on Sonnet
  })

  it('caps at Opus even if it keeps asking', async () => {
    gen.mockResolvedValue({ object: { reply: 'still want more', answered: false, needsStrongerModel: true } })
    const r = await answer('impossible', [])
    expect(r.usedTier).toBe('advisor') // Sonnet → Opus, then stop
    gen.mockReset()
  })
})
