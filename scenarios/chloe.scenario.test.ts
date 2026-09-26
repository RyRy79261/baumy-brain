import { describe } from 'vitest'
import { scenario, say, advance, expectPrompt, expectWords, expectReaction, expectFact } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE, DATE_RE } from './house'

// The failure that started chat-understanding-v2: Chloe TELLS Baumy something in the ask-Baumy
// topic and gets "I don't know, Chloe said Zosia's staying" back — her own message answered as a
// question, grounded on itself, with no idea who was speaking. Later, Marco asks and should get
// the answer, attributed to Chloe and dated.

const STATEMENT = 'Zosia is staying in my room this weekend'
const ASK = "who's staying in Chloe's room this weekend?"

const fixtures = {
  triage: (t: string) => (/who's staying/i.test(t) ? question({ asksBaumy: true }) : t.includes('Zosia is staying') ? statement() : chatter()),
  extract: (t: string, speaker: string | null) =>
    t.includes('Zosia is staying')
      ? [
          fact({
            subject: 'zosia',
            subjectKind: 'person',
            predicate: 'stays_in',
            object: `${(speaker ?? 'chloe').toLowerCase()}'s room`,
            objectKind: 'place',
            when: 'this weekend',
          }),
        ]
      : [],
  reply: (t: string) => (/who's staying/i.test(t) ? "Zosia — Chloe said she's in her room this weekend (Sat 26–Sun 27 Sep)" : "Noted — Zosia's in your room this weekend 😼"),
}

const base = { people: HOUSE, startAt: '2026-09-24 19:00', consoleTopic: 77, fixtures }

describe('scenario: Chloe tells Baumy who is staying, Marco asks later', () => {
  // What already holds: the statement becomes Chloe's fact, and Marco's later question is grounded
  // on what she said.
  scenario('the statement is remembered as Chloe’s and grounds Marco’s later question', {
    ...base,
    steps: [
      say('Chloe', STATEMENT, { topic: 'console' }),
      expectFact({ subject: /zosia/, object: /chloe/, by: 'Chloe', current: true }),
      expectReaction({ not: '👎' }),
      advance({ hours: 3 }),
      say('Marco', ASK, { mention: true }),
      expectPrompt('triage', (c) => !c.text.includes('@baumy_bot'), 'the @mention never reaches the model (C12)'),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /zosia/i.test(l)), 'MEMORY carries what Chloe said about Zosia'),
      expectWords({ judge: "Says Zosia is staying in Chloe's room this weekend. Must not claim not to know." }),
      expectReaction(null),
    ],
  })

  // The spec §4 turn: ack mode, FROM, MESSAGE framing, no self-grounding, dated attributed memory.
  scenario('Chloe gets an ack (not an answer to herself); Marco gets a dated answer attributed to her', {
    ...base,
    steps: [
      say('Chloe', STATEMENT, { topic: 'console' }),
      expectPrompt('reply', /FROM: Chloe\b/, 'the model was told who is speaking (C2)'),
      expectPrompt('reply', /^MODE: ack$/m, 'the model was told to acknowledge a statement, not answer a question (C3)'),
      expectPrompt('reply', new RegExp(`^MESSAGE from Chloe: ${STATEMENT}$`, 'm'), 'the message is labelled MESSAGE from Chloe'),
      expectPrompt('reply', (c) => !/QUESTION/.test(c.prompt), 'nothing frames the statement as a QUESTION'),
      expectPrompt('reply', (c) => !memoryLines(c.prompt).some((l) => /zosia/i.test(l)), 'MEMORY excludes Chloe’s own message and the fact it produced (C1)'),
      expectWords({
        judge:
          "A short acknowledgement that Zosia is staying in Chloe's room this weekend. Speaks to Chloe directly (never 'Chloe said…'), does not claim not to know, does not ask a question back.",
      }),
      expectFact({ subject: /zosia/, object: /chloe/, by: 'Chloe' }),
      advance({ hours: 3 }),
      say('Marco', ASK, { mention: true }),
      expectPrompt('reply', /FROM: Marco\b/, 'the model was told Marco is asking'),
      expectPrompt('reply', /^MODE: answer$/m, 'the model was told to answer'),
      expectPrompt(
        'reply',
        (c) => memoryLines(c.prompt).some((l) => /zosia/i.test(l) && /Chloe/.test(l) && DATE_RE.test(l)),
        'MEMORY carries the Zosia fact, attributed to Chloe, with a date (T1)',
      ),
      expectWords({ judge: "Says Zosia is staying in Chloe's room this weekend (optionally that Chloe said so). Must not claim not to know." }),
      expectReaction(null),
    ],
  })
})
