import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { type Database } from '@/db/client'
import { members, pendingActions } from '@/db/schema'
import { createPendingAction } from '@/lib/confirm/store'
import { now } from '@/lib/core/clock'
import { houseTz } from '@/lib/env'
import { withKitchenHouse } from '@/lib/lists/kitchen-api'
import { sendLoginApprovalCard } from '@/lib/telegram/client'
import type { OlympicsResult } from './client'

// "Sign in with Baumy" (docs/spec/olympics.md §Sign-in approval; Olympics' ADR 0006 and
// docs/brain-integration.md). Someone taps Sign in with Baumy on an Olympics screen; Olympics asks
// Baumy to DM that member "Sign in on <device>? Tap the number on the screen" with the number the
// screen shows and two decoys. The member's tap goes back to Olympics as `approve_login` /
// `deny_login` (lib/inngest/functions/callback.ts).
//
// Walls:
//   1. Bearer KITCHEN_API_TOKEN (the kitchen API's own wall) and the house scope (503 before a house).
//   2. The DM goes ONLY to the ACTIVE member Olympics named, at their own DM (dm_chat_id, else their
//      Telegram id, which is their private chat id). Anyone else: `{ok: true, sent: false}` and no
//      send. Never the group; never an id from text.
//   3. The card is a pending action (`olympics.login`) that only that member may resolve
//      (REQUESTER_ONLY_ACTIONS), expiring when Olympics' request does.
//   4. The LLM never sees any of this: the card is sent and resolved by code only, and Olympics
//      decides whether the tapped number is the right one.

export const LOGIN_ACTION_TYPE = 'olympics.login'

/** What an `olympics.login` card stores: everything the tap needs. */
export interface LoginPending {
  requestId: string
  choices: number[]
  device: string
}

const TWO_DIGITS = z.number().int().min(10).max(99)

const Body = z.object({
  requestId: z.string().uuid(),
  telegramUserId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]).transform(String),
  device: z.string().trim().min(1).max(80),
  choices: z
    .array(TWO_DIGITS)
    .length(3)
    .refine((c) => new Set(c).size === 3, 'distinct'),
  expiresAt: z.string().datetime(),
})

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The DM's words. Code-written, never the reply model. */
export function loginCardText(device: string, at: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: houseTz(), hour: '2-digit', minute: '2-digit' }).format(at)
  return `🔐 Sign in to Baumy Olympics on ${device} at ${time}?\n\nTap the number on the screen. If this wasn't you, tap Deny.`
}

/** POST /api/kitchen/login-approval */
export async function handleLoginApproval(req: Request): Promise<Response> {
  return withKitchenHouse(req, async (db, scope) => {
    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      raw = null
    }
    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      return json({ ok: false, error: 'bad_request', message: 'Expected { requestId, telegramUserId, device, choices[3], expiresAt }.' }, 400)
    }
    const b = parsed.data
    const ttlSec = Math.floor((Date.parse(b.expiresAt) - now().getTime()) / 1000)
    const to = await memberDm(db, b.telegramUserId)
    // Unknown, inactive or already expired: nothing to send. Not an error — Olympics answers every
    // address the same way, whether or not anyone gets a message.
    if (!to || ttlSec <= 0) return json({ ok: true, sent: false })
    const payload: LoginPending = { requestId: b.requestId, choices: b.choices, device: b.device }
    const actionId = await createPendingAction(db, {
      groupId: scope,
      actionType: LOGIN_ACTION_TYPE,
      payload: payload as unknown as Record<string, unknown>,
      requestedBy: b.telegramUserId,
      ttlSec,
    })
    try {
      await sendLoginApprovalCard(to, loginCardText(b.device, now()), actionId, b.choices)
    } catch (err) {
      // Most often: the member never pressed Start in a DM with Baumy, so Telegram refuses.
      console.warn('[baumy/olympics] login approval DM not delivered:', err instanceof Error ? err.message : err)
      return json({ ok: true, sent: false })
    }
    return json({ ok: true, sent: true })
  })
}

/** The active member's own DM chat, or null. */
async function memberDm(db: Database, telegramUserId: string): Promise<string | null> {
  const [m] = await db
    .select({ id: members.telegramUserId, dm: members.dmChatId })
    .from(members)
    .where(and(eq(members.telegramUserId, telegramUserId), eq(members.isActive, true)))
    .limit(1)
  return m ? (m.dm ?? m.id) : null
}

/** The numbers on a sign-in card, or null when there is no such card. Read BEFORE the card is
 *  resolved, so a number that was never on it cannot spend it. */
export async function loginCardChoices(db: Database, actionId: string): Promise<number[] | null> {
  const [row] = await db
    .select({ payload: pendingActions.payload })
    .from(pendingActions)
    .where(and(eq(pendingActions.id, actionId), eq(pendingActions.actionType, LOGIN_ACTION_TYPE)))
    .limit(1)
  const choices = (row?.payload as Partial<LoginPending> | undefined)?.choices
  return Array.isArray(choices) ? choices : null
}

/** Parse `l:<actionId>:<n>` callback data. */
export function parseLoginTap(data: string): { actionId: string; code: number } | null {
  const m = /^l:([0-9a-f-]{36}):(\d{2})$/.exec(data)
  return m ? { actionId: m[1]!, code: Number(m[2]) } : null
}

/** The line the card becomes after the tap. */
export function loginResultLine(p: LoginPending, result: OlympicsResult<{ outcome?: string }>): string {
  if (result.ok) {
    switch (result.data?.outcome) {
      case 'approved':
        return `✅ Signed in on ${p.device}.`
      case 'blocked':
        return "🚫 That wasn't the number on the screen, so I blocked this sign-in. If it wasn't you, nothing happened; if it was, use your password (Sign in with Baumy is off for 15 minutes)."
      case 'denied':
        return `✖️ Denied the sign-in on ${p.device}.`
    }
    return '✅ Done.'
  }
  if (result.kind === 'refused') return `⚠️ ${result.message}`
  if (result.kind === 'not_configured') return "⚠️ Baumy Olympics isn't connected to me yet."
  return "⚠️ Baumy Olympics isn't answering right now."
}
