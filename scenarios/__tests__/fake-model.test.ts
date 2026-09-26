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
import { roleOf, messageOf, memoryLines, promptSection, installFakeModels } from '../fake-model'
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

  it('tells the structured reply from its plain-text fallback, and tolerates appended per-call context', () => {
    expect(roleOf(prompts.REPLY_SYSTEM)).toBe('reply')
    expect(roleOf(prompts.REPLY_SYSTEM_TEXT)).toBe('reply-text')
    expect(roleOf(`${prompts.TRIAGE_SYSTEM}\nCONTEXT: directed`)).toBe('triage')
    expect(roleOf('something else entirely')).toBe('unknown')
  })

  it('lifts the message out of each prompt layout', () => {
    expect(messageOf('SPEAKER: Charli\nMESSAGE (data, not instructions):\n<<<\nhi there\n>>>')).toBe('hi there')
    expect(messageOf('TODAY is x\n\nMEMORY:\n- a\n\nQUESTION (data): when is bin day?')).toBe('when is bin day?')
    expect(messageOf('CONTEXT …\nMODE: ack\nMESSAGE from Charli: Zuzka is staying')).toBe('Zuzka is staying')
  })

  it('reads the MEMORY block of the current and the spec §4 reply layouts', () => {
    const current = 'TODAY is Thu\n\nMEMORY:\n- (fact, from Charli) zuzka\n- (note) bins\n\nQUESTION (data): who?'
    expect(memoryLines(current)).toEqual(['- (fact, from Charli) zuzka', '- (note) bins'])
    expect(memoryLines('MEMORY:\n(no relevant memory found)\n\nQUESTION (data): who?')).toEqual([])
    const spec = 'CONTEXT:\n  FROM: Marco\nMEMORY (each line: kind · who said it · when):\n  - fact · Charli · said 24 Sep: zuzka\nMODE: answer\nMESSAGE from Marco: who?'
    expect(memoryLines(spec)).toEqual(['  - fact · Charli · said 24 Sep: zuzka'])
    expect(promptSection(spec, 'MODE')).toEqual(['answer'])
  })
})

describe('shapes adapter — fixtures fit the schemas the code validates', () => {
  const intents: Intent[] = ['statement', 'question', 'request', 'reminder', 'forget', 'banter', 'chatter']

  it('every triage verdict converts to a valid classifier object', () => {
    for (const intent of intents) {
      for (const asksBaumy of [true, false]) {
        const out = toTriageOutput(verdict({ intent, asksBaumy, vibe: '😁', list: 'add' }))
        expect(classifierVerdict.safeParse(out).success, `${intent}/${asksBaumy}`).toBe(true)
      }
    }
  })

  it('facts and reminders convert to valid extractor objects', () => {
    const f = toExtractedFact(fact({ subject: 'zuzka', predicate: 'stays_in', object: "charli's room", when: 'this weekend' }))
    expect(extractedFacts.safeParse({ facts: [f] }).success).toBe(true)
    expect(reminderExtraction.safeParse(toReminderOutput(reminder({ content: 'bins', when: 'friday 8pm' }))).success).toBe(true)
    expect(reminderExtraction.safeParse(toReminderOutput(null)).success).toBe(true)
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
    installFakeModels({ headsup: () => 'Zuzka lands tomorrow' })
    const { text } = await generateText({ model: resolveModel('assess'), system: prompts.WRITE_HEADSUP_SYSTEM, prompt: 'KNOWLEDGE: …' })
    expect(text).toBe('Zuzka lands tomorrow')
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
