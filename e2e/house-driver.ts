// The e2e test driver (e2e/README.md; tests get it from ./house): housemates talk to the running Baumy the way Telegram does —
// a real-shaped Update POSTed to the webhook with the secret header — and the test reads what Baumy
// did: the Bot API calls the fake Telegram recorded, the rows in the test database, the run outcome
// in the update ledger. No model grades anything; every check is a fact.

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import type { Message, Update, User, Chat } from 'grammy/types'
import * as schema from '@/db/schema'
import type { BotCall, Fault, Person } from './fake-telegram'
import type { AiCall, AiFault } from './fake-anthropic'

export interface StackInfo {
  /** The app (`next start`), e.g. http://127.0.0.1:41234 */
  baseUrl: string
  webhookSecret: string
  /** The local fake server's control door. */
  controlUrl: string
  controlToken: string
  /** The test Postgres, direct from this machine (reads only). */
  dbUrl: string
  bot: { id: number; username: string }
  houseChatId: number
  people: Person[]
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SayOptions {
  /** A Telegram reply to this message (Baumy's or a housemate's). */
  replyTo?: Message
  /** Send in the person's own DM with Baumy instead of the house group. */
  dm?: boolean
  threadId?: number
  /** A sticker instead of text (text is ignored). */
  sticker?: boolean
}

export class House {
  readonly db
  private readonly pool: Pool
  private updateId: number
  constructor(readonly stack: StackInfo) {
    this.pool = new Pool({ connectionString: stack.dbUrl, max: 2 })
    this.db = drizzle(this.pool, { schema })
    // Unique across files and runs: the ledger dedups on update_id.
    this.updateId = Math.floor(Date.now() / 1000) * 1000
  }

  /** Close the database connection (so the test run can exit). */
  close(): Promise<void> {
    return this.pool.end()
  }

  person(name: string): Person {
    const p = this.stack.people.find((x) => x.name === name)
    if (!p) throw new Error(`[e2e] no housemate ${name}`)
    return p
  }

  user(name: string): User {
    const p = this.person(name)
    return { id: p.id, is_bot: false, first_name: p.name, language_code: 'en' }
  }

  get houseChat(): Chat.SupergroupChat {
    return { id: this.stack.houseChatId, type: 'supergroup', title: 'Baumy E2E house' }
  }

  private dmChat(name: string): Chat.PrivateChat {
    const p = this.person(name)
    return { id: p.id, type: 'private', first_name: p.name }
  }

  private async control<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.stack.controlUrl}/__control/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-e2e-control': this.stack.controlToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) throw new Error(`[e2e] control ${path}: ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }

  /** POST one Update to the webhook, retrying a 5xx the way Telegram does. */
  async post(update: Update): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.stack.baseUrl}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': this.stack.webhookSecret,
        },
        body: JSON.stringify(update),
      })
      if (res.status < 500 || attempt >= 3) return res.status
      await sleep(2000 * (attempt + 1))
    }
  }

  nextUpdateId(): number {
    return ++this.updateId
  }

  /** A housemate's message. Resolves once the webhook accepted it (Baumy works on it after that). */
  async say(name: string, text: string, o: SayOptions = {}): Promise<Message> {
    const chat = o.dm ? this.dmChat(name) : this.houseChat
    const draft = {
      message_id: 0,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: this.user(name),
      ...(o.sticker
        ? { sticker: { file_id: 'e2e-sticker', file_unique_id: 'e2e-sticker-u', type: 'regular', width: 512, height: 512, is_animated: false, is_video: false, emoji: '👍' } }
        : { text }),
      ...(o.replyTo ? { reply_to_message: o.replyTo } : {}),
      ...(o.threadId != null ? { message_thread_id: o.threadId, is_topic_message: true } : {}),
    }
    const message = await this.control<Message>('message', { message: draft })
    const status = await this.post({ update_id: this.nextUpdateId(), message } as Update)
    if (status !== 200) throw new Error(`[e2e] webhook answered ${status} for "${text}"`)
    return message
  }

  /** The update id of the last message sent (what the ledger row is keyed on). */
  get lastUpdateId(): number {
    return this.updateId
  }

  /** Wait until Baumy's run for `updateId` ended; returns its ledger row. */
  async done(updateId = this.lastUpdateId, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs
    for (;;) {
      const [row] = await this.db.select().from(schema.telegramUpdates).where(eq(schema.telegramUpdates.updateId, updateId))
      if (row && row.status !== 'received') {
        const broken = await this.control<string[]>('ai-errors')
        if (broken.length) throw new Error(`[e2e] the fake Claude's script is broken (e2e/script.ts):\n${broken.join('\n')}`)
        return row
      }
      if (Date.now() > until) throw new Error(`[e2e] update ${updateId} not done after ${timeoutMs}ms (status ${row?.status ?? 'no row'})`)
      await sleep(1000)
    }
  }

  /** Bot API calls the fake has recorded (optionally only those after `since`). */
  calls(since = 0): Promise<BotCall[]> {
    return this.control<BotCall[]>(`calls?since=${since}`)
  }

  /** The newest call's seq — pass it to `calls` / `waitFor` to see only what came after. */
  async mark(): Promise<number> {
    const all = await this.calls()
    return all.at(-1)?.seq ?? 0
  }

  async waitFor(pred: (c: BotCall) => boolean, o: { since?: number; timeoutMs?: number } = {}): Promise<BotCall> {
    const until = Date.now() + (o.timeoutMs ?? 120_000)
    for (;;) {
      const hit = (await this.calls(o.since ?? 0)).find(pred)
      if (hit) return hit
      if (Date.now() > until) throw new Error('[e2e] the expected Bot API call never came')
      await sleep(1000)
    }
  }

  /** Baumy's worded sends (messages and cards) after `since`. */
  async sent(since = 0): Promise<Message[]> {
    return (await this.calls(since)).filter((c) => c.method === 'sendMessage' && c.ok).map((c) => c.result as Message)
  }

  /** A confirm-card tap (callback_query) by `name` on Baumy's `card`. */
  async tap(name: string, card: Message, data: string): Promise<void> {
    const status = await this.post({
      update_id: this.nextUpdateId(),
      callback_query: { id: `e2e-cb-${this.updateId}`, from: this.user(name), chat_instance: 'e2e', message: card, data },
    } as Update)
    if (status !== 200) throw new Error(`[e2e] webhook answered ${status} for a tap`)
  }

  fault(f: Fault): Promise<unknown> {
    return this.control('fault', f)
  }

  /** Make the fake Claude fail (429 / 500 / 529) or stall, like the real API under load. */
  aiFault(f: AiFault): Promise<unknown> {
    return this.control('ai-fault', f)
  }

  /** The calls the fake Claude answered (optionally only those after `since`). */
  aiCalls(since = 0): Promise<AiCall[]> {
    return this.control<AiCall[]>(`ai-calls?since=${since}`)
  }

  olympics(): Promise<{ events: Record<string, unknown>[]; calls: { name: string; status: number }[] }> {
    return this.control('olympics')
  }
}

/** The inline-keyboard buttons on a sent message, flattened. */
export function buttons(m: Message): { text: string; callback_data?: string }[] {
  const kb = (m as { reply_markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] } }).reply_markup?.inline_keyboard
  return kb?.flat() ?? []
}
