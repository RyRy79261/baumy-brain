import { verifyWebhookSecret } from '@/lib/telegram/verify'
import { parseUpdate } from '@/lib/telegram/schema'
import { inngest } from '@/lib/inngest/client'

// The "200-fast-then-defer-to-Inngest" spine (architecture D5/D6/D7/D8). grammY
// types the update; ALL work happens in Inngest functions off this request path.
export const runtime = 'nodejs'
export const maxDuration = 15

export async function POST(req: Request): Promise<Response> {
  // 1. Constant-time secret verification — BEFORE any body parse.
  if (!verifyWebhookSecret(req)) return new Response('unauthorized', { status: 401 })

  // 2. Minimal parse. Unparseable/poison input → 200 (never retryable; absorb).
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: true, ignored: 'unparseable' })
  }
  const update = parseUpdate(body)
  if (!update) return Response.json({ ok: true, ignored: 'bad-shape' })

  // 3. Route by update type — each just enqueues to Inngest and 200s fast. A
  //    hand-off failure → 503 so Telegram retries (event-id dedup makes it a no-op).
  try {
    // Bot added/removed → owner capture + group registration.
    if (update.my_chat_member) {
      await inngest.send({ id: `tg:mcm:${update.update_id}`, name: 'telegram/my_chat_member', data: { updateId: update.update_id, raw: update } })
      return Response.json({ ok: true })
    }
    // A housemate joined/left → membership lifecycle.
    if (update.chat_member) {
      await inngest.send({ id: `tg:cm:${update.update_id}`, name: 'telegram/chat_member', data: { updateId: update.update_id, raw: update } })
      return Response.json({ ok: true })
    }
    // Inline-keyboard confirm tap → deterministic confirm handler (security Stage D).
    if (update.callback_query) {
      const cq = update.callback_query
      await inngest.send({
        id: `tg:cb:${update.update_id}`,
        name: 'telegram/callback.received',
        data: {
          updateId: update.update_id,
          callbackId: cq.id,
          fromId: cq.from.id,
          chatId: cq.message?.chat.id != null ? String(cq.message.chat.id) : '',
          messageId: cq.message?.message_id ?? null,
          data: cq.data ?? '',
        },
      })
      return Response.json({ ok: true })
    }

    // In-shape message? Forward it. Scope (house group vs known-member DM vs
    // ignore) is resolved DOWNSTREAM from house_config — the webhook needs no chat id.
    const msg = update.message ?? update.edited_message
    if (!msg) return Response.json({ ok: true, ignored: 'no-message' })
    await inngest.send({
      id: `tg:update:${update.update_id}`,
      name: 'telegram/message.received',
      data: {
        updateId: update.update_id,
        chatId: String(msg.chat.id),
        chatType: msg.chat.type,
        fromId: msg.from?.id ?? null,
        text: msg.text ?? null,
        // Trust signals resolved downstream: bot-origin / forwarded → quarantined.
        isBot: msg.from?.is_bot === true,
        isForwarded: msg.forward_origin != null,
        // Raw signal for "directed at Baumy"; the @mention match (against the bot's
        // real username via getMe) is resolved in the pipeline.
        replyToBot: msg.reply_to_message?.from?.is_bot === true,
      },
    })
    return Response.json({ ok: true })
  } catch {
    return new Response('enqueue failed', { status: 503 })
  }
}
