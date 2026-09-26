import { describe, it, expect, vi } from 'vitest'
import { APICallError } from 'ai'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { isCancel: true, target: 'bins' } }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }) }
})

const { extractReminderCancel } = await import('@/lib/ai/reminder-cancel-extract')

describe('extractReminderCancel', () => {
  it('passes the SPEAKER and fences the message as data', async () => {
    const r = await extractReminderCancel('stop the bins reminder', 'Ryan')
    expect(captured.prompt).toContain('SPEAKER: Ryan')
    expect(captured.prompt).toContain('<<<\nstop the bins reminder\n>>>')
    expect(captured.system).toContain('STOP or CANCEL a reminder')
    expect(r).toEqual({ isCancel: true, target: 'bins' })
  })

  it('is BEST-EFFORT: a malformed object degrades to not-a-cancel, never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('AI_NoObjectGeneratedError: No object generated'))
    await expect(extractReminderCancel('stop it')).resolves.toEqual({ isCancel: false, target: '' })
    err.mockRestore()
  })

  it('a transient provider error RETHROWS so the step retries (I2)', async () => {
    gen.mockRejectedValueOnce(new APICallError({ message: 'Overloaded', url: 'x', requestBodyValues: {}, statusCode: 529, isRetryable: true }))
    await expect(extractReminderCancel('stop the bins reminder')).rejects.toThrow(/Overloaded/)
  })
})
