import { verifyWebhookSecret } from '@/lib/telegram/verify'
import { parseUpdate } from '@/lib/telegram/schema'
import { inngest } from '@/lib/inngest/client'

// The "200-fast-then-defer-to-Inngest" spine (architecture D5/D6/D7/D8).
// Node runtime; short maxDuration so a hung send fails fast into a retry.
export const runtime = 'nodejs'
export const maxDuration = 15

export async function POST(req: Request): Promise<Response> {
  // 1. Constant-time secret verification — BEFORE any body parse.
  if (!verifyWebhookSecret(req)) {
    return new Response('unauthorized', { status: 401 })
  }

  // 2. Minimal parse. Unparseable/poison input → 200 (never retryable; absorb).
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: true, ignored: 'unparseable' })
  }
  const update = parseUpdate(body)
  if (!update) return Response.json({ ok: true, ignored: 'bad-shape' })

  // 2b. my_chat_member (bot added/removed) → owner capture + group registration.
  if ((update as { my_chat_member?: unknown }).my_chat_member) {
    try {
      await inngest.send({
        id: `tg:mcm:${update.update_id}`,
        name: 'telegram/my_chat_member',
        data: { updateId: update.update_id, raw: update },
      })
    } catch {
      return new Response('enqueue failed', { status: 503 })
    }
    return Response.json({ ok: true })
  }

  // 3. Structural scope gate: house group, or a private DM (member identity is
  //    checked downstream in the pipeline). Out-of-scope → 200 to drain queue.
  const msg = update.message ?? update.edited_message
  const chatId = msg ? String(msg.chat.id) : ''
  const inHouse = chatId === (process.env.BAUMY_HOUSE_CHAT_ID ?? '')
  const isPrivate = msg?.chat.type === 'private'
  if (!msg || (!inHouse && !isPrivate)) {
    return Response.json({ ok: true, ignored: 'out-of-scope' })
  }

  // 4. Defer to Inngest, event id keyed on update_id (24h idempotency); 200 fast.
  //    If the hand-off throws, 503 → Telegram retries (dedup makes it a no-op).
  try {
    await inngest.send({
      id: `tg:update:${update.update_id}`,
      name: 'telegram/message.received',
      data: {
        updateId: update.update_id,
        chatId,
        chatType: msg.chat.type,
        fromId: msg.from?.id ?? null,
        text: msg.text ?? null,
      },
    })
  } catch {
    return new Response('enqueue failed', { status: 503 })
  }
  return Response.json({ ok: true })
}
