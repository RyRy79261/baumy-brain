// THE ONE ADAPTER between scenario fixtures and the models' current output schemas.
//
// Scenarios describe what a model SHOULD conclude about a message in the shape the spec defines
// (docs/spec/chat-understanding-v2.md §2 for triage, §6 for facts/reminders). Since phase 3 the code's
// schemas ARE the spec shapes, so this is nearly the identity — kept as the one seam a later schema
// change would touch. When a phase changes a schema, THIS file changes — no scenario does.

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

/** A fact's time as the extractor resolves it against the calendar table (spec §6): local ISO. */
export interface WhenSpec {
  start: string
  end?: string
  allDay?: boolean
}

export interface FactSpec {
  subject: string
  predicate: string
  object: string
  subjectKind?: 'person' | 'place' | 'org' | 'event' | 'thing'
  objectKind?: 'person' | 'place' | 'org' | 'event' | 'thing' | 'value'
  /**
   * When it happens. A string is the verbatim time phrase only ("this weekend") — the model gave no
   * resolved `when`, so the code's chrono FALLBACK reads the phrase. An object is the resolved `when`
   * (spec §6); `whenText` may ride along as the cross-check.
   */
  when?: string | WhenSpec
  whenText?: string
}

export const fact = (f: FactSpec): FactSpec => f

export function toExtractedFact(f: FactSpec): Record<string, unknown> {
  const { when, whenText, ...rest } = f
  if (typeof when === 'string') return { ...rest, whenText: when }
  return { ...rest, ...(when ? { when } : {}), ...(whenText ? { whenText } : {}) }
}

// ── Reminders (spec §6) ──────────────────────────────────────────────────────────────────────────

export interface ReminderSpec {
  content: string
  /** The time phrase as said ("friday 8pm"); '' = no time given. Without `fireAt` the code's chrono
   *  fallback reads it (the model resolved nothing itself). */
  when: string
  /** The moment the model resolved against the calendar table, local ISO ("2026-10-02T20:00"). */
  fireAt?: string
  /** RRULE-lite ("FREQ=WEEKLY;BYDAY=FR"). */
  recurrence?: string
  /** "remind me" (speaker) vs "remind us" (house). Omitted = the model did not say. */
  forWhom?: 'speaker' | 'house'
}

export const reminder = (r: ReminderSpec): ReminderSpec => r

/** A reminder fixture may return one reminder, several (A6), or null (not a reminder). */
export function toReminderOutput(r: ReminderSpec | ReminderSpec[] | null): Record<string, unknown> {
  const list = r == null ? [] : Array.isArray(r) ? r : [r]
  return {
    reminders: list.map((x) => ({
      content: x.content,
      fireAt: x.fireAt ?? '',
      whenText: x.when,
      recurrence: x.recurrence ?? '',
      ...(x.forWhom ? { forWhom: x.forWhom } : {}),
    })),
  }
}
