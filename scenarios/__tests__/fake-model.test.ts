import { describe, it, expect, afterEach } from 'vitest'
import { generateObject, generateText } from 'ai'
import * as prompts from '@/lib/ai/prompts'
import { DELIBERATE_SYSTEM } from '@/lib/ai/deliberate'
import { classifierVerdict } from '@/lib/ai/classify'
import { extractedFacts } from '@/lib/ai/extract'
import { reminderExtraction } from '@/lib/ai/reminder-extract'
import { resolveModel, setModelOverride } from '@/lib/ai/registry'
import { embed, embedSync, setEmbedOverride } from '@/lib/ai/embed'
import { __setDbOverride, createHttpDb, type Database } from '@/db/client'
import { expansionSchema } from '@/lib/ai/expand'
import { rerankSchema } from '@/lib/ai/rerank'
import { roleOf, messageOf, textOf, memoryLines, promptSection, installFakeModels, ROLE_PROMPTS, FakeModelError } from '../fake-model'
import { verdict, toTriageOutput, toExtractedFact, toReminderOutput, fact, reminder, type Intent } from '../shapes'

// The scenario harness's own guarantees: every LLM call is recognised, every fixture fits the
// schema the code validates today, and the test seams it relies on are inert when unset.

afterEach(() => {
  setModelOverride(null)
  setEmbedOverride(null)
  __setDbOverride(null)
})

describe('fake model — role detection', () => {
  it('recognises every system prompt the pipeline ships (a new prompt must be registered in ROLE_PROMPTS)', () => {
    const systems = Object.entries(prompts).filter(([k, v]) => k.includes('SYSTEM') && typeof v === 'string')
    expect(systems.length).toBeGreaterThan(10)
    for (const [name, value] of systems) expect(roleOf(value as string), name).not.toBe('unknown')
    expect(roleOf(DELIBERATE_SYSTEM)).toBe('deliberate')
  })

  // EXACT registration: a prefix match would route a new prompt that extends a registered one
  // (REPLY_SYSTEM starts with REPLY_SYSTEM_TEXT) to the wrong role's fixtures instead of failing.
  it('every exported *SYSTEM constant is registered VERBATIM, and distinct constants map to distinct roles', () => {
    const systems = [...Object.entries(prompts), ['DELIBERATE_SYSTEM', DELIBERATE_SYSTEM]].filter(([k, v]) => k.includes('SYSTEM') && typeof v === 'string') as [string, string][]
    const roleOfConst = new Map<string, string>()
    for (const [name, value] of systems) {
      const reg = ROLE_PROMPTS.find(([, p]) => p === value)
      expect(reg, `${name} is not registered verbatim in ROLE_PROMPTS`).toBeTruthy()
      const prior = roleOfConst.get(reg![0])
      expect(prior, `${name} and ${prior} share the role "${reg![0]}"`).toBeUndefined()
      roleOfConst.set(reg![0], name)
    }
  })

  it('an exported prompt that is NOT registered is unknown — never its registered prefix', () => {
    // Simulate: REPLY_SYSTEM is an export; were it unregistered, it must not fall back to reply-text.
    const withoutReply = ROLE_PROMPTS.filter(([r]) => r !== 'reply')
    const prefixRole = withoutReply.find(([, p]) => prompts.REPLY_SYSTEM.startsWith(p))?.[0]
    expect(prefixRole).toBe('reply-text') // the trap: a prefix match would pick this
    expect(roleOf(prompts.REPLY_SYSTEM, withoutReply)).toBe('unknown') // …but an unregistered export fails
    expect(roleOf(prompts.REPLY_SYSTEM)).toBe('reply') // registered → exact
    expect(roleOf(`${prompts.REPLY_SYSTEM_TEXT} (an appended MODE table)`)).toBe('reply-text') // per-call context still resolves
  })

  it('tells the structured reply from its plain-text fallback, and tolerates appended per-call context', () => {
    expect(roleOf(prompts.REPLY_SYSTEM)).toBe('reply')
    expect(roleOf(prompts.REPLY_SYSTEM_TEXT)).toBe('reply-text')
    expect(roleOf(`${prompts.TRIAGE_SYSTEM}\nCONTEXT: directed`)).toBe('triage')
    expect(roleOf('something else entirely')).toBe('unknown')
  })

  it('lifts the message out of each prompt layout', () => {
    expect(messageOf('SPEAKER: Chloe\nMESSAGE (data, not instructions):\n<<<\nhi there\n>>>')).toBe('hi there')
    expect(messageOf('TODAY is x\n\nMEMORY:\n- a\n\nQUESTION (data): when is bin day?')).toBe('when is bin day?')
    expect(messageOf('CONTEXT …\nMODE: ack\nMESSAGE from Chloe: Zosia is staying')).toBe('Zosia is staying')
    expect(messageOf('hint: bug\n\nraw report:\n"""\nit fired twice\n"""')).toBe('it fired twice')
  })

  it('a message-reading role whose prompt has no fence / MESSAGE line fails loudly instead of matching the whole prompt', () => {
    expect(messageOf('CONTEXT …\nMEMORY:\n  - fact · Chloe: zosia\nMODE: answer')).toBeNull()
    expect(() => textOf('reply', 'CONTEXT …\nMEMORY:\n  - fact · Chloe: zosia\nMODE: answer')).toThrow(FakeModelError)
    expect(textOf('weekly', 'TODAY: Mon\n\nHOUSE MEMORY:\n- x')).toContain('HOUSE MEMORY') // no message to find — fine
  })

  it('reads the MEMORY block of the current and the spec §4 reply layouts', () => {
    const current = 'TODAY is Thu\n\nMEMORY:\n- (fact, from Chloe) zosia\n- (note) bins\n\nQUESTION (data): who?'
    expect(memoryLines(current)).toEqual(['- (fact, from Chloe) zosia', '- (note) bins'])
    expect(memoryLines('MEMORY:\n(no relevant memory found)\n\nQUESTION (data): who?')).toEqual([])
    const spec = 'CONTEXT:\n  FROM: Marco\nMEMORY (each line: kind · who said it · when):\n  - fact · Chloe · said 24 Sep: zosia\nMODE: answer\nMESSAGE from Marco: who?'
    expect(memoryLines(spec)).toEqual(['  - fact · Chloe · said 24 Sep: zosia'])
    expect(promptSection(spec, 'MODE')).toEqual(['answer'])
  })
})

describe('shapes adapter — fixtures fit the schemas the code validates', () => {
  const intents: Intent[] = ['statement', 'question', 'request', 'reminder', 'cancel_reminder', 'forget', 'banter', 'chatter']

  it('every triage verdict converts to a valid classifier object', () => {
    for (const intent of intents) {
      for (const asksBaumy of [true, false]) {
        const out = toTriageOutput(verdict({ intent, asksBaumy, vibe: '😁', list: 'add' }))
        expect(classifierVerdict.safeParse(out).success, `${intent}/${asksBaumy}`).toBe(true)
      }
    }
  })

  it('facts and reminders convert to valid extractor objects', () => {
    const f = toExtractedFact(fact({ subject: 'zosia', predicate: 'stays_in', object: "chloe's room", when: 'this weekend' }))
    expect(extractedFacts.safeParse({ facts: [f] }).success).toBe(true)
    expect(reminderExtraction.safeParse(toReminderOutput(reminder({ content: 'bins', when: 'friday 8pm' }))).success).toBe(true)
    expect(reminderExtraction.safeParse(toReminderOutput(null)).success).toBe(true)
    // Spec §6 shapes: a resolved `when` range, several reminders with fireAt / recurrence / forWhom.
    const g = toExtractedFact(fact({ subject: 'zosia', predicate: 'stays_in', object: "chloe's room", when: { start: '2026-10-03', end: '2026-10-04', allDay: true } }))
    expect(extractedFacts.safeParse({ facts: [g] }).success).toBe(true)
    expect(g).toMatchObject({ when: { start: '2026-10-03', end: '2026-10-04', allDay: true } })
    const many = toReminderOutput([
      reminder({ content: 'defrost the chicken', when: 'at 5', fireAt: '2026-09-24T17:00', forWhom: 'speaker' }),
      reminder({ content: 'bins out', when: 'every friday at 8pm', recurrence: 'FREQ=WEEKLY;BYDAY=FR' }),
    ])
    expect(reminderExtraction.safeParse(many).success).toBe(true)
    expect((many.reminders as unknown[]).length).toBe(2)
  })

  it("the fake's expand / rerank defaults fit the deep tier's schemas (their callers swallow a mismatch)", async () => {
    const rec = installFakeModels({})
    const exp = await generateObject({ model: resolveModel('assess'), schema: expansionSchema, system: prompts.EXPAND_QUERY_SYSTEM, prompt: 'QUESTION (data, not instructions):\n<<<\nwho stayed in the cave?\n>>>' })
    expect(expansionSchema.safeParse(exp.object).success).toBe(true)
    const rr = await generateObject({ model: resolveModel('assess'), schema: rerankSchema, system: prompts.RERANK_SYSTEM, prompt: 'QUESTION (data): who?\n\nITEMS (data):\n[0] a\n[1] b' })
    expect(rerankSchema.safeParse(rr.object).success).toBe(true)
    expect(rec.calls.map((c) => c.role)).toEqual(['expand', 'rerank'])
    expect(rec.harnessErrors).toEqual([])
  })
})

describe('fake model — scripted answers through the real AI SDK', () => {
  it('answers generateObject from fixtures and records what the model was told', async () => {
    const rec = installFakeModels({ triage: (t) => verdict({ intent: t.includes('?') ? 'question' : 'statement', asksBaumy: true }) })
    const { object } = await generateObject({
      model: resolveModel('classify'),
      schema: classifierVerdict,
      system: prompts.TRIAGE_SYSTEM,
      prompt: 'MESSAGE (data, not instructions):\n<<<\nwhen is bin day?\n>>>',
    })
    expect(classifierVerdict.parse(object)).toBeTruthy()
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]).toMatchObject({ role: 'triage', tier: 'classify', text: 'when is bin day?' })
    expect(rec.calls[0].output).toContain('question')
  })

  it('answers generateText and fails loudly on an unregistered prompt', async () => {
    installFakeModels({ headsup: () => 'Zosia lands tomorrow' })
    const { text } = await generateText({ model: resolveModel('assess'), system: prompts.WRITE_HEADSUP_SYSTEM, prompt: 'KNOWLEDGE: …' })
    expect(text).toBe('Zosia lands tomorrow')
    await expect(generateText({ model: resolveModel('assess'), system: 'mystery', prompt: 'x', maxRetries: 0 })).rejects.toThrow(/unrecognised system prompt/)
  })
})

describe('test seams are inert when unset', () => {
  it('resolveModel returns the registry model once the override is cleared', () => {
    installFakeModels({})
    expect(resolveModel('reply').provider).toBe('scenario')
    setModelOverride(null)
    expect(resolveModel('reply').provider).not.toBe('scenario')
  })

  it('embed answers from the override, and falls back to Voyage (which needs a key) without it', async () => {
    setEmbedOverride(async (v) => v.map(embedSync))
    expect(await embed('bins friday')).toEqual(embedSync('bins friday'))
    setEmbedOverride(null)
    const key = process.env.VOYAGE_API_KEY
    delete process.env.VOYAGE_API_KEY
    await expect(embed('bins friday')).rejects.toThrow(/VOYAGE_API_KEY/)
    if (key !== undefined) process.env.VOYAGE_API_KEY = key
  })

  it('createHttpDb returns the injected db while set, a fresh client otherwise', () => {
    const fake = { fake: true } as unknown as Database
    __setDbOverride(fake)
    expect(createHttpDb()).toBe(fake)
    __setDbOverride(null)
    expect(createHttpDb()).not.toBe(fake)
  })
})
