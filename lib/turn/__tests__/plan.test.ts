import { describe, it, expect } from 'vitest'
import { planResponse, type Plan } from '@/lib/turn/plan'
import { buildTurnContext, type TurnContext, type TurnOutcome } from '@/lib/turn/context'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import { SAFE_VERDICT } from '@/lib/ai/classify'
import type { ResponsePolicy } from '@/lib/policy'
import type { DirectedWhy } from '@/lib/pipeline/directed'

// The response planner, row by row (docs/spec/chat-understanding-v2.md §3). Pure: every case builds a
// TurnContext + policy and asserts the Plan (kind, mode, emoji, which row fired). The table is the
// spec; if a row changes here it must change there.

const POLICY: ResponsePolicy = {
  global_enabled: true,
  categories: {},
  confidence_threshold: 0.7,
  muted_topics: [],
  reply_frequency: 'quiet', // floor 0.85
  reminder_frequency: 'twice',
}
const PAUSED: ResponsePolicy = { ...POLICY, global_enabled: false }

const V = (o: Partial<ClassifierVerdict> = {}): ClassifierVerdict => ({
  intent: 'chatter',
  asksBaumy: false,
  worthRemembering: false,
  confidence: 0.9,
  replyValue: 0.9,
  vibe: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
  ...o,
})

interface Case {
  lane?: 'house' | 'member_dm'
  why?: DirectedWhy | null
  trust?: 'untrusted' | 'trusted' | 'quarantined' | 'forwarded'
  edit?: { processed: boolean }
  verdict?: ClassifierVerdict | undefined
  outcome?: TurnOutcome
  text?: string
  policy?: ResponsePolicy
}

function ctx(c: Case): TurnContext {
  const lane = c.lane ?? 'house'
  const why = lane === 'member_dm' ? 'dm' : (c.why ?? null)
  const t = buildTurnContext({
    updateId: 1,
    messageId: 1,
    chatId: lane === 'house' ? '-100h' : '701',
    houseScope: '-100h',
    lane,
    fromId: 701,
    senderName: 'Charli',
    isOwner: false,
    anonymous: false,
    authorId: '701',
    trust: c.trust ?? (lane === 'member_dm' ? 'trusted' : 'untrusted'),
    sentAt: new Date('2026-09-26T19:40:00Z'),
    tz: 'Europe/Berlin',
    threadId: why === 'console_topic' ? 77 : null,
    isConsole: why === 'console_topic',
    directed: { value: why != null, why },
    replyTo: null,
    text: c.text ?? 'some message',
    edit: c.edit ?? null,
  })
  t.verdict = 'verdict' in c ? c.verdict : V()
  t.outcome = c.outcome ?? {}
  return t
}
const plan = (c: Case): Plan => planResponse(ctx(c), c.policy ?? POLICY)

const CAPTURED: TurnOutcome['captured'] = { memoryItemId: 'n1', factIds: [], learned: [], rejected: [] }
const set = (): TurnOutcome['reminder'] => ({ status: 'set', fireAt: new Date('2026-10-02T18:00:00Z'), content: 'bins', deliverTo: 'house' })
const list = (o: Partial<NonNullable<TurnOutcome['list']>>): TurnOutcome['list'] => ({ op: 'add', added: [], already: [], checkedOff: [], notFound: [], open: [], ...o })
const DIRECTED_WHYS: DirectedWhy[] = ['mention', 'reply_to_baumy', 'name', 'console_topic']

describe('planResponse — pause and trust', () => {
  it('paused (house lane) → none, whatever the message', () => {
    expect(plan({ policy: PAUSED, why: 'mention', verdict: V({ intent: 'question', asksBaumy: true }) })).toEqual({ kind: 'none', row: 'paused' })
    expect(plan({ policy: PAUSED, verdict: V({ intent: 'statement' }), outcome: { captured: CAPTURED } })).toMatchObject({ row: 'paused' })
    expect(plan({ policy: PAUSED, outcome: { reminder: set() } })).toMatchObject({ row: 'paused' })
  })
  it('paused does NOT silence a DM (the bypass is lane-scoped)', () => {
    expect(plan({ policy: PAUSED, lane: 'member_dm', verdict: V({ intent: 'question' }) })).toMatchObject({ kind: 'words', mode: 'answer' })
  })
  it('member-FORWARDED content (D4): ✍ when kept in the group, silence when not, the deterministic ack in a DM — never an answer', () => {
    expect(plan({ trust: 'forwarded', verdict: V({ intent: 'statement' }), outcome: { captured: CAPTURED } })).toEqual({ kind: 'react', emoji: '✍', row: 'forwarded-captured' })
    expect(plan({ trust: 'forwarded', verdict: V({ intent: 'chatter' }) })).toEqual({ kind: 'none', row: 'forwarded' })
    expect(plan({ trust: 'forwarded', why: 'mention', verdict: V({ intent: 'question', asksBaumy: true }) })).toEqual({ kind: 'none', row: 'forwarded' })
    expect(plan({ trust: 'forwarded', lane: 'member_dm', verdict: V({ intent: 'question' }) })).toEqual({ kind: 'forward-ack', row: 'forwarded-dm' })
    expect(plan({ trust: 'forwarded', policy: PAUSED, outcome: { captured: CAPTURED } })).toMatchObject({ row: 'paused' })
  })
  it('bot (quarantined) content never gets a voice — not even a ✍', () => {
    expect(plan({ trust: 'quarantined', verdict: V({ intent: 'statement' }), outcome: { captured: CAPTURED } })).toEqual({ kind: 'none', row: 'quarantined' })
    expect(plan({ trust: 'quarantined', why: 'mention', verdict: V({ intent: 'question', asksBaumy: true }) })).toMatchObject({ row: 'quarantined' })
  })
})

describe('planResponse — edits never speak in words (I1)', () => {
  const both = [{ processed: true }, { processed: false }]
  it('a directed question edit → silence (it was already answered, or would land under an old message)', () => {
    for (const edit of both) expect(plan({ edit, why: 'mention', verdict: V({ intent: 'question', asksBaumy: true }) })).toEqual({ kind: 'none', row: 'edit-silent' })
  })
  it('a re-set reminder → 👍 instead of the worded confirm; a re-noted statement → ✍ instead of the ack', () => {
    for (const edit of both) {
      expect(plan({ edit, why: 'mention', verdict: V({ intent: 'reminder' }), outcome: { reminder: set() } })).toEqual({ kind: 'react', emoji: '👍', row: 'edit-reminder' })
      expect(plan({ edit, why: 'mention', verdict: V({ intent: 'statement' }), outcome: { captured: CAPTURED } })).toEqual({ kind: 'react', emoji: '✍', row: 'edit-noted' })
    }
  })
  it('reactions pass through unchanged; a list or forget flow that would need words goes quiet', () => {
    expect(plan({ edit: { processed: true }, verdict: V({ intent: 'statement' }), outcome: { captured: CAPTURED } })).toEqual({ kind: 'react', emoji: '✍', row: 'statement-captured' })
    expect(plan({ edit: { processed: true }, lane: 'member_dm', verdict: V({ intent: 'question', list: 'query' }), outcome: { list: list({ op: 'query' }) } })).toEqual({ kind: 'none', row: 'edit-silent' })
    expect(plan({ edit: { processed: true }, why: 'mention', verdict: V({ intent: 'statement' }), outcome: { captured: { ...CAPTURED, conflicts: [{ fact: { subject: 'a', predicate: 'b', object: 'c', when: null, secure: false }, current: { object: 'd', by: null, saidAt: null } }] } } })).toEqual({ kind: 'none', row: 'edit-silent' })
  })
})

describe('planResponse — forget', () => {
  it('a proposed forget → the forget flow (confirm card)', () => {
    expect(plan({ verdict: V({ intent: 'forget' }), outcome: { forget: { proposed: true, pendingId: 'p', card: 'c' } } })).toEqual({ kind: 'forget', row: 'forget' })
  })
  it('nothing to forget / too vague / notes only → the forget flow (its deterministic explanation)', () => {
    for (const reason of ['nothing', 'vague', 'notes_only'] as const) {
      expect(plan({ verdict: V({ intent: 'forget' }), outcome: { forget: { proposed: false, reason } } })).toMatchObject({ kind: 'forget' })
    }
  })
  it('the extractor said it was not a forget request → treated as an ordinary ask', () => {
    const o: TurnOutcome = { forget: { proposed: false, reason: 'not_forget' } }
    expect(plan({ why: 'mention', verdict: V({ intent: 'forget' }), outcome: o })).toMatchObject({ kind: 'words', mode: 'answer', row: 'ask-directed' })
    expect(plan({ verdict: V({ intent: 'forget' }), outcome: o })).toMatchObject({ kind: 'none', row: 'ask-housemates' })
  })
})

describe('planResponse — list (K4 store outcome, A10 continue to the question)', () => {
  it('group add: something new → ✍; everything already there → 👀', () => {
    expect(plan({ verdict: V({ list: 'add' }), outcome: { list: list({ added: ['milk'] }) } })).toEqual({ kind: 'react', emoji: '✍', row: 'list' })
    expect(plan({ verdict: V({ list: 'add' }), outcome: { list: list({ already: ['milk'] }) } })).toEqual({ kind: 'react', emoji: '👀', row: 'list' })
  })
  it('group check-off: all ticked → 👍; anything not found → words', () => {
    expect(plan({ outcome: { list: list({ op: 'checkoff', checkedOff: ['milk'] }) } })).toEqual({ kind: 'react', emoji: '👍', row: 'list' })
    expect(plan({ outcome: { list: list({ op: 'checkoff', checkedOff: ['milk'], notFound: ['eggs'] }) } })).toEqual({ kind: 'list-words', row: 'list' })
    expect(plan({ outcome: { list: list({ op: 'checkoff', notFound: ['eggs'] }) } })).toEqual({ kind: 'list-words', row: 'list' })
  })
  it('a query (either lane) and every DM op → words', () => {
    expect(plan({ verdict: V({ intent: 'question', list: 'query' }), outcome: { list: list({ op: 'query' }) } })).toMatchObject({ kind: 'list-words' })
    expect(plan({ lane: 'member_dm', outcome: { list: list({ added: ['milk'] }) } })).toMatchObject({ kind: 'list-words' })
    expect(plan({ lane: 'member_dm', outcome: { list: list({ op: 'checkoff', checkedOff: ['milk'] }) } })).toMatchObject({ kind: 'list-words' })
  })
  it('A10: a list op that ALSO asks a question → the question is answered, the list ack rides along', () => {
    const q = V({ intent: 'question', asksBaumy: true, list: 'add' })
    expect(plan({ why: 'mention', verdict: q, outcome: { list: list({ added: ['coffee'] }) } })).toEqual({
      kind: 'words',
      mode: 'answer',
      row: 'ask-directed',
      onMiss: 'words',
      alsoReact: '✍',
    })
    // a DM list ack would need words → it goes into THIS TURN instead (no second message)
    expect(plan({ lane: 'member_dm', verdict: q, outcome: { list: list({ added: ['coffee'] }) } })).toMatchObject({ kind: 'words', mode: 'answer' })
    expect(plan({ lane: 'member_dm', verdict: q, outcome: { list: list({ added: ['coffee'] }) } })).not.toHaveProperty('alsoReact')
  })
  it('a list op + a question for someone else / below the floor → just the list ack', () => {
    expect(plan({ verdict: V({ intent: 'question', asksBaumy: false, list: 'add' }), outcome: { list: list({ added: ['coffee'] }) } })).toEqual({
      kind: 'react',
      emoji: '✍',
      row: 'list',
    })
    expect(plan({ verdict: V({ intent: 'question', asksBaumy: true, replyValue: 0.5, list: 'add' }), outcome: { list: list({ added: ['coffee'] }) } })).toMatchObject({
      kind: 'react',
      emoji: '✍',
    })
  })
  it('a list REQUEST ("@baumy add coffee") is acked from the store, not "answered"', () => {
    expect(plan({ why: 'mention', verdict: V({ intent: 'request', asksBaumy: true, list: 'add' }), outcome: { list: list({ added: ['coffee'] }) } })).toEqual({
      kind: 'react',
      emoji: '✍',
      row: 'list',
    })
  })
})

describe('planResponse — reminders (A2/A3/A9)', () => {
  it('set + directed (every why) or DM → confirm words', () => {
    for (const why of DIRECTED_WHYS) expect(plan({ why, outcome: { reminder: set() } })).toEqual({ kind: 'words', mode: 'confirm', row: 'reminder-set' })
    expect(plan({ lane: 'member_dm', outcome: { reminder: set() } })).toMatchObject({ mode: 'confirm' })
  })
  it('set + undirected → 👍 (unreachable in practice: undirected reminders are not created)', () => {
    expect(plan({ outcome: { reminder: set() } })).toEqual({ kind: 'react', emoji: '👍', row: 'reminder-set-undirected' })
  })
  it('needs_time / past / unparsed + directed or DM → clarify words; undirected → none (never ✍)', () => {
    for (const status of ['needs_time', 'past', 'unparsed'] as const) {
      const o = { reminder: { status, content: 'call the landlord' } }
      expect(plan({ why: 'mention', outcome: o, verdict: V({ intent: 'reminder' }) })).toEqual({ kind: 'words', mode: 'clarify', row: 'reminder-failed' })
      expect(plan({ lane: 'member_dm', outcome: o })).toMatchObject({ mode: 'clarify' })
      expect(plan({ outcome: { ...o, captured: CAPTURED } })).toEqual({ kind: 'none', row: 'reminder-failed-undirected' })
    }
  })
  it('A9: an undirected "remind us" (never created) is silent — even if its facts were captured', () => {
    expect(plan({ verdict: V({ intent: 'reminder', worthRemembering: true }), outcome: { captured: CAPTURED } })).toEqual({ kind: 'none', row: 'reminder-undirected' })
  })
  it('a DM reminder while the house is paused → answer words (THIS TURN says why), never a vague "didn\'t set it"', () => {
    const o = { reminder: { status: 'paused' as const } }
    expect(plan({ lane: 'member_dm', policy: PAUSED, verdict: V({ intent: 'reminder' }), outcome: o })).toEqual({
      kind: 'words',
      mode: 'answer',
      onMiss: 'words',
      row: 'reminder-paused',
    })
    expect(plan({ why: 'mention', policy: PAUSED, outcome: o })).toEqual({ kind: 'none', row: 'paused' }) // the group stays silent
  })
  it('directed, but the extractor found no reminder in it → answer (the reply is told nothing was set)', () => {
    expect(plan({ why: 'mention', verdict: V({ intent: 'reminder' }) })).toMatchObject({ kind: 'words', mode: 'answer', row: 'reminder-not-extracted' })
  })
})

describe('planResponse — degraded triage (K5)', () => {
  it('a DM or directed message still gets an answer when triage produced no usable object', () => {
    expect(plan({ lane: 'member_dm', verdict: SAFE_VERDICT })).toMatchObject({ kind: 'words', mode: 'answer', row: 'degraded-directed' })
    expect(plan({ why: 'mention', verdict: SAFE_VERDICT })).toMatchObject({ kind: 'words', mode: 'answer' })
    expect(plan({ why: 'mention', verdict: undefined })).toMatchObject({ kind: 'words', mode: 'answer' })
  })
  it('undirected group text with a degraded verdict → none', () => {
    expect(plan({ verdict: SAFE_VERDICT })).toEqual({ kind: 'none', row: 'degraded' })
  })
})

describe('planResponse — questions and requests', () => {
  for (const intent of ['question', 'request'] as const) {
    it(`${intent}, directed by mention / reply / name → answer, and a miss is still words`, () => {
      for (const why of ['mention', 'reply_to_baumy', 'name'] as const) {
        for (const asksBaumy of [true, false]) {
          expect(plan({ why, verdict: V({ intent, asksBaumy }) })).toEqual({ kind: 'words', mode: 'answer', row: 'ask-directed', onMiss: 'words' })
        }
      }
    })
    it(`${intent} in a DM → answer (bypasses the floor + muted topics)`, () => {
      expect(plan({ lane: 'member_dm', verdict: V({ intent, confidence: 0.1 }), text: 'bins?', policy: { ...POLICY, muted_topics: ['bins'] } })).toMatchObject({
        kind: 'words',
        mode: 'answer',
        onMiss: 'words',
      })
    })
    it(`${intent} in the ask-Baumy topic → answer when asksBaumy; housemates asking each other there → none (C6)`, () => {
      expect(plan({ why: 'console_topic', verdict: V({ intent, asksBaumy: true }) })).toMatchObject({ kind: 'words', mode: 'answer', row: 'ask-directed' })
      expect(plan({ why: 'console_topic', verdict: V({ intent, asksBaumy: false }) })).toEqual({ kind: 'none', row: 'ask-console-housemates' })
    })
    it(`${intent}, undirected, asksBaumy, clears the floor → answer with an ambient miss as 👎`, () => {
      expect(plan({ verdict: V({ intent, asksBaumy: true, replyValue: 0.9 }) })).toEqual({ kind: 'words', mode: 'answer', row: 'ask-undirected', onMiss: '👎' })
    })
    it(`${intent}, undirected, asksBaumy, below the reply floor or a muted topic → none`, () => {
      expect(plan({ verdict: V({ intent, asksBaumy: true, replyValue: 0.8 }) })).toEqual({ kind: 'none', row: 'ask-undirected-below-floor' })
      expect(plan({ verdict: V({ intent, asksBaumy: true, replyValue: 0.8 }), policy: { ...POLICY, reply_frequency: 'chatty' } })).toMatchObject({ kind: 'words' })
      expect(plan({ verdict: V({ intent, asksBaumy: true }), text: 'when are the bins?', policy: { ...POLICY, muted_topics: ['bins'] } })).toMatchObject({
        kind: 'none',
      })
    })
    // I6, second half: the floor measures how useful a volunteered answer would be (triage replyValue),
    // never the certainty of the intent label — the audit's two cases, now the right way round.
    it(`${intent}, undirected: the floor reads replyValue, never confidence (I6)`, () => {
      // a rhetorical question triage is SURE about is still not worth volunteering an answer to
      expect(plan({ verdict: V({ intent, asksBaumy: true, confidence: 0.95, replyValue: 0.2 }), text: 'who even ate my yogurt lol?' })).toEqual({
        kind: 'none',
        row: 'ask-undirected-below-floor',
      })
      // a genuinely useful question with an ambiguous label is answered (default 'quiet' floor, 0.85)
      expect(plan({ verdict: V({ intent, asksBaumy: true, confidence: 0.6, replyValue: 0.9 }), text: 'is the plumber still coming or' })).toEqual({
        kind: 'words',
        mode: 'answer',
        row: 'ask-undirected',
        onMiss: '👎',
      })
    })
    it(`${intent}, undirected, not asksBaumy (housemates talking) → none (C6)`, () => {
      expect(plan({ verdict: V({ intent, asksBaumy: false, confidence: 1 }) })).toEqual({ kind: 'none', row: 'ask-housemates' })
    })
  }
})

describe('planResponse — statements (C3/C4/K3)', () => {
  it('directed (every why) or DM → ack words — never an "answer" to itself', () => {
    for (const why of DIRECTED_WHYS) expect(plan({ why, verdict: V({ intent: 'statement' }) })).toEqual({ kind: 'words', mode: 'ack', row: 'statement-directed' })
    expect(plan({ lane: 'member_dm', verdict: V({ intent: 'statement' }), outcome: { captured: CAPTURED } })).toMatchObject({ kind: 'words', mode: 'ack' })
  })
  it('undirected + something captured → ✍ (and never a 👎 on news)', () => {
    expect(plan({ verdict: V({ intent: 'statement', worthRemembering: true, vibe: '🎉' }), outcome: { captured: CAPTURED } })).toEqual({
      kind: 'react',
      emoji: '✍',
      row: 'statement-captured',
    })
  })
  it('undirected, nothing captured → its vibe, else none (no more 👀-on-everything)', () => {
    expect(plan({ verdict: V({ intent: 'statement', vibe: '🔥' }) })).toEqual({ kind: 'react', emoji: '🔥', row: 'vibe' })
    expect(plan({ verdict: V({ intent: 'statement' }) })).toEqual({ kind: 'none', row: 'otherwise' })
  })
})

describe('planResponse — banter and chatter', () => {
  it('banter directed at Baumy → banter words; undirected banter → vibe or none', () => {
    for (const why of DIRECTED_WHYS) expect(plan({ why, verdict: V({ intent: 'banter' }) })).toEqual({ kind: 'words', mode: 'banter', row: 'banter-directed' })
    expect(plan({ verdict: V({ intent: 'banter', vibe: '😁' }) })).toEqual({ kind: 'react', emoji: '😁', row: 'vibe' })
    expect(plan({ verdict: V({ intent: 'banter' }) })).toEqual({ kind: 'none', row: 'otherwise' })
  })
  it('chatter with a vibe → react the vibe (directed or not); otherwise none', () => {
    expect(plan({ verdict: V({ intent: 'chatter', vibe: '🤯' }) })).toEqual({ kind: 'react', emoji: '🤯', row: 'vibe' })
    expect(plan({ why: 'mention', verdict: V({ intent: 'chatter', vibe: '🎉' }) })).toEqual({ kind: 'react', emoji: '🎉', row: 'vibe' })
    expect(plan({ verdict: V({ intent: 'chatter' }) })).toEqual({ kind: 'none', row: 'otherwise' })
    expect(plan({ lane: 'member_dm', verdict: V({ intent: 'chatter' }) })).toEqual({ kind: 'none', row: 'otherwise' })
  })
})

describe('planResponse — reactions are always Bot-API-valid', () => {
  it('every emoji the planner can return is in PLANNER_EMOJI', async () => {
    const { PLANNER_EMOJI } = await import('@/lib/turn/emoji')
    const vibes = ['🔥', '🎉', '🤯', '😁'] as const
    for (const v of vibes) expect(PLANNER_EMOJI).toContain(v)
    for (const e of ['✍', '👍', '👎', '👀']) expect(PLANNER_EMOJI).toContain(e)
  })
})

// Spec §7 (F5): a correction the trust gate refused is kept as a conflict — Baumy asks which is right,
// directed or not, never a ✍ that claims it was taken. Pause still silences the group.
describe('planResponse — fact conflict', () => {
  const conflict: TurnOutcome = {
    captured: {
      ...CAPTURED!,
      conflicts: [
        {
          fact: { subject: 'zuzka', predicate: 'stays in', object: 'the cave', when: null, secure: false },
          current: { object: "charli's room", by: 'Charli', saidAt: '2026-09-25T10:00:00.000Z' },
        },
      ],
    },
  }
  it('undirected and directed statements → clarify', () => {
    expect(plan({ verdict: V({ intent: 'statement', worthRemembering: true }), outcome: conflict })).toEqual({ kind: 'words', mode: 'clarify', row: 'statement-conflict' })
    expect(plan({ why: 'mention', verdict: V({ intent: 'statement', worthRemembering: true }), outcome: conflict })).toMatchObject({ mode: 'clarify', row: 'statement-conflict' })
    expect(plan({ lane: 'member_dm', verdict: V({ intent: 'statement', worthRemembering: true }), outcome: conflict })).toMatchObject({ mode: 'clarify' })
  })
  it('an undirected info-carrying request with a conflict asks too (never silent)', () => {
    expect(plan({ verdict: V({ intent: 'request', worthRemembering: true, asksBaumy: false }), outcome: conflict })).toMatchObject({ mode: 'clarify', row: 'statement-conflict' })
  })
  it('paused → none; quarantined never gets here (no facts)', () => {
    expect(plan({ policy: PAUSED, verdict: V({ intent: 'statement' }), outcome: conflict })).toMatchObject({ kind: 'none', row: 'paused' })
  })
})
