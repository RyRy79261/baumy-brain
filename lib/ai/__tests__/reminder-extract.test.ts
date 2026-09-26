import { describe, it, expect, vi } from 'vitest'

const gen = vi.fn(async (_a: { prompt: string }) => ({
  object: {
    reminders: [
      { content: 'defrost the chicken', fireAt: '2026-09-24T17:00', whenText: 'at 5', recurrence: '', forWhom: 'speaker' },
      { content: 'put it in the oven', fireAt: '2026-09-24T19:00', whenText: 'at 7', recurrence: '', forWhom: 'speaker' },
    ],
  },
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (a: { prompt: string }) => gen(a) }
})

const { extractReminder } = await import('@/lib/ai/reminder-extract')

describe('extractReminder (spec §6)', () => {
  it('returns every reminder in the message, each with its resolved fireAt, phrase, rule and owner (A6)', async () => {
    const r = await extractReminder('remind me at 5 to defrost the chicken and at 7 to put it in the oven', 'Chloe', null, {
      at: new Date('2026-09-24T12:00:00Z'),
      tz: 'Europe/Berlin',
    })
    expect(r.reminders).toHaveLength(2)
    expect(r.reminders[0]).toMatchObject({ content: 'defrost the chicken', fireAt: '2026-09-24T17:00', forWhom: 'speaker' })
  })

  it('is told who is speaking, when the message was sent, and the calendar table (T4/T9)', async () => {
    await extractReminder('remind us friday around 10pm to let Zosia in', 'Marco', null, { at: new Date('2026-09-23T08:30:00Z'), tz: 'Europe/Berlin' })
    const prompt = gen.mock.calls.at(-1)![0].prompt
    expect(prompt).toContain('SPEAKER: Marco')
    expect(prompt).toContain('MESSAGE SENT: Wed 23 Sep 2026 10:30 Europe/Berlin')
    expect(prompt).toContain('Fri 2026-09-25')
    expect(prompt).toMatch(/<<<\nremind us friday around 10pm to let Zosia in\n>>>/)
  })

  it('is BEST-EFFORT: a malformed object degrades to no reminders, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError'))
    await expect(extractReminder('remind us to buy milk tomorrow')).resolves.toEqual({ reminders: [] })
    err.mockRestore()
  })
})
