import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APICallError, NoObjectGeneratedError } from 'ai'

// The hygiene sweep's one LLM step (spec §7, F12): the model PROPOSES which candidate pairs name the
// same thing; code keeps only the indexes it offered. Malformed → no merges; transient → rethrow.
const gen = vi.fn(async (_a?: unknown): Promise<{ object: { same: number[] } }> => ({ object: { same: [] } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0]) }
})

const { proposeEntityMerges } = await import('@/lib/ai/dedupe')

const PAIRS = [
  { a: 'washing machine', b: 'washer', kind: 'thing' },
  { a: 'front door', b: 'back door', kind: 'place' },
]

beforeEach(() => {
  gen.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('proposeEntityMerges', () => {
  it('keeps only indexes it offered (out-of-range dropped) and each at most once', async () => {
    gen.mockResolvedValue({ object: { same: [0, 0, 2, 7] } })
    expect(await proposeEntityMerges(PAIRS)).toEqual([0])
    const { prompt } = gen.mock.calls[0][0] as { prompt: string }
    expect(prompt).toContain('[0] "washing machine" vs "washer" (thing)') // the names go in as quoted data
  })

  it('no candidate pairs → no model call', async () => {
    expect(await proposeEntityMerges([])).toEqual([])
    expect(gen).not.toHaveBeenCalled()
  })

  it('a malformed object → no merges this run (never a crash)', async () => {
    gen.mockRejectedValue(
      new NoObjectGeneratedError({
        message: 'No object generated: response did not match schema.',
        text: '{"same":"yes"}',
        response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      }),
    )
    expect(await proposeEntityMerges(PAIRS)).toEqual([])
  })

  it('a transient provider error rethrows (the cron retries)', async () => {
    gen.mockRejectedValue(new APICallError({ message: 'Overloaded', url: 'u', requestBodyValues: {}, statusCode: 529, isRetryable: true }))
    await expect(proposeEntityMerges(PAIRS)).rejects.toThrow(/Overloaded/)
  })
})
