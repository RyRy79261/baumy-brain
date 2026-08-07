// End-to-end health probe for "Baumy has gone quiet" (docs/spec/telegram.md D9/D9c).
//
// When Baumy stops reading or answering in the house group, the code is usually fine — the break is
// in LIVE STATE, and there are ~8 places it can be. This walks the inbound chain in order and names
// the broken link instead of leaving you to guess:
//
//   Telegram → webhook → Inngest → origin/lane → policy → reply → send
//
// The decisive fork is step 5 (inbound ledger): if update rows ARE landing, Telegram and the webhook
// are healthy and the fault is downstream (pause switch, topic mismatch, roster); if they are NOT,
// the fault is upstream (privacy mode, webhook registration, secret mismatch) and nothing in the app
// will ever see a message.
//
// READ-ONLY by default: every Telegram call is a getter and every query is a SELECT. Nothing is
// written, nothing is posted to the group. --probe-topics adds the ONE exception (see below).
//
// Run:  node --experimental-strip-types scripts/doctor.ts
//       node --experimental-strip-types scripts/doctor.ts --probe-topics   (validate the topic ids)
// Needs: TELEGRAM_BOT_TOKEN, DATABASE_URL. Run it with the PRODUCTION env (`vercel env pull`), or
// the report describes a database nobody is talking to.

export {} // module scope (isolates top-level names from other scripts under tsc)

import { neon } from '@neondatabase/serverless'

const token = process.env.TELEGRAM_BOT_TOKEN
const dbUrl = process.env.DATABASE_URL
if (!token || !dbUrl) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, DATABASE_URL')
  process.exit(1)
}

const probeTopics = process.argv.slice(2).includes('--probe-topics')

const sql = neon(dbUrl)
const api = `https://api.telegram.org/bot${token}`

type TgResp<T> = { ok: boolean; result?: T; description?: string; parameters?: { migrate_to_chat_id?: number } }
// A diagnostic must survive the failures it exists to diagnose: a proxy, an outage or a rate-limit
// page answers with HTML, not JSON, and a doctor that dies on the first odd response tells you
// nothing. Every failure becomes an ordinary `ok: false` so the walk continues and still reports.
async function tg<T>(method: string, body: Record<string, unknown> = {}): Promise<TgResp<T>> {
  try {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const raw = await res.text()
    try {
      return JSON.parse(raw) as TgResp<T>
    } catch {
      return { ok: false, description: `HTTP ${res.status}, non-JSON response: ${raw.slice(0, 120)}` }
    }
  } catch (e) {
    return { ok: false, description: `network error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// Findings accumulate as we go and print together at the end, so the fix list is one block rather
// than something you have to reconstruct by scrolling. BLOCKER = inbound is definitely broken here.
type Level = 'BLOCKER' | 'WARN' | 'INFO'
const findings: { level: Level; what: string; fix: string }[] = []
const flag = (level: Level, what: string, fix: string) => findings.push({ level, what, fix })

const ok = (s: string) => `✓ ${s}`
const bad = (s: string) => `✗ ${s}`
const warn = (s: string) => `⚠ ${s}`
const section = (n: number, title: string) => console.log(`\n── ${n}. ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
const ago = (d: Date | string | null) => {
  if (!d) return 'never'
  const ms = Date.now() - new Date(d).getTime()
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : (((r as { rows?: T[] }).rows ?? []) as T[]))

// Same reasoning as tg(): an unreachable database is a FINDING, not a crash. A query that fails
// degrades to no rows so the rest of the walk (Telegram side included) still produces a report.
let dbBroken = false
async function q<T>(run: () => Promise<unknown>, what: string): Promise<T[]> {
  try {
    return rowsOf<T>(await run())
  } catch (e) {
    if (!dbBroken) {
      dbBroken = true
      flag('BLOCKER', `Cannot query the database (${what}): ${e instanceof Error ? e.message : String(e)}`, 'Check DATABASE_URL. Every DB-backed check below is unreliable until this is fixed.')
    }
    console.log(bad(`query failed (${what}) — skipping`))
    return []
  }
}

async function main() {
  console.log('Baumy doctor — walking the inbound chain (read-only)\n')

  // ── 1. Env. Only what the INBOUND path needs; this reflects the shell you ran in, which is the
  // production environment only if you pulled it. lib/env.ts owns the full required list, and
  // /api/health reports the deployed truth — say so rather than implying otherwise.
  section(1, 'Environment (of THIS shell, not necessarily Vercel)')
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) {
    console.log(process.env[k] ? ok(`${k} set`) : warn(`${k} not set here`))
  }
  if (process.env.BAUMY_HOUSE_CHAT_ID) {
    console.log(`  BAUMY_HOUSE_CHAT_ID override = ${process.env.BAUMY_HOUSE_CHAT_ID} (pins the memory SCOPE, not the transport id)`)
  }
  console.log('  → deployed env truth: GET /api/health (503 + notReady lists what Vercel is missing)')

  // ── 2. Bot identity + PRIVACY MODE. This is the #1 cause of "it stopped reading the group": with
  // privacy mode ON a bot receives ONLY commands, @mentions and replies to itself — so it looks
  // half-alive (slash commands work, ambient capture doesn't). Toggling it in BotFather is NOT
  // enough; the bot must be REMOVED and RE-ADDED for an existing chat to re-evaluate it.
  section(2, 'Bot identity + privacy mode')
  const me = await tg<{ id: number; username?: string; can_read_all_group_messages?: boolean }>('getMe')
  // Telegram being unreachable from THIS shell says nothing about the deployment, so don't report it
  // as a dead token. Either way the DB-backed checks below are independent — keep walking, because
  // the inbound ledger (step 5) can still settle upstream-vs-downstream on its own.
  const botId = me.result?.id ?? null
  const tgReachable = me.ok && me.result != null
  if (!tgReachable) {
    const unreachable = /network error|non-JSON/.test(me.description ?? '')
    console.log(bad(`getMe failed: ${me.description}`))
    flag(
      unreachable ? 'WARN' : 'BLOCKER',
      unreachable ? 'Could not reach the Telegram API from this machine' : 'Telegram rejected the bot token',
      unreachable
        ? 'Network/egress problem here, not necessarily in production — the Telegram-side checks (2, 3, 6, 7) are unreliable. The database checks below still stand.'
        : 'Check TELEGRAM_BOT_TOKEN — a revoked or rotated token makes the bot completely deaf.',
    )
  } else {
    console.log(ok(`@${me.result!.username} (id ${botId})`))
    if (me.result!.can_read_all_group_messages === false) {
      console.log(bad('privacy mode is ON — the bot only sees commands, @mentions and replies to itself'))
      flag(
        'BLOCKER',
        'Telegram privacy mode is ON',
        'BotFather → /mybots → Bot Settings → Group Privacy → Turn OFF, then REMOVE and RE-ADD the bot to the supergroup (existing chats keep the old setting until re-add).',
      )
    } else {
      console.log(ok('privacy mode is OFF — the bot can see all group messages'))
    }
  }

  // ── 3. Webhook registration. last_error_message is the highest-signal field in this whole script:
  // Telegram records exactly why its last delivery failed (401 = webhook-secret mismatch, 404/500 =
  // wrong URL or a broken deploy). A climbing pending_update_count means Telegram is holding
  // messages it cannot hand over — the app never sees them.
  section(3, 'Webhook registration')
  type WebhookInfo = {
    url?: string
    pending_update_count?: number
    last_error_date?: number
    last_error_message?: string
    allowed_updates?: string[]
    max_connections?: number
  }
  const wh: TgResp<WebhookInfo> = tgReachable ? await tg<WebhookInfo>('getWebhookInfo') : { ok: false }
  const w = wh.result
  if (!tgReachable) {
    console.log('  skipped — the Telegram API is unreachable from here (see step 2)')
  } else if (!w?.url) {
    console.log(bad('no webhook registered — Telegram has nowhere to deliver'))
    flag('BLOCKER', 'No webhook URL registered', 'Run: node --experimental-strip-types scripts/set-webhook.ts (needs BAUMY_PUBLIC_URL).')
  } else {
    console.log(ok(`url = ${w.url}`))
    const allowed = w.allowed_updates ?? ['(default: all but chat_member)']
    console.log(`  allowed_updates = ${allowed.join(', ')}`)
    // allowed_updates is a filter Telegram applies BEFORE delivery — omitting 'message' silences
    // ingest entirely, and omitting 'chat_member' (NOT in Telegram's default set) quietly breaks
    // the roster lifecycle, which is what gates the member-DM lane.
    for (const need of ['message', 'callback_query', 'my_chat_member', 'chat_member']) {
      if (w.allowed_updates && !w.allowed_updates.includes(need)) {
        console.log(bad(`allowed_updates is missing '${need}'`))
        flag(
          need === 'message' ? 'BLOCKER' : 'WARN',
          `Webhook does not subscribe to '${need}'`,
          'Re-run scripts/set-webhook.ts — it registers message, edited_message, callback_query, my_chat_member, chat_member.',
        )
      }
    }
    const pending = w.pending_update_count ?? 0
    console.log(pending > 0 ? warn(`pending_update_count = ${pending} (undelivered backlog)`) : ok('pending_update_count = 0'))
    if (w.last_error_message) {
      const when = w.last_error_date ? new Date(w.last_error_date * 1000) : null
      console.log(bad(`last delivery error (${ago(when)}): ${w.last_error_message}`))
      const m = w.last_error_message.toLowerCase()
      // 401 is unambiguous here: route.ts returns exactly that, before any parsing, on a secret mismatch.
      if (m.includes('401') || m.includes('unauthorized')) {
        flag(
          'BLOCKER',
          'Telegram deliveries rejected 401 by the webhook',
          'TELEGRAM_WEBHOOK_SECRET in Vercel no longer matches the secret_token registered with Telegram. Re-run scripts/set-webhook.ts with the DEPLOYED secret (env changes need a redeploy to take effect).',
        )
      } else if (pending > 0) {
        flag('BLOCKER', `Telegram cannot deliver: ${w.last_error_message}`, 'Fix the endpoint/URL, then updates flush automatically (they are retried).')
      } else {
        flag('WARN', `Telegram logged a delivery error ${ago(when)}: ${w.last_error_message}`, 'Stale if traffic has landed since — cross-check step 5.')
      }
    } else {
      console.log(ok('no delivery errors recorded'))
    }
  }

  // ── 4. House ids + topics + the pause switch (the alias seam, D9). scope = the memory key and is
  // never rewritten; live = the current transport id after a group→supergroup upgrade.
  section(4, 'House config (alias seam + topics + response policy)')
  const cfgRows = await q<{
    house_group_chat_id: string | null
    live_chat_id: string | null
    migrated_from_chat_id: string | null
    reminder_thread_id: string | number | null
    console_thread_id: string | number | null
    response_policy: Record<string, unknown> | null
  }>(
    () => sql`SELECT house_group_chat_id, live_chat_id, migrated_from_chat_id, reminder_thread_id, console_thread_id, response_policy
              FROM baumy_house_config WHERE id = true LIMIT 1`,
    'house_config',
  )
  if (cfgRows.length === 0 || !cfgRows[0].house_group_chat_id) {
    // Only claim "no house captured" when the DB actually answered — an unreachable database
    // produces the same empty result and must not be reported as a missing house.
    if (!dbBroken) {
      console.log(bad('house_config is empty — no house captured yet'))
      flag('BLOCKER', 'No house group captured', 'Add the bot to the group (my_chat_member captures it), or set BAUMY_HOUSE_CHAT_ID.')
    }
    return report()
  }
  const cfg = cfgRows[0]
  const scopeId = process.env.BAUMY_HOUSE_CHAT_ID || cfg.house_group_chat_id
  const sendId = cfg.live_chat_id || scopeId
  const acceptIds = [...new Set([scopeId, sendId])]
  const consoleThread = cfg.console_thread_id == null ? null : Number(cfg.console_thread_id)
  const reminderThread = cfg.reminder_thread_id == null ? null : Number(cfg.reminder_thread_id)
  console.log(`  scope id (memory key, never changes): ${scopeId}`)
  console.log(`  live/send id (transport):             ${sendId}${cfg.live_chat_id ? '' : '  (no migration recorded)'}`)
  console.log(`  accepted inbound ids (house lane):    ${acceptIds.join(', ')}`)
  console.log(`  reminder topic (thread):              ${reminderThread ?? 'General'}`)
  console.log(`  ask-Baumy topic (thread):             ${consoleThread ?? 'not set'}`)

  const policy = (cfg.response_policy ?? {}) as { global_enabled?: boolean; reply_frequency?: string; muted_topics?: string[] }
  const enabled = policy.global_enabled ?? true
  const freq = policy.reply_frequency ?? 'quiet'
  // The pause switch silences the whole HOUSE lane — replies AND reactions — while member DMs keep
  // answering (the bypass is lane-scoped). That asymmetry is the tell if only the group went quiet.
  console.log(enabled ? ok('global_enabled = true (not paused)') : bad('global_enabled = FALSE — the house lane is PAUSED'))
  if (!enabled) {
    flag('BLOCKER', 'Baumy is paused (global_enabled = false)', 'DM the bot /resume (owner only), or flip it in the dashboard settings. Pause silences group replies AND reactions; DMs still answer.')
  }
  console.log(`  reply_frequency = ${freq} (confidence floor for UNADDRESSED group messages: quiet 0.85 / balanced 0.7 / chatty 0.5)`)
  if (freq === 'quiet') {
    flag(
      'INFO',
      "reply_frequency is 'quiet' — by design Baumy stays silent unless addressed",
      "Expected: an @mention, a reply to Baumy, any DM, or a message in the ask-Baumy topic still always answers. If ONLY ambient chat is quiet, nothing is broken — retune to 'balanced' in the dashboard.",
    )
  }
  if (policy.muted_topics?.length) console.log(`  muted_topics = ${policy.muted_topics.join(', ')}`)
  if (!consoleThread) {
    flag('WARN', 'No ask-Baumy topic set (console_thread_id is null)', 'Run /baumyhere INSIDE the topic you want to chat in (owner only, from the group).')
  }

  // ── 5. THE DECISIVE FORK. Every accepted update writes one row here from the FIRST ingest step,
  // before any classify/policy/LLM work. Rows landing ⇒ Telegram + webhook + Inngest are all healthy
  // and the fault is downstream. No rows ⇒ nothing upstream is reaching the app at all.
  section(5, 'Inbound ledger — is anything arriving at all?  (the decisive check)')
  const inbound = await q<{ chat_id: string | null; n: number; last: string }>(
    () => sql`SELECT chat_id, count(*)::int AS n, max(received_at) AS last
              FROM baumy_telegram_updates
              WHERE received_at > now() - interval '7 days'
              GROUP BY chat_id ORDER BY max(received_at) DESC`,
    'telegram_updates',
  )
  const [{ last: lastEver = null } = {}] = await q<{ last: string | null }>(
    () => sql`SELECT max(received_at) AS last FROM baumy_telegram_updates`,
    'telegram_updates high-water mark',
  )
  if (dbBroken) {
    console.log('  unavailable — the ledger lives in the database (see the finding above)')
  } else if (inbound.length === 0) {
    console.log(bad(`no inbound updates in the last 7 days (last ever: ${ago(lastEver)})`))
    flag(
      'BLOCKER',
      'No Telegram updates are reaching the app',
      'The break is UPSTREAM of the pipeline: privacy mode (step 2), webhook registration/secret (step 3), or the bot is no longer in the chat (step 6). Nothing downstream can matter until a row lands here.',
    )
  } else {
    console.log(`  updates in the last 7 days, by chat:`)
    for (const r of inbound) {
      const known = r.chat_id != null && acceptIds.includes(r.chat_id)
      const dm = r.chat_id != null && !r.chat_id.startsWith('-')
      const label = known ? 'HOUSE' : dm ? 'DM' : 'other/unknown'
      console.log(`   ${known || dm ? ' ' : '⚠'} ${String(r.chat_id).padEnd(16)} ${String(r.n).padStart(6)} updates   last ${ago(r.last).padEnd(9)} [${label}]`)
      // An unrecognised NEGATIVE chat id is the migration smell: the group upgraded, Telegram now
      // delivers under a -100… id, and house_config never learned it — so every message from the
      // real group falls through resolveOriginParts to the 'ignore' lane and is dropped in silence.
      if (!known && !dm && r.chat_id) {
        flag(
          'BLOCKER',
          `Updates are arriving from ${r.chat_id}, which is NOT in the accepted house ids (${acceptIds.join(', ')})`,
          'That chat resolves to the "ignore" lane and every message is dropped. If it is the house supergroup, capture it: node --experimental-strip-types scripts/heal-house.ts ' +
            r.chat_id,
        )
      }
    }
    const houseSeen = inbound.find((r) => r.chat_id != null && acceptIds.includes(r.chat_id))
    if (!houseSeen) {
      console.log(bad('nothing from the house group in 7 days'))
      flag('BLOCKER', 'No inbound from the house group', 'See step 2 (privacy mode) and step 6 (is the bot still a member?).')
    } else {
      console.log(ok(`house traffic is landing (last ${ago(houseSeen.last)}) — Telegram, webhook and Inngest are all healthy`))
    }
  }

  // ── 6. Is the bot still IN the chat, and is that chat still the right one? getChat on a stale
  // pre-upgrade id 400s with migrate_to_chat_id — the same signal sendToHouseResilient self-heals on.
  section(6, 'The live chat itself')
  type ChatInfo = { id: number; type?: string; title?: string; is_forum?: boolean }
  const chat: TgResp<ChatInfo> = tgReachable ? await tg<ChatInfo>('getChat', { chat_id: sendId }) : { ok: false }
  if (!tgReachable) {
    console.log('  skipped — the Telegram API is unreachable from here (see step 2)')
  } else if (!chat.ok) {
    console.log(bad(`getChat(${sendId}) failed: ${chat.description}`))
    const migrated = chat.parameters?.migrate_to_chat_id
    if (migrated != null) {
      flag(
        'BLOCKER',
        `The live chat id ${sendId} is STALE — the group was upgraded to supergroup ${migrated}`,
        `Converge it: node --experimental-strip-types scripts/heal-house.ts ${migrated} (writes live_chat_id only; the memory scope is untouched).`,
      )
    } else {
      flag('BLOCKER', `Cannot read the house chat ${sendId}: ${chat.description}`, 'Usually means the bot was removed from the group, or the id is wrong.')
    }
  } else {
    console.log(ok(`${chat.result?.type} "${chat.result?.title}" — is_forum = ${chat.result?.is_forum === true}`))
    // Topic routing (message_thread_id) is meaningless outside a forum: a configured thread id in a
    // non-forum chat means the ask-Baumy topic can never match, so it silently never triggers.
    if (chat.result?.is_forum !== true && (consoleThread != null || reminderThread != null)) {
      flag(
        'WARN',
        'Topic ids are configured but this chat is not a forum',
        'Topics only exist in forum supergroups — clear them with /baumyoff and /notifyoff, or enable Topics in group settings.',
      )
    }
    const cm = botId == null ? { ok: false } : await tg<{ status?: string }>('getChatMember', { chat_id: sendId, user_id: botId })
    const status = (cm as TgResp<{ status?: string }>).result?.status
    console.log(status === 'left' || status === 'kicked' ? bad(`bot status in chat: ${status}`) : ok(`bot status in chat: ${status}`))
    if (status === 'left' || status === 'kicked') {
      flag('BLOCKER', `The bot is '${status}' in the house chat`, 'Re-add it to the group (and re-adding also re-applies the privacy-mode setting from step 2).')
    }
  }

  // ── 7. Topic id validation (opt-in). Telegram exposes NO list-topics API, so the only way to tell
  // a good thread id from a bad one is to address it. sendChatAction is the least invasive probe
  // that still validates: it posts no message and expires in seconds — it briefly shows "typing…".
  // A wrong console_thread_id is the classic silent failure: everything looks configured, but
  // messageThreadId === consoleThreadId never holds, so the topic never goes conversational.
  section(7, 'Topic ids')
  if (!tgReachable) {
    console.log('  skipped — the Telegram API is unreachable from here (see step 2)')
  } else if (!probeTopics) {
    console.log('  skipped (read-only). Re-run with --probe-topics to validate them.')
    console.log('  Note: a topic id is the message_thread_id of the topic, NOT the message id in a t.me/c/<chat>/<id> link.')
  } else {
    for (const [name, id] of [
      ['ask-Baumy (console_thread_id)', consoleThread],
      ['reminders (reminder_thread_id)', reminderThread],
    ] as const) {
      if (id == null) {
        console.log(`  ${name}: not set (General topic)`)
        continue
      }
      const probe = await tg('sendChatAction', { chat_id: sendId, action: 'typing', message_thread_id: id })
      if (probe.ok) {
        console.log(ok(`${name} = ${id} — valid`))
      } else {
        console.log(bad(`${name} = ${id} — ${probe.description}`))
        flag(
          'BLOCKER',
          `Configured topic id ${id} (${name}) is not a real thread in this chat`,
          name.startsWith('ask-Baumy')
            ? 'This is exactly why the ask-Baumy topic stays quiet: the id never matches an inbound message_thread_id. Fix it by running /baumyhere INSIDE the topic (owner, from the group) — it captures the authenticated thread id.'
            : 'Run /notifyhere INSIDE the topic you want reminders in.',
        )
      }
    }
  }

  // ── 8. Downstream liveness. If inbound is landing (step 5) but these are flat, the message is
  // being heard and then dropped — pause switch, roster, or the reply gate rather than transport.
  section(8, 'Downstream: is it capturing and answering?')
  const [{ n: caps = 0, last: lastCap = null } = {}] = await q<{ n: number; last: string | null }>(
    () => sql`SELECT count(*)::int AS n, max(created_at) AS last FROM baumy_memory_items WHERE created_at > now() - interval '7 days'`,
    'memory_items',
  )
  const [{ n: reps = 0, last: lastRep = null } = {}] = await q<{ n: number; last: string | null }>(
    () => sql`SELECT count(*)::int AS n, max(sent_at) AS last FROM baumy_replies WHERE sent_at > now() - interval '7 days'`,
    'replies',
  )
  console.log(`  memory captured (7d): ${caps}, last ${ago(lastCap)}`)
  console.log(`  replies sent    (7d): ${reps}, last ${ago(lastRep)}`)
  // Memory is written under the SCOPE id; a split here means something wrote to the transport id and
  // that history is orphaned from every (group-scoped) retrieval query.
  const scopes = await q<{ group_id: string; n: number }>(
    () => sql`SELECT group_id, count(*)::int AS n FROM baumy_memory_items GROUP BY group_id ORDER BY count(*) DESC LIMIT 5`,
    'memory scopes',
  )
  if (scopes.length > 1) {
    console.log(warn('memory is split across more than one group_id:'))
    for (const s of scopes) console.log(`     ${s.group_id}: ${s.n}${s.group_id === scopeId ? '  ← current scope' : ''}`)
    flag(
      'WARN',
      'Memory rows exist under more than one group_id',
      'Retrieval is group-scoped, so only rows under the current scope are recalled. The scope id must never be rewritten on a migration — check house_group_chat_id.',
    )
  } else if (scopes.length === 1) {
    console.log(ok(`all memory under one scope: ${scopes[0].group_id} (${scopes[0].n} rows)`))
    if (scopes[0].group_id !== scopeId) {
      flag('BLOCKER', `All memory is under ${scopes[0].group_id} but the active scope is ${scopeId}`, 'Every recall will come back empty. Align BAUMY_HOUSE_CHAT_ID / house_group_chat_id with the id the history is under.')
    }
  }
  if (caps === 0 && inbound.length > 0) {
    flag('WARN', 'Updates are arriving but nothing was captured in 7 days', 'Messages are heard and then dropped — check the pause switch (step 4) and the ANTHROPIC_API_KEY/classify path in the deployment logs.')
  }

  // ── 9. Roster. The member-DM lane is fail-closed: resolveOriginParts only grants it when
  // roster.isMember(fromId) holds, so an empty/deactivated roster makes every DM resolve to the
  // 'ignore' lane and vanish without a word. That is the specific cause of "DMs get no reply".
  section(9, 'Roster (gates the member-DM lane)')
  const mem = await q<{ telegram_user_id: string; display_name: string | null; role: string; is_active: boolean; dm_chat_id: string | null }>(
    () => sql`SELECT telegram_user_id, display_name, role, is_active, dm_chat_id FROM baumy_members ORDER BY role, telegram_user_id`,
    'members',
  )
  const active = mem.filter((m) => m.is_active)
  console.log(`  ${active.length} active / ${mem.length} total`)
  for (const m of mem) console.log(`   ${m.is_active ? ' ' : '✗'} ${m.telegram_user_id}  ${m.display_name ?? '(no name)'}  [${m.role}]${m.is_active ? '' : ' INACTIVE'}`)
  if (active.length === 0 && !dbBroken) {
    console.log(bad('roster is empty — every DM resolves to the ignore lane'))
    flag(
      'BLOCKER',
      'No active members — DMs cannot be answered',
      'The roster fails closed by design. Members register from group activity (or chat_member updates); BAUMY_OWNER_ID always counts as owner+member. Have people post once in the group, or set BAUMY_OWNER_ID.',
    )
  } else if (active.length > 0 && !active.some((m) => m.role === 'owner')) {
    flag('WARN', 'No owner in the roster', 'Owner-only commands (/pause, /resume, /baumyhere, /notifyhere) will all be refused. Set BAUMY_OWNER_ID.')
  }

  report()
}

function report() {
  console.log(`\n${'═'.repeat(64)}\nFINDINGS\n${'═'.repeat(64)}`)
  if (findings.length === 0) {
    console.log('\n✓ Nothing wrong found in the inbound chain.')
    console.log('  If Baumy is still quiet, the failure is inside a step rather than the wiring:')
    console.log('  check the Inngest run history for handle-telegram-message (failed//paused runs)')
    console.log('  and the deployment logs for [baumy/classify] fallback lines.')
    return
  }
  for (const level of ['BLOCKER', 'WARN', 'INFO'] as const) {
    const hits = findings.filter((f) => f.level === level)
    if (hits.length === 0) continue
    console.log(`\n${level}${hits.length > 1 ? 'S' : ''}:`)
    for (const f of hits) console.log(`\n  • ${f.what}\n    → ${f.fix}`)
  }
  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
