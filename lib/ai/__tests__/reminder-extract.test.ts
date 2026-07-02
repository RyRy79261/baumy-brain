import { describe, it, expect, vi } from 'vitest'

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: vi.fn(async () => ({
      object: { isReminder: true, whenText: 'in 3 days', content: 'pay rent' },
    })),
  }
})

const { extractReminder } = await import('@/lib/ai/reminder-extract')

describe('extractReminder', () => {
  it('returns the structured reminder slots', async () => {
    const r = await extractReminder('remind us to pay rent in 3 days')
    expect(r.isReminder).toBe(true)
    expect(r.whenText).toBe('in 3 days')
    expect(r.content).toBe('pay rent')
  })
})
