// One-shot recovery for a group→supergroup migration (docs/spec/telegram.md D9).
//
// When a Telegram group is upgraded to a supergroup its chat_id changes to the -100… form and the
// OLD id stops working — so Baumy goes deaf (inbound ignored) and reminders silently fail. The
// running bot self-heals on the NEXT proactive send (sendToHouseResilient catches the stale-id 400),
// but if nothing is due it can stay stuck. This script captures the new id immediately and writes it
// to house_config.live_chat_id — WITHOUT touching house_group_chat_id (the memory scope), so no
// history is orphaned. Deploy these changes FIRST (the live_chat_id column ships in migration 0012).
//
// Run:  node --experimental-strip-types scripts/heal-house.ts            (probe + heal)
//       node --experimental-strip-types scripts/heal-house.ts --dry      (probe only, no write)
//       node --experimental-strip-types scripts/heal-house.ts -100NEWID  (force a specific new id)
// Needs: TELEGRAM_BOT_TOKEN, DATABASE_URL

export {} // module scope (isolates top-level names from other scripts under tsc)

import { neon } from '@neondatabase/serverless'

const token = process.env.TELEGRAM_BOT_TOKEN
const dbUrl = process.env.DATABASE_URL
if (!token || !dbUrl) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, DATABASE_URL')
  process.exit(1)
}

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const forced = argv.find((a) => !a.startsWith('-')) ?? null // a bare -100… positional overrides the probe

const sql = neon(dbUrl)
const api = `https://api.telegram.org/bot${token}`

type TgResp = { ok: boolean; result?: { id?: number; type?: string }; description?: string; parameters?: { migrate_to_chat_id?: number } }
async function tg(method: string, body: Record<string, unknown>): Promise<TgResp> {
  const res = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as TgResp
}

async function main() {
  const rows = (await sql`SELECT house_group_chat_id, live_chat_id FROM baumy_house_config WHERE id = true LIMIT 1`) as {
    house_group_chat_id: string | null
    live_chat_id: string | null
  }[]
  if (rows.length === 0 || !rows[0].house_group_chat_id) {
    console.error('No house captured yet (house_config is empty). Add the bot to the group first.')
    process.exit(1)
  }
  const scope = rows[0].house_group_chat_id
  const currentSend = rows[0].live_chat_id ?? scope
  console.log(`scope (memory key, never changes): ${scope}`)
  console.log(`current send/live id:              ${currentSend}`)

  // Determine the new id: an explicit arg wins; otherwise probe the id Baumy currently sends to.
  let newId = forced
  if (!newId) {
    const probe = await tg('getChat', { chat_id: currentSend })
    if (probe.ok) {
      console.log(`\n✅ getChat(${currentSend}) succeeded (type=${probe.result?.type}). Not migrated — nothing to heal.`)
      console.log('   If Baumy is still quiet, the issue is elsewhere (check /api/health + getWebhookInfo).')
      return
    }
    const target = probe.parameters?.migrate_to_chat_id
    if (target == null) {
      console.error(`\n❌ getChat failed but gave no migrate_to_chat_id: "${probe.description}"`)
      console.error('   Get the new -100… id another way (e.g. forward a group message to @RawDataBot) and re-run:')
      console.error('   node --experimental-strip-types scripts/heal-house.ts -100NEWID')
      process.exit(1)
    }
    newId = String(target)
    console.log(`\n🔀 Telegram reports this group migrated → new supergroup id: ${newId}`)
  }

  if (newId === scope || newId === rows[0].live_chat_id) {
    console.log(`\nAlready converged (live_chat_id = ${newId}). Nothing to do.`)
    return
  }
  if (dry) {
    console.log(`\n(--dry) Would set live_chat_id=${newId}, migrated_from_chat_id=${currentSend}. No write made.`)
    return
  }

  await sql`UPDATE baumy_house_config SET live_chat_id = ${newId}, migrated_from_chat_id = ${currentSend}, updated_at = now() WHERE id = true`
  console.log(`\n✅ Healed. live_chat_id = ${newId} (scope ${scope} untouched — all memory intact).`)
  console.log('   Baumy will now hear + send in the supergroup. Next: run /notifyhere inside the topic you want reminders in.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
