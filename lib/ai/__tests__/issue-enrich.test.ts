import { describe, it, expect, vi } from 'vitest'

const gen = vi.fn(async (_a?: unknown) => ({
  object: { type: 'bug', title: 'Rent reminder fires twice', summary: 'The rent reminder fired twice in one evening.', stepsToReproduce: ['set a rent reminder', 'wait for it'], severity: 'medium' },
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateObject: (...a: unknown[]) => gen(a[0] as never) }
})

const { enrichIssue, formatIssueBody } = await import('@/lib/ai/issue-enrich')

describe('enrichIssue + formatIssueBody', () => {
  it('returns the structured, faithful issue', async () => {
    const e = await enrichIssue('the rent reminder fired twice', 'bug')
    expect(e.type).toBe('bug')
    expect(e.title).toContain('twice')
  })

  it('formats a markdown body with steps + reporter attribution', () => {
    const body = formatIssueBody(
      { type: 'bug', title: 'x', summary: 'A summary.', stepsToReproduce: ['first', 'second'], expected: 'E', actual: 'A', severity: 'high' },
      'Ryan',
    )
    expect(body).toContain('A summary.')
    expect(body).toContain('### Steps to reproduce')
    expect(body).toContain('1. first')
    expect(body).toContain('### Expected')
    expect(body).toContain('Reported by Ryan via Baumy')
  })

  it('is BEST-EFFORT: a model failure falls back to a plain template (never lost)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    gen.mockRejectedValueOnce(new Error('model hiccup'))
    const e = await enrichIssue('the thing is totally broken', 'bug')
    expect(e.type).toBe('bug')
    expect(e.title).toContain('broken')
    expect(e.summary).toContain('broken')
    err.mockRestore()
  })
})
