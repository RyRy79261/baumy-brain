import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GrammyError } from 'grammy'

// K6: an unknown DM sender is checked against Telegram's membership of the house group — fail-closed,
// a definite "no" cached so a stranger costs one Bot API call per window.
const getChatMemberStatus = vi.fn(async (..._a: unknown[]): Promise<{ status: string; isMember: boolean } | null> => null)
vi.mock('@/lib/telegram/client', () => ({ getChatMemberStatus: (...a: unknown[]) => getChatMemberStatus(...a) }))
const { checkHouseMembership, clearMembershipCache } = await import('@/lib/identity/verify')

const HOUSE = '-100verify'

describe('checkHouseMembership', () => {
  beforeEach(() => {
    clearMembershipCache()
    getChatMemberStatus.mockReset()
  })

  it('an active member (incl. a restricted one still in the group) is a member; left/kicked is not', async () => {
    getChatMemberStatus.mockResolvedValueOnce({ status: 'member', isMember: true })
    expect(await checkHouseMembership(HOUSE, 1)).toBe('member')
    getChatMemberStatus.mockResolvedValueOnce({ status: 'restricted', isMember: true })
    expect(await checkHouseMembership(HOUSE, 2)).toBe('member')
    getChatMemberStatus.mockResolvedValueOnce({ status: 'left', isMember: false })
    expect(await checkHouseMembership(HOUSE, 3)).toBe('not_member')
  })

  it('a "no" is cached for a while (one call), then asked again', async () => {
    getChatMemberStatus.mockResolvedValue({ status: 'kicked', isMember: false })
    const t = 1_000_000
    expect(await checkHouseMembership(HOUSE, 4, t)).toBe('not_member')
    expect(await checkHouseMembership(HOUSE, 4, t + 60_000)).toBe('not_member')
    expect(getChatMemberStatus).toHaveBeenCalledTimes(1)
    await checkHouseMembership(HOUSE, 4, t + 11 * 60_000)
    expect(getChatMemberStatus).toHaveBeenCalledTimes(2)
  })

  it('"user not found" is a definite no; any other error FAILS CLOSED and is not cached', async () => {
    getChatMemberStatus.mockRejectedValueOnce(new GrammyError('x', { ok: false, error_code: 400, description: 'Bad Request: user not found' }, 'getChatMember', {}))
    expect(await checkHouseMembership(HOUSE, 5)).toBe('not_member')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getChatMemberStatus.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    expect(await checkHouseMembership(HOUSE, 6)).toBe('error')
    getChatMemberStatus.mockResolvedValueOnce({ status: 'member', isMember: true })
    expect(await checkHouseMembership(HOUSE, 6)).toBe('member') // not cached → asked again
    warn.mockRestore()
  })

  it('no house configured → never a member', async () => {
    expect(await checkHouseMembership('', 7)).toBe('not_member')
    expect(getChatMemberStatus).not.toHaveBeenCalled()
  })
})
