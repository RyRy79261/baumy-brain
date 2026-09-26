import { classifierVerdict } from '@/lib/ai/classify'

// THE ONE ADAPTER between scenario fixtures and the models' current output schemas.
//
// Scenarios describe what a model SHOULD conclude about a message in the shape the spec defines
// (docs/spec/chat-understanding-v2.md §2 for triage, §6 for facts/reminders). The pipeline's zod
// schemas are still the pre-v2 ones in places, so every fixture passes through here on its way into
// the fake model. When a phase changes a schema, THIS file changes — no scenario does.

// ── Triage (spec §2) ─────────────────────────────────────────────────────────────────────────────

export type Intent = 'statement' | 'question' | 'request' | 'reminder' | 'forget' | 'banter' | 'chatter'
export type Vibe = '🔥' | '🎉' | '🤯' | '😁'

export interface Verdict {
  intent: Intent
  /** Is a question/request aimed at Baumy (vs at another housemate)? */
  asksBaumy: boolean
  /** Durable house info — never true for a pure question. */
  worthRemembering: boolean
  /** Confidence in `intent` (I6). */
  confidence: number
  vibe: Vibe | null
  tier: 'quick' | 'deep'
  webSearch: boolean
  list: 'add' | 'checkoff' | 'query' | 'none'
}

export function verdict(v: Partial<Verdict> & { intent: Intent }): Verdict {
  return {
    asksBaumy: false,
    worthRemembering: v.intent === 'statement',
    confidence: 0.9,
    vibe: null,
    tier: 'quick',
    webSearch: false,
    list: 'none',
    ...v,
  }
}

type Extra = Partial<Omit<Verdict, 'intent'>>
export const statement = (o: Extra = {}) => verdict({ intent: 'statement', ...o })
export const question = (o: Extra = {}) => verdict({ intent: 'question', ...o })
export const request = (o: Extra = {}) => verdict({ intent: 'request', ...o })
export const reminderAsk = (o: Extra = {}) => verdict({ intent: 'reminder', ...o })
export const forgetAsk = (o: Extra = {}) => verdict({ intent: 'forget', ...o })
export const banter = (o: Extra = {}) => verdict({ intent: 'banter', ...o })
export const chatter = (o: Extra = {}) => verdict({ intent: 'chatter', ...o })

// Phase 2 lands the spec schema; until then the classifier emits the legacy shape. Detected from
// the live zod schema, so the adapter flips itself the day `asksBaumy` appears in it.
const SPEC_TRIAGE = 'asksBaumy' in classifierVerdict.shape

const LEGACY_INTENT: Record<Intent, string> = {
  statement: 'fact',
  question: 'question',
  request: 'task',
  reminder: 'reminder',
  forget: 'forget',
  banter: 'chatter',
  chatter: 'chatter',
}

/**
 * What the triage model returns for this verdict, in the schema the code currently validates.
 *
 * For the LEGACY schema this is what a model faithfully following today's TRIAGE_SYSTEM would say
 * — not an idealised reading. That prompt says ANY question or request ("…tell/remind us…") gets
 * respond:"answer" whoever it is aimed at (the C6 bug), so `asksBaumy:false` cannot be expressed
 * and a housemate-to-housemate question still routes to "answer". Scenarios that need the spec's
 * behaviour are marked as known gaps instead of the adapter quietly fixing them.
 */
export function toTriageOutput(v: Verdict): Record<string, unknown> {
  if (SPEC_TRIAGE) return { ...v }
  const asks = v.intent === 'question' || v.intent === 'request' || v.intent === 'reminder' || v.intent === 'forget'
  const respond = asks
    ? 'answer'
    : v.intent === 'banter' && v.asksBaumy
      ? 'answer'
      : v.intent === 'statement'
        ? 'react'
        : v.vibe
          ? 'react'
          : 'ignore'
  const legacyVibe = v.vibe === '🔥' || v.vibe === '🎉' || v.vibe === '🤯' ? v.vibe : null
  return {
    worthRemembering: v.worthRemembering,
    intent: LEGACY_INTENT[v.intent],
    needsReply: respond === 'answer',
    confidence: v.confidence,
    respond,
    reaction: respond === 'react' ? legacyVibe : null,
    tier: v.tier,
    webSearch: v.webSearch,
    list: v.list,
  }
}

// ── Facts (spec §6/§7) ───────────────────────────────────────────────────────────────────────────

export interface FactSpec {
  subject: string
  predicate: string
  object: string
  subjectKind?: 'person' | 'place' | 'org' | 'event' | 'thing'
  objectKind?: 'person' | 'place' | 'org' | 'event' | 'thing' | 'value'
  /** The time phrase as said ("this weekend"). Phase 3 replaces it with resolved `when` ranges;
   *  when it does, the conversion lives in toExtractedFact below. */
  when?: string
}

export const fact = (f: FactSpec): FactSpec => f

export function toExtractedFact(f: FactSpec): Record<string, unknown> {
  const { when, ...rest } = f
  return when ? { ...rest, whenText: when } : rest
}

// ── Reminders (spec §6) ──────────────────────────────────────────────────────────────────────────

export interface ReminderSpec {
  content: string
  /** The time phrase as said ("friday 8pm"); '' = no time given. */
  when: string
}

export const reminder = (r: ReminderSpec): ReminderSpec => r

export function toReminderOutput(r: ReminderSpec | null): Record<string, unknown> {
  return r ? { isReminder: true, whenText: r.when, content: r.content } : { isReminder: false, whenText: '', content: '' }
}
