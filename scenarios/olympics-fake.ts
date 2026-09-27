// An in-memory Baumy Olympics (docs/spec/olympics.md), speaking the `/api/v1/actions` contract of
// Olympics' docs/brain-integration.md closely enough to drive Baumy's client end to end with no
// network: the bearer token, `X-Baumy-Actor` mapped to a linked member, `X-Baumy-Confirmed` for
// `confirm`-risk writes (428 without it), and an `Idempotency-Key` ledger (the same key and input
// replays the stored answer; a different input is 409). Every write is audited with `source: 'brain'`.
//
// Installed with the client's test-only transport seam (setOlympicsTransport) — by a scenario's
// `olympics` option, or directly in a unit test.

import { now as clockNow } from '@/lib/core/clock'

export const FAKE_OLYMPICS_URL = 'https://olympics.test'
export const FAKE_OLYMPICS_TOKEN = 'brain-service-token-for-tests-0123456789'

export interface FakeMember {
  id: string
  displayName: string
  /** The linked Telegram user id, if any. */
  telegramUserId?: string
}
export interface FakeChore {
  id: string
  name: string
  basePoints: number
  /** Minutes before it can be logged again. */
  cooldownMinutes?: number
}

export interface FakeCall {
  name: string
  actor: string | null
  idempotencyKey: string | null
  confirmed: boolean
  body: Record<string, unknown>
  status: number
}

type Json = Record<string, unknown>
type Answer = { status: number; body: Json }

const CONFIRM = new Set(['create_event', 'log_completion'])
const WRITES = new Set(['create_event', 'log_completion', 'link_telegram'])

export class FakeOlympics {
  members: FakeMember[]
  chores: FakeChore[]
  /** One-time link codes → the member who made them. */
  codes = new Map<string, string>()
  events: Json[] = []
  completions: { id: string; choreId: string; doneBy: string; at: number }[] = []
  audit: { action: string; memberId: string; source: 'brain'; entityId: string | null }[] = []
  calls: FakeCall[] = []
  /** Names of actions whose NEXT answer is lost after it ran (a timeout after the commit). */
  loseNextAnswer = new Set<string>()
  /** Answer every call with 503 UNAVAILABLE while true. */
  down = false
  private ledger = new Map<string, { input: string; answer: Answer }>()
  private seq = 0

  constructor(o: { members?: FakeMember[]; chores?: FakeChore[]; now?: () => number } = {}) {
    this.members = o.members ?? []
    this.chores = o.chores ?? []
    this.now = o.now ?? (() => clockNow().getTime())
  }
  private now: () => number

  /** The transport to install with setOlympicsTransport. */
  transport = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers)
    const path = new URL(url).pathname
    const reply = (a: Answer) => new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
    if (headers.get('Authorization') !== `Bearer ${FAKE_OLYMPICS_TOKEN}`) return reply(err(401, 'UNAUTHENTICATED', 'Unknown token.'))
    if (init.method === 'GET' && path === '/api/v1/actions') {
      return reply({ status: 200, body: { ok: true, actions: [...ACTION_RISK].map(([name, risk]) => ({ name, description: name, input_schema: {}, kind: WRITES.has(name) ? 'write' : 'read', risk })) } })
    }
    const m = path.match(/^\/api\/v1\/actions\/([a-z_]+)$/)
    if (init.method !== 'POST' || !m) return reply(err(404, 'UNKNOWN_ACTION', 'No such action.'))
    const name = m[1]
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {}
    const actor = headers.get('X-Baumy-Actor')?.match(/^tg:(\d+)$/)?.[1] ?? null
    const key = headers.get('Idempotency-Key')
    const confirmed = headers.get('X-Baumy-Confirmed') === '1'
    const answer = this.dispatch(name, body, actor, key, confirmed)
    this.calls.push({ name, actor, idempotencyKey: key, confirmed, body, status: answer.status })
    if (this.loseNextAnswer.delete(name)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return reply(answer)
  }

  private dispatch(name: string, body: Json, actor: string | null, key: string | null, confirmed: boolean): Answer {
    if (this.down) return err(503, 'UNAVAILABLE', 'Olympics is having a moment.')
    if (!ACTION_RISK.has(name)) return err(404, 'UNKNOWN_ACTION', 'No such action.')
    if (!actor) return err(400, 'INVALID_INPUT', 'X-Baumy-Actor is missing.')
    const member = this.members.find((x) => x.telegramUserId === actor)
    if (!member && name !== 'link_telegram') return err(403, 'TELEGRAM_NOT_LINKED', 'Link your Telegram first: send /link <code>.')
    if (CONFIRM.has(name) && !confirmed) return err(428, 'CONFIRMATION_REQUIRED', 'Confirm this first.')
    if (!WRITES.has(name)) return this.read(name, body, member!)
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return err(400, 'INVALID_INPUT', 'Idempotency-Key is missing.')
    // Keyed per member (Olympics keys link_telegram on the member its code names — `joinedAs`).
    const owner = (name === 'link_telegram' ? this.codes.get(String(body.code)) : undefined) ?? member?.id ?? `tg:${actor}`
    const ledgerKey = `${owner}:${key}`
    const input = JSON.stringify({ name, body })
    const seen = this.ledger.get(ledgerKey)
    if (seen) return seen.input === input ? seen.answer : err(409, 'IDEMPOTENCY_CONFLICT', 'That key was used for something else.')
    const answer = this.write(name, body, actor, member ?? null)
    if (answer.status < 300) this.ledger.set(ledgerKey, { input, answer })
    return answer
  }

  private read(name: string, body: Json, me: FakeMember): Answer {
    if (name === 'whoami') return ok({ memberId: me.id, displayName: me.displayName, role: 'member', actorKind: 'service' })
    if (name === 'list_events') {
      const from = String(body.from ?? '')
      const to = String(body.to ?? from)
      const events = this.events.filter((e) => String(e.startDate) <= to && String(e.endDate) >= from)
      return ok({ from, to, events })
    }
    if (name === 'list_chores') {
      return ok({
        chores: this.chores.map((c) => {
          const last = this.completions.filter((x) => x.choreId === c.id).at(-1)
          const until = last && c.cooldownMinutes ? last.at + c.cooldownMinutes * 60_000 : 0
          const cooling = until > this.now()
          return {
            id: c.id,
            name: c.name,
            archived: false,
            basePoints: c.basePoints,
            state: cooling ? 'cooldown' : 'due',
            availableAt: cooling ? new Date(until).toISOString() : null,
            next: { totalPts: c.basePoints, streakLen: 1 },
          }
        }),
      })
    }
    // get_standings
    const pts = new Map<string, number>()
    for (const c of this.completions) pts.set(c.doneBy, (pts.get(c.doneBy) ?? 0) + (this.chores.find((x) => x.id === c.choreId)?.basePoints ?? 0))
    const standings = this.members
      .map((m) => ({ memberId: m.id, displayName: m.displayName, points: pts.get(m.id) ?? 0, provisionalPts: 0 }))
      .sort((a, b) => b.points - a.points)
      .map((s, i) => ({ ...s, rank: i + 1 }))
    const leaderId = standings.length && standings[0].points > (standings[1]?.points ?? -1) ? standings[0].memberId : null
    return ok({ season: { year: new Date(this.now()).getUTCFullYear() }, leaderId, standings })
  }

  private write(name: string, body: Json, actor: string, me: FakeMember | null): Answer {
    if (name === 'link_telegram') {
      const memberId = this.codes.get(String(body.code))
      if (!memberId) return err(422, 'LINK_CODE_INVALID', 'That code is wrong, used or expired.')
      const holder = this.members.find((x) => x.telegramUserId === actor)
      if (holder && holder.id !== memberId) return err(422, 'TELEGRAM_ALREADY_LINKED', 'That Telegram account is linked to someone else.')
      this.codes.delete(String(body.code))
      const m = this.members.find((x) => x.id === memberId)!
      m.telegramUserId = actor
      this.audit.push({ action: name, memberId, source: 'brain', entityId: memberId })
      return ok({ memberId, displayName: m.displayName })
    }
    if (name === 'create_event') {
      const id = `evt${++this.seq}xx`
      const date = String(body.date)
      const endDate = String(body.endDate ?? date)
      const when = body.kind === 'all_day' ? `${date}, all day` : `${date}, ${body.startTime}–${body.endTime}`
      const event = {
        id,
        title: body.title,
        location: body.location ?? null,
        allDay: body.kind === 'all_day',
        startDate: date,
        endDate,
        startTime: body.startTime ?? null,
        endTime: body.endTime ?? null,
        when,
        addedBy: me!.id,
      }
      this.events.push(event)
      this.audit.push({ action: name, memberId: me!.id, source: 'brain', entityId: id })
      return ok({ event })
    }
    // log_completion
    const chore = this.chores.find((c) => c.id === body.choreId)
    if (!chore) return err(404, 'NOT_FOUND', 'No such chore.')
    const last = this.completions.filter((x) => x.choreId === chore.id).at(-1)
    if (last && chore.cooldownMinutes && last.at + chore.cooldownMinutes * 60_000 > this.now()) return err(422, 'COOLDOWN', `${chore.name} was done too recently.`)
    const id = `cmp${++this.seq}`
    this.completions.push({ id, choreId: chore.id, doneBy: me!.id, at: this.now() })
    this.audit.push({ action: name, memberId: me!.id, source: 'brain', entityId: id })
    return ok({ completionId: id, choreId: chore.id, choreName: chore.name, doneBy: me!.id, doneByName: me!.displayName, status: 'pending', counted: true, totalPts: chore.basePoints })
  }
}

const ACTION_RISK = new Map<string, string>([
  ['whoami', 'safe'],
  ['link_telegram', 'safe'],
  ['list_events', 'safe'],
  ['create_event', 'confirm'],
  ['list_chores', 'safe'],
  ['log_completion', 'confirm'],
  ['get_standings', 'safe'],
])

const ok = (data: unknown): Answer => ({ status: 200, body: { ok: true, data } })
const err = (status: number, code: string, message: string): Answer => ({ status, body: { ok: false, code, message } })
