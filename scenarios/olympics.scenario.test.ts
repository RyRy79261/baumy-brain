import { describe } from 'vitest'
import { scenario, say, tap, expectWords, expectNoWords, expectNoPrompt, expectPrompt, expectReminder, check, type Run } from './dsl'
import { request, statement, question, chatter, reminderAsk, reminder } from './shapes'
import { HOUSE } from './house'
import { FakeOlympics } from './olympics-fake'

// Baumy Olympics from Telegram (docs/spec/olympics.md, RyRy79261/baumy-olympics#28): the calendar and
// the chore game, run AS the authenticated sender. Reads answer straight away; a write is only a
// confirm card until its asker taps it, and the tap goes out with X-Baumy-Confirmed and the
// Idempotency-Key minted with the card — so a retried tap never creates a second event.

const start = '2026-10-01 18:00' // Thursday — "Saturday" is Sat 3 Oct
const DINNER = 'add dinner with Anna Saturday 19:00'
const TRASH = 'I took the trash out'

const house = () =>
  new FakeOlympics({
    members: [
      { id: 'm-ryan', displayName: 'Ryan', telegramUserId: '703' },
      { id: 'm-marco', displayName: 'Marco' },
    ],
    chores: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Take out the trash', basePoints: 10, cooldownMinutes: 120 },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Dishes', basePoints: 6 },
    ],
  })

const fixtures = {
  triage: (t: string) =>
    /calendar|add dinner/i.test(t)
      ? request({ asksBaumy: true, olympics: /what'?s on/i.test(t) ? 'calendar_list' : 'calendar_add' })
      : /trash|dishes/i.test(t)
        ? statement({ asksBaumy: true, worthRemembering: false, olympics: 'chore_log' })
        : /winning|standings/i.test(t)
          ? question({ asksBaumy: true, olympics: 'standings' })
          : chatter(),
  olympics: (t: string) =>
    /add dinner/i.test(t)
      ? { op: 'calendar_add' as const, title: 'Dinner with Anna', date: '2026-10-03', startTime: '19:00', endTime: '' }
      : /what'?s on/i.test(t)
        ? { op: 'calendar_list' as const, from: '2026-10-03', to: '2026-10-04' }
        : /trash/i.test(t)
          ? { op: 'chore_log' as const, chore: 'trash' }
          : /winning|standings/i.test(t)
            ? { op: 'standings' as const }
            : null,
}

const fake = (r: Run) => r.olympics!
const lastEdit = (r: Run) => r.turns.at(-1)!.entries.filter((x) => x.kind === 'edit').at(-1)?.text ?? null
const lastAnswer = (r: Run) => r.turns.at(-1)!.entries.filter((x) => x.kind === 'callback-answer').at(-1)?.text ?? null
const cards = (r: Run) => r.turns.at(-1)!.entries.filter((x) => x.kind === 'confirm-card')

describe('scenario: Baumy Olympics from Telegram', () => {
  scenario('"add dinner with Anna Saturday 19:00" → a confirm card → the tap creates ONE event, as the asker, audited source=brain', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: house,
    steps: [
      say('Ryan', DINNER, { dm: true }),
      expectWords({ contains: ['Add this to the house calendar?', 'Dinner with Anna', 'Sat 3 Oct, 19:00–20:00', 'Tap to confirm'] }),
      expectNoPrompt('reply', 'the card is deterministic — the reply model never words an Olympics op'),
      check('nothing is written before the tap (only the whoami link check ran)', (r, e) => {
        e(fake(r).events).toHaveLength(0)
        e(fake(r).calls.map((c) => c.name)).toEqual(['whoami'])
      }),
      tap('Ryan'),
      check('the card now says what was added', (r, e) => e(lastEdit(r)).toMatch(/✅ Added to the house calendar: Dinner with Anna/)),
      check('one event, created with the confirm header, as Ryan, with an idempotency key, audited source=brain', (r, e) => {
        const f = fake(r)
        e(f.events).toHaveLength(1)
        e(f.events[0]).toMatchObject({ title: 'Dinner with Anna', startDate: '2026-10-03', startTime: '19:00', endTime: '20:00', addedBy: 'm-ryan' })
        const call = f.calls.find((c) => c.name === 'create_event')!
        e(call).toMatchObject({ actor: '703', confirmed: true, status: 200 })
        e(call.idempotencyKey).toMatch(/^brain-[0-9a-f-]{36}$/)
        e(call.body).toEqual({ title: 'Dinner with Anna', kind: 'timed', date: '2026-10-03', startTime: '19:00', endTime: '20:00' })
        e(f.audit).toEqual([{ action: 'create_event', memberId: 'm-ryan', source: 'brain', entityId: f.events[0].id }])
      }),
      tap('Ryan'),
      check('a second tap on the same card does nothing', (r, e) => {
        e(lastAnswer(r)).toMatch(/already expired or was handled/)
        e(fake(r).events).toHaveLength(1)
      }),
    ],
  })

  scenario('a tap whose answer was lost is retried with the SAME Idempotency-Key — still one event', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: house,
    offlineOnly: 'scripts a lost Olympics answer',
    steps: [
      say('Ryan', DINNER, { dm: true }),
      check('Olympics will commit the next create_event but its answer never arrives', (r) => void fake(r).loseNextAnswer.add('create_event')),
      tap('Ryan'),
      check('the asker is told to tap again; the card is kept', (r, e) => {
        e(lastAnswer(r)).toMatch(/didn't answer — tap confirm again/)
        e(lastEdit(r)).toBeNull()
      }),
      tap('Ryan'),
      check('the retry replays the stored answer: one event, two calls, one key', (r, e) => {
        const f = fake(r)
        e(f.events).toHaveLength(1)
        const calls = f.calls.filter((c) => c.name === 'create_event')
        e(calls).toHaveLength(2)
        e(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey)
        e(lastEdit(r)).toMatch(/✅ Added to the house calendar: Dinner with Anna/)
      }),
    ],
  })

  scenario('an unlinked housemate is told to link first; /link links them; "I took the trash out" + a tap logs the chore for them', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: () => {
      const f = house()
      f.codes.set('GOODCODE42', 'm-marco')
      return f
    },
    steps: [
      say('Marco', DINNER, { dm: true }),
      expectWords({ contains: ['/link <code>', 'Settings'] }),
      check('no card for an unlinked asker', (r, e) => e(cards(r)).toHaveLength(0)),
      say('Marco', '/link WRONGCODE1', { dm: true }),
      expectWords({ contains: "That code didn't work" }),
      say('Marco', '/link', { dm: true }),
      expectWords({ contains: 'Send it like this: /link' }),
      say('Marco', '/link GOODCODE42', { dm: true }),
      expectWords({ contains: "Linked — you're Marco in Baumy Olympics" }),
      check('linked as the sender, never the text', (r, e) => e(fake(r).members.find((m) => m.id === 'm-marco')!.telegramUserId).toBe('702')),
      say('Marco', TRASH, { dm: true }),
      expectWords({ contains: ['Log this chore for you?', '🧹 Take out the trash — +10 points', 'Tap to confirm'] }),
      check('nothing is logged before the tap', (r, e) => e(fake(r).completions).toHaveLength(0)),
      tap('Marco'),
      check('logged for Marco, confirmed, audited source=brain', (r, e) => {
        const f = fake(r)
        e(f.completions).toEqual([e.objectContaining({ choreId: '11111111-1111-4111-8111-111111111111', doneBy: 'm-marco' })])
        e(f.calls.find((c) => c.name === 'log_completion')).toMatchObject({ actor: '702', confirmed: true, body: { choreId: '11111111-1111-4111-8111-111111111111' } })
        e(f.audit.at(-1)).toMatchObject({ action: 'log_completion', memberId: 'm-marco', source: 'brain' })
        e(lastEdit(r)).toMatch(/✅ Logged: Take out the trash — \+10 points/)
      }),
      say('Marco', TRASH, { dm: true }),
      expectWords({ contains: 'was done recently' }),
      check('a chore still cooling down gets no card', (r, e) => e(cards(r)).toHaveLength(0)),
    ],
  })

  scenario("only the asker can confirm their card — another housemate's tap is refused", {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: house,
    steps: [
      say('Ryan', DINNER, { mention: true }),
      expectWords({ contains: 'Add this to the house calendar?' }),
      tap('Marco'),
      check('Marco cannot confirm Ryan’s card', (r, e) => {
        e(lastAnswer(r)).toMatch(/Only the person who asked/)
        e(fake(r).events).toHaveLength(0)
      }),
      tap('Ryan'),
      check('Ryan still can', (r, e) => e(fake(r).events).toHaveLength(1)),
    ],
  })

  scenario('reads answer straight away: what is on the calendar, the standings', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: () => {
      const f = house()
      f.events.push({ id: 'evt1', title: 'Flat party', location: null, allDay: false, startDate: '2026-10-03', endDate: '2026-10-03', startTime: '21:00', endTime: '23:00', when: 'Sat 3 Oct, 21:00–23:00', addedBy: 'm-ryan' })
      f.completions.push({ id: 'c1', choreId: '22222222-2222-4222-8222-222222222222', doneBy: 'm-ryan', at: 0 })
      return f
    },
    steps: [
      say('Ryan', "what's on the calendar this weekend?", { dm: true }),
      expectWords({ contains: ['House calendar, Sat 3 Oct – Sun 4 Oct', '• Sat 3 Oct, 21:00–23:00 — Flat party'] }),
      say('Ryan', "who's winning the standings?", { dm: true }),
      expectWords({ contains: ['standings — Ryan leads', '1. Ryan — 6 pts'] }),
      check('no card, no write', (r, e) => e(fake(r).calls.every((c) => c.name === 'list_events' || c.name === 'get_standings')).toBe(true)),
    ],
  })

  scenario('a proposal code cannot validate never becomes a card: a past day, an unknown chore', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      ...fixtures,
      olympics: (t: string) =>
        /yesterday/.test(t)
          ? { op: 'calendar_add' as const, title: 'Dinner', date: '2026-09-30', startTime: '19:00' }
          : /windows/.test(t)
            ? { op: 'chore_log' as const, chore: 'windows' }
            : fixtures.olympics(t),
    },
    olympics: house,
    steps: [
      say('Ryan', 'add dinner yesterday to the calendar', { dm: true }),
      expectWords({ contains: 'already passed' }),
      say('Ryan', 'I did the trash and the windows', { dm: true }),
      expectWords({ contains: ["I couldn't match \"windows\" to a chore", '• Take out the trash', '• Dishes'] }),
      check('no card, and nothing written', (r, e) => {
        e(r.turns.flatMap((t) => t.entries).filter((x) => x.kind === 'confirm-card')).toHaveLength(0)
        e(fake(r).calls.some((c) => c.name === 'create_event' || c.name === 'log_completion')).toBe(false)
      }),
    ],
  })

  scenario('Olympics not connected → a friendly line, never an error', {
    people: HOUSE,
    startAt: start,
    fixtures,
    steps: [
      say('Ryan', DINNER, { dm: true }),
      expectWords({ contains: "Baumy Olympics isn't connected to me yet" }),
      say('Ryan', '/link GOODCODE42', { dm: true }),
      expectWords({ contains: "Baumy Olympics isn't connected to me yet" }),
    ],
  })

  scenario('Olympics down → "not answering", never an error', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: () => Object.assign(house(), { down: true }),
    offlineOnly: 'scripts an Olympics outage',
    steps: [say('Ryan', TRASH, { dm: true }), expectWords({ contains: "Baumy Olympics isn't answering right now" })],
  })

  scenario('/link in the group is never used — the code could be claimed by anyone reading', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: () => {
      const f = house()
      f.codes.set('GOODCODE42', 'm-marco')
      return f
    },
    steps: [
      say('Marco', '/link GOODCODE42'),
      expectWords({ contains: "Don't post link codes in the group" }),
      check('Olympics was never called', (r, e) => e(fake(r).calls).toHaveLength(0)),
    ],
  })

  scenario('undirected "I took the trash out" in the group logs nothing and proposes nothing', {
    people: HOUSE,
    startAt: start,
    fixtures,
    olympics: house,
    steps: [
      say('Ryan', TRASH),
      expectNoWords(),
      check('Olympics was never called', (r, e) => e(fake(r).calls).toHaveLength(0)),
    ],
  })

  scenario('a calendar add + a group reminder in ONE message: both happen; after the tap Baumy knows it is done', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      triage: (t: string) => (/bed/i.test(t) ? reminderAsk({ asksBaumy: true, olympics: 'calendar_add' }) : question({ asksBaumy: true })),
      olympics: (t: string) => (/bed/i.test(t) ? { op: 'calendar_add' as const, title: 'Bed delivery', date: '2026-10-08', startTime: '', endTime: '' } : null),
      reminder: (t: string) =>
        /bed/i.test(t) ? reminder({ content: 'the bed arrives tomorrow', when: 'wednesday 9am', fireAt: '2026-10-07T09:00', forWhom: 'house' }) : null,
      reply: () => "Yes — the bed delivery is on the calendar for Thu 8 Oct 🐈",
    },
    olympics: house,
    steps: [
      say('Ryan', 'put the bed delivery on the calendar for Thursday the 8th and remind the group wednesday 9am', { dm: true }),
      expectWords({ contains: ['Add this to the house calendar?', 'Bed delivery', '⏰ Reminder set: Wed 7 Oct 09:00 — the bed arrives tomorrow'] }),
      expectReminder({ content: /bed arrives/, at: '2026-10-07 09:00', status: 'scheduled', count: 1 }),
      tap('Ryan'),
      check('the tap added the event', (r, e) => e(fake(r).events).toHaveLength(1)),
      say('Ryan', 'did that go through?', { dm: true }),
      expectPrompt('reply', /✅ Added to the house calendar: Bed delivery/, 'the window shows the card as the tap left it'),
      expectPrompt('reply', (c) => !c.prompt.includes('Tap to confirm'), 'the stale "confirm?" card text is gone from RECENT CHAT'),
      expectWords({ judge: 'Says yes, the bed delivery is on the house calendar. Must NOT say it is still waiting for a confirm tap.' }),
    ],
  })
})
