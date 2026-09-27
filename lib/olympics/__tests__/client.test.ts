import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callOlympicsAction, listOlympicsActions, mapResponse, olympicsConfigured, setOlympicsTransport } from '@/lib/olympics/client'
import { captureOutbound } from '@/lib/telegram/outbox'

// The Olympics client (docs/spec/olympics.md): the headers it sends, the result union it maps every
// answer to, and that it never throws into the bot. The transport is mocked — no network.

const URL_ = 'https://olympics.example'
const TOKEN = 'svc-token-0123456789abcdef0123456789'
const saved = { url: process.env.OLYMPICS_BASE_URL, token: process.env.BRAIN_SERVICE_TOKEN }

type Seen = { url: string; init: RequestInit; headers: Headers }
let seen: Seen[] = []
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const answer = (status: number, body: unknown) =>
  setOlympicsTransport(async (url, init) => {
    seen.push({ url, init, headers: new Headers(init.headers) })
    return json(status, body)
  })

beforeEach(() => {
  process.env.OLYMPICS_BASE_URL = `${URL_}/`
  process.env.BRAIN_SERVICE_TOKEN = TOKEN
  seen = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setOlympicsTransport(null)
  vi.restoreAllMocks()
  for (const [k, v] of [
    ['OLYMPICS_BASE_URL', saved.url],
    ['BRAIN_SERVICE_TOKEN', saved.token],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('callOlympicsAction — the request', () => {
  it('POSTs the input to /api/v1/actions/{name} with the bearer token, the actor and the idempotency key', async () => {
    answer(200, { ok: true, data: { event: { id: 'e1' } } })
    const r = await callOlympicsAction('create_event', { title: 'Dinner' }, { actor: 703, idempotencyKey: 'brain-abc12345', confirmed: true })
    expect(r).toEqual({ ok: true, data: { event: { id: 'e1' } } })
    const [s] = seen
    expect(s.url).toBe(`${URL_}/api/v1/actions/create_event`) // trailing slash of the base stripped
    expect(s.init.method).toBe('POST')
    expect(JSON.parse(String(s.init.body))).toEqual({ title: 'Dinner' })
    expect(s.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(s.headers.get('X-Baumy-Actor')).toBe('tg:703')
    expect(s.headers.get('Idempotency-Key')).toBe('brain-abc12345')
    expect(s.headers.get('X-Baumy-Confirmed')).toBe('1')
    expect(s.headers.get('Content-Type')).toBe('application/json')
    expect(s.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends X-Baumy-Confirmed ONLY when confirmed, and no Idempotency-Key for a read', async () => {
    answer(200, { ok: true, data: {} })
    await callOlympicsAction('list_chores', {}, { actor: '703' })
    await callOlympicsAction('create_event', {}, { actor: '703', idempotencyKey: 'brain-abc12345', confirmed: false })
    expect(seen[0].headers.has('X-Baumy-Confirmed')).toBe(false)
    expect(seen[0].headers.has('Idempotency-Key')).toBe(false)
    expect(seen[1].headers.has('X-Baumy-Confirmed')).toBe(false)
  })

  it('refuses locally (no request) a bad actor, key or action name', async () => {
    answer(200, { ok: true, data: {} })
    expect(await callOlympicsAction('list_chores', {}, { actor: 'tg:1' })).toMatchObject({ kind: 'refused', code: 'INVALID_INPUT' })
    expect(await callOlympicsAction('create_event', {}, { actor: 1, idempotencyKey: 'short' })).toMatchObject({ kind: 'refused', code: 'INVALID_INPUT' })
    expect(await callOlympicsAction('../admin', {}, { actor: 1 })).toMatchObject({ kind: 'refused', code: 'INVALID_INPUT' })
    expect(seen).toHaveLength(0)
  })
})

describe('callOlympicsAction — never throws, always a result', () => {
  it('not configured without OLYMPICS_BASE_URL or BRAIN_SERVICE_TOKEN (and no request)', async () => {
    answer(200, { ok: true, data: {} })
    delete process.env.BRAIN_SERVICE_TOKEN
    expect(olympicsConfigured()).toBe(false)
    expect(await callOlympicsAction('whoami', {}, { actor: 1 })).toEqual({ ok: false, kind: 'not_configured' })
    process.env.BRAIN_SERVICE_TOKEN = TOKEN
    process.env.OLYMPICS_BASE_URL = 'not a url'
    expect(await callOlympicsAction('whoami', {}, { actor: 1 })).toEqual({ ok: false, kind: 'not_configured' })
    expect(seen).toHaveLength(0)
  })

  it('a network error or a timeout is unavailable', async () => {
    setOlympicsTransport(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await callOlympicsAction('whoami', {}, { actor: 1 })).toEqual({ ok: false, kind: 'unavailable' })
    // A transport that only ends when the 5s-style signal aborts it.
    setOlympicsTransport(
      (_url, init) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))),
    )
    expect(await callOlympicsAction('whoami', {}, { actor: 1, timeoutMs: 20 })).toEqual({ ok: false, kind: 'unavailable' })
  })

  it('a non-JSON 502 is unavailable', async () => {
    setOlympicsTransport(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    expect(await callOlympicsAction('whoami', {}, { actor: 1 })).toEqual({ ok: false, kind: 'unavailable', status: 502 })
  })

  it('the token is never logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setOlympicsTransport(async () => {
      throw new Error(`boom ${TOKEN}`)
    })
    await callOlympicsAction('whoami', {}, { actor: 1 })
    answer(401, { ok: false, code: 'UNAUTHENTICATED', message: 'no' })
    await callOlympicsAction('whoami', {}, { actor: 1 })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
  })

  it('inside the sandbox (captured sends) it never reaches the network without a test transport', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = await captureOutbound(() => callOlympicsAction('whoami', {}, { actor: 1 }))
    expect(result).toEqual({ ok: false, kind: 'not_configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('mapResponse — error mapping', () => {
  it('200 {ok:true} is ok; a 200 of the wrong shape is unavailable', () => {
    expect(mapResponse(200, { ok: true, data: 1 })).toEqual({ ok: true, body: { ok: true, data: 1 } })
    expect(mapResponse(200, { data: 1 })).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(mapResponse(200, null)).toMatchObject({ ok: false, kind: 'unavailable' })
  })
  it('401 means brain is not set up for Olympics', () => {
    expect(mapResponse(401, { ok: false, code: 'UNAUTHENTICATED', message: 'x' })).toEqual({ ok: false, kind: 'not_configured' })
  })
  it('a domain refusal keeps its code and the person-facing message', () => {
    expect(mapResponse(403, { ok: false, code: 'TELEGRAM_NOT_LINKED', message: 'Link first.' })).toEqual({
      ok: false,
      kind: 'refused',
      status: 403,
      code: 'TELEGRAM_NOT_LINKED',
      message: 'Link first.',
    })
    expect(mapResponse(422, { ok: false, code: 'COOLDOWN', message: 'Too soon.', retryAt: '2026-10-01T20:00:00Z' })).toMatchObject({
      kind: 'refused',
      code: 'COOLDOWN',
      retryAt: '2026-10-01T20:00:00Z',
    })
    expect(mapResponse(429, { ok: false, code: 'RATE_LIMITED', message: 'Slow down.', retryAfterSeconds: 30 })).toMatchObject({
      kind: 'refused',
      retryAfterSeconds: 30,
    })
    expect(mapResponse(428, { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Confirm.' })).toMatchObject({ kind: 'refused', code: 'CONFIRMATION_REQUIRED' })
    // Google Calendar not set up in Olympics: a refusal with a message to show, not a retry.
    expect(mapResponse(503, { ok: false, code: 'NOT_CONFIGURED', message: 'Calendar is not set up.' })).toMatchObject({ kind: 'refused', code: 'NOT_CONFIGURED' })
  })
  it('transient answers are unavailable (retry with the same key)', () => {
    expect(mapResponse(409, { ok: false, code: 'IN_PROGRESS', message: 'Still running.' })).toMatchObject({ kind: 'unavailable', status: 409 })
    expect(mapResponse(503, { ok: false, code: 'UNAVAILABLE', message: 'x' })).toMatchObject({ kind: 'unavailable' })
    expect(mapResponse(500, { ok: false, code: 'INTERNAL', message: 'x' })).toMatchObject({ kind: 'unavailable' })
  })
})

describe('listOlympicsActions', () => {
  it('GETs the tool list with the token and no actor', async () => {
    answer(200, { ok: true, actions: [{ name: 'whoami', description: 'd', input_schema: {}, kind: 'read', risk: 'safe' }, { junk: true }] })
    const r = await listOlympicsActions()
    expect(r).toEqual({ ok: true, data: [{ name: 'whoami', description: 'd', input_schema: {}, kind: 'read', risk: 'safe' }] })
    expect(seen[0].url).toBe(`${URL_}/api/v1/actions`)
    expect(seen[0].init.method).toBe('GET')
    expect(seen[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(seen[0].headers.has('X-Baumy-Actor')).toBe(false)
  })
})
