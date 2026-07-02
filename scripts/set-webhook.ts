// One-time Telegram webhook registration (task-graph S7).
// Run:  node --experimental-strip-types scripts/set-webhook.ts
// Needs: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, BAUMY_PUBLIC_URL

const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET
const base = process.env.BAUMY_PUBLIC_URL

if (!token || !secret || !base) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, BAUMY_PUBLIC_URL')
  process.exit(1)
}

const api = `https://api.telegram.org/bot${token}`

async function post(method: string, body?: Record<string, unknown>) {
  const res = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>
}

async function main() {
  const set = await post('setWebhook', {
    url: `${base}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'edited_message', 'my_chat_member'],
    drop_pending_updates: true,
  })
  console.log('setWebhook:', set)

  const me = (await post('getMe')).result as { can_read_all_group_messages?: boolean } | undefined
  console.log('getMe:', me)
  if (me && me.can_read_all_group_messages === false) {
    console.warn('⚠️  Privacy mode is ON — disable it in BotFather (Group Privacy → Turn off) and RE-ADD the bot to the group.')
  }

  console.log('getWebhookInfo:', (await post('getWebhookInfo')).result)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
