import { isCapturing } from '@/lib/telegram/outbox'

// The Baumy Olympics client (docs/spec/olympics.md; the contract is Olympics'
// docs/brain-integration.md). Olympics owns the house calendar, chores and the season scoreboard;
// Baumy reaches them through its action endpoint:
//
//   GET  {OLYMPICS_BASE_URL}/api/v1/actions          → the tools brain may call (name, schema, risk)
//   POST {OLYMPICS_BASE_URL}/api/v1/actions/{name}   → run one action; the JSON body is its input
//
// Every call carries `Authorization: Bearer BRAIN_SERVICE_TOKEN`; a POST carries `X-Baumy-Actor:
// tg:<telegram id>` (the AUTHENTICATED sender — never text), a write its `Idempotency-Key`, and a
// `confirm`-risk write `X-Baumy-Confirmed: 1` — sent ONLY from the confirm-tap handler, after a
// member's tap (lib/inngest/functions/callback.ts).
//
// It NEVER throws into the bot: every outcome is a result union, a request is cut off after 5s, and
// the token never reaches a log line. With either env var unset every call is `not_configured`, and
// inside the sandbox (captured sends) it never touches the network unless a test transport is set.

export const OLYMPICS_TIMEOUT_MS = 5_000

/** One tool as `GET /api/v1/actions` lists it. */
export interface OlympicsTool {
  name: string
  title?: string
  description: string
  input_schema: Record<string, unknown>
  kind: 'read' | 'write'
  risk: 'safe' | 'confirm' | 'destructive'
}

/** Olympics answered and said no: `message` is a sentence it wrote to be shown to the person. */
export interface OlympicsRefusal {
  ok: false
  kind: 'refused'
  status: number
  code: string
  message: string
  retryAt?: string
  retryAfterSeconds?: number
}

export type OlympicsResult<T> =
  | { ok: true; data: T }
  /** OLYMPICS_BASE_URL / BRAIN_SERVICE_TOKEN unset, or the token was not accepted (401). */
  | { ok: false; kind: 'not_configured' }
  /** Down, timed out, a 5xx, a key still in progress, or an answer of the wrong shape. Safe to retry
   *  with the SAME Idempotency-Key. */
  | { ok: false; kind: 'unavailable'; status?: number }
  | OlympicsRefusal

export interface CallOptions {
  /** The Telegram user Baumy acts for (the authenticated `from.id`). */
  actor: string | number
  /** One per intended action; a retry of the same action MUST resend the same key. Writes only. */
  idempotencyKey?: string
  /** Only after the person tapped the inline confirm button. */
  confirmed?: boolean
  timeoutMs?: number
}

type Transport = (url: string, init: RequestInit) => Promise<Response>

// TEST-ONLY seam (scenarios, unit tests): when set, requests go through it instead of the network —
// even inside the sandbox. Never set in production.
let transportOverride: Transport | null = null
export function setOlympicsTransport(fn: Transport | null): void {
  transportOverride = fn
}

interface Config {
  baseUrl: string
  token: string
}

function config(): Config | null {
  const base = process.env.OLYMPICS_BASE_URL?.trim()
  const token = process.env.BRAIN_SERVICE_TOKEN?.trim()
  if (!base || !token) return null
  // The token rides in a header: HTTPS only, plain HTTP just for a local Olympics.
  let u: URL
  try {
    u = new URL(base)
  } catch {
    return null
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  return { baseUrl: base.replace(/\/+$/, ''), token }
}

/** Is the Olympics integration configured at all (both env vars set)? */
export const olympicsConfigured = (): boolean => config() !== null

// Olympics' own rules for these headers (docs/brain-integration.md §Headers) — checked here too, so a
// bad value is our bug surfaced as a refusal, never a request.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/
const ACTION_NAME = /^[a-z][a-z0-9_]{0,63}$/
const TELEGRAM_ID = /^\d{1,20}$/

const localRefusal = (message: string): OlympicsRefusal => ({ ok: false, kind: 'refused', status: 400, code: 'INVALID_INPUT', message })

/** GET /api/v1/actions — the tools brain may call. */
export async function listOlympicsActions(opts: { timeoutMs?: number } = {}): Promise<OlympicsResult<OlympicsTool[]>> {
  const res = await request('GET', '/api/v1/actions', { headers: {}, timeoutMs: opts.timeoutMs })
  if (!res.ok) return res
  const actions = (res.body as { actions?: unknown }).actions
  if (!Array.isArray(actions)) return unavailable('list: no actions array')
  return { ok: true, data: actions.filter(isTool) }
}

/** POST /api/v1/actions/{name} — run one action for `opts.actor`. */
export async function callOlympicsAction<T = unknown>(name: string, input: Record<string, unknown>, opts: CallOptions): Promise<OlympicsResult<T>> {
  if (!ACTION_NAME.test(name)) return localRefusal(`Unknown action name.`)
  const actor = String(opts.actor)
  if (!TELEGRAM_ID.test(actor)) return localRefusal('No Telegram user to act for.')
  if (opts.idempotencyKey != null && !IDEMPOTENCY_KEY.test(opts.idempotencyKey)) return localRefusal('Bad idempotency key.')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Baumy-Actor': `tg:${actor}` }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  if (opts.confirmed === true) headers['X-Baumy-Confirmed'] = '1'
  const res = await request('POST', `/api/v1/actions/${name}`, { headers, body: JSON.stringify(input ?? {}), timeoutMs: opts.timeoutMs })
  if (!res.ok) return res
  return { ok: true, data: (res.body as { data?: T }).data as T }
}

type Raw = { ok: true; body: Record<string, unknown> } | Exclude<OlympicsResult<never>, { ok: true }>

async function request(method: 'GET' | 'POST', path: string, o: { headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<Raw> {
  const cfg = config()
  if (!cfg) return { ok: false, kind: 'not_configured' }
  // The sandbox (console / scenarios) must never create a real calendar event: without a test
  // transport it is simply "not connected".
  const send: Transport | null = transportOverride ?? (isCapturing() ? null : (url, init) => fetch(url, init))
  if (!send) return { ok: false, kind: 'not_configured' }
  let resp: Response
  try {
    resp = await send(`${cfg.baseUrl}${path}`, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${cfg.token}`, ...o.headers },
      ...(o.body != null ? { body: o.body } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? OLYMPICS_TIMEOUT_MS),
      cache: 'no-store',
      // Never follow a redirect: it would re-send the bearer token somewhere OLYMPICS_BASE_URL did not
      // name, and a 301/302 turns the POST into a GET that silently drops the write. A redirecting
      // base URL (apex → www, http → https) is a setup mistake; it reads as "not answering".
      redirect: 'error',
    })
  } catch (err) {
    // A timeout, DNS failure or refused connection. Never log the request (it holds the token).
    return unavailable(`${method} ${path}: ${err instanceof Error ? err.name : 'network error'}`)
  }
  let body: unknown = null
  try {
    body = await resp.json()
  } catch {
    body = null
  }
  return mapResponse(resp.status, body, `${method} ${path}`)
}

/** Map an HTTP answer to the result union (exported for tests). */
export function mapResponse(status: number, body: unknown, label = 'olympics'): Raw {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (status >= 200 && status < 300) {
    if (b?.ok === true) return { ok: true, body: b }
    return unavailable(`${label}: ${status} with an unexpected body`)
  }
  // The token was not accepted: brain is not (correctly) set up for Olympics — say so, don't retry.
  if (status === 401) {
    console.warn(`[baumy/olympics] ${label}: 401 — BRAIN_SERVICE_TOKEN was not accepted`)
    return { ok: false, kind: 'not_configured' }
  }
  const code = typeof b?.code === 'string' ? b.code : null
  const message = typeof b?.message === 'string' ? b.message : null
  // Transient: the same key is still running, Olympics or an integration is having a moment, or a
  // 5xx without a usable answer. The caller may retry with the same Idempotency-Key.
  if (code === 'IN_PROGRESS' || code === 'UNAVAILABLE' || code === 'INTERNAL' || !code || !message) {
    return unavailable(`${label}: ${status}${code ? ` ${code}` : ''}`, status)
  }
  const refusal: OlympicsRefusal = { ok: false, kind: 'refused', status, code, message }
  if (typeof b?.retryAt === 'string') refusal.retryAt = b.retryAt
  if (typeof b?.retryAfterSeconds === 'number') refusal.retryAfterSeconds = b.retryAfterSeconds
  return refusal
}

function unavailable(why: string, status?: number): { ok: false; kind: 'unavailable'; status?: number } {
  console.warn(`[baumy/olympics] unavailable — ${why}`)
  return status != null ? { ok: false, kind: 'unavailable', status } : { ok: false, kind: 'unavailable' }
}

function isTool(t: unknown): t is OlympicsTool {
  if (!t || typeof t !== 'object') return false
  const x = t as Record<string, unknown>
  return typeof x.name === 'string' && typeof x.description === 'string' && typeof x.kind === 'string' && typeof x.risk === 'string'
}
