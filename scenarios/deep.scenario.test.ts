import { describe } from 'vitest'
import { scenario, say, advance, expectPrompt, expectWords } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE } from './house'

// The DEEP retrieval tier (docs/spec/chat-understanding-v2.md §4, AGENTS.md "Memory & retrieval"):
// a broad history question earns query expansion, a re-rank and the fact-graph walk. Each of those is
// best-effort in lib/turn/grounding.ts (a failure silently falls back), so this scenario pins that
// they actually RUN through the real pipeline — and the DSL fails any step where the scripted model
// itself broke, even inside those swallowing catches.

const start = '2026-09-24 19:00'

describe('scenario: deep retrieval tier', () => {
  scenario('a deep question expands, re-ranks, and walks the fact graph into MEMORY', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t) => (/who has stayed/i.test(t) ? question({ asksBaumy: true, tier: 'deep' }) : /zuzka|cave/i.test(t) ? statement() : chatter()),
      extract: (t) =>
        /sister/i.test(t)
          ? [fact({ subject: 'zuzka', subjectKind: 'person', predicate: 'sibling_of', object: 'charli', objectKind: 'person' })]
          : /cave/i.test(t)
            ? [fact({ subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: 'the cave', objectKind: 'place' })]
            : [],
      expand: () => ({ variants: ['guests in the cave room', 'who slept in the cave'], hypothetical: 'Zuzka stayed in the cave in September.' }),
      reply: () => 'Zuzka — your sister, Charli — has the cave 🐈‍⬛',
    },
    steps: [
      say('Charli', 'Zuzka is my sister btw'),
      say('Charli', 'Zuzka is staying in the cave this month'),
      advance({ hours: 2 }),
      say('Marco', 'who has stayed in the cave this year?', { mention: true }),
      expectPrompt('expand', (c) => c.text === 'who has stayed in the cave this year?', 'the deep tier expanded the question'),
      expectPrompt('rerank', /ITEMS \(data\):\n\[0\] .*\n\[1\] /, 'the deep tier re-ranked several candidates'),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /cave/i.test(l)), 'the cave stay grounds the answer'),
      expectPrompt(
        'reply',
        (c) => memoryLines(c.prompt).some((l) => /^\s*- (connection|timeline) ·/.test(l) && /sibling/i.test(l)),
        "the graph walk hops from the cave to Zuzka's sibling edge (a connection/timeline line)",
      ),
      expectWords({ judge: 'Says Zuzka (Charli’s sister) has been staying in the cave. Does not invent other guests.' }),
    ],
  })
})
