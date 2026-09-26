import { it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { and, eq, sql } from 'drizzle-orm'
import { __setDbOverride, type Database } from '@/db/client'
import { reminders } from '@/db/schema'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { embedSync, setEmbedOverride } from '@/lib/ai/embed'
import { setConsoleThread } from '@/lib/identity/house'
import { inngest } from '@/lib/inngest/client'
import { createSandbox, sendAs, tapAs, advanceBy, type Sandbox, type SandboxPerson, type SendOptions, type TranscriptEntry } from '@/lib/sandbox/harness'
import { installFakeModels, installRecordingModels, type CallRole, type Fixtures, type ModelCall, type ModelRecorder } from './fake-model'
import { judgeReply } from './judge'

// A small declarative DSL for multi-turn house conversations (docs/spec/chat-understanding-v2.md
// §9). A scenario is people + a start time + fixtures + a list of steps; it runs through the REAL
// pipeline via the sandbox harness (PGlite, captured outbound, simulated clock). Only the model and
// the embedder are swapped: scripted offline, real in live mode (SCENARIOS_LIVE=1).
//
//   scenario('undirected statement is noted', {
//     people: [{ id: 1, name: 'Chloe', role: 'owner' }],
//     startAt: '2026-09-24 19:00',
//     fixtures: { triage: () => statement() },
//     steps: [say('Chloe', 'the bins go out on thursdays now'), expectReaction('✍'), expectNoWords()],
//   })

export const LIVE = process.env.SCENARIOS_LIVE === '1'
const LIVE_READY = LIVE && !!process.env.ANTHROPIC_API_KEY && !!process.env.VOYAGE_API_KEY
const OFFLINE_TIMEOUT = 60_000
const LIVE_TIMEOUT = 300_000

export interface KnownGap {
  /** Audit finding refs this scenario is blocked on (e.g. 'C1 C2 C3'). */
  refs: string
  /** The chat-understanding-v2 phase whose landing flips it to passing. */
  phase: number
  /**
   * The 1-based step the gap is blocked at. The scenario must fail at THIS step (or a later one):
   * a failure at an earlier step is a regression in behaviour that already works, so the known gap
   * then reports red instead of hiding it.
   */
  failsAt: number
  note?: string
}

export interface ScenarioSpec {
  people: SandboxPerson[]
  /** 'yyyy-MM-dd HH:mm' in `tz`, or any ISO string with an offset. */
  startAt: string
  tz?: string
  /** Configure an ask-Baumy topic (the /baumyhere thread id); `say(…, { topic: 'console' })` posts there. */
  consoleTopic?: number
  fixtures?: Fixtures
  steps: Step[]
  /** The current code does not satisfy this scenario yet: runs as `it.fails` offline, skipped live. */
  knownGap?: KnownGap
  /** Why this can only run offline (e.g. it scripts a provider outage). Skipped in live mode. */
  offlineOnly?: string
}

export interface Step {
  label: string
  run(r: Run): Promise<void>
}

export interface Turn {
  kind: 'say' | 'advance' | 'tap'
  /** Who spoke (say) or what ran (advance). */
  who: string
  text: string
  messageId: number
  dm: boolean
  entries: TranscriptEntry[]
  calls: ModelCall[]
  error?: unknown
}

export interface Run {
  sb: Sandbox
  db: Database
  mode: 'offline' | 'live'
  models: ModelRecorder
  spec: ScenarioSpec
  turns: Turn[]
  /** Events the pipeline handed to Inngest (captured, never sent — the harness drives crons itself). */
  events: { name: string; data: unknown }[]
}

/** A scenario expectation that did not hold (as opposed to the harness itself falling over). */
export class ExpectationFailure extends Error {
  override name = 'ExpectationFailure'
}

const fail = (msg: string): never => {
  throw new ExpectationFailure(msg)
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────────

export function scenario(name: string, spec: ScenarioSpec): void {
  if (LIVE) {
    if (!LIVE_READY) return it.skip(`${name} (live mode needs ANTHROPIC_API_KEY + VOYAGE_API_KEY)`, () => {})
    if (spec.offlineOnly) return it.skip(`${name} (offline only: ${spec.offlineOnly})`, () => {})
    if (spec.knownGap) return it.skip(`${name} (known gap ${spec.knownGap.refs} → phase ${spec.knownGap.phase})`, () => {})
    return it(name, () => runScenario(spec, 'live'), LIVE_TIMEOUT)
  }
  // SCENARIOS_SHOW_GAPS=1 runs known gaps as ordinary tests, to see exactly where each one fails
  // (or to check a phase flipped it).
  if (spec.knownGap && process.env.SCENARIOS_SHOW_GAPS !== '1') {
    const g = spec.knownGap
    return it.fails(`${name} [known gap ${g.refs} → phase ${g.phase}]`, () => runKnownGap(spec), OFFLINE_TIMEOUT)
  }
  it(name, () => runScenario(spec, 'offline'), OFFLINE_TIMEOUT)
}

// A known-gap scenario must fail AT AN EXPECTATION, at or after its `failsAt` step. Anything else is
// swallowed (after logging) so `it.fails` reports the scenario red: a broken harness, or a regression
// in an EARLIER step (behaviour that works today), must never look like the known gap.
async function runKnownGap(spec: ScenarioSpec): Promise<void> {
  try {
    await runScenario(spec, 'offline')
  } catch (err) {
    const atExpectation = err instanceof ExpectationFailure || (err as Error)?.name === 'AssertionError'
    const step = Number(/^step (\d+) —/.exec((err as Error)?.message ?? '')?.[1] ?? NaN)
    if (atExpectation && step >= (spec.knownGap?.failsAt ?? Infinity)) throw err
    console.error(
      atExpectation
        ? `[scenarios] known-gap scenario failed at step ${step}, BEFORE its failsAt step ${spec.knownGap?.failsAt} — a regression, not the gap:`
        : '[scenarios] known-gap scenario crashed in the harness, not at an expectation:',
      err,
    )
  }
}

const DEFAULT_KEY = Buffer.alloc(32, 13).toString('base64')

async function runScenario(spec: ScenarioSpec, mode: 'offline' | 'live'): Promise<void> {
  const tz = spec.tz ?? 'Europe/Berlin'
  const saved = { tz: process.env.BAUMY_TIMEZONE, key: process.env.BAUMY_ENCRYPTION_KEY, house: process.env.BAUMY_HOUSE_CHAT_ID }
  process.env.BAUMY_TIMEZONE = tz
  process.env.BAUMY_ENCRYPTION_KEY ??= DEFAULT_KEY
  delete process.env.BAUMY_HOUSE_CHAT_ID

  const db = await makeTestDb()
  __setDbOverride(db)
  if (mode === 'offline') setEmbedOverride(async (values) => values.map(embedSync))
  const models = mode === 'offline' ? installFakeModels(spec.fixtures ?? {}) : installRecordingModels()
  // Inngest is never reached from a scenario, in either mode: events are captured instead (the
  // harness runs the cron cores itself, so e.g. a reminder's arm event is redundant here).
  const events: Run['events'] = []
  const realSend = inngest.send
  const client = inngest as unknown as { send: (p: unknown) => Promise<{ ids: string[] }> }
  client.send = async (payload) => {
    for (const e of [payload].flat() as { name: string; data: unknown }[]) events.push({ name: e.name, data: e.data })
    return { ids: [] }
  }
  // Offline means OFFLINE: any code path that still reaches for the network fails loudly.
  const realFetch = globalThis.fetch
  if (mode === 'offline') {
    globalThis.fetch = (async (input: unknown) => {
      throw new Error(`[scenarios] offline scenario tried to reach the network: ${String((input as { url?: string })?.url ?? input)}`)
    }) as typeof fetch
  }
  try {
    const people = spec.people.some((p) => p.role === 'owner') ? spec.people : spec.people.map((p, i) => (i === 0 ? { ...p, role: 'owner' as const } : p))
    const startAt = DateTime.fromISO(spec.startAt.replace(' ', 'T'), { zone: tz })
    if (!startAt.isValid) throw new Error(`[scenarios] bad startAt: ${spec.startAt}`)
    const sb = await createSandbox({ db, startAt: startAt.toJSDate(), people, tz })
    if (spec.consoleTopic != null) await setConsoleThread(db, spec.consoleTopic)
    const r: Run = { sb, db, mode, models, spec: { ...spec, people }, turns: [], events }
    for (const [i, step] of spec.steps.entries()) {
      try {
        const faults = models.harnessErrors.length
        await step.run(r)
        // A fault in the scripted model the pipeline swallowed (a best-effort `catch {}`) is still a
        // broken scenario — a plain Error, so a known gap reports it red too.
        if (models.harnessErrors.length > faults) throw new Error(`the fake model failed:\n${models.harnessErrors.slice(faults).join('\n')}`)
      } catch (err) {
        if (err instanceof Error) err.message = `step ${i + 1} — ${step.label}:\n${err.message}`
        throw err
      }
    }
  } finally {
    globalThis.fetch = realFetch
    inngest.send = realSend
    models.uninstall()
    setEmbedOverride(null)
    __setDbOverride(null)
    restoreEnv('BAUMY_TIMEZONE', saved.tz)
    restoreEnv('BAUMY_ENCRYPTION_KEY', saved.key)
    restoreEnv('BAUMY_HOUSE_CHAT_ID', saved.house)
  }
}

function restoreEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────

export interface SayOptions {
  /** Send from the person's private chat (member_dm lane). */
  dm?: boolean
  /** Post inside a forum topic: 'console' = the scenario's ask-Baumy topic, or a thread id. */
  topic?: 'console' | number
  /** Reply to Baumy. `true` replies to Baumy's most recent worded message (its text is forwarded). */
  replyToBaumy?: boolean | string
  /** Reply to another housemate's message. */
  replyTo?: SendOptions['replyTo']
  /** Prefix the exact @username (a real mention). */
  mention?: boolean
  /** Forwarded into the chat by this person (trust 'forwarded' — D4). */
  forwarded?: boolean
  /** The text is the caption of this media (a photo, a document…) — I4. */
  media?: SendOptions['media']
  anonymousAdmin?: boolean
  /** This is an EDIT of the speaker's previous message (same message_id, new update). */
  edit?: boolean
  /** Ingest is expected to throw (e.g. a transient model error must surface for Inngest to retry). */
  throws?: true | RegExp
}

export function say(who: string, text: string, opts: SayOptions = {}): Step {
  return {
    label: `${who}${opts.dm ? ' (DM)' : ''}: "${text}"`,
    async run(r) {
      const person = r.spec.people.find((p) => p.name.toLowerCase() === who.toLowerCase())
      if (!person) throw new Error(`[scenarios] no such person: ${who}`)
      let threadId: number | undefined
      if (opts.topic === 'console') {
        if (r.spec.consoleTopic == null) throw new Error('[scenarios] topic:"console" needs spec.consoleTopic')
        threadId = r.spec.consoleTopic
      } else if (typeof opts.topic === 'number') threadId = opts.topic
      let messageId: number | undefined
      if (opts.edit) {
        const prev = [...r.turns].reverse().find((t) => t.kind === 'say' && t.who === person.name)
        if (!prev) throw new Error(`[scenarios] ${who} has no earlier message to edit`)
        messageId = prev.messageId
      }
      let replyToBaumy = opts.replyToBaumy
      if (replyToBaumy === true) replyToBaumy = lastBaumyWords(r) ?? true

      const before = r.models.calls.length
      const id = messageId ?? r.sb.seq
      let entries: TranscriptEntry[] = []
      let error: unknown
      try {
        entries = await sendAs(r.sb, person.id, text, {
          dm: opts.dm,
          threadId,
          replyToBaumy,
          replyTo: opts.replyTo,
          mention: opts.mention,
          forwarded: opts.forwarded,
          anonymousAdmin: opts.anonymousAdmin,
          messageId,
          edit: opts.edit,
          media: opts.media,
        })
      } catch (err) {
        error = err
      }
      r.turns.push({ kind: 'say', who: person.name, text, messageId: id, dm: !!opts.dm, entries, calls: r.models.calls.slice(before), error })
      if (error && !opts.throws) throw error
      if (opts.throws) {
        if (!error) fail('expected ingest to THROW (so Inngest retries), but it completed')
        const msg = error instanceof Error ? error.message : String(error)
        if (opts.throws instanceof RegExp && !opts.throws.test(msg)) fail(`ingest threw, but not ${opts.throws}: ${msg}`)
      }
    },
  }
}

/**
 * Tap the most recent confirm card's button as `who` (the confirm-tap wall's second half): drives the
 * real callback handler with the card's pending-action id, in the chat the card was sent to.
 */
export function tap(who: string, verb: 'confirm' | 'cancel' = 'confirm'): Step {
  return {
    label: `${who} taps ${verb}`,
    async run(r) {
      const person = r.spec.people.find((p) => p.name.toLowerCase() === who.toLowerCase())
      if (!person) throw new Error(`[scenarios] no such person: ${who}`)
      const card = r.turns.flatMap((t) => t.entries).filter((e) => e.kind === 'confirm-card').at(-1)
      if (!card?.meta) fail('no confirm card has been sent to tap')
      const before = r.models.calls.length
      const entries = await tapAs(r.sb, person.id, card!.meta!, { verb, chatId: card!.chatId, messageId: card!.messageId })
      r.turns.push({ kind: 'tap', who: person.name, text: verb, messageId: -1, dm: card!.chatId !== r.sb.houseChatId, entries, calls: r.models.calls.slice(before) })
    },
  }
}

/** Move the clock forward, running every cron that falls in between at its own instant. */
export function advance(d: { days?: number; hours?: number; minutes?: number }): Step {
  return {
    label: `advance ${JSON.stringify(d)}`,
    async run(r) {
      const before = r.models.calls.length
      const res = await advanceBy(r.sb, d)
      const entries = res.fired.flatMap((f) => f.said)
      r.turns.push({ kind: 'advance', who: res.fired.map((f) => f.job).join(', ') || 'clock', text: '', messageId: -1, dm: false, entries, calls: r.models.calls.slice(before) })
    },
  }
}

// ── Expectations (all about the most recent turn unless stated) ─────────────────────────────────

const WORD_KINDS = new Set(['message', 'dm', 'confirm-card'])

function lastTurn(r: Run, kind?: Turn['kind']): Turn {
  const t = [...r.turns].reverse().find((x) => !kind || x.kind === kind)
  if (!t) throw new Error(`[scenarios] no ${kind ?? ''} turn to check yet`)
  return t
}

function lastBaumyWords(r: Run): string | null {
  for (const t of [...r.turns].reverse()) {
    const w = [...t.entries].reverse().find((e) => WORD_KINDS.has(e.kind) && e.text)
    if (w) return w.text
  }
  return null
}

/** The reaction left on the message once the turn settled (👀 → cleared counts as none). */
export function finalReaction(entries: TranscriptEntry[]): string | null {
  const reactions = entries.filter((e) => e.kind === 'reaction')
  return reactions.length ? (reactions[reactions.length - 1].meta ?? null) : null
}

const wordsOf = (t: Turn) => t.entries.filter((e) => WORD_KINDS.has(e.kind) && e.text)

function describeTurn(t: Turn): string {
  const said = t.entries.map((e) => `${e.kind}${e.meta !== undefined ? `(${e.meta})` : ''}${e.text ? `: ${e.text}` : ''}`)
  return said.length ? said.join('\n  ') : '(nothing)'
}

/** The reaction Baumy left on the last message: an emoji, `null` for none, or `{ not }`. */
export function expectReaction(want: string | null | { not: string }): Step {
  return {
    label: `reaction ${JSON.stringify(want)}`,
    async run(r) {
      const t = lastTurn(r, 'say')
      const got = finalReaction(t.entries)
      if (want !== null && typeof want === 'object') {
        if (got === want.not) fail(`expected no ${want.not} reaction, got it. Baumy did:\n  ${describeTurn(t)}`)
        return
      }
      if (got !== want) fail(`expected reaction ${want ?? '(none)'}, got ${got ?? '(none)'}. Baumy did:\n  ${describeTurn(t)}`)
    },
  }
}

type TextMatch = string | RegExp
const matches = (text: string, m: TextMatch) => (typeof m === 'string' ? text.toLowerCase().includes(m.toLowerCase()) : m.test(text))

export interface WordsExpectation {
  contains?: TextMatch | TextMatch[]
  notContains?: TextMatch | TextMatch[]
  /** Live mode only: a rubric an LLM judge checks the words against. */
  judge?: string
}

/** Baumy answered the last message in words, in the chat it came from. */
export function expectWords(want: WordsExpectation = {}): Step {
  return {
    label: `words${want.contains ? ` containing ${String(want.contains)}` : ''}${want.notContains ? ` without ${String(want.notContains)}` : ''}${want.judge ? ` [judge: ${want.judge}]` : ''}`,
    async run(r) {
      const t = lastTurn(r)
      const words = wordsOf(t)
      if (!words.length) fail(`expected words, Baumy said nothing. It did:\n  ${describeTurn(t)}`)
      if (t.kind === 'say') {
        const person = r.spec.people.find((p) => p.name === t.who)!
        const dest = t.dm ? String(person.id) : r.sb.houseChatId
        const stray = words.find((w) => w.chatId !== dest)
        if (stray) fail(`words went to ${stray.chatId}, expected the originating chat ${dest}`)
      }
      const text = words.map((w) => w.text).join('\n')
      for (const m of [want.contains ?? []].flat()) if (!matches(text, m)) fail(`expected the words to contain ${m}; got:\n${text}`)
      for (const m of [want.notContains ?? []].flat()) if (matches(text, m)) fail(`expected the words NOT to contain ${m}; got:\n${text}`)
      if (want.judge && r.mode === 'live') {
        const v = await judgeReply({ conversation: conversationSoFar(r), reply: text, rubric: want.judge })
        if (!v.pass) fail(`judge: ${v.reason}\nrubric: ${want.judge}\nreply: ${text}`)
      }
    },
  }
}

/** No worded message on the last turn (reactions allowed). */
export function expectNoWords(): Step {
  return {
    label: 'no words',
    async run(r) {
      const t = lastTurn(r)
      if (wordsOf(t).length) fail(`expected no words, Baumy said:\n  ${describeTurn(t)}`)
    },
  }
}

/** Baumy did nothing visible at all — no words, no reaction (not even a 👀 flash). */
export function expectSilent(): Step {
  return {
    label: 'silent',
    async run(r) {
      const t = lastTurn(r)
      if (t.entries.length) fail(`expected silence, Baumy did:\n  ${describeTurn(t)}`)
    },
  }
}

function conversationSoFar(r: Run): string {
  const lines: string[] = []
  for (const t of r.turns) {
    if (t.kind === 'say') lines.push(`${t.who}${t.dm ? ' (DM to Baumy)' : ''}: ${t.text}`)
    for (const w of wordsOf(t)) lines.push(`Baumy: ${w.text}`)
  }
  return lines.join('\n')
}

type PromptMatch = RegExp | string | ((call: ModelCall) => boolean | void)

/**
 * What the model was TOLD on the last turn: the latest `role` call's prompt must satisfy `match`
 * (a regex / substring over the user prompt, or a predicate over the whole call). `why` reads as
 * the claim, e.g. 'the model was told who is speaking'.
 */
export function expectPrompt(role: CallRole, match: PromptMatch, why: string): Step {
  return {
    label: `prompt[${role}] ${why}`,
    async run(r) {
      const t = lastTurn(r)
      const calls = t.calls.filter((c) => c.role === role)
      if (!calls.length) fail(`${why}: the model was never asked for "${role}" on this turn (calls: ${t.calls.map((c) => c.role).join(', ') || 'none'})`)
      const call = calls[calls.length - 1]
      const ok = typeof match === 'function' ? match(call) !== false : typeof match === 'string' ? call.prompt.includes(match) : match.test(call.prompt)
      if (!ok) fail(`${why} — not satisfied by the ${role} prompt:\n----\n${call.prompt}\n----`)
    },
  }
}

/** The model was never asked for `role` on the last turn. */
export function expectNoPrompt(role: CallRole, why: string): Step {
  return {
    label: `no prompt[${role}] ${why}`,
    async run(r) {
      const t = lastTurn(r)
      if (t.calls.some((c) => c.role === role)) fail(`${why}: but the model WAS asked for "${role}"`)
    },
  }
}

/** Free-form check against the scenario database. Use vitest `expect` inside, or return false. */
export function expectDb(check: (db: Database, r: Run) => Promise<boolean | void>, why: string): Step {
  return {
    label: `db: ${why}`,
    async run(r) {
      if ((await check(r.db, r)) === false) fail(why)
    },
  }
}

export interface FactRow {
  subject: string | null
  predicate: string
  object: string | null
  authored_by: string | null
  author_name: string | null
  trust_level: string
  is_current: boolean
  event_at: Date | string | null
}

/** Every fact in the house scope, subjects/objects resolved to names. */
export async function houseFacts(r: Run): Promise<FactRow[]> {
  const res = (await r.db.execute(sql`
    SELECT se.canonical_name AS subject, f.predicate, COALESCE(f.object_value, oe.canonical_name) AS object,
           f.authored_by, m.display_name AS author_name, f.trust_level, f.is_current, f.event_at
      FROM baumy_facts f
      LEFT JOIN baumy_entities se ON se.id = f.subject_entity_id
      LEFT JOIN baumy_entities oe ON oe.id = f.object_entity_id
      LEFT JOIN baumy_members m ON m.telegram_user_id = f.authored_by
     WHERE f.group_id = ${r.sb.houseChatId}`)) as unknown as { rows?: FactRow[] } | FactRow[]
  return Array.isArray(res) ? res : (res.rows ?? [])
}

export interface FactExpectation {
  subject?: TextMatch
  predicate?: TextMatch
  object?: TextMatch
  /** The person the fact is attributed to (by sandbox name). */
  by?: string
  current?: boolean
  /** The stored trust tier ('trusted' for a member DM, 'untrusted' for group text …) — a security
   *  invariant: it decides which facts may supersede which. */
  trust?: string
}

/** At least one fact in the house scope matches (or, with `count: 0`, none does). */
export function expectFact(want: FactExpectation & { count?: number }): Step {
  return {
    label: `fact ${JSON.stringify({ ...want, subject: want.subject ? String(want.subject) : undefined, object: want.object ? String(want.object) : undefined, predicate: want.predicate ? String(want.predicate) : undefined })}`,
    async run(r) {
      const rows = await houseFacts(r)
      const byId = want.by ? String(r.spec.people.find((p) => p.name === want.by)?.id ?? '?') : null
      const hit = rows.filter(
        (f) =>
          (!want.subject || matches(f.subject ?? '', want.subject)) &&
          (!want.predicate || matches(f.predicate, want.predicate)) &&
          (!want.object || matches(f.object ?? '', want.object)) &&
          (!byId || f.authored_by === byId) &&
          (want.current === undefined || f.is_current === want.current) &&
          (!want.trust || f.trust_level === want.trust),
      )
      const show = rows.map((f) => `${f.subject} | ${f.predicate} | ${f.object} (by ${f.author_name ?? f.authored_by}, ${f.trust_level})`).join('\n  ') || '(none)'
      if (want.count !== undefined ? hit.length !== want.count : hit.length === 0)
        fail(`expected ${want.count ?? '≥1'} matching fact(s), found ${hit.length}. Facts:\n  ${show}`)
    },
  }
}

export interface ReminderExpectation {
  content?: TextMatch
  /** Local fire time in the scenario tz, 'yyyy-MM-dd HH:mm'. */
  at?: string
  status?: string
  /** Exact number of matching reminders (0 = none may exist). Default: at least one. */
  count?: number
}

export function expectReminder(want: ReminderExpectation = {}): Step {
  return {
    label: `reminder ${JSON.stringify({ ...want, content: want.content ? String(want.content) : undefined })}`,
    async run(r) {
      const tz = r.spec.tz ?? 'Europe/Berlin'
      const rows = await r.db
        .select()
        .from(reminders)
        .where(and(eq(reminders.groupId, r.sb.houseChatId), eq(reminders.anchorKind, 'absolute')))
      const local = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('yyyy-MM-dd HH:mm')
      const hit = rows.filter(
        (x) =>
          (!want.content || matches(x.content, want.content)) && (!want.at || local(x.fireAt) === want.at) && (!want.status || x.status === want.status),
      )
      const show = rows.map((x) => `"${x.content}" @ ${local(x.fireAt)} [${x.status}]`).join('\n  ') || '(none)'
      if (want.count !== undefined ? hit.length !== want.count : hit.length === 0)
        fail(`expected ${want.count ?? '≥1'} matching reminder(s), found ${hit.length}. Reminders:\n  ${show}`)
    },
  }
}

/** Assert with vitest `expect` against the run (escape hatch for one-off checks). */
export function check(why: string, fn: (r: Run, e: typeof expect) => void | Promise<void>): Step {
  return { label: why, run: async (r) => fn(r, expect) }
}
