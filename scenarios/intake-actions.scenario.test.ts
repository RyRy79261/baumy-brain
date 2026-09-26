import { describe } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { scenario, say, tap, advance, expectFact, expectWords, expectNoWords, expectSilent, expectReaction, expectPrompt, expectNoPrompt, expectReminder, expectDb, check } from './dsl'
import { memoryLines, promptSection } from './fake-model'
import { statement, question, reminderAsk, forgetAsk, chatter, fact, reminder } from './shapes'
import { HOUSE } from './house'

// Phase 5 of chat-understanding-v2 (spec §8): intake & actions — edits (I1), captions (I4), forwarded
// content (I5/D4), personal reminders (A4/A5/D2), soft forget (A7/A8), list ops (A11), new housemates (K6).

async function rows<T = Record<string, unknown>>(db: Database, q: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await db.execute(q)) as unknown as { rows?: T[] } | T[]
  return Array.isArray(res) ? res : (res.rows ?? [])
}
const idOf = (r: { spec: { people: { name: string; id: number }[] } }, name: string) => String(r.spec.people.find((p) => p.name === name)!.id)

describe('scenario: edits (I1)', () => {
  scenario('editing a statement supersedes the note and the fact — the typo is not remembered, and there is no second reply', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: (t) => (/arrives/.test(t) ? statement() : /when does/.test(t) ? question({ asksBaumy: true }) : chatter()),
      extract: (t) => {
        const day = t.match(/arrives (friday|saturday)/)?.[1]
        return day ? [fact({ subject: 'zuzka', subjectKind: 'person', predicate: 'arrives_on', object: day })] : []
      },
    },
    steps: [
      say('Charli', 'Zuzka arrives friday', { mention: true }),
      expectWords(),
      say('Charli', 'Zuzka arrives saturday', { mention: true, edit: true }),
      expectNoWords(),
      expectReaction('✍'),
      expectFact({ subject: /zuzka/, predicate: 'arrives_on', object: 'saturday', current: true }),
      expectFact({ subject: /zuzka/, object: 'friday', current: true, count: 0 }),
      expectDb(async (db) => {
        const active = await rows<{ content: string }>(db, sql`SELECT content FROM baumy_memory_items WHERE is_active`)
        return active.length === 1 && active[0].content === 'Zuzka arrives saturday'
      }, 'only the edited text is an active note'),
      say('Marco', 'when does Zuzka arrive?', { mention: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /saturday/.test(l)) && !c.prompt.includes('friday'), 'the reply sees saturday, and friday nowhere (not even as "earlier")'),
      expectWords({ judge: 'Says Zuzka arrives on Saturday. Must not mention Friday.' }),
    ],
  })

  scenario('an edit of a message Baumy never saw is handled as new — but silently', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: () => question({ asksBaumy: true }),
    },
    steps: [
      check('a message id Baumy has no record of', (r) => {
        r.turns.push({ kind: 'say', who: 'Ryan', text: '(sent before Baumy joined)', messageId: 424242, dm: false, entries: [], calls: [] })
      }),
      say('Ryan', "what's the bin day?", { mention: true, edit: true }),
      expectPrompt('triage', /bin day/, 'it is still read'),
      expectNoWords(),
    ],
  })
})

describe('scenario: captions and media (I4)', () => {
  scenario('a photo captioned "boiler code is 4821" is remembered — encrypted, never in plaintext', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: (t) => (/boiler code is/.test(t) ? statement() : /boiler code/.test(t) ? question({ asksBaumy: true }) : chatter()),
      extract: (t) => (/boiler code is/.test(t) ? [fact({ subject: 'boiler', predicate: 'code', object: '4821' })] : []),
      reply: () => 'The boiler code is 4821 🔥',
    },
    steps: [
      say('Charli', 'boiler code is 4821', { media: 'photo' }),
      expectPrompt('triage', /boiler code is 4821/, 'the caption reached triage as the message text'),
      expectReaction('✍'),
      expectDb(async (db) => {
        const notes = await rows<{ content: string; is_secure: boolean }>(db, sql`SELECT content, is_secure FROM baumy_memory_items`)
        const f = await rows<{ object_value: string | null; is_secure: boolean }>(db, sql`SELECT object_value, is_secure FROM baumy_facts WHERE predicate = 'code'`)
        const win = await rows<{ text_redacted: string }>(db, sql`SELECT text_redacted FROM baumy_messages`)
        return (
          notes.length === 1 && notes[0].is_secure && !notes[0].content.includes('4821') &&
          f.length === 1 && f[0].is_secure && f[0].object_value == null &&
          !win.some((w) => w.text_redacted.includes('4821'))
        )
      }, 'the note and the fact are secure and no stored text (memory or window) holds 4821'),
      say('Marco', "what's the boiler code?", { mention: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /4821/.test(l)), 'a direct ask decrypts it for the answer'),
      expectWords({ contains: '4821' }),
    ],
  })

  scenario('a voice note (no caption) is ignored explicitly — nothing read, stored or said', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: { triage: () => statement() },
    steps: [
      say('Ryan', '', { media: 'voice' }),
      expectSilent(),
      expectNoPrompt('triage', 'no text, no triage'),
      expectDb(async (db) => (await rows(db, sql`SELECT id FROM baumy_memory_items`)).length === 0, 'nothing stored'),
    ],
  })
})

const LANDLORD = 'Landlord: the boiler inspection is on Tuesday at 10am, please be home'

describe('scenario: forwarded content (I5, D4)', () => {
  scenario('Marco forwards the landlord’s notice; later "when is the inspection?" is answered citing that Marco forwarded it — no fact row', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: (t) => (t.startsWith('Landlord') ? statement() : /inspection/.test(t) ? question({ asksBaumy: true }) : chatter()),
      extract: (t) => (t.startsWith('Landlord') ? [fact({ subject: 'boiler inspection', subjectKind: 'event', predicate: 'status', object: 'tuesday 10am' })] : []),
      reply: () => 'Tuesday at 10 — Marco forwarded the landlord’s note, someone needs to be home 🔧',
    },
    steps: [
      say('Marco', LANDLORD, { forwarded: true }),
      expectPrompt('triage', /FORWARDED: yes — Marco forwarded someone else's message/, 'triage is told it is forwarded'),
      expectNoPrompt('extract', 'forwarded content never reaches fact extraction'),
      expectReaction('✍'),
      expectNoWords(),
      expectFact({ count: 0 }),
      expectDb(async (db, r) => {
        const n = await rows<{ trust_level: string; authored_by: string | null; forwarded_by: string | null }>(db, sql`SELECT trust_level, authored_by, forwarded_by FROM baumy_memory_items`)
        return n.length === 1 && n[0].trust_level === 'forwarded' && n[0].authored_by === null && n[0].forwarded_by === idOf(r, 'Marco')
      }, 'stored as a forwarded note: never Marco’s words (no author), Marco recorded as the forwarder'),
      advance({ days: 1 }),
      say('Charli', 'when is the inspection?', { mention: true }),
      expectPrompt(
        'reply',
        (c) => memoryLines(c.prompt).some((l) => /inspection/.test(l) && /forwarded by Marco/.test(l) && !/· Marco ·/.test(l)),
        'MEMORY carries the notice labelled "forwarded by Marco", not as Marco’s own words',
      ),
      expectWords({ judge: 'Says the inspection is Tuesday at 10am and that this came from a message Marco forwarded (the landlord’s). Must NOT present it as something Marco himself said or decided.' }),
      expectFact({ count: 0 }),
    ],
  })

  scenario('a message forwarded to Baumy’s DM is filed and acknowledged — never answered as the member’s own words', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: { triage: () => statement() },
    steps: [
      say('Marco', LANDLORD, { forwarded: true, dm: true }),
      expectWords({ contains: 'forwarded' }),
      expectNoPrompt('reply', 'the reply model never voices a forwarded message back'),
      expectFact({ count: 0 }),
    ],
  })
})

describe('scenario: personal reminders (A4, A5, D2)', () => {
  scenario('DM "remind me to call mum at 6" is delivered to that DM, naming the person — never the group', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: () => reminderAsk({ asksBaumy: true }),
      reminder: () => reminder({ content: 'call mum', when: 'at 6', fireAt: '2026-09-28T18:00', forWhom: 'speaker' }),
      reply: () => 'Done — today 18:00, I’ll ping you here ⏰',
    },
    steps: [
      say('Charli', 'remind me to call mum at 6', { dm: true }),
      expectReminder({ content: 'Charli: call mum', at: '2026-09-28 18:00', status: 'scheduled', count: 1 }),
      expectDb(async (db, r) => {
        const x = await rows<{ deliver_chat_id: string; group_id: string }>(db, sql`SELECT deliver_chat_id, group_id FROM baumy_reminders`)
        return x.length === 1 && x[0].deliver_chat_id === idOf(r, 'Charli') && x[0].group_id === r.sb.houseChatId
      }, 'scoped to the house, delivered to Charli’s own DM (code-resolved)'),
      expectWords({ judge: 'Confirms a reminder to call mum at 6pm / 18:00 today.' }),
      say('Marco', '/reminders'),
      expectWords({ notContains: 'call mum' }),
      advance({ hours: 9 }),
      check('the reminder went to Charli’s DM only, naming her', (r, e) => {
        const said = r.turns.at(-1)!.entries.filter((x) => x.kind === 'message')
        e(said.map((x) => [x.chatId, x.text])).toEqual([[idOf(r, 'Charli'), '⏰ Charli: call mum']])
      }),
      expectReminder({ content: 'Charli: call mum', status: 'sent' }),
    ],
  })

  scenario('"remind me" in the group names who asked, from the authenticated sender — even when the model did not say whose it is (A4)', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: () => reminderAsk({ asksBaumy: true }),
      reminder: () => reminder({ content: 'call the plumber', when: 'friday 9am', fireAt: '2026-10-02T09:00' }),
    },
    steps: [
      say('Marco', 'remind me to call the plumber friday 9am', { mention: true }),
      expectReminder({ content: 'Marco: call the plumber', at: '2026-10-02 09:00', count: 1 }),
      expectDb(async (db, r) => (await rows<{ deliver_chat_id: string }>(db, sql`SELECT deliver_chat_id FROM baumy_reminders`))[0]?.deliver_chat_id === r.sb.houseChatId, 'a group ask posts to the group'),
    ],
  })
})

describe('scenario: forget hides the source message too (A7, A8)', () => {
  scenario('after a soft forget of "where Zuzka is sleeping", Baumy no longer answers it — from the fact OR the note', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: (t) => (/^forget/i.test(t) ? forgetAsk() : /where is zuzka/i.test(t) ? question({ asksBaumy: true }) : /staying in my room/.test(t) ? statement() : chatter()),
      extract: (t) => (/staying in my room/.test(t) ? [fact({ subject: 'zuzka', subjectKind: 'person', predicate: 'stays_in', object: "marco's room", objectKind: 'place' })] : []),
      forget: (t) => (/^forget/i.test(t) ? { isForget: true, values: [], subject: 'Zuzka', attribute: 'where she is sleeping' } : null),
      reply: (t, c) => (/where is zuzka/i.test(t) && memoryLines(c.prompt).length === 0 ? { reply: "Nobody's told me where Zuzka's staying 🐈", answered: false } : '(scripted)'),
    },
    steps: [
      say('Marco', 'Zuzka is staying in my room this weekend'),
      expectFact({ subject: /zuzka/, predicate: 'stays_in', current: true }),
      say('Marco', 'forget where Zuzka is sleeping', { dm: true }),
      expectWords({ contains: ['stays in', 'hide 1 message', 'Tap to confirm'] }),
      tap('Marco'),
      check('the receipt says the message was hidden too', (r, e) => {
        e(r.turns.at(-1)!.entries.find((x) => x.kind === 'edit')?.text).toMatch(/Forgotten — 1 fact \+ hid 1 message/)
      }),
      advance({ hours: 1 }),
      say('Charli', 'where is Zuzka staying?', { mention: true }),
      expectPrompt('reply', (c) => !promptSection(c.prompt, 'MEMORY').some((l) => /zuzka|marco's room/i.test(l)), 'neither the fact nor the note is in MEMORY'),
      expectWords({ judge: "Does NOT say Zuzka is staying in Marco's room. It may say nobody has told it." }),
    ],
  })
})

describe('scenario: list ops are not memory notes (A11)', () => {
  scenario('"we’re out of oat milk" goes on the list only — it is never filed as a note that says so forever', {
    people: HOUSE,
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: () => statement({ worthRemembering: true, list: 'add' }),
      list: () => ({ op: 'add' as const, items: ['oat milk'] }),
    },
    steps: [
      say('Ryan', "we're out of oat milk"),
      expectReaction('✍'),
      expectNoPrompt('extract', 'no fact extraction for a list op'),
      expectDb(async (db) => (await rows(db, sql`SELECT id FROM baumy_memory_items`)).length === 0, 'no memory note'),
      expectDb(async (db) => (await rows(db, sql`SELECT id FROM baumy_list_items WHERE item = 'oat milk'`)).length === 1, 'the list has it'),
    ],
  })
})

describe('scenario: a new housemate (K6)', () => {
  scenario('a housemate who never spoke in the group can DM Baumy (verified against the group, then served)', {
    people: [...HOUSE, { id: 704, name: 'Nina', unseen: true }],
    startAt: '2026-09-28 10:00',
    fixtures: {
      triage: (t) => (/bins/.test(t) ? statement() : /bin day/.test(t) ? question({ asksBaumy: true }) : chatter()),
      extract: (t) => (/bins/.test(t) ? [fact({ subject: 'bins', predicate: 'collection_day', object: 'thursday' })] : []),
      reply: () => 'Thursdays 🗑️',
    },
    steps: [
      expectDb(async (db) => (await rows(db, sql`SELECT 1 FROM baumy_members WHERE telegram_user_id = '704'`)).length === 0, 'Nina is not on Baumy’s roster yet'),
      say('Charli', 'the bins go out on thursdays'),
      say('Nina', "what's the bin day?", { dm: true }),
      expectPrompt('reply', (c) => memoryLines(c.prompt).some((l) => /thursday/.test(l)), 'she is answered from house memory'),
      expectWords({ judge: 'Says the bins go out on Thursday.' }),
      expectDb(async (db) => (await rows<{ is_active: boolean }>(db, sql`SELECT is_active FROM baumy_members WHERE telegram_user_id = '704'`))[0]?.is_active === true, 'she is now an active member'),
    ],
  })
})
