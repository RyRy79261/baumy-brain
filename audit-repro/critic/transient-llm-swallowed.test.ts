import { describe, it, expect, vi } from 'vitest'
import { APICallError } from 'ai'

// Critic repro: a TRANSIENT provider error (429 / overloaded / timeout) is swallowed by every
// hot-path extractor exactly like a malformed object, so the degraded default is RETURNED (and the
// enclosing Inngest step memoizes it) — Inngest's retries: 3 never re-run the LLM call.
const gen = vi.fn(async (_a?: unknown): Promise<never> => {
  throw new APICallError({ message: 'Overloaded', url: 'https://api.anthropic.com', requestBodyValues: {}, statusCode: 529, isRetryable: true })
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as never) }
})

const { classify } = await import('@/lib/ai/classify')
const { extractReminder } = await import('@/lib/ai/reminder-extract')
const { extractFacts } = await import('@/lib/ai/extract')
const { extractListOp } = await import('@/lib/ai/list-extract')

describe('transient LLM errors are converted into permanent silent degradation', () => {
  it('classify returns SAFE_VERDICT (chatter/ignore/list none) instead of throwing', async () => {
    const v = await classify('remind us to put the bins out friday 8pm')
    expect(v.intent).toBe('chatter') // reminder intent lost -> decision never "reminder"
    expect(v.respond).toBe('ignore') // undirected question -> silence
    expect(v.list).toBe('none') // "buy milk" in a DM -> list op lost
  })
  it('extractReminder returns not-a-reminder instead of throwing', async () => {
    const r = await extractReminder('remind us to put the bins out friday 8pm')
    expect(r.isReminder).toBe(false)
  })
  it('extractFacts returns [] instead of throwing (and nothing ever re-extracts later)', async () => {
    const r = await extractFacts('Zuzka is staying in my room this weekend', 'Charli')
    expect(r.facts).toEqual([])
  })
  it('extractListOp returns none instead of throwing', async () => {
    const r = await extractListOp('buy oat milk')
    expect(r.op).toBe('none')
  })
})
