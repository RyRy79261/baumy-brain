// A fake Telegram Bot API for the end-to-end stack (e2e/README.md). The deployed app reaches it
// through TELEGRAM_API_ROOT (lib/telegram/client.ts), so every Bot API call Baumy makes lands here
// and is recorded. It answers in Telegram's own shapes (grammy/types) and with Telegram's own
// errors for the cases Baumy must survive ("message is not modified", "chat not found", 429 with
// retry_after), and it can inject faults and latency on purpose.
//
// It is also the message-id authority: a housemate's message gets its id here too, so ids in one
// chat never collide between people and Baumy, exactly as in a real chat.

import type { Chat, Message, User, ChatMember } from 'grammy/types'

export interface Person {
  id: number
  name: string
  role?: 'owner' | 'member'
}

export interface BotCall {
  seq: number
  at: number
  method: string
  params: Record<string, unknown>
  /** What the fake answered (the Bot API envelope). */
  ok: boolean
  result?: unknown
  error?: { error_code: number; description: string }
}

export interface Fault {
  method: string
  /** How many calls it hits (default 1). */
  times?: number
  /** An error answer (Telegram's envelope). */
  status?: number
  description?: string
  retryAfter?: number
  /** Extra wait before answering, in ms. */
  delayMs?: number
}

type Envelope = { ok: true; result: unknown } | { ok: false; error_code: number; description: string; parameters?: { retry_after: number } }

const err = (error_code: number, description: string, retryAfter?: number): Envelope => ({
  ok: false,
  error_code,
  description,
  ...(retryAfter != null ? { parameters: { retry_after: retryAfter } } : {}),
})

export class FakeTelegram {
  readonly bot: User
  readonly houseChat: Chat.SupergroupChat
  people = new Map<number, Person>()
  calls: BotCall[] = []
  /** Every message in every chat, by `${chatId}:${messageId}`. */
  messages = new Map<string, Message>()
  faults: (Fault & { left: number })[] = []
  /** Base latency added to every answer: [min, max] ms. Real Bot API calls take tens of ms. */
  latency: [number, number] = [20, 120]
  private nextId = new Map<string, number>()
  private seq = 0

  constructor(o: { botId: number; botUsername: string; houseChatId: number; houseTitle?: string; people: Person[] }) {
    this.bot = { id: o.botId, is_bot: true, first_name: 'Baumy', username: o.botUsername }
    this.houseChat = { id: o.houseChatId, type: 'supergroup', title: o.houseTitle ?? 'Baumy E2E house' }
    for (const p of o.people) this.people.set(p.id, p)
  }

  /** The next message id in a chat (one counter per chat, shared by people and Baumy). */
  allocId(chatId: number | string): number {
    const k = String(chatId)
    const n = (this.nextId.get(k) ?? 100) + 1
    this.nextId.set(k, n)
    return n
  }

  chatFor(chatId: number | string): Chat | null {
    const id = Number(chatId)
    if (id === this.houseChat.id) return this.houseChat
    const p = this.people.get(id)
    return p ? { id: p.id, type: 'private', first_name: p.name } : null
  }

  userFor(id: number): User {
    const p = this.people.get(id)
    if (!p) throw new Error(`[fake-telegram] unknown person ${id}`)
    return { id: p.id, is_bot: false, first_name: p.name }
  }

  /** Store a message (a person's, from the driver, or Baumy's, from a send). */
  store(m: Message): Message {
    this.messages.set(`${m.chat.id}:${m.message_id}`, m)
    return m
  }

  find(chatId: number | string, messageId: number): Message | undefined {
    return this.messages.get(`${chatId}:${messageId}`)
  }

  addFault(f: Fault): void {
    this.faults.push({ ...f, left: f.times ?? 1 })
  }

  reset(): void {
    this.calls = []
    this.faults = []
  }

  /** One Bot API call: `token` is checked against the bot id prefix, like Telegram's 401. */
  async call(token: string, method: string, params: Record<string, unknown>): Promise<Envelope> {
    const fault = this.faults.find((f) => f.method === method && f.left > 0)
    if (fault) fault.left--
    const [lo, hi] = this.latency
    const wait = lo + Math.random() * Math.max(0, hi - lo) + (fault?.delayMs ?? 0)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))

    let answer: Envelope
    if (Number(token.split(':')[0]) !== this.bot.id) answer = err(401, 'Unauthorized')
    else if (fault?.status) answer = err(fault.status, fault.description ?? 'Internal Server Error', fault.retryAfter)
    else answer = this.answer(method, params)

    this.calls.push({
      seq: ++this.seq,
      at: Date.now(),
      method,
      params,
      ok: answer.ok,
      ...(answer.ok ? { result: answer.result } : { error: { error_code: answer.error_code, description: answer.description } }),
    })
    return answer
  }

  private answer(method: string, p: Record<string, unknown>): Envelope {
    const now = Math.floor(Date.now() / 1000)
    switch (method) {
      case 'getMe':
        return { ok: true, result: { ...this.bot, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } }

      case 'sendMessage': {
        const chat = this.chatFor(p.chat_id as string)
        if (!chat) return err(400, 'Bad Request: chat not found')
        const text = String(p.text ?? '')
        if (!text.trim()) return err(400, 'Bad Request: message text is empty')
        if (text.length > 4096) return err(400, 'Bad Request: message is too long')
        const rp = p.reply_parameters as { message_id?: number; allow_sending_without_reply?: boolean } | undefined
        const replied = rp?.message_id != null ? this.find(chat.id, rp.message_id) : undefined
        if (rp?.message_id != null && !replied && !rp.allow_sending_without_reply) return err(400, 'Bad Request: message to be replied not found')
        const m = {
          message_id: this.allocId(chat.id),
          date: now,
          chat,
          from: this.bot,
          text,
          ...(p.message_thread_id != null ? { message_thread_id: Number(p.message_thread_id), is_topic_message: true } : {}),
          ...(replied ? { reply_to_message: replied } : {}),
          ...(p.reply_markup ? { reply_markup: p.reply_markup } : {}),
        } as Message
        return { ok: true, result: this.store(m) }
      }

      case 'editMessageText': {
        const m = this.find(p.chat_id as string, Number(p.message_id))
        if (!m) return err(400, 'Bad Request: message to edit not found')
        const text = String(p.text ?? '')
        const markup = p.reply_markup ?? undefined
        const sameMarkup = JSON.stringify((m as { reply_markup?: unknown }).reply_markup ?? null) === JSON.stringify(markup ?? null)
        if ((m as { text?: string }).text === text && sameMarkup) {
          return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message')
        }
        const edited = { ...m, text, edit_date: now, ...(markup ? { reply_markup: markup } : {}) } as Message
        return { ok: true, result: this.store(edited) }
      }

      case 'deleteMessage': {
        const k = `${p.chat_id}:${p.message_id}`
        if (!this.messages.has(k)) return err(400, 'Bad Request: message to delete not found')
        this.messages.delete(k)
        return { ok: true, result: true }
      }

      case 'pinChatMessage':
      case 'unpinChatMessage':
      case 'answerCallbackQuery':
      case 'sendChatAction':
        return { ok: true, result: true }

      case 'setMessageReaction': {
        if (!this.find(p.chat_id as string, Number(p.message_id))) return err(400, 'Bad Request: message to react not found')
        return { ok: true, result: true }
      }

      case 'getChatMember': {
        const chat = this.chatFor(p.chat_id as string)
        if (!chat) return err(400, 'Bad Request: chat not found')
        const uid = Number(p.user_id)
        if (uid === this.bot.id) return { ok: true, result: { status: 'administrator', user: this.bot } }
        const person = this.people.get(uid)
        if (!person) return err(400, 'Bad Request: PARTICIPANT_ID_INVALID')
        const result: ChatMember = person.role === 'owner'
          ? { status: 'creator', user: this.userFor(uid), is_anonymous: false }
          : { status: 'member', user: this.userFor(uid) }
        return { ok: true, result }
      }

      case 'getChatAdministrators': {
        const owners = [...this.people.values()].filter((x) => x.role === 'owner')
        return { ok: true, result: owners.map((o) => ({ status: 'creator', user: this.userFor(o.id), is_anonymous: false })) }
      }

      default:
        return err(404, `Not Found: method ${method} is not in the e2e fake (add it to e2e/fake-telegram.ts)`)
    }
  }
}
