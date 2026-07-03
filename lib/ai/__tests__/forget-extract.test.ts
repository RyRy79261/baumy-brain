import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { isForget: true, values: ['Madeleine Goujon'], subject: 'Madeleine', attribute: 'full name', permanent: true } }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }) }
})

const { extractForget } = await import('@/lib/ai/forget-extract')

describe('extractForget', () => {
  it('passes the SPEAKER so first-person forget targets resolve', async () => {
    const r = await extractForget('delete my full name', 'Madeleine')
    expect(captured.prompt).toContain('SPEAKER: Madeleine')
    expect(captured.system).toContain('DELETE/FORGET/REMOVE')
    expect(r.isForget).toBe(true)
    expect(r.permanent).toBe(true)
    expect(r.values).toContain('Madeleine Goujon') // exact value strings, not a fuzzy description
    expect(r.attribute).toBe('full name')
  })

  it('is BEST-EFFORT: a malformed object degrades to not-a-forget, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError'))
    await expect(extractForget('forget this')).resolves.toEqual({ isForget: false, values: [], subject: '', attribute: '', permanent: false })
    err.mockRestore()
  })
})
