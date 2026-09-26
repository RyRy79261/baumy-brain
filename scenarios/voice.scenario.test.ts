import { describe } from 'vitest'
import { scenario, say, advance, expectPrompt, expectNoPrompt, expectWords, expectNoWords, expectSilent, expectReaction, check } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE } from './house'

// Baumy's voice after phase 1 (docs/spec/chat-understanding-v2.md §1–§4): who it talks to, in which
// MODE, and what the reply model is — and is not — shown. Each scenario is one of the audit's
// conversations, replayed through the real pipeline.

const start = '2026-09-24 19:00'

describe('scenario: voice — addressing, modes and discretion', () => {
  scenario('talking ABOUT Baumy is not talking TO it (C10)', {
    people: HOUSE,
    startAt: start,
    fixtures: { triage: () => chatter() },
    steps: [
      say('Charli', "Baumy's reminders are annoying lol"),
      expectSilent(),
      say('Marco', 'Charli, ask baumy, it knows'),
      expectSilent(),
    ],
  })

  scenario('the vocative name IS addressing it — a question gets words', {
    people: HOUSE,
    startAt: start,
    fixtures: { triage: () => question({ asksBaumy: true }) },
    steps: [say('Marco', 'baumy, when is bin day?'), expectPrompt('reply', /^MODE: answer$/m, 'answer mode'), expectWords()],
  })

  scenario('in the ask-Baumy topic, a housemate replying to another housemate is left alone (C6)', {
    people: HOUSE,
    startAt: start,
    consoleTopic: 77,
    fixtures: { triage: () => question({ asksBaumy: false }) },
    steps: [
      say('Marco', 'are you home tonight?', { topic: 'console', replyTo: { who: 'Charli', text: 'anyone up for dinner?' } }),
      expectSilent(),
      expectPrompt('triage', /REPLYING TO: Charli: "anyone up for dinner\?"/, 'triage was told who the message replies to'),
    ],
  })

  scenario('K2: re-addressing a statement ("did you catch that?") gets an ack, never Charli quoted back to Charli', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t) => (/zuzka/i.test(t) ? statement() : chatter()),
      extract: (t, speaker) =>
        /zuzka/i.test(t) ? [fact({ subject: 'zuzka', subjectKind: 'person', predicate: 'stays_in', object: `${(speaker ?? '').toLowerCase()}'s room`, objectKind: 'place', when: 'this weekend' })] : [],
      reply: () => "Yep, got it — Zuzka's in your room this weekend 😼",
    },
    steps: [
      say('Charli', 'Zuzka is staying in my room this weekend'),
      expectReaction('✍'),
      expectNoWords(),
      advance({ minutes: 2 }),
      say('Charli', "did you catch that? Zuzka's staying in my room this weekend", { mention: true }),
      expectPrompt('reply', /^MODE: ack$/m, 'ack mode, not answer'),
      expectPrompt('reply', /FROM: Charli\b/, 'the model knows Charli is the one talking'),
      expectPrompt('reply', (c) => !memoryLines(c.prompt).some((l) => l.includes('did you catch that')), 'the restatement itself is not in MEMORY'),
      expectWords({ judge: "Acknowledges Zuzka staying in Charli's room, speaking TO Charli (never 'Charli said…'). Does not claim not to know." }),
    ],
  })

  scenario('a secret told to Baumy is acked without echoing it; asked for directly, it is answered (C15)', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t) => (/what's the wifi/i.test(t) ? question({ asksBaumy: true }) : /wifi/i.test(t) ? statement() : chatter()),
      reply: (_t, c) => (/^MODE: ack$/m.test(c.prompt) ? 'Noted the new wifi password 🔐' : 'It’s hunter3'),
    },
    steps: [
      say('Charli', 'the wifi password is now hunter3', { mention: true }),
      expectPrompt('reply', (c) => !c.prompt.includes('hunter3'), 'the ack prompt never carries the secret value'),
      expectWords({ notContains: 'hunter3' }),
      advance({ hours: 1 }),
      say('Marco', "what's the wifi password?", { mention: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => l.includes('hunter3')), 'a direct ask decrypts it into MEMORY'),
      expectWords({ contains: 'hunter3' }),
    ],
  })

  scenario('an unaddressed question the house memory cannot answer gets a quiet 👎, not a line of "no idea"', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: () => question({ asksBaumy: true, confidence: 0.95 }),
      reply: () => ({ reply: 'Nobody has mentioned the plumber', answered: false }),
    },
    steps: [say('Ryan', 'does anyone know when the plumber is coming?'), expectNoWords(), expectReaction('👎')],
  })

  scenario('words are sent as a Telegram reply to the message they answer (C11)', {
    people: HOUSE,
    startAt: start,
    fixtures: { triage: () => question({ asksBaumy: true }), reply: () => 'Thursday 🗑️' },
    steps: [
      say('Marco', 'when is bin day?', { mention: true }),
      check('the message carries reply_parameters → the triggering message id', (r, e) => {
        const t = r.turns.at(-1)!
        const msg = t.entries.find((x) => x.kind === 'message')
        e(msg?.replyTo).toBe(t.messageId)
      }),
    ],
  })

  scenario('a question is not filed as evidence, so the next question cannot be "answered" from it (I3)', {
    people: HOUSE,
    startAt: start,
    fixtures: { triage: () => question({ asksBaumy: true, worthRemembering: true }) },
    steps: [
      say('Marco', 'is the plumber coming on thursday?', { mention: true }),
      expectNoPrompt('extract', 'a question never reaches fact extraction'),
      advance({ days: 2 }),
      say('Ryan', 'when is the plumber coming?', { mention: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).length === 0, "Marco's old question is not MEMORY"),
      expectWords({ judge: 'Says nobody has mentioned when the plumber is coming. Must not claim Thursday.' }),
    ],
  })
})
