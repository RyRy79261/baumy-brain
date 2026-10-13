import { describe, it, expect, vi } from 'vitest'

const gen = vi.fn(async (): Promise<{ object: Record<string, unknown> }> => ({ object: { op: 'add', items: ['milk', 'bin bags'] } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(...(a as [])) }
})

const { extractListOp, listExtraction } = await import('@/lib/ai/list-extract')
const { EXTRACT_LIST_SYSTEM } = await import('@/lib/ai/prompts')

describe('extractListOp', () => {
  it('returns the structured op + items', async () => {
    const r = await extractListOp('buy milk and bin bags')
    expect(r.op).toBe('add')
    expect(r.items).toEqual(['milk', 'bin bags'])
  })

  // Issue #23: the new ops parse; a rename carries from → to pairs (text only — code matches the row).
  it('parses a remove and a rename', async () => {
    gen.mockResolvedValueOnce({ object: { op: 'remove', items: ['bin bags'] } })
    expect(await extractListOp('take bin bags off the list')).toEqual({ op: 'remove', items: ['bin bags'] })
    gen.mockResolvedValueOnce({ object: { op: 'rename', items: [], renames: [{ from: 'mlik', to: 'milk' }] } })
    expect(await extractListOp('change mlik to milk')).toEqual({ op: 'rename', items: [], renames: [{ from: 'mlik', to: 'milk' }] })
  })

  it('the schema the model is held to accepts the new ops and rejects anything else', () => {
    expect(listExtraction.safeParse({ op: 'remove', items: ['milk'] }).success).toBe(true)
    expect(listExtraction.safeParse({ op: 'rename', items: [], renames: [{ from: 'mlik', to: 'milk' }] }).success).toBe(true)
    expect(listExtraction.safeParse({ op: 'delete', items: ['milk'] }).success).toBe(false)
    expect(listExtraction.safeParse({ op: 'rename', items: [], renames: [{ from: 'mlik' }] }).success).toBe(false)
  })

  it('the prompt teaches remove and rename, and keeps the injection wall', () => {
    expect(EXTRACT_LIST_SYSTEM).toMatch(/"remove"/)
    expect(EXTRACT_LIST_SYSTEM).toMatch(/"rename"/)
    expect(EXTRACT_LIST_SYSTEM).toMatch(/change mlik to milk/)
    expect(EXTRACT_LIST_SYSTEM).toMatch(/untrusted DATA/)
  })

  it('is BEST-EFFORT: a malformed object degrades to not-a-list-op, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError'))
    // must NOT crash-loop ingest — degrade to op:'none' so the message falls through.
    await expect(extractListOp('buy milk')).resolves.toEqual({ op: 'none', items: [] })
    err.mockRestore()
  })
})
