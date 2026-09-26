import { createHttpDb } from '@/db/client'
import type { Origin } from '@/lib/core/origin'
import type { FullRoster } from '@/lib/identity/roster'
import { memberDisplayNames } from '@/lib/identity/roster'
import { enrichIssue, formatIssueBody } from '@/lib/ai/issue-enrich'
import { issuesConfigured, labelsFor } from '@/lib/github/issues'
import { parseReportCommand } from '@/lib/pipeline/report'
import { parseHouseReport, weeklyReport, guestReport, upcomingRemindersReport, recentLearningsReport } from '@/lib/reports/reports'
import { createPendingAction } from '@/lib/confirm/store'
import { parseNotifyCommand, setReminderThread, parseConsoleCommand, setConsoleThread } from '@/lib/identity/house'
import { handleCommand } from '@/lib/identity/commands'
import { writeAudit } from '@/lib/audit'
import { houseTz } from '@/lib/env'
import { sendToHouse, sendConfirmCard, reactToMessage } from '@/lib/telegram/client'
import type { TurnStep } from './step'

// Slash commands — deterministic, no classify/LLM routing. Run after lane resolution (so nothing
// here can answer in a foreign group — A12) and before the conversational turn. Returns the ingest
// decision when a command handled the message, or null to continue.

export interface CommandEnv {
  rawText: string
  origin: Origin
  roster: FullRoster
  fromId: number | null
  chatId: string
  messageId: number
  messageThreadId: number | null
  houseScope: string
  /** A worded house send that echoes the inbound forum topic (DM: no thread). */
  sayHouse: (body: string) => Promise<void>
  houseThreadId: number | undefined
}

export type CommandDecision = 'report' | 'report-view' | 'notify-config' | 'console-config' | 'command' | 'unknown-command'

export async function runCommands(step: TurnStep, env: CommandEnv): Promise<CommandDecision | null> {
  const { rawText, origin, roster, fromId, chatId, messageId, messageThreadId, houseScope, sayHouse, houseThreadId } = env

  // Bug/feature report (/bug, /feature) → enrich into a clean GitHub issue and file it on a confirm
  // tap. Explicit slash command, works in the house group OR a member DM, from an authenticated house
  // member only. Runs before the DM-command path (so /bug in a DM isn't "Unknown command") and
  // independent of the pause switch.
  const report = parseReportCommand(rawText)
  if (report && fromId != null && roster.isMember(fromId)) {
    await step.run('report', async () => {
      const db = createHttpDb()
      if (!issuesConfigured()) {
        await sayHouse("I'd file that, but issue reporting isn't wired up yet — the house owner needs to add a GitHub token. 🐈‍⬛")
        return
      }
      if (!report.body) {
        const eg = report.hint === 'feature' ? '/feature a dark mode for the dashboard' : '/bug the reminder fired twice'
        await sayHouse(`Tell me what to file, like:\n${eg}`)
        return
      }
      const reporter = (await memberDisplayNames(db)).get(String(fromId)) ?? 'a housemate'
      const enriched = await enrichIssue(report.body, report.hint)
      const pid = await createPendingAction(db, {
        groupId: chatId,
        actionType: 'github.issue',
        payload: { title: enriched.title, body: formatIssueBody(enriched, reporter), labels: labelsFor(enriched.type), type: enriched.type },
        requestedBy: String(fromId),
      })
      const kind = enriched.type === 'feature' ? '✨ Feature' : '🐛 Bug'
      await sendConfirmCard(chatId, `${kind}: ${enriched.title}\n\n${enriched.summary}\n\nFile this as a GitHub issue?`, pid, houseThreadId)
    })
    return 'report'
  }

  // House reports (/weekly, /guests, /reminders, /recent) → post a memory-grounded report.
  // Read-only, no confirm, house group OR a member DM, from a member. Independent of pause.
  const reportView = parseHouseReport(rawText)
  if (reportView && fromId != null && roster.isMember(fromId)) {
    await step.run('house-report', async () => {
      const db = createHttpDb()
      await reactToMessage(chatId, messageId, '👀') // seen — putting it together
      // READ scope is always the house (houseScope); in a member DM, chatId is the private chat,
      // which holds nothing. Reply to chatId.
      try {
        const md =
          reportView === 'guests'
            ? await guestReport(db, houseScope)
            : reportView === 'reminders'
              ? await upcomingRemindersReport(db, houseScope, houseTz())
              : reportView === 'recent'
                ? await recentLearningsReport(db, houseScope)
                : await weeklyReport(db, houseScope)
        await sayHouse(md)
      } finally {
        // A transient model error rethrows (I2) so the step retries — never strand the 👀.
        await reactToMessage(chatId, messageId, null)
      }
    })
    return 'report-view'
  }

  // Reminders "notification channel" (/notifyhere in the target topic, /notifyoff to reset). Owner
  // only, HOUSE lane — the authorization is the authenticated owner id and the value is the
  // authenticated message_thread_id, NEVER message text (injection wall intact). Auto-commits at
  // the capture tier: it only routes low-privilege reminder posts to a topic WITHIN the fixed house
  // group. Audited.
  const notify = parseNotifyCommand(rawText)
  if (notify && origin.lane === 'house' && fromId != null && roster.isOwner(fromId)) {
    await step.run('notify-config', async () => {
      const db = createHttpDb()
      if (notify === 'off') {
        await setReminderThread(db, null)
        await writeAudit(db, 'reminder.topic.set', String(fromId), null, { threadId: null })
        await sendToHouse(chatId, 'Reminders will post to the General topic from now on. 🐈', { threadId: messageThreadId ?? undefined })
        return
      }
      if (messageThreadId == null) {
        // Run in General (no topic thread) → nothing to pin. Tell them where to run it.
        await sendToHouse(chatId, 'Run /notifyhere INSIDE the topic you want reminders in — this looks like the General topic. 😼')
        return
      }
      await setReminderThread(db, messageThreadId)
      await writeAudit(db, 'reminder.topic.set', String(fromId), null, { threadId: messageThreadId })
      await sendToHouse(chatId, '📌 Got it — reminders and event heads-ups will post in this topic from now on.', { threadId: messageThreadId })
    })
    return 'notify-config'
  }

  // Ask-Baumy topic (/baumyhere in the target topic, /baumyoff to turn off). Owner only, house lane.
  // Same guarantees as /notifyhere. It only widens VERBOSITY in that topic — it grants NO trust or
  // privilege, so the injection wall is untouched. Audited.
  const console_ = parseConsoleCommand(rawText)
  if (console_ && origin.lane === 'house' && fromId != null && roster.isOwner(fromId)) {
    await step.run('console-config', async () => {
      const db = createHttpDb()
      if (console_ === 'off') {
        await setConsoleThread(db, null)
        await writeAudit(db, 'console.topic.set', String(fromId), null, { threadId: null })
        await sendToHouse(chatId, "Ask-Baumy mode off — I'll go back to only piping up when addressed. 🐈", { threadId: messageThreadId ?? undefined })
        return
      }
      if (messageThreadId == null) {
        await sendToHouse(chatId, 'Run /baumyhere INSIDE the topic you want to chat with me in — this looks like the General topic. 😼')
        return
      }
      await setConsoleThread(db, messageThreadId)
      await writeAudit(db, 'console.topic.set', String(fromId), null, { threadId: messageThreadId })
      await sendToHouse(
        chatId,
        "🐈‍⬛ This is our channel now — ask me anything here (no need to @ me). Try 'what's coming up?', '/reminders', '/recent', or 'what do you know about the kitchen?'",
        { threadId: messageThreadId },
      )
    })
    return 'console-config'
  }

  // Member-DM commands (house-management). Deterministic; no classify/LLM.
  if (origin.lane === 'member_dm' && rawText.trim().startsWith('/')) {
    await step.run('command', async () => handleCommand(origin, rawText))
    return 'command'
  }
  // Any OTHER slash command in the house group (/pause, /help, /start, a non-owner /notifyhere…) is
  // ignored outright (I7): never classified, captured or answered.
  if (origin.lane === 'house' && /^\/[A-Za-z0-9_]+(?:@\w+)?(?:\s|$)/.test(rawText.trim())) return 'unknown-command'
  return null
}
