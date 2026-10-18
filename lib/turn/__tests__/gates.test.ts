import { describe, it, expect } from 'vitest'
import { resolveOriginParts, type OriginParts, type Roster } from '@/lib/core/origin'
import { SAFE_VERDICT, type ClassifierVerdict } from '@/lib/ai/classify'
import { turnGates, type GateInput, type TurnGates } from '@/lib/turn/gates'

// Every precedence rule of the turn, in one table (lib/turn/gates.ts). The runner executes what these
// allow; the after-the-fact suppressions (a list op that happened is not captured, a private DM
// reminder is not captured) are pinned by the ingest/scenario suites.

const HOUSE = '-100house'
const roster: Roster = { isOwner: (id) => id === 1, isMember: (id) => id === 1 || id === 2 }
const origin = (p: Partial<OriginParts> = {}) => resolveOriginParts({ chatId: HOUSE, fromId: 2, text: 'x', isPrivate: false, ...p }, roster, HOUSE)
const DM = { chatId: '2', isPrivate: true }

const V = (v: Partial<ClassifierVerdict>): ClassifierVerdict => ({ ...SAFE_VERDICT, confidence: 0.9, replyValue: 0.9, ...v })
const STATEMENT = V({ intent: 'statement', worthRemembering: true })
const REMINDER = V({ intent: 'reminder', worthRemembering: true, asksBaumy: true })
const QUESTION = V({ intent: 'question', asksBaumy: true })
const FORGET = V({ intent: 'forget', asksBaumy: true })
const CANCEL = V({ intent: 'cancel_reminder', asksBaumy: true })
const LIST_ADD = V({ intent: 'request', worthRemembering: true, list: 'add' })

function gates(over: Partial<GateInput> & { o?: Partial<OriginParts> }): TurnGates {
  const { o, ...rest } = over
  return turnGates({
    origin: origin(o),
    verdict: STATEMENT,
    directed: false,
    authorId: '2',
    scope: HOUSE,
    windowable: true,
    enabled: true,
    isEdit: false,
    text: 'zofia arrives friday',
    ...rest,
  })
}

describe('turnGates — one action', () => {
  it('an undirected statement is captured, nothing else', () => {
    expect(gates({})).toMatchObject({ decision: 'capture', capture: true, list: false, olympics: false, reminder: 'none', forget: false, cancelReminder: false })
  })

  it('a question is never captured (I3), nor a question about a secret (I9)', () => {
    expect(gates({ verdict: QUESTION, text: "what's the wifi password?" }).capture).toBe(false)
    expect(gates({ verdict: QUESTION, directed: true }).decision).toBe('reply')
    // I9 on its own: a capturable request phrased as a question about a secret is still not captured.
    const ASK = V({ intent: 'request', worthRemembering: true })
    expect(gates({ verdict: ASK, text: 'can you send the plumber the address?' }).capture).toBe(true)
    expect(gates({ verdict: ASK, text: 'can you send me the wifi password?' }).capture).toBe(false)
  })

  it('a reminder needs a DIRECTED ask (A9); a directed one runs the reminder step', () => {
    expect(gates({ verdict: REMINDER }).reminder).toBe('none')
    expect(gates({ verdict: REMINDER, directed: true }).reminder).toBe('ask')
    expect(gates({ verdict: REMINDER, o: DM }).reminder).toBe('ask') // a DM is for Baumy
  })

  it('forget only proposes — never captured, never on an edit, the request withheld from the window', () => {
    const g = gates({ verdict: FORGET, directed: true })
    expect(g).toMatchObject({ decision: 'forget', forget: true, capture: false, withholdForget: true })
    expect(gates({ verdict: FORGET, directed: true, isEdit: true }).forget).toBe(false)
    // Below the confidence bar it is not a forget decision — but the text is still withheld.
    expect(gates({ verdict: { ...FORGET, confidence: 0.2 }, directed: true })).toMatchObject({ forget: false, withholdForget: true })
  })

  it('a reminder cancellation only proposes, directed only, never on an edit', () => {
    expect(gates({ verdict: CANCEL }).cancelReminder).toBe(false)
    expect(gates({ verdict: CANCEL, directed: true }).cancelReminder).toBe(true)
    expect(gates({ verdict: CANCEL, directed: true, isEdit: true }).cancelReminder).toBe(false)
  })
})

describe('turnGates — two actions in one message', () => {
  it('"remind us to buy bin bags friday": the reminder wins, the list op never preempts it', () => {
    const g = gates({ verdict: { ...REMINDER, list: 'add' }, directed: true })
    expect(g).toMatchObject({ reminder: 'ask', list: false })
    // …even when the reminder is not created because the ask was undirected (A9).
    expect(gates({ verdict: { ...REMINDER, list: 'add' } })).toMatchObject({ reminder: 'none', list: false })
  })

  it('a calendar add + "remind the group the day before": BOTH run (#18)', () => {
    const g = gates({ verdict: { ...REMINDER, olympics: 'calendar_add' }, directed: true })
    expect(g).toMatchObject({ reminder: 'ask', olympics: true })
  })

  it('any other Olympics op yields to a reminder ask', () => {
    expect(gates({ verdict: { ...REMINDER, olympics: 'chore_log' }, directed: true })).toMatchObject({ reminder: 'ask', olympics: false })
  })

  it('a list op and an Olympics op never both run', () => {
    expect(gates({ verdict: { ...LIST_ADD, olympics: 'calendar_add' }, directed: true })).toMatchObject({ list: true, olympics: false })
  })

  it('a list op is gated as capture-eligible here — the runner drops the capture once the op ran (A11)', () => {
    expect(gates({ verdict: LIST_ADD })).toMatchObject({ list: true, capture: true })
  })

  it('forget beats a reminder and a list op in the same message', () => {
    expect(gates({ verdict: { ...FORGET, list: 'add' }, directed: true })).toMatchObject({ forget: true, list: false, reminder: 'none' })
  })

  it('a reminder that also states a fact is still captured', () => {
    expect(gates({ verdict: REMINDER, directed: true })).toMatchObject({ reminder: 'ask', capture: true })
  })

  it('a follow-up may complete a reminder draft — but never when it is a list op, forget or cancel', () => {
    expect(gates({ verdict: STATEMENT, directed: true }).reminderDraft).toBe(true)
    expect(gates({ verdict: LIST_ADD, directed: true }).reminderDraft).toBe(false)
    expect(gates({ verdict: FORGET, directed: true }).reminderDraft).toBe(false)
    expect(gates({ verdict: CANCEL, directed: true }).reminderDraft).toBe(false)
    expect(gates({ verdict: STATEMENT }).reminderDraft).toBe(false) // undirected
  })
})

describe('turnGates — pause, edits, relayed content', () => {
  it('paused: the group goes silent, a DM still works; a reminder ask is an explicit "paused" outcome', () => {
    const g = gates({ verdict: { ...LIST_ADD }, enabled: false })
    expect(g).toMatchObject({ canSpeak: false, list: false, keepRemindersForEdit: true })
    expect(gates({ verdict: LIST_ADD, enabled: false, o: DM })).toMatchObject({ canSpeak: true, list: true })
    expect(gates({ verdict: REMINDER, directed: true, enabled: false }).reminder).toBe('paused')
    expect(gates({ verdict: REMINDER, enabled: false, o: DM }).reminder).toBe('paused') // reminders honour pause in BOTH lanes
    expect(gates({ verdict: FORGET, directed: true, enabled: false }).forget).toBe(false)
    expect(gates({ verdict: FORGET, enabled: false, o: DM }).forget).toBe(true)
    expect(gates({ verdict: STATEMENT, directed: true, enabled: false }).reminderDraft).toBe(false)
  })

  it('a forwarded message drives nothing (D4) — it may still be captured, labelled', () => {
    const fwd = { isForwarded: true }
    expect(gates({ o: fwd, authorId: null, verdict: { ...REMINDER, list: 'add', olympics: 'calendar_add' }, directed: true })).toMatchObject({
      reminder: 'none',
      list: false,
      olympics: false,
      reminderDraft: false,
    })
    expect(gates({ o: fwd, authorId: null, verdict: V({ intent: 'question', worthRemembering: true }) }).capture).toBe(true)
  })

  it('no house configured: no list, Olympics, draft or cancellation', () => {
    const g = gates({ scope: '', verdict: { ...LIST_ADD, olympics: 'calendar_add' }, directed: true })
    expect(g).toMatchObject({ list: false, olympics: false, reminderDraft: false })
    expect(gates({ scope: '', verdict: CANCEL, directed: true }).cancelReminder).toBe(false)
  })

  it('an edit never runs an Olympics op (it never speaks)', () => {
    expect(gates({ verdict: V({ intent: 'request', olympics: 'standings' }), directed: true, isEdit: true }).olympics).toBe(false)
  })
})
