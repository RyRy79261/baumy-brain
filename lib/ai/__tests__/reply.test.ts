import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(async (args: { prompt?: string; system?: string }) => {
      captured = args
      return { text: 'MOCK REPLY' }
    }),
  }
})

const { groundedReply } = await import('@/lib/ai/reply')

describe('groundedReply — retrieval-grounded, tool-less', () => {
  it('feeds retrieved memory into the prompt', async () => {
    const out = await groundedReply('when is rent due', [
      { id: '1', content: 'rent is due friday', memoryType: 'fact', authoredBy: '100', similarity: 0.9 },
    ])
    expect(out).toBe('MOCK REPLY')
    expect(captured.prompt).toContain('rent is due friday')
    expect(captured.prompt).toContain('from 100')
  })

  it('honest-miss: empty memory yields an explicit no-memory block + forbids invention', async () => {
    await groundedReply('anything on the landlord?', [])
    expect(captured.prompt).toContain('(no relevant memory found)')
    expect(captured.system).toContain('NEVER invent')
  })
})
