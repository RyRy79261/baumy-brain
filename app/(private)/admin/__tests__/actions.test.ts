import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig } from '@/db/schema'
import { loadResponsePolicy } from '@/lib/policy'

// The dashboard's pause switch (house settings): turning Baumy back ON also asks for a shopping-topic
// repost, so the list posted there is not stale after changes made while paused (issue #21).
const dbh: { db: any } = { db: null }
vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/auth/require-admin', () => ({ requireAdmin: async () => ({ uid: '100' }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
const inngestSend = vi.fn(async (..._a: unknown[]) => ({ ids: [] as string[] }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }))

const { setPolicyEnabledAction } = await import('@/app/(private)/admin/actions')
const HOUSE = '-100dash'

const form = (enabled: boolean) => {
  const f = new FormData()
  if (enabled) f.set('enabled', 'on')
  return f
}

describe('setPolicyEnabledAction — resume reposts the shopping list', () => {
  beforeEach(async () => {
    dbh.db = await makeTestDb()
    await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
    vi.stubEnv('BAUMY_HOUSE_CHAT_ID', '')
    inngestSend.mockClear()
  })

  it('switching OFF asks for nothing; switching back ON asks for a repost of the house list', async () => {
    await setPolicyEnabledAction(form(false))
    expect((await loadResponsePolicy(dbh.db)).global_enabled).toBe(false)
    expect(inngestSend).not.toHaveBeenCalled()
    await setPolicyEnabledAction(form(true))
    expect((await loadResponsePolicy(dbh.db)).global_enabled).toBe(true)
    expect(inngestSend).toHaveBeenCalledTimes(1)
    expect(inngestSend.mock.calls[0][0]).toEqual({ name: 'lists/shopping.changed', data: { groupId: HOUSE } })
  })
})
