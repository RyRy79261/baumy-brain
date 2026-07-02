import { verifyWebhookSecret } from '@/lib/telegram/verify'
import { parseUpdate } from '@/lib/telegram/schema'
import { isDirectedAtBaumy } from '@/lib/pipeline/directed'
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

  // 2c. callback_query (inline-keyboard confirm tap) → deterministic confirm
  //     handler (security Stage D). Authorization (member from.id) is downstream.
  if (update.callback_query) {
    const cq = update.callback_query
    try {
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
    } catch {
      return new Response('enqueue failed', { status: 503 })
    }
    return Response.json({ ok: true })
  }

  // 2d. chat_member (a housemate joined/left) → membership lifecycle handler.
  if ((update as { chat_member?: unknown }).chat_member) {
    try {
      await inngest.send({
        id: `tg:cm:${update.update_id}`,
        name: 'telegram/chat_member',
        data: { updateId: update.update_id, raw: update },
      })
    } catch {
      return new Response('enqueue failed', { status: 503 })
    }
    return Response.json({ ok: true })
  }

  // 3. In-shape message? Forward it. Scope (house group vs known-member DM vs
  //    ignore) is resolved DOWNSTREAM in the pipeline from house_config — the
  //    house group is auto-captured on bot-add, so the webhook needs no chat id.
  const msg = update.message ?? update.edited_message
  if (!msg) return Response.json({ ok: true, ignored: 'no-message' })
  const chatId = String(msg.chat.id)

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
        // Trust signals resolved downstream: bot-origin / forwarded → quarantined.
        isBot: msg.from?.is_bot === true,
        isForwarded: msg.forward_origin != null || msg.forward_date != null,
        // Directed at Baumy (@mention / by name / reply-to-Baumy) → always answered.
        directed: isDirectedAtBaumy(msg.text ?? null, msg.reply_to_message?.from?.is_bot === true),
      },
    })
  } catch {
    return new Response('enqueue failed', { status: 503 })
  }
  return Response.json({ ok: true })
}
