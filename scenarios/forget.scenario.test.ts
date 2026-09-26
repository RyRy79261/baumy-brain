import { describe } from 'vitest'
import { scenario, say, tap, expectFact, expectWords, check } from './dsl'
import { statement, forgetAsk, chatter, fact } from './shapes'
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
      tap('Charli'),
      check('the card is rewritten as done, in the DM it was tapped in', (r, e) => {
        const edit = r.turns.at(-1)!.entries.find((x) => x.kind === 'edit')
        e(edit?.chatId).toBe(String(r.spec.people.find((p) => p.name === 'Charli')!.id))
        e(edit?.text).toMatch(/Forgotten — 1 fact/)
      }),
      expectFact({ subject: /charli/, object: NUMBER, current: true, count: 0 }),
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
