// THE ONE ADAPTER between scenario fixtures and the models' current output schemas.
//
// Scenarios describe what a model SHOULD conclude about a message in the shape the spec defines
// (docs/spec/chat-understanding-v2.md §2 for triage, §6 for facts/reminders). Triage already speaks
// the spec shape; facts/reminders are still pre-§6 (phase 3), so every fixture passes through here on
// its way into the fake model. When a phase changes a schema, THIS file changes — no scenario does.

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

/** What the triage model returns for this verdict. The classifier schema IS the spec §2 shape since
 *  phase 1, so this is the identity — kept as the one seam a later schema change would touch. */
export function toTriageOutput(v: Verdict): Record<string, unknown> {
  return { ...v }
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
