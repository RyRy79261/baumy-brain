import { describe } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { scenario, say, advance, expectPrompt, expectNoPrompt, expectWords, expectReminder, expectDb, expectFact, check } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, reminderAsk, fact, reminder } from './shapes'
import { HOUSE } from './house'

// Phase 3 — the time model (docs/spec/chat-understanding-v2.md §6). Extraction is told WHEN the message
// was sent and gets a calendar table; facts carry an event window and stop being "current" once it is
// over (T2); reminders resolve the whole phrase with fixed defaults (T4/T8/T9), recur (A6) and name
// who asked (A4); heads-ups are written at DELIVERY with the real lead (T11); /weekly and /guests are
// dated (T5). Offline, the reminder fixtures mostly give only the verbatim phrase — so what is tested
// is the code's validation + chrono fallback; live, the real model resolves it against the calendar.

type Row = Record<string, unknown>
const rowsOf = (res: unknown): Row[] => (Array.isArray(res) ? res : ((res as { rows?: Row[] }).rows ?? []))
const localOf = async (db: Database, col: 'event_at' | 'valid_to', predicate: string): Promise<string | null> => {
  const res = await db.execute(sql`
    SELECT to_char(${sql.raw(col)} AT TIME ZONE 'Europe/Berlin', 'Dy YYYY-MM-DD HH24:MI') AS v FROM baumy_facts WHERE predicate = ${predicate} LIMIT 1`)
  return (rowsOf(res)[0]?.v as string | undefined) ?? null
}

describe('scenario: the time model (phase 3)', () => {
  scenario('a guest who stayed last weekend is not reported as staying now (T2)', {
    people: HOUSE,
    startAt: '2026-09-17 19:00', // Thursday
    fixtures: {
      triage: (t) => (/who's staying/i.test(t) ? question({ asksBaumy: true }) : t.includes('Zosia is staying') ? statement() : chatter()),
      extract: (t, speaker) =>
        t.includes('Zosia is staying')
          ? [
              fact({
                subject: 'zosia',
                subjectKind: 'person',
                predicate: 'stays_in',
                object: `${(speaker ?? 'chloe').toLowerCase()}'s room, Sat 19–Sun 20 Sep`,
                objectKind: 'place',
                when: { start: '2026-09-19', end: '2026-09-20', allDay: true },
                whenText: 'this weekend',
              }),
            ]
          : [],
      reply: (t) => (/who's staying/i.test(t) ? "Nobody right now — Zosia had it last weekend (19–20 Sep) 🐈" : 'Noted 😼'),
      report: () => 'No guests on the books right now 😺',
    },
    steps: [
      say('Chloe', 'Zosia is staying in my room this weekend'),
      expectPrompt('extract', /MESSAGE SENT: Thu 17 Sep 2026 19:00 Europe\/Berlin/, 'the extractor was told when the message was sent'),
      expectPrompt('extract', /Sat 2026-09-19/, '…and given the calendar table to look the weekend up in'),
      expectDb(async (db) => (await localOf(db, 'valid_to', 'stays_in')) === 'Sun 2026-09-20 23:59', 'the stay ends at the end of Sunday (valid_to)'),
      advance({ days: 5 }), // → Tue 22 Sep: the stay is over
      say('Marco', "who's staying in Chloe's room?", { mention: true }),
      expectPrompt(
        'reply',
        (c) => !memoryLines(c.prompt).some((l) => /^\s*- fact/.test(l) && /zosia/i.test(l)),
        'MEMORY carries no CURRENT fact about Zosia staying — the stay is over',
      ),
      expectWords({ judge: "Does NOT say Zosia is staying in Chloe's room now. It may say nobody is, or that Zosia stayed there last weekend." }),
      say('Ryan', '/guests'),
      expectPrompt('guests', (c) => !/zosia stays in/i.test(c.prompt), '/guests is not given the expired stay as a current guest'),
      expectWords({ judge: 'Does not list Zosia as a current or upcoming guest.' }),
    ],
  })

  scenario('"remind me at 5", said at 14:00, fires at 17:00 today — and names who asked (T9, A4)', {
    people: HOUSE,
    startAt: '2026-09-28 14:00', // Monday
    fixtures: {
      triage: (t) => (/remind me/i.test(t) ? reminderAsk({ asksBaumy: true }) : chatter()),
      reminder: () => reminder({ content: 'take the bins out', when: 'at 5', forWhom: 'speaker' }),
      reply: () => "On it — today at 17:00 ⏰",
    },
    steps: [
      say('Ryan', 'remind me at 5 to take the bins out', { mention: true }),
      expectPrompt('reminder', /MESSAGE SENT: Mon 28 Sep 2026 14:00/, 'the reminder extractor was told the time it was asked'),
      expectReminder({ content: 'Ryan: take the bins out', at: '2026-09-28 17:00', status: 'scheduled', count: 1 }),
      expectPrompt('reply', /reminder set Mon 28 Sep 17:00 — Ryan: take the bins out/, 'THIS TURN carries the resolved time'),
      expectWords({ judge: 'Confirms a reminder for 5pm / 17:00 today (not tomorrow morning).' }),
      advance({ hours: 4 }),
      expectWords({ contains: '⏰ Ryan: take the bins out' }),
      expectReminder({ content: /bins/, status: 'sent', count: 1 }),
    ],
  })

  scenario('"friday around 10pm" fires at 22:00 on Friday, not 09:00 (T4)', {
    people: HOUSE,
    startAt: '2026-09-30 10:30', // Wednesday
    fixtures: {
      triage: (t) => (/remind us/i.test(t) ? reminderAsk({ asksBaumy: true }) : chatter()),
      reminder: () => reminder({ content: 'let Zosia in', when: 'friday around 10pm', forWhom: 'house' }),
      reply: () => 'Done — Fri 2 Oct, 22:00 ⏰',
    },
    steps: [
      say('Marco', 'remind us friday around 10pm to let Zosia in', { mention: true }),
      expectReminder({ content: 'let Zosia in', at: '2026-10-02 22:00', status: 'scheduled', count: 1 }),
      expectPrompt('reply', /reminder set Fri 2 Oct 22:00/, 'THIS TURN carries Friday 22:00'),
      expectWords({ judge: 'Confirms a reminder on Friday (2 Oct) at 10pm / 22:00.' }),
      advance({ days: 2, hours: 11, minutes: 45 }), // → Fri 22:15
      expectWords({ contains: '⏰ let Zosia in' }),
    ],
  })

  scenario('"every friday at 8pm" recurs — delivered two Fridays running, the third already scheduled (A6)', {
    people: HOUSE,
    startAt: '2026-09-28 10:00', // Monday
    fixtures: {
      triage: (t) => (/remind us/i.test(t) ? reminderAsk({ asksBaumy: true }) : chatter()),
      reminder: () => reminder({ content: 'put the bins out', when: 'every friday at 8pm', fireAt: '2026-10-02T20:00', recurrence: 'FREQ=WEEKLY;BYDAY=FR', forWhom: 'house' }),
      reply: () => 'Done — every Friday at 20:00 ⏰',
    },
    steps: [
      say('Ryan', 'remind us every friday at 8pm to put the bins out', { mention: true }),
      expectReminder({ content: /bins/, at: '2026-10-02 20:00', status: 'scheduled', count: 1 }),
      expectPrompt('reply', /reminder set Fri 2 Oct 20:00 \(repeats every Friday\)/, 'THIS TURN says it repeats'),
      expectWords({ judge: 'Confirms a WEEKLY reminder: every Friday at 8pm / 20:00, to put the bins out. Must not suggest it is a one-off.' }),
      advance({ days: 4, hours: 11 }), // → Fri 2 Oct 21:00
      expectWords({ contains: '⏰ put the bins out' }),
      check('posted exactly once that Friday (the 20:00 digest does not double it)', (r, e) => {
        const t = r.turns.at(-1)!
        e(t.entries.filter((x) => x.kind === 'message' && x.text?.includes('put the bins out'))).toHaveLength(1)
      }),
      expectReminder({ content: /bins/, at: '2026-10-09 20:00', status: 'scheduled', count: 1 }),
      advance({ days: 7 }), // → Fri 9 Oct 21:00
      expectWords({ contains: '⏰ put the bins out' }),
      expectReminder({ content: /bins/, status: 'sent', count: 2 }),
      expectReminder({ content: /bins/, at: '2026-10-16 20:00', status: 'scheduled', count: 1 }),
    ],
  })

  scenario('"the 9th" resolves — for a reminder and for a dated fact (T8)', {
    people: HOUSE,
    startAt: '2026-09-24 15:00', // Thursday
    fixtures: {
      triage: (t) => (/remind me/i.test(t) ? reminderAsk({ asksBaumy: true }) : /parents/.test(t) ? statement() : chatter()),
      reminder: () => reminder({ content: 'pay the rent', when: 'on the 9th', forWhom: 'speaker' }),
      extract: (t) => (/parents/.test(t) ? [fact({ subject: "marco's parents", subjectKind: 'person', predicate: 'arrive_on', object: 'Fri 9 Oct', when: 'the 9th' })] : []),
      reply: () => 'Got it — Fri 9 Oct ⏰',
    },
    steps: [
      say('Chloe', 'remind me to pay the rent on the 9th', { mention: true }),
      expectReminder({ content: 'Chloe: pay the rent', at: '2026-10-09 09:00', status: 'scheduled', count: 1 }),
      expectWords({ judge: 'Confirms a reminder to pay the rent on Friday 9 October (morning).' }),
      say('Marco', 'my parents arrive on the 9th'),
      expectDb(async (db) => (await localOf(db, 'event_at', 'arrive_on')) === 'Fri 2026-10-09 00:00', 'the arrival is dated Fri 9 Oct (event_at)'),
    ],
  })

  scenario('a heads-up posted at 20:00 for an event the next day says "tomorrow" — written at delivery (T11)', {
    people: HOUSE,
    startAt: '2026-09-28 12:00', // Monday
    fixtures: {
      triage: (t) => (/party/.test(t) ? statement() : chatter()),
      extract: (t) =>
        /party/.test(t) ? [fact({ subject: 'marco', subjectKind: 'person', predicate: 'hosts_party', object: 'Thu 1 Oct 21:00', when: { start: '2026-10-01T21:00' }, whenText: 'thursday 9pm' })] : [],
      // Echoes the lead it was TOLD — so the posted line shows exactly what delivery computed.
      headsup: (c) => `Marco's party is ${c.prompt.match(/^WHEN: (.+?) \(/m)?.[1] ?? '?'} 🎉`,
    },
    steps: [
      say('Marco', 'party at mine thursday 9pm'),
      advance({ days: 2, hours: 8, minutes: 5 }), // → Wed 30 Sep 20:05 (scans ran Tue + Wed 07:45; the 20:00 digest delivered)
      expectPrompt('headsup', /^WHEN: tomorrow \(Thu 1 Oct, 21:00\)$/m, 'the line was written at delivery, told the real lead'),
      expectWords({ contains: "🗓️ Marco's party is tomorrow" }),
      advance({ hours: 12 }), // → Thu 1 Oct 08:05
      expectWords({ contains: "🗓️ Marco's party is tonight" }),
      check('the morning-of line never says "tomorrow" on the day', (r, e) => {
        const words = r.turns.at(-1)!.entries.map((x) => x.text ?? '').join('\n')
        e(words).not.toContain('tomorrow')
      }),
    ],
  })

  scenario('a date-only "when" without the allDay flag is the whole day: current all day, and the morning heads-up still goes out', {
    people: HOUSE,
    startAt: '2026-09-28 12:00', // Monday
    fixtures: {
      triage: (t) => (/when does zosia/i.test(t) ? question({ asksBaumy: true }) : /arrives/.test(t) ? statement() : chatter()),
      // The model resolved the day but left the optional allDay flag out — a valid output.
      extract: (t) =>
        /arrives/.test(t) ? [fact({ subject: 'zosia', subjectKind: 'person', predicate: 'arrives_on', object: 'Sat 3 Oct', when: { start: '2026-10-03' } })] : [],
      headsup: (c) => `Zosia arrives ${c.prompt.match(/^WHEN: (.+?) \(/m)?.[1] ?? '?'} 🧳`,
      reply: (t) => (/when does zosia/i.test(t) ? 'Today — Sat 3 Oct 🧳' : 'Noted 😼'),
    },
    steps: [
      say('Chloe', 'Zosia arrives on saturday'),
      expectDb(async (db) => (await localOf(db, 'valid_to', 'arrives_on')) === 'Sat 2026-10-03 23:59', 'the arrival lasts the whole Saturday (not until 06:00)'),
      advance({ days: 4, hours: 8, minutes: 5 }), // → Fri 2 Oct 20:05
      expectWords({ contains: '🗓️ Zosia arrives tomorrow' }),
      advance({ hours: 12 }), // → Sat 3 Oct 08:05
      expectWords({ contains: '🗓️ Zosia arrives today' }),
      advance({ hours: 6 }), // → Sat 14:05
      say('Marco', 'when does Zosia arrive?', { mention: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /- fact/.test(l) && /zosia arrives on/i.test(l)), 'the arrival is still a CURRENT fact on the day itself'),
      expectWords({ judge: 'Says Zosia arrives today (Saturday 3 October). Must not say it does not know.' }),
    ],
  })

  scenario('a past-dated change of state takes effect: "the plumber fixed the sink yesterday" over "the sink is broken"', {
    people: HOUSE,
    startAt: '2026-09-20 10:00', // Sunday
    fixtures: {
      triage: (t) => (/is the sink/i.test(t) ? question({ asksBaumy: true }) : /sink/.test(t) ? statement() : chatter()),
      extract: (t) =>
        /is broken/.test(t)
          ? [fact({ subject: 'kitchen sink', predicate: 'status', object: 'broken' })]
          : /fixed the sink yesterday/.test(t)
            ? [fact({ subject: 'kitchen sink', predicate: 'status', object: 'fixed', when: { start: '2026-09-25', allDay: true }, whenText: 'yesterday' })]
            : [],
      reply: (t) => (/is the sink/i.test(t) ? 'Yes — Marco said the plumber fixed it yesterday (Fri 25 Sep) 🔧' : 'Noted 😼'),
    },
    steps: [
      say('Chloe', 'the kitchen sink is broken'),
      advance({ days: 6 }), // → Sat 26 Sep
      say('Marco', 'the plumber fixed the sink yesterday'),
      expectFact({ subject: /sink/, object: 'fixed', current: true }),
      expectFact({ subject: /sink/, object: 'broken', current: true, count: 0 }),
      say('Ryan', 'is the kitchen sink fixed?', { mention: true }),
      expectPrompt(
        'reply',
        (c) => {
          const facts = memoryLines(c.prompt).filter((l) => /- fact/.test(l)).map((l) => l.split(' (earlier:')[0])
          return facts.some((l) => /since Fri 25 Sep: kitchen sink status: fixed$/.test(l)) && !facts.some((l) => /status: broken$/.test(l))
        },
        'MEMORY grounds the NEW state (since Fri 25 Sep), not the old one',
      ),
      expectWords({ judge: 'Says yes, the sink has been fixed (the plumber fixed it yesterday). Must not say it is still broken.' }),
    ],
  })

  scenario('/weekly is the last 7 days of dated news plus what is coming up, each with its date (T5)', {
    people: HOUSE,
    startAt: '2026-09-07 10:00', // Monday
    fixtures: {
      triage: (t) => (/remind us/i.test(t) ? reminderAsk({ asksBaumy: true }) : /party|boiler/.test(t) ? statement() : chatter()),
      reminder: () => reminder({ content: 'put the bins out', when: 'friday 8pm', forWhom: 'house' }),
      reply: () => 'Done ⏰',
      report: () => '🌳 This week: the boiler got serviced (Mon 21 Sep). Coming up: bins Fri 25 Sep, 20:00.',
    },
    steps: [
      say('Chloe', 'the party is tomorrow night'),
      advance({ days: 14 }), // → Mon 21 Sep
      say('Chloe', 'the boiler got serviced'),
      say('Marco', 'remind us friday 8pm to put the bins out', { mention: true }),
      say('Ryan', '/weekly'),
      expectNoPrompt('reply', '/weekly is a command, not a question'),
      expectPrompt('weekly', /- noted Mon 21 Sep by Chloe: the boiler got serviced/, 'this week’s note is dated and attributed'),
      expectPrompt('weekly', /- reminder Fri 25 Sep 20:00: put the bins out/, 'the coming reminder carries its day and time'),
      expectPrompt('weekly', (c) => !c.prompt.includes('the party is tomorrow night'), 'a two-week-old note is not this week’s news'),
      expectWords({ judge: 'A short weekly digest that mentions the boiler service and the Friday (25 Sep) 8pm bins reminder WITH their dates. Must not mention a party.' }),
    ],
  })
})
