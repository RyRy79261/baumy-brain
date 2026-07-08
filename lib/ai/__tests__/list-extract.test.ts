import { describe, it, expect, vi } from 'vitest'

const gen = vi.fn(async () => ({ object: { op: 'add', items: ['milk', 'bin bags'] } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(...(a as [])) }
})

const { extractListOp } = await import('@/lib/ai/list-extract')

describe('extractListOp', () => {
  it('returns the structured op + items', async () => {
    const r = await extractListOp('buy milk and bin bags')
    expect(r.op).toBe('add')
    expect(r.items).toEqual(['milk', 'bin bags'])
  })

  it('is BEST-EFFORT: a malformed object degrades to not-a-list-op, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError'))
    // must NOT crash-loop ingest — degrade to op:'none' so the message falls through.
    await expect(extractListOp('buy milk')).resolves.toEqual({ op: 'none', items: [] })
    err.mockRestore()
  })
})
