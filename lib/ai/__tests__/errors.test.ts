import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APICallError, NoObjectGeneratedError, TypeValidationError } from 'ai'

// I2: only a MALFORMED object may degrade to a safe default. A transient provider error (429 /
// 529 overloaded / timeout) must propagate, so the enclosing Inngest step fails and RETRIES
// instead of memoizing a degraded value forever (an outage used to silently lose every reminder,
// list op and fact posted during it).
const gen = vi.fn(async (_a?: unknown): Promise<never> => {
  throw new Error('unset')
})
const genText = vi.fn(async (_a?: unknown): Promise<never> => {
  throw new Error('unset')
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0]), generateText: (...a: unknown[]) => genText(a[0]) }
})
vi.mock('@/lib/memory/retrieve', () => ({ retrieve: vi.fn(async () => []) }))

const { isMalformedObjectError, isPermanentProviderError } = await import('@/lib/ai/errors')
const { classify } = await import('@/lib/ai/classify')
const { extractFacts } = await import('@/lib/ai/extract')
const { extractReminder } = await import('@/lib/ai/reminder-extract')
const { extractListOp } = await import('@/lib/ai/list-extract')
const { extractForget } = await import('@/lib/ai/forget-extract')
const { enrichIssue } = await import('@/lib/ai/issue-enrich')
const { writeHeadsUp } = await import('@/lib/ai/nudge')
const { webSearchAnswer } = await import('@/lib/ai/websearch')

const overloaded = () =>
  new APICallError({ message: 'Overloaded', url: 'https://api.anthropic.com', requestBodyValues: {}, statusCode: 529, isRetryable: true })
const malformed = () =>
  new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    text: '{"verdict":{}}',
    response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })

// Every best-effort LLM call site, with how to invoke it and what its safe default looks like.
const SITES: { name: string; text?: boolean; call: () => Promise<unknown>; safe: (r: unknown) => void }[] = [
  { name: 'classify', call: () => classify('remind us to put the bins out friday 8pm'), safe: (r) => expect((r as { intent: string }).intent).toBe('chatter') },
  { name: 'extractFacts', call: () => extractFacts('Zuzka is staying in my room this weekend', 'Charli'), safe: (r) => expect(r).toEqual({ facts: [] }) },
  { name: 'extractReminder', call: () => extractReminder('remind us friday'), safe: (r) => expect((r as { isReminder: boolean }).isReminder).toBe(false) },
  { name: 'extractListOp', call: () => extractListOp('buy oat milk'), safe: (r) => expect((r as { op: string }).op).toBe('none') },
  { name: 'extractForget', call: () => extractForget('forget the door code', 'Charli'), safe: (r) => expect((r as { isForget: boolean }).isForget).toBe(false) },
  { name: 'enrichIssue', call: () => enrichIssue('the reminder fired twice', 'bug'), safe: (r) => expect((r as { title: string }).title).toContain('twice') },
  { name: 'writeHeadsUp', text: true, call: () => writeHeadsUp([{ subject: 'zuzka', predicate: 'arrives_on', object: 'sat' }], 'tomorrow', 'Sat 27 Sep'), safe: (r) => expect(r).toBeNull() },
  { name: 'webSearchAnswer', text: true, call: () => webSearchAnswer('look up the festival dates'), safe: (r) => expect(r).toEqual({ text: '', searched: false }) },
]

beforeEach(() => {
  gen.mockReset()
  genText.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('isMalformedObjectError', () => {
  it('recognises the SDK schema failures (by class and by message)', () => {
    expect(isMalformedObjectError(malformed())).toBe(true)
    expect(isMalformedObjectError(new TypeValidationError({ value: {}, cause: new Error('bad') }))).toBe(true)
    expect(isMalformedObjectError(new Error('AI_NoObjectGeneratedError'))).toBe(true)
    expect(isMalformedObjectError(new Error('schema mismatch'))).toBe(true)
  })
  it('does NOT treat transport / provider failures as malformed', () => {
    expect(isMalformedObjectError(overloaded())).toBe(false)
    expect(isMalformedObjectError(new Error('fetch failed'))).toBe(false)
    expect(isMalformedObjectError(new Error('model hiccup'))).toBe(false)
    expect(isMalformedObjectError('boom')).toBe(false)
  })
  it('isPermanentProviderError: a non-retryable 4xx only (never 429/5xx)', () => {
    const e = (statusCode: number, isRetryable: boolean) => new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode, isRetryable })
    expect(isPermanentProviderError(e(400, false))).toBe(true)
    expect(isPermanentProviderError(e(429, true))).toBe(false)
    expect(isPermanentProviderError(e(529, true))).toBe(false)
    expect(isPermanentProviderError(new Error('x'))).toBe(false)
  })
})

describe('a TRANSIENT provider error propagates (so Inngest retries the step)', () => {
  for (const s of SITES) {
    it(`${s.name} rethrows a 529 overloaded`, async () => {
      ;(s.text ? genText : gen).mockRejectedValue(overloaded())
      await expect(s.call()).rejects.toThrow(/Overloaded/)
    })
  }
})

describe('a MALFORMED object still degrades to the safe default (never crash-loops ingest)', () => {
  for (const s of SITES) {
    it(`${s.name} degrades`, async () => {
      ;(s.text ? genText : gen).mockRejectedValue(malformed())
      s.safe(await s.call())
    })
  }
})

describe('web search: a PERMANENT refusal falls back to the memory reply (retrying cannot help)', () => {
  it('a 400 (tool not enabled) → searched:false', async () => {
    genText.mockRejectedValue(new APICallError({ message: 'tool not enabled', url: 'u', requestBodyValues: {}, statusCode: 400, isRetryable: false }))
    expect(await webSearchAnswer('look it up')).toEqual({ text: '', searched: false })
  })
})

// A generateText enrichment with a deterministic fallback: a permanent refusal (prompt too long as
// memory grows, auth, model gone) falls back instead of burning retries and sending nothing.
describe('text enrichments: a PERMANENT refusal falls back; a transient error still rethrows', () => {
  const refused = () => new APICallError({ message: 'prompt is too long', url: 'u', requestBodyValues: {}, statusCode: 400, isRetryable: false })
  it('textFallbackAllowed: malformed or permanent only', async () => {
    const { textFallbackAllowed } = await import('@/lib/ai/errors')
    expect(textFallbackAllowed(refused())).toBe(true)
    expect(textFallbackAllowed(malformed())).toBe(true)
    expect(textFallbackAllowed(overloaded())).toBe(false)
    expect(textFallbackAllowed(new Error('fetch failed'))).toBe(false)
  })
  it('writeHeadsUp → null (schedules nothing) on a 400', async () => {
    genText.mockRejectedValue(refused())
    expect(await writeHeadsUp([{ subject: 'zuzka', predicate: 'arrives_on', object: 'sat' }], 'tomorrow', 'Sat 27 Sep')).toBeNull()
  })
})
