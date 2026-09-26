import { describe } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { scenario, say, tap, expectFact, expectWords, expectPrompt, expectDb, check } from './dsl'
import { promptSection } from './fake-model'
import { statement, question, forgetAsk, chatter, fact } from './shapes'
import { HOUSE } from './house'

// Forget, end to end through BOTH halves of the confirm-tap wall (AGENTS.md; spec §8 A1): a request
// only PROPOSES a deletion (a card naming the exact rows), and nothing is removed until a housemate
// taps confirm — which then deletes in the house SCOPE the proposal stored, never in the chat the
// button was tapped in (a DM chat, or a migrated supergroup's live id, owns no memory rows).

const start = '2026-09-24 19:00'
const NUMBER = '0176 5554433'
const fixtures = {
  triage: (t: string) => (/forget/i.test(t) ? forgetAsk() : /number is/i.test(t) ? statement() : chatter()),
  extract: (t: string) => (/number is/i.test(t) ? [fact({ subject: 'charli', subjectKind: 'person' as const, predicate: 'phone', object: NUMBER })] : []),
  forget: (t: string) => (/forget/i.test(t) ? { isForget: true, values: [NUMBER] } : null),
}

// The 48h conversation window (baumy_messages): every row, or one chat's.
async function windowTexts(db: Database, chatId?: string): Promise<string[]> {
  const res = (await db.execute(
    chatId ? sql`SELECT text_redacted FROM baumy_messages WHERE chat_id = ${chatId} ORDER BY seq` : sql`SELECT text_redacted FROM baumy_messages ORDER BY seq`,
  )) as unknown as { rows?: { text_redacted: string }[] } | { text_redacted: string }[]
  return (Array.isArray(res) ? res : (res.rows ?? [])).map((r) => r.text_redacted)
}
const dmOf = (r: { spec: { people: { name: string; id: number }[] } }, name: string) => String(r.spec.people.find((p) => p.name === name)!.id)

describe('scenario: forget — propose, then a tap', () => {
  scenario('a DM "forget my number" → a card in the DM → tap → the HOUSE fact is gone', {
    people: HOUSE,
    startAt: start,
    fixtures,
    steps: [
      say('Charli', `my number is ${NUMBER}`),
      expectFact({ subject: /charli/, object: NUMBER, current: true }),
      say('Charli', `forget my number ${NUMBER}`, { dm: true }),
      expectWords({ contains: 'Tap to confirm' }),
      expectFact({ subject: /charli/, object: NUMBER, current: true }), // proposed only — nothing removed yet
      // The card NAMES the number; the window keeps only that a card was sent (and that a forget was asked).
      expectDb(async (db, r) => {
        const dm = await windowTexts(db, dmOf(r, 'Charli'))
        return dm.length === 2 && !dm.some((t) => t.includes(NUMBER)) && dm.some((t) => /confirm card/.test(t))
      }, 'neither the forget request nor the confirm card keeps the number in the DM’s window'),
      tap('Charli'),
      check('the card is rewritten as done, in the DM it was tapped in', (r, e) => {
        const edit = r.turns.at(-1)!.entries.find((x) => x.kind === 'edit')
        e(edit?.chatId).toBe(dmOf(r, 'Charli'))
        e(edit?.text).toMatch(/Forgotten — 1 fact/)
      }),
      expectFact({ subject: /charli/, object: NUMBER, current: true, count: 0 }),
      // A SOFT forget clears the window too: the group line that stated the number is withheld.
      expectDb(async (db) => !(await windowTexts(db)).some((t) => t.includes(NUMBER)), 'no window row anywhere still holds the number'),
    ],
  })

  scenario('a PERMANENT forget scrubs the value from the group’s recent chat', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      ...fixtures,
      triage: (t: string) => (/forget/i.test(t) ? forgetAsk() : /number is|call me/i.test(t) ? statement() : chatter()),
      forget: (t: string) => (/forget/i.test(t) ? { isForget: true, values: [NUMBER], permanent: true } : null),
    },
    steps: [
      say('Charli', `my number is ${NUMBER}`),
      say('Marco', `ok I'll call you on ${NUMBER} if the door jams`),
      expectDb(async (db) => (await windowTexts(db)).filter((t) => t.includes(NUMBER)).length === 2, 'both lines are in the window before the forget'),
      say('Charli', 'permanently forget my number', { dm: true }),
      expectWords({ contains: 'permanently forget' }),
      tap('Charli'),
      expectFact({ subject: /charli/, object: NUMBER, current: true, count: 0 }),
      expectDb(async (db) => {
        const texts = await windowTexts(db)
        return !texts.some((t) => t.includes(NUMBER)) && texts.some((t) => t.includes("ok I'll call you on [redacted]"))
      }, 'the number is gone from every window row (the rest of Marco’s line is kept)'),
    ],
  })

  scenario('after a soft forget, the forgotten news no longer answers from RECENT CHAT', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t: string) => (/^forget/i.test(t) ? forgetAsk() : /is zuzka coming/i.test(t) ? question({ asksBaumy: true }) : /coming friday/i.test(t) ? statement() : chatter()),
      extract: (t: string) =>
        /coming friday/i.test(t) ? [fact({ subject: 'zuzka', subjectKind: 'person' as const, predicate: 'arrives_on', object: 'friday', when: 'friday' })] : [],
      forget: (t: string) => (/^forget/i.test(t) ? { isForget: true, values: [], subject: 'Zuzka', attribute: 'arrives' } : null),
      reply: (t: string) => (/is zuzka coming/i.test(t) ? { reply: "Nobody's mentioned Zuzka coming 🐈", answered: false } : 'Noted 😼'),
    },
    steps: [
      say('Marco', "Zuzka's coming friday"),
      expectFact({ subject: /zuzka/, predicate: /arrives/, current: true }),
      say('Marco', 'forget that Zuzka is coming', { dm: true }),
      expectWords({ contains: 'Tap to confirm' }),
      tap('Marco'),
      expectFact({ subject: /zuzka/, predicate: /arrives/, current: true, count: 0 }),
      say('Charli', 'is Zuzka coming?', { mention: true }),
      expectPrompt('reply', (c) => !promptSection(c.prompt, 'RECENT CHAT').some((l) => /coming friday/i.test(l)), 'the forgotten line is not in RECENT CHAT'),
      expectPrompt('reply', (c) => !promptSection(c.prompt, 'MEMORY').some((l) => /zuzka/i.test(l) && /- fact/.test(l)), 'nor a current fact in MEMORY'),
      expectWords({ judge: 'Does NOT say that Zuzka is coming (or coming on Friday). It may say nobody has mentioned it or that it does not know.' }),
    ],
  })

  scenario('cancel leaves the memory untouched, and the card cannot be confirmed afterwards', {
    people: HOUSE,
    startAt: start,
    fixtures,
    steps: [
      say('Charli', `my number is ${NUMBER}`),
      say('Charli', `baumy forget my number ${NUMBER}`),
      expectWords({ contains: 'Tap to confirm' }),
      tap('Marco', 'cancel'),
      tap('Charli', 'confirm'),
      check('the late confirm is refused', (r, e) => {
        const answer = r.turns.at(-1)!.entries.find((x) => x.kind === 'callback-answer')
        e(answer?.text).toMatch(/expired or was handled/)
      }),
      expectFact({ subject: /charli/, object: NUMBER, current: true }),
    ],
  })
})
