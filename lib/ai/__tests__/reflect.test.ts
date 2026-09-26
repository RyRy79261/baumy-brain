import { describe, it, expect, vi } from 'vitest'

let lastPrompt = ''
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: async (o: { prompt: string }) => ((lastPrompt = o.prompt), { text: ' A guest. ' }) }
})

const { reflectPerson } = await import('@/lib/ai/reflect')
const { withSimulatedTime } = await import('@/lib/core/clock')

// F11: the synthesis sees WHO said each fact, WHEN, and when a dated one happens — plus TODAY — so a
// dated plan is never baked into a profile as a permanent trait.
describe('reflectPerson prompt', () => {
  it('dates and attributes every fact', async () => {
    const out = await withSimulatedTime(new Date('2026-09-20T10:00:00Z'), () =>
      reflectPerson(
        'zofia',
        [
          { predicate: 'stays_in', value: "chloe's room", by: 'Chloe', saidAt: new Date('2026-09-12T10:00:00Z'), eventAt: new Date('2026-09-25T22:00:00Z'), validTo: new Date('2026-09-27T21:59:59.999Z') },
          { predicate: 'sibling_of', value: 'felix' },
        ],
        [{ text: 'she is lovely', by: 'Ryan' }],
        {} as never,
        'Europe/Berlin',
      ),
    )
    expect(out).toBe('A guest.')
    expect(lastPrompt).toContain('TODAY: 20 Sep 2026')
    expect(lastPrompt).toContain("- stays in: chloe's room (said by Chloe, 12 Sep 2026, happens Sat 26 Sep – Sun 27 Sep)")
    expect(lastPrompt).toContain('- sibling of: felix\n')
    expect(lastPrompt).toContain('- Ryan: she is lovely')
  })
})
