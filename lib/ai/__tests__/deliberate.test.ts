import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string } = {}
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn(async (args: { prompt?: string }) => {
      captured = args
      return { text: 'DELIBERATE OUTPUT' }
    }),
  }
})

const { deliberate } = await import('@/lib/ai/deliberate')

describe('deliberate — the deliberative path runner', () => {
  it('runs the task prompt on the deliberative model and returns text', async () => {
    const out = await deliberate('find hardware stores near us with weekend specials')
    expect(out).toBe('DELIBERATE OUTPUT')
    expect(captured.prompt).toContain('hardware stores')
  })
})
