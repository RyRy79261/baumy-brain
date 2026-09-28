import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { auditLog, houseConfig, pendingActions } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { deactivateMember, setDmChatId, upsertMember } from '@/lib/identity/roster'
import { setOlympicsTransport } from '@/lib/olympics/client'

// "Sign in with Baumy" (docs/spec/olympics.md §Sign-in approval): the kitchen-token endpoint that DMs
// the member the number card, and the tap that answers Olympics as that member. PGlite for the
// database; Telegram and Olympics are mocked.

const dbh: { db: any } = { db: null }
const sendLoginApprovalCard = vi.fn(async (..._a: unknown[]) => {})
const answerCallback = vi.fn(async (..._a: unknown[]) => {})
const editMessageText = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/telegram/client', () => ({
  sendLoginApprovalCard: (...a: unknown[]) => sendLoginApprovalCard(...a),
  answerCallback: (...a: unknown[]) => answerCallback(...a),
  editMessageText: (...a: unknown[]) => editMessageText(...a),
}))
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, createFunction: (_a: unknown, _b: unknown, h: unknown) => h } }
})

const { POST } = await import('@/app/api/kitchen/login-approval/route')
const { loginCardText, parseLoginTap } = await import('@/lib/olympics/login-approval')
const { handleCallbackQuery } = (await import('@/lib/inngest/functions/callback')) as unknown as {
  handleCallbackQuery: (ctx: { event: { data: Record<string, unknown> }; step: unknown }) => Promise<Record<string, unknown>>
}

const TOKEN = 'kitchen-token-0123456789abcdef'
const HOUSE = '-100loginhouse'
const RYAN = 4242
const SAM = 4343
const REQUEST_ID = '0b0e6c1a-3a7e-4c38-9a53-6f1f3f0d2a11'
const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() }

type Seen = { url: string; headers: Headers; body: Record<string, unknown> }
let seen: Seen[] = []
let olympicsAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, data: { outcome: 'approved', device: 'Safari on iPad' } } }

const body = (over: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  telegramUserId: RYAN,
  device: 'Safari on iPad',
  choices: [12, 30, 47, 65, 83],
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  ...over,
})
const post = (b: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  POST(
    new Request('http://local/api/kitchen/login-approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: typeof b === 'string' ? b : JSON.stringify(b),
    }),
  )
const tap = (fromId: number, data: string) =>
  handleCallbackQuery({ event: { data: { callbackId: 'cb', fromId, chatId: String(fromId), messageId: 9, data } }, step })

async function cardId(): Promise<string> {
  const res = await post(body())
  expect(await res.json()).toEqual({ ok: true, sent: true })
  const [row] = await dbh.db.select().from(pendingActions)
  return row.id
}

beforeEach(async () => {
  vi.stubEnv('KITCHEN_API_TOKEN', TOKEN)
  vi.stubEnv('BAUMY_HOUSE_CHAT_ID', '')
  vi.stubEnv('OLYMPICS_BASE_URL', 'https://www.baumy.tech')
  vi.stubEnv('BRAIN_SERVICE_TOKEN', 'svc-token-0123456789abcdef0123456789')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dbh.db = await makeTestDb()
  const { __setDbOverride } = await import('@/db/client')
  __setDbOverride(dbh.db)
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
  await upsertMember(dbh.db, HOUSE, String(RYAN), 'Ryan', 'member')
  await upsertMember(dbh.db, HOUSE, String(SAM), 'Sam', 'member')
  sendLoginApprovalCard.mockClear()
  sendLoginApprovalCard.mockImplementation(async () => {})
  answerCallback.mockClear()
  editMessageText.mockClear()
  seen = []
  olympicsAnswer = { status: 200, body: { ok: true, data: { outcome: 'approved', device: 'Safari on iPad' } } }
  setOlympicsTransport(async (url, init) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(olympicsAnswer.body), { status: olympicsAnswer.status, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(async () => {
  setOlympicsTransport(null)
  const { __setDbOverride } = await import('@/db/client')
  __setDbOverride(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/kitchen/login-approval', () => {
  it('DMs the named member the numbers and Deny, as a card only they can resolve', async () => {
    const id = await cardId()
    const [row] = await dbh.db.select().from(pendingActions)
    expect(row).toMatchObject({
      groupId: HOUSE,
      actionType: 'olympics.login',
      requestedBy: String(RYAN),
      status: 'pending',
      payload: { requestId: REQUEST_ID, choices: [12, 30, 47, 65, 83], device: 'Safari on iPad' },
    })
    // To their own DM (their Telegram id is their private chat), never the group.
    expect(sendLoginApprovalCard).toHaveBeenCalledWith(String(RYAN), expect.stringContaining('Safari on iPad'), id, [12, 30, 47, 65, 83])
    expect(String(sendLoginApprovalCard.mock.calls[0]![1])).toContain('Tap the number on the screen')
  })

  it('uses the DM chat Baumy captured on /start when there is one', async () => {
    await setDmChatId(dbh.db, String(RYAN), '98765')
    await cardId()
    expect(sendLoginApprovalCard.mock.calls[0]![0]).toBe('98765')
  })

  it('sends nothing for an unknown or departed member, or an expired request', async () => {
    await deactivateMember(dbh.db, String(SAM))
    for (const b of [body({ telegramUserId: 999 }), body({ telegramUserId: SAM }), body({ expiresAt: new Date(Date.now() - 1000).toISOString() })]) {
      const res = await post(b)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, sent: false })
    }
    expect(sendLoginApprovalCard).not.toHaveBeenCalled()
    expect(await dbh.db.select().from(pendingActions)).toEqual([])
  })

  it('answers sent: false when Telegram refuses the DM', async () => {
    sendLoginApprovalCard.mockImplementation(async () => {
      throw new Error('Forbidden: bot can\'t initiate conversation with a user')
    })
    expect(await (await post(body())).json()).toEqual({ ok: true, sent: false })
  })

  it('refuses a wrong token, a bad body, and answers 503 before a house', async () => {
    expect((await post(body(), 'Bearer nope')).status).toBe(401)
    expect((await post(body(), null)).status).toBe(401)
    for (const b of ['x', body({ choices: [12, 12, 47, 65, 83] }), body({ choices: [1, 30, 47, 65, 83] }), body({ choices: [12, 47, 83] }), body({ requestId: 'r' }), body({ device: '' })]) {
      expect((await post(b)).status).toBe(400)
    }
    await dbh.db.delete(houseConfig)
    expect((await post(body())).status).toBe(503)
    expect(sendLoginApprovalCard).not.toHaveBeenCalled()
  })
})

describe('the tap', () => {
  it('sends the tapped number to Olympics as approve_login, as the member, confirmed, once', async () => {
    const id = await cardId()
    const res = await tap(RYAN, `l:${id}:47`)
    expect(res).toMatchObject({ login: 'approve_login', olympics: 'approved' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://www.baumy.tech/api/v1/actions/approve_login')
    expect(seen[0]!.body).toEqual({ requestId: REQUEST_ID, code: 47 })
    expect(seen[0]!.headers.get('x-baumy-actor')).toBe(`tg:${RYAN}`)
    expect(seen[0]!.headers.get('x-baumy-confirmed')).toBe('1')
    expect(seen[0]!.headers.get('idempotency-key')).toBe(`login-${id}-47`)
    expect(editMessageText).toHaveBeenLastCalledWith(String(RYAN), 9, '✅ Signed in on Safari on iPad.')
    const [audit] = await dbh.db.select().from(auditLog).where(eq(auditLog.action, 'olympics.login'))
    expect(audit).toBeTruthy()
    // A second tap: the card is spent.
    expect(await tap(RYAN, `l:${id}:47`)).toEqual({ ignored: 'not-pending' })
    expect(seen).toHaveLength(1)
  })

  it('says a decoy blocked the sign-in', async () => {
    olympicsAnswer = { status: 200, body: { ok: true, data: { outcome: 'blocked', device: 'Safari on iPad' } } }
    const id = await cardId()
    await tap(RYAN, `l:${id}:12`)
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toContain("wasn't the number on the screen")
  })

  it('never lets anyone else answer, and ignores a number that was not on the card', async () => {
    const id = await cardId()
    expect(await tap(SAM, `l:${id}:47`)).toEqual({ ignored: 'not-requester' })
    expect(await tap(RYAN, `l:${id}:99`)).toMatchObject({ ignored: 'bad-data' })
    expect(await tap(RYAN, `l:${id}:x`)).toEqual({ ignored: 'bad-data' })
    // Neither spent the card.
    expect((await dbh.db.select().from(pendingActions))[0].status).toBe('pending')
    expect(await tap(RYAN, `c:${id}`)).toEqual({ ignored: 'bad-data' })
    // Not even a crafted Confirm spends it: the member can still answer.
    expect((await dbh.db.select().from(pendingActions))[0].status).toBe('pending')
    expect(await tap(RYAN, `l:${id}:47`)).toMatchObject({ login: 'approve_login' })
    expect(await tap(9999, `l:${id}:47`)).toEqual({ ignored: 'not-member' })
    expect(seen).toHaveLength(1)
  })

  it('sends Deny as deny_login', async () => {
    olympicsAnswer = { status: 200, body: { ok: true, data: { outcome: 'denied', device: 'Safari on iPad' } } }
    const id = await cardId()
    const res = await tap(RYAN, `x:${id}`)
    expect(res).toMatchObject({ login: 'deny_login', olympics: 'denied' })
    expect(seen[0]!.url).toBe('https://www.baumy.tech/api/v1/actions/deny_login')
    expect(seen[0]!.body).toEqual({ requestId: REQUEST_ID })
    expect(editMessageText).toHaveBeenLastCalledWith(String(RYAN), 9, '✖️ Denied the sign-in on Safari on iPad. Sign in with Baumy is off for you for 15 minutes; your password still works.')
  })

  it("shows Olympics' refusal, and puts the card back when Olympics does not answer", async () => {
    olympicsAnswer = { status: 422, body: { ok: false, code: 'INVALID_STATE', message: 'That sign-in request expired.' } }
    const id = await cardId()
    await tap(RYAN, `l:${id}:47`)
    expect(editMessageText).toHaveBeenLastCalledWith(String(RYAN), 9, '⚠️ That sign-in request expired.')

    await dbh.db.delete(pendingActions)
    const again = await cardId()
    olympicsAnswer = { status: 503, body: { ok: false, code: 'UNAVAILABLE', message: 'x' } }
    const res = await tap(RYAN, `l:${again}:47`)
    expect(res).toMatchObject({ olympics: 'unavailable', reopened: true })
    const [row] = await dbh.db.select().from(pendingActions)
    expect(row.status).toBe('pending')
  })

  it('a Deny Olympics did not hear still reads as denied, never as expired or not done', async () => {
    olympicsAnswer = { status: 503, body: { ok: false, code: 'UNAVAILABLE', message: 'x' } }
    const id = await cardId()
    const res = await tap(RYAN, `x:${id}`)
    expect(res).toMatchObject({ login: 'deny_login', olympics: 'unavailable', reopened: false })
    const [row] = await dbh.db.select().from(pendingActions)
    expect(row.status).toBe('cancelled')
    const [, , text] = editMessageText.mock.lastCall as unknown as [string, number, string]
    expect(text).toMatch(/^🚫 Denied/)
    expect(text).not.toMatch(/expired|Not done/)
  })
})

describe('helpers', () => {
  it('parses a number tap', () => {
    expect(parseLoginTap(`l:${REQUEST_ID}:47`)).toEqual({ actionId: REQUEST_ID, code: 47 })
    expect(parseLoginTap(`l:${REQUEST_ID}:7`)).toBeNull()
    expect(parseLoginTap(`c:${REQUEST_ID}`)).toBeNull()
  })

  it('names the device and the time in the house timezone', () => {
    vi.stubEnv('BAUMY_TIMEZONE', 'Europe/Berlin')
    expect(loginCardText('Chrome on macOS', new Date('2026-09-28T10:05:00Z'))).toContain('on Chrome on macOS at 12:05?')
  })
})
