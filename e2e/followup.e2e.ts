import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import * as schema from '@/db/schema'
import { house, buttons } from './house'
import { BUTCHER_REMINDER_DAYS } from './script'

// The house chat of 2026-10-19 (scenarios/followup.scenario.test.ts is the offline version): Ryan
// @mentioned Baumy to put his India trip on the calendar, then — no second @mention — asked to "also
// add" the butcher delivery with reminders. Here it runs through the whole stack: the webhook, Inngest,
// Postgres, the Olympics and Telegram round trips. The model's answers are scripted (e2e/script.ts).

const h = house()
const tag = `@${h.stack.bot.username}`

describe('a follow-up ask needs no second @mention', () => {
  it('India trip → card → tap → on the calendar; then the untagged butcher ask → a card and BOTH reminders', async () => {
    const start = await h.mark()
    const india = await h.say('Ryan', `Heads up, I'm gonna be in India for two weeks ${tag} could you add this to the calendar`)
    const indiaRun = await h.done()
    expect(indiaRun.status, JSON.stringify(indiaRun.outcome)).toBe('processed')

    const card = (await h.sent(start)).find((m) => buttons(m).some((b) => b.callback_data?.startsWith('c:')))
    expect(card, 'a confirm card for the India trip').toBeTruthy()
    expect(card!.reply_to_message?.message_id).toBe(india.message_id)

    const confirm = buttons(card!).find((b) => b.callback_data?.startsWith('c:'))!.callback_data!
    const tapMark = await h.mark()
    await h.tap('Ryan', card!, confirm)
    await h.waitFor((c) => c.method === 'answerCallbackQuery', { since: tapMark })
    await expect.poll(async () => (await h.olympics()).events.length, { timeout: 60_000, interval: 2000 }).toBe(1)

    const afterTap = await h.mark()
    await h.say('Ryan', "Could you also add that we'll have a delivery from the butchers in three weeks, make reminders the day before and 2 days before")
    const butcherRun = await h.done()
    expect(butcherRun.status).toBe('processed')
    expect(butcherRun.outcome, 'the follow-up stays directed').toMatchObject({ directed: true, directedWhy: 'follow_up' })

    const ryan = String(h.person('Ryan').id)
    const rows = await h.db.select().from(schema.reminders).where(and(eq(schema.reminders.createdBy, ryan), eq(schema.reminders.status, 'scheduled')))
    const days = rows.map((r) => DateTime.fromJSDate(r.fireAt).setZone('Europe/Berlin').toISODate()).sort()
    expect(days, 'the day before and 2 days before').toEqual(BUTCHER_REMINDER_DAYS())

    const words = await h.sent(afterTap)
    expect(words.some((m) => buttons(m).some((b) => b.callback_data?.startsWith('c:'))), 'a calendar card for the butcher delivery').toBe(true)
  })
})

describe('a reminder fires on time through the real Inngest scheduler', () => {
  it('"remind me in 2 minutes" → a confirm reply, then the reminder posts in the house', async () => {
    const start = await h.mark()
    await h.say('Marco', `${tag} remind me in 2 minutes to take the bread out of the oven`)
    const run = await h.done()
    expect(run.outcome).toMatchObject({ reminderSet: true })
    const fired = await h.waitFor(
      (c) => c.method === 'sendMessage' && /bread/i.test(String(c.params.text)) && c.params.reply_parameters == null,
      { since: start, timeoutMs: 5 * 60_000 },
    )
    expect(String(fired.params.chat_id)).toBe(String(h.stack.houseChatId))
  })
})

describe('Claude overloaded (I2): the step retries, nothing is lost', () => {
  it('a 529 on triage → Inngest retries → the run ends processed and Baumy still answers', async () => {
    await h.aiFault({ role: 'triage', status: 529, times: 3 })
    const start = await h.mark()
    const aiStart = (await h.aiCalls()).at(-1)?.seq ?? 0
    const ask = await h.say('Marco', `${tag} remind me in 2 minutes to take the bread out of the oven`)
    const run = await h.done(undefined, 4 * 60_000)
    expect(run.status).toBe('processed')
    expect(run.outcome).toMatchObject({ reminderSet: true })

    const triage = (await h.aiCalls(aiStart)).filter((c) => c.role === 'triage')
    expect(triage.map((c) => c.status), 'three overloaded answers, then a good one').toEqual([529, 529, 529, 200])
    const replies = (await h.sent(start)).filter((m) => m.reply_to_message?.message_id === ask.message_id)
    expect(replies, 'exactly one reply, however many retries').toHaveLength(1)
  })
})
