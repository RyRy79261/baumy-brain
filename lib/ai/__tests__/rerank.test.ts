import { describe, it, expect, vi } from 'vitest'

let scores: { i: number; score: number }[] = []
const gen = vi.fn(async () => ({ object: { scores } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: () => gen() }
})

const { rerank } = await import('@/lib/ai/rerank')

const mem = (id: string, content: string) => ({
  id,
  content,
  memoryType: 'fact',
  authoredBy: null,
  similarity: 0.5,
  isSecure: false,
  contentEncrypted: null,
})

describe('rerank — deep-tier pointwise relevance reorder', () => {
  it('reorders by the judged score (best first)', async () => {
    scores = [
      { i: 0, score: 0.1 },
      { i: 1, score: 0.9 },
      { i: 2, score: 0.5 },
    ]
    const out = await rerank('q', [mem('a', 'A'), mem('b', 'B'), mem('c', 'C')])
    expect(out.map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('short-circuits (no model call) for 0 or 1 items', async () => {
    gen.mockClear()
    expect(await rerank('q', [])).toEqual([])
    const one = [mem('a', 'A')]
    expect(await rerank('q', one)).toBe(one)
    expect(gen).not.toHaveBeenCalled()
  })

  it('an unscored item sinks to the bottom but is preserved', async () => {
    scores = [{ i: 0, score: 0.8 }] // item 1 unscored → defaults to 0
    const out = await rerank('q', [mem('a', 'A'), mem('b', 'B')])
    expect(out.map((m) => m.id)).toEqual(['a', 'b'])
    expect(out).toHaveLength(2)
  })
})
