import { describe, it, expect, vi } from 'vitest'

const gen = vi.fn(async (_a: unknown) => ({ object: { op: 'calendar_add', title: 'Dinner with Anna', date: '2026-10-03', startTime: '19:00' } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (a: unknown) => gen(a) }
})

const { extractOlympicsOp } = await import('@/lib/ai/olympics-extract')

describe('extractOlympicsOp', () => {
  it('returns the op + slots, having shown the model the calendar table and the message as fenced data', async () => {
    const r = await extractOlympicsOp('add dinner with Anna Saturday 19:00', 'Ryan', { at: new Date('2026-10-01T16:00:00Z'), tz: 'Europe/Berlin' })
    expect(r).toMatchObject({ op: 'calendar_add', date: '2026-10-03', startTime: '19:00' })
    const prompt = (gen.mock.calls[0][0] as { prompt: string }).prompt
    expect(prompt).toContain('SPEAKER: Ryan')
    expect(prompt).toContain('Sat 2026-10-03')
    expect(prompt).toContain('<<<\nadd dinner with Anna Saturday 19:00\n>>>')
  })

  it('is BEST-EFFORT: a malformed object degrades to not-an-Olympics-op', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError'))
    await expect(extractOlympicsOp('I took the trash out')).resolves.toEqual({ op: 'none' })
    err.mockRestore()
  })

  it('a transient provider error rethrows so the step retries (I2)', async () => {
    gen.mockRejectedValueOnce(new Error('overloaded'))
    await expect(extractOlympicsOp('I took the trash out')).rejects.toThrow('overloaded')
  })
})
