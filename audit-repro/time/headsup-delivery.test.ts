// AUDIT REPRO (time/dates): event heads-ups bake a relative lead ("tomorrow") into the text at scan
// time, but are only DELIVERED by the 08:00/20:00 digest — so a "day before" nudge for an evening
// event lands on the event day, in the same message as the "today" nudge.
import { describe, it, expect, vi } from 'vitest'

const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({ sendToHouse: (...a: unknown[]) => sendToHouse(...a) }))
vi.mock('@/lib/ai/nudge', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/nudge')>()),
  writeHeadsUp: async (f: { subject: string }[], lead: string, when: string) => `${f[0].subject} party ${lead} (${when})`,
}))
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64')

const { makeTestDb } = await import('@/lib/memory/__tests__/pglite')
const { ensureRegistered } = await import('@/lib/memory/write')
const { reconcileFact } = await import('@/lib/memory/facts')
const { runEventSurfacingScan } = await import('@/lib/inngest/functions/surfacing')
const { deliverDueReminders } = await import('@/lib/inngest/functions/reminders')

const GROUP = '-100headsup'
const TZ = 'Europe/Berlin'

describe('heads-up delivery timing', () => {
  it('Saturday 22:00 event: the "tomorrow" nudge and the "today" nudge are posted together on Saturday 08:00', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    // "Party at Marco's saturday 10pm" -> event_at Sat 3 Oct 22:00 Berlin (20:00Z)
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'marco', subjectKind: 'person', predicate: 'hosting_party', object: 'saturday 10pm' },
      authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-10-03T20:00:00Z'),
    })
    await runEventSurfacingScan(db, GROUP, new Date('2026-10-01T06:00:00Z'), TZ) // Thu 08:00 Berlin

    // Friday 20:00 digest: the "day before" stage (Fri 22:00) is not yet due -> nothing
    expect((await deliverDueReminders(db, new Date('2026-10-02T18:00:00Z'))).sent).toBe(0)
    // Saturday 08:00 digest (the event day): both stages fire in ONE message
    const r = await deliverDueReminders(db, new Date('2026-10-03T06:00:00Z'))
    expect(r.sent).toBe(2)
    const body = String(sendToHouse.mock.calls.at(-1)![1])
    expect(body).toContain('marco party tomorrow (Sat 3 Oct)') // posted ON Sat 3 Oct
    expect(body).toContain('marco party today (Sat 3 Oct)')
  })
})
