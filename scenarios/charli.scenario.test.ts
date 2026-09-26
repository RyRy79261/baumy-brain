import { describe } from 'vitest'
import { scenario, say, advance, expectPrompt, expectWords, expectReaction, expectFact } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE, DATE_RE } from './house'

// The failure that started chat-understanding-v2: Charli TELLS Baumy something in the ask-Baumy
// topic and gets "I don't know, Charli said Zuzka's staying" back — her own message answered as a
// question, grounded on itself, with no idea who was speaking. Later, Marco asks and should get
// the answer, attributed to Charli and dated.

const STATEMENT = 'Zuzka is staying in my room this weekend'
const ASK = "who's staying in Charli's room this weekend?"

const fixtures = {
  triage: (t: string) => (/who's staying/i.test(t) ? question({ asksBaumy: true }) : t.includes('Zuzka is staying') ? statement() : chatter()),
  extract: (t: string, speaker: string | null) =>
    t.includes('Zuzka is staying')
      ? [
          fact({
            subject: 'zuzka',
            subjectKind: 'person',
            predicate: 'stays_in',
            object: `${(speaker ?? 'charli').toLowerCase()}'s room`,
            objectKind: 'place',
            when: 'this weekend',
          }),
        ]
      : [],
  reply: (t: string) => (/who's staying/i.test(t) ? "Zuzka — Charli said she's in her room this weekend (Sat 26–Sun 27 Sep)" : "Noted — Zuzka's in your room this weekend 😼"),
}

const base = { people: HOUSE, startAt: '2026-09-24 19:00', consoleTopic: 77, fixtures }

describe('scenario: Charli tells Baumy who is staying, Marco asks later', () => {
  // What already holds: the statement becomes Charli's fact, and Marco's later question is grounded
  // on what she said.
  scenario('the statement is remembered as Charli’s and grounds Marco’s later question', {
    ...base,
    steps: [
      say('Charli', STATEMENT, { topic: 'console' }),
      expectFact({ subject: /zuzka/, object: /charli/, by: 'Charli', current: true }),
      expectReaction({ not: '👎' }),
      advance({ hours: 3 }),
      say('Marco', ASK, { mention: true }),
      expectPrompt('triage', (c) => !c.text.includes('@baumy_bot'), 'the @mention never reaches the model (C12)'),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /zuzka/i.test(l)), 'MEMORY carries what Charli said about Zuzka'),
      expectWords({ judge: "Says Zuzka is staying in Charli's room this weekend. Must not claim not to know." }),
      expectReaction(null),
    ],
  })

  // The spec §4 turn: ack mode, FROM, MESSAGE framing, no self-grounding, dated attributed memory.
  scenario('Charli gets an ack (not an answer to herself); Marco gets a dated answer attributed to her', {
    ...base,
    knownGap: { refs: 'C1 C2 C3 T1', phase: 1, note: 'reply prompt v2 (turn context + MODE + self-exclusion + dated MEMORY)' },
    steps: [
      say('Charli', STATEMENT, { topic: 'console' }),
      expectPrompt('reply', /FROM: Charli\b/, 'the model was told who is speaking (C2)'),
      expectPrompt('reply', /^MODE: ack$/m, 'the model was told to acknowledge a statement, not answer a question (C3)'),
      expectPrompt('reply', new RegExp(`^MESSAGE from Charli: ${STATEMENT}$`, 'm'), 'the message is labelled MESSAGE from Charli'),
      expectPrompt('reply', (c) => !/QUESTION/.test(c.prompt), 'nothing frames the statement as a QUESTION'),
      expectPrompt('reply', (c) => !memoryLines(c.prompt).some((l) => /zuzka/i.test(l)), 'MEMORY excludes Charli’s own message and the fact it produced (C1)'),
      expectWords({
        judge:
          "A short acknowledgement that Zuzka is staying in Charli's room this weekend. Speaks to Charli directly (never 'Charli said…'), does not claim not to know, does not ask a question back.",
      }),
      expectFact({ subject: /zuzka/, object: /charli/, by: 'Charli' }),
      advance({ hours: 3 }),
      say('Marco', ASK, { mention: true }),
      expectPrompt('reply', /FROM: Marco\b/, 'the model was told Marco is asking'),
      expectPrompt('reply', /^MODE: answer$/m, 'the model was told to answer'),
      expectPrompt(
        'reply',
        (c) => memoryLines(c.prompt).some((l) => /zuzka/i.test(l) && /Charli/.test(l) && DATE_RE.test(l)),
        'MEMORY carries the Zuzka fact, attributed to Charli, with a date (T1)',
      ),
      expectWords({ judge: "Says Zuzka is staying in Charli's room this weekend (optionally that Charli said so). Must not claim not to know." }),
      expectReaction(null),
    ],
  })
})
