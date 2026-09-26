import { describe } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { scenario, say, advance, expectPrompt, expectWords, expectReaction, expectFact, expectDb, expectNoWords } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE } from './house'

// Phase 4 — the fact model (docs/spec/chat-understanding-v2.md §7): cardinality + the controlled
// predicate vocabulary (F2/F3), possessives never folded into their owner (F1), the lookup that finds
// the object side and reads "my" as the sender (F4/F7), and the trust gate's authenticated exceptions
// with conflicts surfaced instead of silently dropped (F5).

const WEEKEND = { start: '2026-09-26', end: '2026-09-27', allDay: true } // Sat 26 – Sun 27 Sep (startAt is Thu 24 Sep)
/** The fact lines of a reply prompt's MEMORY, without the "(earlier: …)" lineage suffix. */
const factLines = (prompt: string) => memoryLines(prompt).filter((l) => /^\s*- fact/.test(l)).map((l) => l.split(' (earlier:')[0])
const thisTurn = (prompt: string) => prompt.match(/^\s*THIS TURN: (.*)$/m)?.[1] ?? ''

async function rows(db: Database, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const res = (await db.execute(q)) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[]
  return Array.isArray(res) ? res : (res.rows ?? [])
}

describe('scenario: the fact model (phase 4)', () => {
  scenario('two guests at once are both kept — and one dropping out closes only hers (F2)', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/who's staying/i.test(t) ? question({ asksBaumy: true }) : /staying|coming/i.test(t) ? statement() : chatter()),
      extract: (t) =>
        /both staying/.test(t)
          ? [
              fact({ subject: 'the house', predicate: 'has_guest', object: 'zosia', objectKind: 'person', when: WEEKEND, whenText: 'this weekend' }),
              fact({ subject: 'the house', predicate: 'has_guest', object: 'marta', objectKind: 'person', when: WEEKEND, whenText: 'this weekend' }),
            ]
          : /isn't coming/.test(t)
            ? [fact({ subject: 'the house', predicate: 'has_guest', object: 'marta', objectKind: 'person', removes: true })]
            : [],
      reply: (t) => (/who's staying/i.test(t) ? 'Zosia and Marta, both this weekend (Sat 26–Sun 27 Sep) 🐈' : 'Noted 😼'),
    },
    steps: [
      say('Chloe', 'Zosia and Marta are both staying with us this weekend'),
      expectReaction('✍'),
      expectFact({ predicate: 'has_guest', object: 'zosia', current: true }),
      expectFact({ predicate: 'has_guest', object: 'marta', current: true }),
      say('Ryan', "who's staying at the house this weekend?", { mention: true }),
      expectPrompt('reply', (c) => ['zosia', 'marta'].every((g) => factLines(c.prompt).some((l) => l.includes(`house has guest: ${g}`))), 'MEMORY carries BOTH guests as current facts'),
      expectWords({ judge: 'Says both Zosia and Marta are staying this weekend. Must not drop either of them or claim not to know.' }),
      say('Marco', "Marta isn't coming anymore"),
      expectFact({ predicate: 'has_guest', object: 'marta', current: true, count: 0 }),
      expectFact({ predicate: 'has_guest', object: 'zosia', current: true }),
    ],
  })

  scenario('a correction under a synonym predicate supersedes: "arrival_date" corrects "arrives_on" (F3)', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/when does/i.test(t) ? question({ asksBaumy: true }) : /zosia/i.test(t) ? statement() : chatter()),
      extract: (t) =>
        /arrives Friday/.test(t)
          ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'arrives_on', object: 'Fri 25 Sep', when: { start: '2026-09-25', allDay: true }, whenText: 'Friday' })]
          : /getting in Saturday/.test(t)
            ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'arrival_date', object: 'Sat 26 Sep', when: { start: '2026-09-26', allDay: true }, whenText: 'Saturday' })]
            : [],
      reply: (t) => (/when does/i.test(t) ? 'Saturday (26 Sep) — Chloe moved it from Friday 🐈' : 'Noted 😼'),
    },
    steps: [
      say('Chloe', 'Zosia arrives Friday'),
      say('Chloe', "actually Zosia's getting in Saturday"),
      expectFact({ subject: 'zosia', predicate: 'arrives_on', object: /Sat/, current: true }),
      expectFact({ subject: 'zosia', object: /Fri/, current: true, count: 0 }),
      expectFact({ predicate: 'arrival_date', count: 0 }),
      say('Marco', 'when does Zosia arrive?', { mention: true }),
      expectPrompt('reply', (c) => factLines(c.prompt).some((l) => /zosia arrives on: Sat 26 Sep/.test(l)), 'MEMORY grounds Saturday'),
      expectPrompt('reply', (c) => !factLines(c.prompt).some((l) => /Fri 25 Sep$/.test(l)), 'Friday is no longer a current fact (only the "earlier:" lineage mentions it)'),
      expectWords({ judge: 'Says Zosia arrives on Saturday. Must not say Friday is the arrival day, and must not hedge between Friday and Saturday.' }),
    ],
  })

  scenario('"chloe\'s bike is broken" never attaches to Chloe herself (F1)', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/where's chloe/i.test(t) ? question({ asksBaumy: true }) : /barcelona|bike/i.test(t) ? statement() : chatter()),
      extract: (t, speaker) =>
        /Barcelona/.test(t)
          ? [fact({ subject: (speaker ?? 'chloe').toLowerCase(), subjectKind: 'person', predicate: 'location', object: 'Barcelona until Sun 27 Sep' })]
          : /bike is broken/.test(t)
            ? [fact({ subject: "chloe's bike", predicate: 'status', object: 'broken' })]
            : [],
      reply: (t) => (/where's chloe/i.test(t) ? 'Barcelona till Sunday, she said 🐈' : 'Noted 😼'),
    },
    steps: [
      say('Chloe', "I'm in Barcelona till Sunday"),
      say('Marco', "chloe's bike is broken"),
      expectFact({ subject: "chloe's bike", predicate: 'status', object: 'broken', current: true }),
      expectFact({ subject: 'chloe', predicate: 'location', object: /Barcelona/, current: true }),
      expectDb(async (db) => {
        const ents = await rows(db, sql`SELECT canonical_name AS name, aliases FROM baumy_entities WHERE is_active`)
        const chloe = ents.find((e) => e.name === 'chloe')
        const aliases = (chloe?.aliases as string[] | null) ?? []
        return !!chloe && !aliases.includes("chloe's bike") && ents.some((e) => e.name === "chloe's bike")
      }, "the bike is its own node — never an alias of the person Chloe"),
      say('Ryan', "where's Chloe?", { mention: true }),
      expectPrompt('reply', (c) => factLines(c.prompt).some((l) => /chloe location: Barcelona/.test(l)), 'MEMORY has where Chloe is'),
      expectPrompt('reply', (c) => !factLines(c.prompt).some((l) => /broken|belongs to/.test(l)), "the bike's status is not a fact about Chloe"),
      expectWords({ judge: 'Says Chloe is in Barcelona (until Sunday). Must not say Chloe is broken or confuse her with her bike.' }),
    ],
  })

  scenario('"who\'s in the cave?" finds the fact from its OBJECT side (F7)', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/who's in/i.test(t) ? question({ asksBaumy: true }) : /cave/i.test(t) ? statement() : chatter()),
      extract: (t) =>
        /staying in the cave/.test(t)
          ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'staying_in', object: 'the cave', objectKind: 'place', when: WEEKEND, whenText: 'this weekend' })]
          : [],
      reply: (t) => (/who's in/i.test(t) ? 'Zosia — this weekend, Marco said 🐈' : 'Noted 😼'),
    },
    steps: [
      say('Marco', 'Zosia is staying in the cave this weekend'),
      expectFact({ subject: 'zosia', predicate: 'stays_in', object: 'the cave' }),
      advance({ days: 2 }), // → Sat 26 Sep: the stay is on
      say('Ryan', "who's in the cave?", { mention: true }),
      expectPrompt('reply', (c) => factLines(c.prompt).some((l) => /zosia stays in: the cave/.test(l)), 'MEMORY carries the Zosia fact although the question never names her'),
      expectWords({ judge: 'Says Zosia is staying in the cave (this weekend). Must not claim nobody is there or not to know.' }),
    ],
  })

  scenario('Chloe asking "who\'s in my room?" gets chloe\'s room (the sender is "my")', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/who's in my room/i.test(t) ? question({ asksBaumy: true }) : /room/i.test(t) ? statement() : chatter()),
      extract: (t) =>
        /Chloe's room/.test(t)
          ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'stays_in', object: "chloe's room", objectKind: 'place', when: WEEKEND, whenText: 'this weekend' })]
          : [],
      reply: (t) => (/who's in my room/i.test(t) ? "Zosia, this weekend — Marco said so 🐈" : 'Noted 😼'),
    },
    steps: [
      say('Marco', "Zosia is staying in Chloe's room this weekend"),
      advance({ hours: 2 }),
      say('Chloe', "who's in my room?", { mention: true }),
      expectPrompt('reply', /FROM: Chloe\b/, 'the model knows Chloe is asking'),
      expectPrompt('reply', (c) => factLines(c.prompt).some((l) => /zosia stays in: chloe's room/.test(l)), "MEMORY carries the fact keyed on chloe's room"),
      expectWords({ judge: "Tells Chloe that Zosia is staying in her room this weekend (speaking to Chloe as 'you'/'your room'). Must not claim not to know." }),
    ],
  })

  scenario('the same person corrects their own DM fact from the group — it takes (F5)', {
    people: HOUSE,
    // Marco, not Chloe: Chloe is the house OWNER, and the owner exception would let her correction
    // through on its own — this must pass through the same-author exception only.
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/zosia/i.test(t) ? statement() : chatter()),
      extract: (t, speaker) =>
        /my room/.test(t)
          ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'stays_in', object: `${(speaker ?? 'chloe').toLowerCase()}'s room`, objectKind: 'place' })]
          : /in the cave/.test(t)
            ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'stays_in', object: 'the cave', objectKind: 'place' })]
            : [],
      reply: () => "Noted — Zosia's in your room 😼",
    },
    steps: [
      say('Marco', "Zosia's staying in my room", { dm: true }),
      expectFact({ subject: 'zosia', object: "marco's room", by: 'Marco', trust: 'trusted', current: true }),
      advance({ hours: 20 }),
      say('Marco', "change of plan, Zosia's in the cave"),
      expectFact({ subject: 'zosia', predicate: 'stays_in', object: 'the cave', by: 'Marco', trust: 'untrusted', current: true }),
      expectFact({ subject: 'zosia', object: "marco's room", current: true, count: 0 }),
      expectReaction('✍'),
      expectNoWords(),
    ],
  })

  scenario('a conflicting correction by someone else is not taken — Baumy asks which is right (F5)', {
    people: HOUSE,
    startAt: '2026-09-24 19:00',
    fixtures: {
      triage: (t) => (/zosia/i.test(t) ? statement() : chatter()),
      extract: (t, speaker) =>
        /my room/.test(t)
          ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'stays_in', object: `${(speaker ?? 'chloe').toLowerCase()}'s room`, objectKind: 'place' })]
          : /in the cave/.test(t)
            ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'stays_in', object: 'the cave', objectKind: 'place' })]
            : [],
      reply: (t) =>
        /in the cave/.test(t) ? "Hm — Chloe told me Zosia's in her room. Cave or Chloe's room, which is it? 🐈" : "Noted — Zosia's in your room 😼",
    },
    steps: [
      say('Chloe', "Zosia's staying in my room", { dm: true }),
      advance({ hours: 20 }),
      say('Marco', "no, Zosia's in the cave"),
      expectFact({ subject: 'zosia', object: "chloe's room", by: 'Chloe', current: true }),
      expectFact({ subject: 'zosia', object: 'the cave', by: 'Marco', current: false }),
      expectDb(async (db) => {
        const r = await rows(db, sql`SELECT count(*)::int AS n FROM baumy_facts WHERE object_value = 'the cave' AND conflicts_with_fact_id IS NOT NULL AND NOT is_current`)
        return Number(r[0]?.n) === 1
      }, 'the refused correction is kept as a conflict row pointing at the fact it contradicts'),
      expectPrompt('reply', /^MODE: clarify$/m, 'the planner asks instead of a silent ✍'),
      expectPrompt('reply', (c) => /CONFLICT/.test(thisTurn(c.prompt)) && /Chloe said zosia · stays in · chloe's room/.test(thisTurn(c.prompt)), 'THIS TURN names the conflict and who said the current value'),
      expectReaction({ not: '✍' }),
      expectWords({
        judge:
          "Points out that Chloe said Zosia is staying in Chloe's room while Marco now says the cave, and asks which is right. Must not claim to have updated or noted the cave as fact.",
      }),
    ],
  })
})
