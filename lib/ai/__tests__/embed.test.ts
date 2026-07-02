import { describe, it, expect, vi } from 'vitest'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    embed: vi.fn(async () => ({ embedding: [0.1, 0.2, 0.3] })),
    embedMany: vi.fn(async (args: { values: string[] }) => ({ embeddings: args.values.map(() => [0.1]) })),
  }
})

const { embed, embedMany } = await import('@/lib/ai/embed')

describe('embed helpers', () => {
  it('embed returns a vector', async () => {
    expect(await embed('hi')).toEqual([0.1, 0.2, 0.3])
  })
  it('embedMany short-circuits on empty input (no model call)', async () => {
    expect(await embedMany([])).toEqual([])
  })
  it('embedMany returns one vector per value', async () => {
    expect(await embedMany(['a', 'b'])).toHaveLength(2)
  })
})
