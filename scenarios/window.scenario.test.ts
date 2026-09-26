import { describe } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { scenario, say, advance, expectPrompt, expectWords, expectReaction, expectDb } from './dsl'
import { promptSection } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE } from './house'

// Phase 2 — the 48h conversation window (docs/spec/chat-understanding-v2.md §5, C5). Every in-scope
// message and every Baumy send lands in baumy_messages (secret-redacted); the last turns of the same
// chat reach BOTH triage and the reply as a quoted RECENT CHAT block, so a follow-up ("which room is
// she in?") can be read against what was just said — including Baumy's own previous reply.

const recentChat = (prompt: string) => promptSection(prompt, 'RECENT CHAT')

async function windowTexts(db: Database): Promise<string[]> {
  const res = (await db.execute(sql`SELECT text_redacted FROM baumy_messages ORDER BY seq`)) as unknown as
    | { rows?: { text_redacted: string }[] }
    | { text_redacted: string }[]
  return (Array.isArray(res) ? res : (res.rows ?? [])).map((r) => r.text_redacted)
}

const ZUZKA = "Zuzka's coming Friday"
const CAVE = "she's taking the cave"
const FOLLOW_UP = 'which room is she in?'

const followUps = {
  triage: (t: string) => (t === FOLLOW_UP ? question({ asksBaumy: true }) : /Zuzka|cave/i.test(t) ? statement() : chatter()),
  extract: (t: string) =>
    t.includes('Zuzka') ? [fact({ subject: 'zuzka', subjectKind: 'person', predicate: 'arrives_on', object: 'friday', when: 'friday' })] : [],
  reply: (t: string) => (t === FOLLOW_UP ? "The cave — Marco said she's taking it 🐈" : "Noted — Zuzka's coming Friday 😼"),
}

describe('scenario: the conversation window (phase 2)', () => {
  scenario('a follow-up is read against the recent turns, Baumy’s own previous reply included', {
    people: HOUSE,
    startAt: '2026-09-28 18:00',
    fixtures: followUps,
    steps: [
      say('Charli', ZUZKA, { mention: true }),
      expectWords({ judge: "A short acknowledgement that Zuzka is coming on Friday. Speaks to Charli directly; no question back." }),
      say('Marco', CAVE),
      expectReaction('✍'),
      expectPrompt('triage', (c) => recentChat(c.prompt).some((l) => l.includes(ZUZKA)), 'triage sees the turn this one follows up on'),
      say('Charli', FOLLOW_UP, { replyToBaumy: true }),
      expectPrompt('triage', (c) => recentChat(c.prompt).some((l) => l.includes(CAVE)), 'triage is shown the recent chat'),
      expectPrompt(
        'reply',
        (c) => {
          const lines = recentChat(c.prompt)
          const i = lines.findIndex((l) => /Charli: ".*Zuzka's coming Friday"/.test(l))
          const j = lines.findIndex((l) => /Baumy \(you\): "Noted — Zuzka's coming Friday/.test(l))
          const k = lines.findIndex((l) => /Marco: "she's taking the cave"/.test(l))
          return i >= 0 && j > i && k > j
        },
        'RECENT CHAT carries the earlier turns in order — Charli’s news, Baumy’s own ack, Marco’s line',
      ),
      expectPrompt('reply', (c) => !recentChat(c.prompt).some((l) => l.includes(FOLLOW_UP)), 'the message being answered is the MESSAGE line, not a RECENT CHAT turn'),
      expectPrompt('reply', (c) => c.prompt.indexOf('RECENT CHAT') > c.prompt.indexOf('THIS TURN:'), 'the recent chat is quoted data after the verified CONTEXT block'),
      expectWords({ judge: 'Says Zuzka is staying in the cave (Marco said so). Must resolve "she" to Zuzka and must not claim not to know.' }),
    ],
  })

  scenario('a secret typed in chat never reaches baumy_messages — not the message, not Baumy’s answer', {
    people: HOUSE,
    startAt: '2026-09-28 18:00',
    fixtures: {
      triage: (t) => (/what's the wifi/i.test(t) ? question({ asksBaumy: true }) : /wifi/i.test(t) ? statement() : chatter()),
      // The answer quotes the value in words no pattern recognises — the window must still not keep it.
      reply: (t) => (/what's the wifi/i.test(t) ? "it's hunter2 🐈" : 'Noted 😼'),
    },
    steps: [
      say('Charli', 'the wifi password is hunter2 now'),
      expectReaction('✍'),
      say('Marco', "what's the wifi password?", { mention: true }),
      expectPrompt('reply', (c) => !recentChat(c.prompt).some((l) => l.includes('hunter2')), 'the recent chat never carries the secret'),
      expectPrompt('reply', (c) => recentChat(c.prompt).some((l) => l.includes('the wifi password') && l.includes('withheld')), 'only its descriptor'),
      expectWords({ contains: 'hunter2' }),
      expectDb(async (db) => {
        const texts = await windowTexts(db)
        return texts.length === 3 && !texts.some((t) => t.includes('hunter2'))
      }, 'three window rows (Charli, Marco, Baumy) and none holds the value'),
    ],
  })

  scenario('turns older than 48h are not shown, and the purge removes them', {
    people: HOUSE,
    startAt: '2026-09-28 18:00',
    fixtures: followUps,
    steps: [
      say('Marco', ZUZKA),
      advance({ hours: 47 }),
      say('Ryan', 'lol ok'),
      expectPrompt('triage', (c) => recentChat(c.prompt).some((l) => l.includes(ZUZKA)), 'a 47h-old turn is still in the window'),
      advance({ hours: 2 }),
      say('Charli', FOLLOW_UP, { mention: true }),
      expectPrompt('reply', (c) => !recentChat(c.prompt).some((l) => l.includes(ZUZKA)), 'a 49h-old turn is gone from RECENT CHAT'),
      expectPrompt('reply', (c) => recentChat(c.prompt).some((l) => l.includes('lol ok')), 'a 2h-old one is still there'),
      advance({ days: 1 }), // the purge cron runs at its own simulated instant
      expectDb(async (db) => !(await windowTexts(db)).includes(ZUZKA), 'the purge deleted the stale row'),
    ],
  })

  scenario('a DM to Baumy never shows up in the house group’s recent chat', {
    people: HOUSE,
    startAt: '2026-09-28 18:00',
    fixtures: {
      triage: (t) => (/anything new/i.test(t) ? question({ asksBaumy: true }) : chatter()),
    },
    steps: [
      say('Marco', 'between us: I might move out in spring', { dm: true }),
      say('Charli', 'anything new?', { mention: true }),
      expectPrompt('reply', (c) => !/move out/.test(c.prompt), 'the private DM is not in the group’s context'),
      expectPrompt('triage', (c) => !/move out/.test(c.prompt), 'nor in triage’s'),
    ],
  })

  scenario('a member-forwarded message is labelled as forwarded, never as the forwarder’s own words', {
    people: HOUSE,
    startAt: '2026-09-28 18:00',
    fixtures: {
      triage: (t) => (/is that right/i.test(t) ? question({ asksBaumy: true }) : chatter()),
    },
    steps: [
      say('Marco', 'Landlord: rent goes up 20% from November', { forwarded: true }),
      say('Charli', 'is that right?', { mention: true }),
      expectPrompt(
        'reply',
        (c) => recentChat(c.prompt).some((l) => l.includes("Marco forwarded (not Marco's own words)") && l.includes('rent goes up')),
        'the forward is labelled in RECENT CHAT',
      ),
    ],
  })
})
