import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Api, GrammyError } from 'grammy'
import { startFakeServer, type FakeServer } from '../fake-server'

// The e2e fake Telegram, driven by the REAL grammY client (the one lib/telegram/client.ts uses), so a
// shape the client cannot read, or an error it cannot recognise, fails here and not in a slow e2e run.
let fake: FakeServer
const BOT = 8_000_000_123
const HOUSE = -1_000_000_000_777
const token = `${BOT}:fake-secret`

beforeAll(async () => {
  fake = await startFakeServer({
    botId: BOT, botUsername: 'baumy_e2e_bot', houseChatId: HOUSE, controlToken: 'ctl',
    people: [{ id: 71, name: 'Chloe', role: 'owner' }, { id: 72, name: 'Marco' }],
    olympicsMembers: [],
  })
  fake.telegram.latency = [0, 0]
})
afterAll(() => fake.close())

const api = () => new Api(token, { apiRoot: fake.url })

describe('fake Telegram', () => {
  it('answers getMe as the bot', async () => {
    expect(await api().getMe()).toMatchObject({ id: BOT, is_bot: true, username: 'baumy_e2e_bot' })
  })

  it('sends into the house with ids from the chat counter, as a reply when asked', async () => {
    const first = await api().sendMessage(HOUSE, 'hello')
    const second = await api().sendMessage(HOUSE, 'again', { reply_parameters: { message_id: first.message_id } })
    expect(second.message_id).toBe(first.message_id + 1)
    expect(second.reply_to_message?.message_id).toBe(first.message_id)
    expect(fake.telegram.calls.at(-1)).toMatchObject({ method: 'sendMessage', ok: true })
  })

  it('refuses an unknown chat, a wrong token and an empty text like Telegram', async () => {
    await expect(api().sendMessage(-42, 'x')).rejects.toThrow(/chat not found/)
    await expect(new Api(`1:nope`, { apiRoot: fake.url }).getMe()).rejects.toThrow(/Unauthorized/)
    await expect(api().sendMessage(HOUSE, ' ')).rejects.toThrow(/message text is empty/)
  })

  it('says "message is not modified" for an identical edit (the live list treats it as success)', async () => {
    const m = await api().sendMessage(HOUSE, 'list')
    const err = await api().editMessageText(HOUSE, m.message_id, 'list').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GrammyError)
    expect((err as GrammyError).description).toMatch(/message is not modified/)
    await expect(api().editMessageText(HOUSE, m.message_id, 'list v2')).resolves.toMatchObject({ text: 'list v2' })
  })

  it('injects a 429 with retry_after once, then answers normally', async () => {
    fake.telegram.addFault({ method: 'sendMessage', status: 429, description: 'Too Many Requests: retry after 3', retryAfter: 3 })
    const err = (await api().sendMessage(HOUSE, 'busy').catch((e: unknown) => e)) as GrammyError
    expect(err.error_code).toBe(429)
    expect(err.parameters.retry_after).toBe(3)
    await expect(api().sendMessage(HOUSE, 'ok now')).resolves.toMatchObject({ text: 'ok now' })
  })

  it('knows the roster for getChatMember (the K6 new-housemate check)', async () => {
    await expect(api().getChatMember(HOUSE, 71)).resolves.toMatchObject({ status: 'creator' })
    await expect(api().getChatMember(HOUSE, 72)).resolves.toMatchObject({ status: 'member' })
    await expect(api().getChatMember(HOUSE, 99)).rejects.toThrow(/PARTICIPANT_ID_INVALID/)
  })

  it('keeps the control door shut without the token', async () => {
    expect((await fetch(`${fake.url}/__control/calls`)).status).toBe(403)
    expect((await fetch(`${fake.url}/__control/calls`, { headers: { 'x-e2e-control': 'ctl' } })).status).toBe(200)
  })
})
