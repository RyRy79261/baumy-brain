import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string; tools?: Record<string, unknown> } = {}
const genText = vi.fn(async (args: { prompt?: string; system?: string; tools?: Record<string, unknown> }) => {
  captured = args
  return { text: 'Roztoc 2026 runs Aug 14–17 in Prague; tickets open in May.' }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: (...a: unknown[]) => genText(a[0] as never) }
})

const { webSearchAnswer } = await import('@/lib/ai/websearch')

describe('webSearchAnswer — Anthropic server-side web search, gated + best-effort', () => {
  it('attaches the web_search tool, blends house memory, and returns the answer', async () => {
    const r = await webSearchAnswer('look up the roztoc festival dates', [{ content: 'the house loves flow arts', authoredBy: 'Ryan' }])
    expect(r.searched).toBe(true)
    expect(r.text).toContain('Roztoc')
    expect(captured.tools).toHaveProperty('web_search') // Anthropic web search attached
    expect(captured.prompt).toContain('roztoc festival dates') // the question
    expect(captured.prompt).toContain('the house loves flow arts') // memory blended in
    expect(captured.system).toContain('search the web')
  })

  it('is BEST-EFFORT: on tool/model error it returns searched:false so the caller falls back', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    genText.mockRejectedValueOnce(new Error('web search unavailable'))
    await expect(webSearchAnswer('search the web for X')).resolves.toEqual({ text: '', searched: false })
    err.mockRestore()
  })

  it('treats an empty result as not-searched (memory-only fallback)', async () => {
    genText.mockResolvedValueOnce({ text: '   ' })
    expect(await webSearchAnswer('search for nothing')).toEqual({ text: '', searched: false })
  })
})
