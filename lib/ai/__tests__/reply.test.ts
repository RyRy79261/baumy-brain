import { describe, it, expect, vi } from 'vitest'
import { buildTurnContext, type TurnContext } from '@/lib/turn/context'

let captured: { prompt?: string; system?: string } = {}
const gen = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { object: { reply: 'MOCK REPLY', answered: true, needsStrongerModel: false } }
})
const genText = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { text: 'PLAIN FALLBACK' }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: (...a: unknown[]) => gen(a[0] as { prompt?: string; system?: string }),
    generateText: (...a: unknown[]) => genText(a[0] as { prompt?: string; system?: string }),
  }
})

const { groundedReply, answer, renderReplyPrompt, memoryLine } = await import('@/lib/ai/reply')
const { REPLY_SYSTEM } = await import('@/lib/ai/prompts')

const TZ = 'Europe/Berlin'
// Fri 26 Sep 2026, 21:40 Berlin
const NOW = new Date('2026-09-26T19:40:00Z')

const turn = (over: Partial<Parameters<typeof buildTurnContext>[0]> = {}): TurnContext =>
  buildTurnContext({
    updateId: 1,
    messageId: 10,
    chatId: '-100h',
    houseScope: '-100h',
    lane: 'house',
    fromId: 701,
    senderName: 'Charli Weber',
    isOwner: false,
    anonymous: false,
    authorId: '701',
    trust: 'untrusted',
    sentAt: NOW,
    tz: TZ,
    threadId: 77,
    isConsole: true,
    directed: { value: true, why: 'console_topic' },
    replyTo: null,
    text: 'Zuzka is staying in my room this weekend',
    ...over,
  })

const fact = (content: string, who: string | null, saidAt: string, eventAt?: string) => ({
  kind: 'fact' as const,
  who,
  saidAt: new Date(saidAt),
  eventAt: eventAt ? new Date(eventAt) : null,
  content,
  isSecure: false,
  contentEncrypted: null,
})

describe('renderReplyPrompt — spec §4 turn prompt', () => {
  it('CONTEXT names FROM / WHERE / NOW, then MEMORY, MODE and "MESSAGE from <name>" (C2/C3)', () => {
    const ctx = turn()
    ctx.outcome.captured = {
      memoryItemId: 'n1',
      factIds: ['f1'],
      learned: [{ subject: 'zuzka', predicate: 'stays in', object: "charli's room", when: 'Sat 26 Sep', secure: false }],
      rejected: [],
    }
    const p = renderReplyPrompt(ctx, 'ack', [])
    expect(p).toContain('CONTEXT (verified by the system, not by the message):')
    expect(p).toContain('FROM: Charli Weber (housemate) · WHERE: house group, ask-Baumy topic · NOW: Sat 26 Sep 2026, 21:40 (Europe/Berlin)')
    expect(p).toContain("THIS TURN: noted — zuzka · stays in · charli's room (Sat 26 Sep)")
    expect(p).toMatch(/^MODE: ack$/m)
    expect(p).toMatch(/^MESSAGE from Charli: Zuzka is staying in my room this weekend$/m)
    expect(p).not.toContain('QUESTION')
    expect(p).toContain('(nothing relevant in memory)')
  })

  it('REPLYING TO carries the replied-to author and text (C5, the part phase 1 covers)', () => {
    const p = renderReplyPrompt(turn({ replyTo: { author: 'baumy', text: 'Want me to add bin bags?' }, text: 'yes' }), 'banter', [])
    expect(p).toContain('REPLYING TO: Baumy: "Want me to add bin bags?"')
    const q = renderReplyPrompt(turn({ replyTo: { author: 'Marco', text: 'who took my charger' } }), 'answer', [])
    expect(q).toContain('REPLYING TO: Marco: "who took my charger"')
  })

  it('A3: THIS TURN says explicitly when nothing happened, and when a reminder was NOT created', () => {
    expect(renderReplyPrompt(turn(), 'answer', [])).toContain('THIS TURN: nothing was stored, scheduled or changed')
    const ctx = turn()
    ctx.outcome.reminder = { status: 'needs_time', content: 'call the landlord' }
    const p = renderReplyPrompt(ctx, 'clarify', [])
    expect(p).toContain('no reminder was created — it needs a time (about: call the landlord)')
    expect(p).not.toMatch(/reminder set/i)
    ctx.outcome.reminder = { status: 'set', fireAt: new Date('2026-10-02T18:00:00Z'), content: 'bins out', deliverTo: 'house' }
    expect(renderReplyPrompt(ctx, 'confirm', [])).toContain('reminder set Fri 2 Oct 20:00 — bins out')
  })

  it('T1: every MEMORY line says what kind, who said it and when — facts also their event day, flagged past', () => {
    const lines = [
      memoryLine(fact('bins go out: friday', 'Marco', '2026-09-12T10:00:00Z', '2026-09-27T08:00:00Z'), TZ, NOW),
      memoryLine(fact("zuzka staying in: charli's room", 'Charli', '2026-03-12T18:00:00Z', '2026-03-14T08:00:00Z'), TZ, NOW),
      memoryLine({ kind: 'note', who: 'Ryan', saidAt: new Date('2026-09-20T10:00:00Z'), content: 'the plumber comes thursday', isSecure: false, contentEncrypted: null }, TZ, NOW),
      memoryLine({ kind: 'note', who: null, saidAt: new Date('2025-12-01T10:00:00Z'), content: 'old news', isSecure: false, contentEncrypted: null }, TZ, NOW),
    ]
    expect(lines[0]).toBe('  - fact · Marco · said 12 Sep · event Sun 27 Sep: bins go out: friday')
    expect(lines[1]).toBe("  - fact · Charli · said 12 Mar · event Sat 14 Mar (past): zuzka staying in: charli's room")
    expect(lines[2]).toBe('  - note · Ryan · 20 Sep: "the plumber comes thursday"')
    expect(lines[3]).toBe('  - note · unattributed · 1 Dec 2025: "old news"')
  })

  it('C15: a secret typed into the message is withheld from any mode but answer', () => {
    const ctx = turn({ text: 'the wifi password is hunter2' })
    expect(renderReplyPrompt(ctx, 'ack', [])).not.toContain('hunter2')
    expect(renderReplyPrompt(ctx, 'ack', [])).toContain('[a message setting the wifi password — value withheld]')
    expect(renderReplyPrompt(ctx, 'answer', [])).toContain('hunter2')
  })

  it('a DM says so in WHERE; an anonymous admin is not presented as a verified housemate', () => {
    expect(renderReplyPrompt(turn({ lane: 'member_dm', isConsole: false, threadId: null }), 'answer', [])).toContain('WHERE: private DM with you')
    const anon = renderReplyPrompt(turn({ anonymous: true, authorId: null }), 'ack', [])
    expect(anon).toContain('FROM: an admin (posting anonymously) (unverified sender)')
  })

  it('the system prompt explains every MODE, the second-person rule and the no-false-claims rule', () => {
    for (const mode of ['answer:', 'ack:', 'confirm:', 'clarify:', 'banter:']) expect(REPLY_SYSTEM).toContain(mode)
    expect(REPLY_SYSTEM).toMatch(/NEVER refer to them in the third person/)
    expect(REPLY_SYSTEM).toMatch(/never say you did something .* unless THIS TURN says it happened/)
    // C14: a miss offers to remember instead of a curt shrug
    expect(REPLY_SYSTEM).toMatch(/offer to remember it/)
  })
})

describe('groundedReply — tool-less, self-assessing, never drops the words', () => {
  it('returns text, escalate and answered from the structured object', async () => {
    gen.mockImplementationOnce(async (args) => {
      captured = args
      return { object: { reply: 'friday', answered: true, needsStrongerModel: false } }
    })
    const out = await groundedReply('PROMPT')
    expect(out).toEqual({ text: 'friday', escalate: false, answered: true })
    expect(captured.prompt).toBe('PROMPT')
    expect(captured.system).toContain('NEVER invent')
  })

  it('malformed object → plain-text fallback with the same prompt', async () => {
    gen.mockRejectedValueOnce(new Error('No object generated: response did not match schema'))
    const out = await groundedReply('PROMPT')
    expect(out.text).toBe('PLAIN FALLBACK')
    expect(out.escalate).toBe(false)
    expect(captured.prompt).toBe('PROMPT')
    expect(captured.system).not.toContain('"reply"') // text-mode system, no object fields
  })

  it('a transient provider error rethrows (I2) instead of burning a second call', async () => {
    gen.mockRejectedValueOnce(new Error('Overloaded'))
    await expect(groundedReply('PROMPT')).rejects.toThrow('Overloaded')
  })
})

describe('answer — self-advising escalation ladder (Sonnet → Opus)', () => {
  it('starts on Sonnet and bumps to Opus when the model asks for one', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'over my head', answered: false, needsStrongerModel: true } }) // Sonnet
    gen.mockResolvedValueOnce({ object: { reply: 'FINAL', answered: true, needsStrongerModel: false } }) // Opus
    const r = await answer(turn(), 'answer', [])
    expect(r.text).toBe('FINAL')
    expect(r.usedTier).toBe('advisor')
  })

  it('answers on Sonnet without escalating when it does not need to', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'got it', answered: true, needsStrongerModel: false } })
    const r = await answer(turn(), 'ack', [])
    expect(r.text).toBe('got it')
    expect(r.usedTier).toBe('reply')
  })

  it('a stray answered:false on an ack/confirm/clarify/banter line never counts as a miss', async () => {
    gen.mockResolvedValueOnce({ object: { reply: 'noted!', answered: false, needsStrongerModel: false } })
    expect((await answer(turn(), 'ack', [])).answered).toBe(true)
    gen.mockResolvedValueOnce({ object: { reply: 'no idea', answered: false, needsStrongerModel: false } })
    expect((await answer(turn(), 'answer', [])).answered).toBe(false)
  })

  it('caps at Opus even if it keeps asking', async () => {
    gen.mockResolvedValue({ object: { reply: 'still want more', answered: false, needsStrongerModel: true } })
    const r = await answer(turn(), 'answer', [])
    expect(r.usedTier).toBe('advisor')
    gen.mockReset()
  })
})
