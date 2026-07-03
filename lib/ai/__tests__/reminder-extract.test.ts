import { describe, it, expect, vi } from 'vitest'

const gen = vi.fn(async () => ({ object: { isReminder: true, whenText: 'in 3 days', content: 'take the bins out' } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(...(a as [])) }
})

const { extractReminder } = await import('@/lib/ai/reminder-extract')

describe('extractReminder', () => {
  it('returns the structured reminder slots', async () => {
    const r = await extractReminder('remind us to take the bins out in 3 days')
    expect(r.isReminder).toBe(true)
    expect(r.whenText).toBe('in 3 days')
    expect(r.content).toBe('take the bins out')
  })

  it('is BEST-EFFORT: a malformed object degrades to not-a-reminder, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError'))
    await expect(extractReminder('remind us to buy milk tomorrow')).resolves.toEqual({ isReminder: false, whenText: '', content: '' })
    err.mockRestore()
  })
})
