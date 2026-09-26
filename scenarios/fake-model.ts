import { APICallError, wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import { setModelOverride } from '@/lib/ai/registry'
import type { Role } from '@/lib/ai/models'
import * as prompts from '@/lib/ai/prompts'
import {
  TRIAGE_SYSTEM,
  EXTRACT_FACTS_SYSTEM,
  EXTRACT_REMINDER_SYSTEM,
  EXTRACT_LIST_SYSTEM,
  FORGET_EXTRACT_SYSTEM,
  REPLY_SYSTEM,
  REPLY_SYSTEM_TEXT,
  VOICE_SYSTEM,
  REFLECT_SYSTEM,
  WRITE_HEADSUP_SYSTEM,
  EXPAND_QUERY_SYSTEM,
  RERANK_SYSTEM,
  WEB_SEARCH_SYSTEM,
  WEEKLY_REPORT_SYSTEM,
  GUEST_REPORT_SYSTEM,
  ISSUE_ENRICH_SYSTEM,
} from '@/lib/ai/prompts'
import { DELIBERATE_SYSTEM } from '@/lib/ai/deliberate'
import { toTriageOutput, toExtractedFact, toReminderOutput, chatter, type Verdict, type FactSpec, type ReminderSpec } from './shapes'

type LanguageModelV2 = Parameters<typeof wrapLanguageModel>[0]['model']

// The scripted model (docs/spec/chat-understanding-v2.md §9). Installed through the test-only
// seam in lib/ai/registry.ts, it stands in for EVERY language-model role while the real pipeline
// runs: it works out which call it is from the system prompt, answers from the scenario's fixtures
// (or a safe default), and records the call so a scenario can assert what the model was TOLD.
//
// In live mode the same recorder wraps the real Anthropic models instead, so prompt assertions
// hold against real runs too. (A hand-rolled v2 model rather than `ai/test`'s mock: that entry
// point pulls in msw, which this repo doesn't otherwise need.)

/** Which LLM call this is — derived from the system prompt, never from the message. */
export type CallRole =
  | 'triage'
  | 'extract'
  | 'reminder'
  | 'list'
  | 'forget'
  | 'reply'
  | 'reply-text'
  | 'voice'
  | 'reflect'
  | 'headsup'
  | 'expand'
  | 'rerank'
  | 'websearch'
  | 'weekly'
  | 'guests'
  | 'issue'
  | 'deliberate'
  | 'unknown'

export interface ModelCall {
  role: CallRole
  /** The routing tier the pipeline asked for (lib/ai/models.ts). */
  tier: Role
  system: string
  /** The user-turn text the model was given. */
  prompt: string
  /** The message the call is about, lifted from the prompt (the <<<…>>> block, the QUESTION/MESSAGE line). */
  text: string
  /** What the model answered (JSON text for structured calls). */
  output: string
}

/** A fault in the scripted model itself (an unregistered prompt, a prompt layout it cannot read) —
 *  as opposed to a fixture deliberately throwing (a scripted outage). Always fails the scenario. */
export class FakeModelError extends Error {
  override name = 'FakeModelError'
}

// Longest constant first, so a prompt that EXTENDS another (REPLY_SYSTEM ⊃ REPLY_SYSTEM_TEXT) wins.
export const ROLE_PROMPTS: [CallRole, string][] = (
  [
    ['triage', TRIAGE_SYSTEM],
    ['extract', EXTRACT_FACTS_SYSTEM],
    ['reminder', EXTRACT_REMINDER_SYSTEM],
    ['list', EXTRACT_LIST_SYSTEM],
    ['forget', FORGET_EXTRACT_SYSTEM],
    ['reply', REPLY_SYSTEM],
    ['reply-text', REPLY_SYSTEM_TEXT],
    ['voice', VOICE_SYSTEM],
    ['reflect', REFLECT_SYSTEM],
    ['headsup', WRITE_HEADSUP_SYSTEM],
    ['expand', EXPAND_QUERY_SYSTEM],
    ['rerank', RERANK_SYSTEM],
    ['websearch', WEB_SEARCH_SYSTEM],
    ['weekly', WEEKLY_REPORT_SYSTEM],
    ['guests', GUEST_REPORT_SYSTEM],
    ['issue', ISSUE_ENRICH_SYSTEM],
    ['deliberate', DELIBERATE_SYSTEM],
  ] as [CallRole, string][]
).sort((a, b) => b[1].length - a[1].length)

// Every exported *SYSTEM constant. One that is not registered above must never be mistaken for the
// registered prompt it happens to extend (REPLY_SYSTEM starts with REPLY_SYSTEM_TEXT): it is
// 'unknown', which fails loudly, instead of silently answering from the wrong role's fixtures.
const EXPORTED_SYSTEMS = new Set(
  [...Object.entries(prompts), ['DELIBERATE_SYSTEM', DELIBERATE_SYSTEM]].filter(([k, v]) => k.includes('SYSTEM') && typeof v === 'string').map(([, v]) => v as string),
)

export function roleOf(system: string, registry: [CallRole, string][] = ROLE_PROMPTS): CallRole {
  const exact = registry.find(([, p]) => p === system)
  if (exact) return exact[0]
  if (EXPORTED_SYSTEMS.has(system)) return 'unknown' // an exported prompt nobody registered
  // A system prompt built as constant + per-call context (a later phase may append a MODE table).
  const prefixed = registry.find(([, p]) => system.startsWith(p))
  return prefixed ? prefixed[0] : 'unknown'
}

// The message a call is about: the fenced <<<…>>> (or """…""") block the extractors use, else the
// last QUESTION/MESSAGE line (reply, rerank, websearch). null when the prompt has neither.
export function messageOf(prompt: string): string | null {
  const fenced = prompt.match(/<<<\n([\s\S]*?)\n>>>/) ?? prompt.match(/"""\n([\s\S]*?)\n"""/)
  if (fenced) return fenced[1]
  const lines = [...prompt.matchAll(/^(?:QUESTION|MESSAGE)[^:\n]*:\s*(.*)$/gm)]
  if (lines.length) return lines[lines.length - 1][1].trim()
  return null
}

// Roles whose fixtures are a function of the message text. If their prompt layout changes so the
// message can no longer be found, a fixture must not silently regex over MEMORY / THIS TURN instead.
const TEXT_ROLES = new Set<CallRole>(['triage', 'extract', 'reminder', 'list', 'forget', 'reply', 'reply-text', 'websearch', 'expand', 'rerank', 'issue'])

export function textOf(role: CallRole, prompt: string, strict = true): string {
  const m = messageOf(prompt)
  if (m != null) return m
  if (strict && TEXT_ROLES.has(role))
    throw new FakeModelError(`[scenarios/fake-model] no <<<…>>> fence or QUESTION/MESSAGE line in the ${role} prompt — its layout changed; update messageOf:\n${prompt.slice(0, 300)}`)
  return prompt
}

const speakerOf = (prompt: string): string | null => prompt.match(/^SPEAKER: (.+)$/m)?.[1]?.trim() ?? null

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

export interface ReplyScript {
  reply: string
  /** Did it answer from memory (true) or admit a miss (false)? Defaults to true. */
  answered?: boolean
}

/** Per-scenario answers, each a function of the message text. Anything omitted uses a safe default. */
export interface Fixtures {
  triage?: (text: string, call: ModelCall) => Verdict
  extract?: (text: string, speaker: string | null, call: ModelCall) => FactSpec[]
  reminder?: (text: string, call: ModelCall) => ReminderSpec | null
  list?: (text: string, call: ModelCall) => { op: 'add' | 'checkoff' | 'query' | 'none'; items: string[] }
  forget?: (
    text: string,
    speaker: string | null,
    call: ModelCall,
  ) => { isForget: boolean; values?: string[]; subject?: string; attribute?: string; permanent?: boolean } | null
  reply?: (text: string, call: ModelCall) => string | ReplyScript
  headsup?: (call: ModelCall) => string
  reflect?: (call: ModelCall) => string
  websearch?: (text: string, call: ModelCall) => string
  report?: (call: ModelCall) => string
  /** Deep-tier query expansion (paraphrases + a HyDE sentence). Default: none. */
  expand?: (text: string, call: ModelCall) => { variants: string[]; hypothetical: string }
}

/** The lines of the MEMORY block a reply prompt carries ("- …" entries only). */
export function memoryLines(prompt: string): string[] {
  return promptSection(prompt, 'MEMORY').filter((l) => /^\s*-\s/.test(l))
}

/**
 * The body of a prompt section: the lines after the one starting `header` up to the next
 * SHOUTED header ("MODE: …", "QUESTION (data): …", "RECENT CHAT (oldest first):"). Works for the
 * current reply prompt and the spec §4 layout alike. Empty when the section is absent.
 */
export function promptSection(prompt: string, header: string): string[] {
  const lines = prompt.split('\n')
  const start = lines.findIndex((l) => l.trimStart().startsWith(header))
  if (start < 0) return []
  const out: string[] = []
  const inline = lines[start].trimStart().slice(header.length).replace(/^[^:]*:\s*/, '')
  if (inline.trim()) out.push(inline)
  for (const l of lines.slice(start + 1)) {
    if (/^[A-Z][A-Z ]{2,}(?:\s*\([^)]*\))?(?: from [^:]+)?:/.test(l.trimStart()) && !/^\s*-/.test(l)) break
    out.push(l)
  }
  return out
}

// Default reply: in MODE answer, an honest miss when MEMORY is empty; any other mode (ack /
// confirm / clarify / banter) just echoes the mode, so a scenario can see which one was used.
const noteDefaultReply = (call: ModelCall): ReplyScript => {
  const mode = call.prompt.match(/^MODE: (\w+)$/m)?.[1] ?? 'answer'
  if (mode !== 'answer') return { reply: `(scripted ${mode})`, answered: true }
  return memoryLines(call.prompt).length === 0
    ? { reply: "Nobody's mentioned anything like that 🐈‍⬛", answered: false }
    : { reply: '(scripted reply)', answered: true }
}

// The answer for one call, as the raw text the provider would have returned.
function answerFor(call: ModelCall, fx: Fixtures): string {
  const json = (v: unknown) => JSON.stringify(v)
  switch (call.role) {
    case 'triage':
      return json(toTriageOutput(fx.triage ? fx.triage(call.text, call) : chatter()))
    case 'extract': {
      const facts = fx.extract ? fx.extract(call.text, speakerOf(call.prompt), call) : []
      return json({ facts: facts.map(toExtractedFact) })
    }
    case 'reminder':
      return json(toReminderOutput(fx.reminder ? fx.reminder(call.text, call) : null))
    case 'list':
      return json(fx.list ? fx.list(call.text, call) : { op: 'none', items: [] })
    case 'forget': {
      const f = fx.forget ? fx.forget(call.text, speakerOf(call.prompt), call) : null
      return json({ isForget: false, values: [], subject: '', attribute: '', permanent: false, ...(f ?? {}) })
    }
    case 'reply': {
      const r = fx.reply ? fx.reply(call.text, call) : noteDefaultReply(call)
      const s = typeof r === 'string' ? { reply: r, answered: true } : r
      return json({ reply: s.reply, answered: s.answered ?? true, needsStrongerModel: false })
    }
    case 'reply-text': {
      const r = fx.reply ? fx.reply(call.text, call) : noteDefaultReply(call)
      return typeof r === 'string' ? r : r.reply
    }
    case 'headsup':
      return fx.headsup ? fx.headsup(call) : 'SKIP'
    case 'reflect':
      return fx.reflect ? fx.reflect(call) : 'A housemate.'
    case 'websearch':
      // Empty text → webSearchAnswer reports searched:false and the memory-only reply runs.
      return fx.websearch ? fx.websearch(call.text, call) : ''
    case 'weekly':
    case 'guests':
      return fx.report ? fx.report(call) : 'Quiet week in the house 😼'
    case 'expand':
      return json(fx.expand ? fx.expand(call.text, call) : { variants: [], hypothetical: '' })
    case 'rerank':
      return json({ scores: [] })
    case 'issue':
      return json({ type: 'bug', title: call.text.slice(0, 80) || 'Report', summary: call.text || 'Report from the house' })
    case 'voice':
      return 'ok 😼'
    case 'deliberate':
      return 'ok'
    case 'unknown':
      throw new FakeModelError(
        `[scenarios/fake-model] unrecognised system prompt — add its constant to ROLE_PROMPTS in scenarios/fake-model.ts:\n${call.system.slice(0, 200)}`,
      )
  }
}

// ── Recording + install ──────────────────────────────────────────────────────────────────────────

type CallParams = Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['params']

function readParams(params: CallParams): { system: string; prompt: string } {
  const system: string[] = []
  const prompt: string[] = []
  for (const m of params.prompt) {
    if (m.role === 'system') system.push(m.content)
    else if (m.role === 'user') for (const p of m.content) if (p.type === 'text') prompt.push(p.text)
  }
  return { system: system.join('\n'), prompt: prompt.join('\n') }
}

function describeCall(tier: Role, params: CallParams): ModelCall {
  const { system, prompt } = readParams(params)
  const role = roleOf(system)
  return { role, tier, system, prompt, text: textOf(role, prompt, false), output: '' }
}

export interface ModelRecorder {
  /** Every LLM call so far, in order. */
  calls: ModelCall[]
  /** FakeModelErrors raised so far. The pipeline wraps several calls in best-effort `catch {}` (the
   *  deep-tier expand / rerank / graph walk), which would swallow them — the DSL checks this after
   *  every step so a broken fake can never pass silently. */
  harnessErrors: string[]
  uninstall(): void
}

const recordingMiddleware = (tier: Role, calls: ModelCall[]): LanguageModelMiddleware => ({
  wrapGenerate: async ({ doGenerate, params }) => {
    const call = describeCall(tier, params)
    calls.push(call)
    const result = await doGenerate()
    call.output = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return result
  },
})

/** Offline: every role answers from `fixtures` (or a safe default). No network. */
export function installFakeModels(fixtures: Fixtures): ModelRecorder {
  const calls: ModelCall[] = []
  const harnessErrors: string[] = []
  setModelOverride((tier) => {
    const fake: LanguageModelV2 = {
      specificationVersion: 'v2',
      provider: 'scenario',
      modelId: `fake-${tier}`,
      supportedUrls: {},
      doStream: async () => {
        throw new Error('[scenarios/fake-model] streaming is not scripted — no pipeline call streams today')
      },
      doGenerate: async (params) => {
        const { system, prompt } = readParams(params)
        let text: string
        try {
          const role = roleOf(system)
          const call: ModelCall = { role, tier, system, prompt, text: textOf(role, prompt), output: '' }
          text = answerFor(call, fixtures)
        } catch (err) {
          if (err instanceof FakeModelError) harnessErrors.push(err.message)
          throw err
        }
        return {
          content: [{ type: 'text', text }],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        }
      },
    }
    return wrapLanguageModel({ model: fake, middleware: recordingMiddleware(tier, calls) })
  })
  return { calls, harnessErrors, uninstall: () => setModelOverride(null) }
}

/** Live: the real models, wrapped so every call is still recorded for prompt assertions. */
export function installRecordingModels(): ModelRecorder {
  const calls: ModelCall[] = []
  setModelOverride((tier, real) => wrapLanguageModel({ model: real(), middleware: recordingMiddleware(tier, calls) }))
  return { calls, harnessErrors: [], uninstall: () => setModelOverride(null) }
}

/**
 * A transient provider failure (529 overloaded) for a fixture to throw. `retry-after-ms: 0` lets
 * the AI SDK's own retries run instantly, so the pipeline sees exactly what production sees after
 * they are spent (a RetryError wrapping the 529) without the suite sleeping through backoff.
 */
export function transientError(): APICallError {
  return new APICallError({
    message: 'Overloaded',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: 529,
    isRetryable: true,
    responseHeaders: { 'retry-after-ms': '0' },
  })
}
