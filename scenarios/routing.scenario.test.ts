import { describe } from 'vitest'
import {
  scenario,
  say,
  expectPrompt,
  expectWords,
  expectNoWords,
  expectSilent,
  expectReaction,
  expectFact,
} from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, banter, chatter, fact } from './shapes'
import { HOUSE } from './house'

// Who Baumy talks to, and how: the spec §3 planner table, one row per scenario.

const start = '2026-09-24 19:00'

describe('scenario: routing — words, reactions, silence', () => {
  scenario('an undirected statement in the group is noted with ✍ — no words, no 👎', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t) => (/bins/.test(t) ? statement() : chatter()),
      extract: (t) => (/bins/.test(t) ? [fact({ subject: 'bins', predicate: 'collection_day', object: 'thursday' })] : []),
    },
    steps: [
      say('Marco', 'bins go out on thursdays now'),
      expectReaction('✍'),
      expectNoWords(),
      expectFact({ subject: /bins/, object: /thursday/, by: 'Marco' }),
    ],
  })

  scenario('housemates asking each other a question — Baumy stays out of it', {
    people: HOUSE,
    startAt: start,
    // C6: today's triage prompt routes ANY question to "answer", whoever it is aimed at; the spec's
    // `asksBaumy` flag + the planner's "question, undirected, not asksBaumy → none" row fix it.
    knownGap: { refs: 'C6', phase: 1, note: 'asksBaumy in triage + planner' },
    fixtures: { triage: () => question({ asksBaumy: false }) },
    steps: [say('Marco', 'Charli are you home tonight?'), expectSilent()],
  })

  scenario('a directed question with nothing in memory gets words saying so — never a 👎', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: () => question({ asksBaumy: true }),
      reply: () => ({ reply: "Nobody's mentioned bin day yet 🐈‍⬛", answered: false }),
    },
    steps: [
      say('Marco', 'when is bin day?', { mention: true }),
      expectPrompt('triage', (c) => c.text === 'when is bin day?', 'triage sees the question without the @mention (C12)'),
      expectPrompt('reply', (c) => memoryLines(c.prompt).length === 0, 'the model was given no memory to answer from'),
      expectWords({ judge: 'Says plainly that nobody in the house has mentioned bin day / there is no record of it. Does not invent a day.' }),
      expectReaction({ not: '👎' }),
      expectReaction(null),
    ],
  })

  scenario('a DM statement writes through to shared house memory as trusted', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: () => statement(),
      extract: () => [fact({ subject: 'boiler service', predicate: 'scheduled_on', object: 'tuesday', when: 'tuesday' })],
    },
    steps: [
      say('Charli', 'the boiler service is on tuesday', { dm: true }),
      expectFact({ subject: /boiler/, by: 'Charli', current: true }),
      expectReaction({ not: '👎' }),
    ],
  })

  scenario('a DM statement gets a short worded ack in the DM (not silence, not just an emoji)', {
    people: HOUSE,
    startAt: start,
    // K3: a DM statement is not a "wantAnswer", so the only feedback is a reaction; the planner's
    // "statement, directed/DM → ack" row gives it words.
    knownGap: { refs: 'K3', phase: 1, note: 'planner ack mode for DM statements' },
    fixtures: {
      triage: () => statement(),
      extract: () => [fact({ subject: 'boiler service', predicate: 'scheduled_on', object: 'tuesday', when: 'tuesday' })],
      reply: () => 'Noted — boiler service Tuesday 😼',
    },
    steps: [
      say('Charli', 'the boiler service is on tuesday', { dm: true }),
      expectWords({ judge: 'A short acknowledgement that the boiler service is on Tuesday. Not a question back, never "I don\'t know".' }),
    ],
  })

  scenario('"yes" as a reply to Baumy is not dropped as noise', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t) => (t === 'yes' ? banter({ asksBaumy: true }) : chatter()),
      reply: () => 'On it 😼',
    },
    steps: [
      say('Ryan', 'yes', { replyToBaumy: 'Want me to put bin bags on the shopping list?' }),
      expectPrompt('triage', (c) => c.text === 'yes', '"yes" reached triage (C7)'),
      expectWords(),
    ],
  })

  scenario('a reply to Baumy tells the model what Baumy had said', {
    people: HOUSE,
    startAt: start,
    // C5: the replied-to text is forwarded by the webhook now (phase 0) but never reaches the reply
    // prompt; spec §4's REPLYING TO line carries it.
    knownGap: { refs: 'C5', phase: 1, note: 'REPLYING TO in the reply prompt' },
    fixtures: {
      triage: (t) => (t === 'yes' ? banter({ asksBaumy: true }) : chatter()),
      reply: () => 'On it 😼',
    },
    steps: [
      say('Ryan', 'yes', { replyToBaumy: 'Want me to put bin bags on the shopping list?' }),
      expectPrompt('reply', /REPLYING TO: Baumy: "Want me to put bin bags on the shopping list\?"/, 'the model sees the message being replied to'),
    ],
  })
})
