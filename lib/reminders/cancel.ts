import { and, asc, eq, inArray, ne, or } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { reminders } from '@/db/schema'
import { normalizeItem } from '@/lib/lists/store'
import { describeRecurrence } from './recurrence'
import { cancelUnsentSeries, visibleReminders } from './store'

// Cancelling a reminder from chat (docs/spec/reminders.md §Cancelling from chat). The classifier flags
// the intent, the extractor DESCRIBES which reminder ("bins", "call mum"), and THIS code disposes: it
// resolves the description to concrete scheduled rows in the house scope that the asker may SEE, and
// the confirm-tap wall (lib/inngest/functions/callback.ts) cancels exactly those rows' series — never a
// row id the model named, never a row outside the stored scope.
//
// Visibility is the same rule /reminders uses (visibleReminders): in the house lane only HOUSE reminders;
// in a member's own DM also that member's personal DM reminders. Someone else's DM-private reminder is
// invisible — it cannot be matched, listed or cancelled by anyone but its creator (the tap re-checks).
// Event-surfacing heads-ups (anchor_kind 'event_offset') are not user-set reminders and are out of scope.

export interface CancelCandidate {
  id: string
  content: string
  fireAt: Date
  recurrence: string | null
  /** A personal reminder delivered to its creator's DM (D2) — not a house reminder. */
  personal: boolean
}

/** The scheduled, user-set reminders a viewer may see (and so ask to cancel), soonest first. */
export async function cancellableReminders(db: Database, groupId: string, privateTo: string | null, limit = 50): Promise<CancelCandidate[]> {
  const rows = await db
    .select({
      id: reminders.id,
      content: reminders.content,
      fireAt: reminders.fireAt,
      recurrence: reminders.recurrence,
      deliverChatId: reminders.deliverChatId,
      groupId: reminders.groupId,
    })
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.status, 'scheduled'), ne(reminders.anchorKind, 'event_offset'), visibleReminders(privateTo)))
    .orderBy(asc(reminders.fireAt))
    .limit(limit)
  return rows.map((r) => ({ id: r.id, content: r.content, fireAt: r.fireAt, recurrence: r.recurrence, personal: r.deliverChatId !== r.groupId }))
}

// Words that say "a reminder" rather than WHICH reminder. Dropped from both sides before matching.
const FILLER = new Set([
  'the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'us', 'me', 'we', 'i', 'to', 'for', 'about', 'of', 'on', 'that', 'this', 'one',
  'reminder', 'reminders', 'remind', 'reminding', 'stop', 'cancel', 'delete', 'remove', 'drop', 'anymore', 'any', 'more', 'please', 'no', 'need',
])

// The same read-side tolerance the shopping-list check-off uses (lib/lists/store.ts looseItemKey): case,
// whitespace, punctuation, a possessive and a plain plural never decide a match ("the bins" ~ "bin").
function singular(w: string): string {
  return w.length > 3 ? w.replace(/(?:(?<=[sxz]|ch|sh)es|(?<!s)s)$/, '') : w
}

/** The content words of a reminder text or a target description. */
export function contentWords(s: string): string[] {
  const words = normalizeItem(s)
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/'s$|'$/, '').replace(/'/g, ''))
    .filter((w) => w && !FILLER.has(w))
    .map(singular)
  return [...new Set(words)]
}

export type CancelMatch =
  | { kind: 'match'; rows: CancelCandidate[] }
  | { kind: 'ambiguous'; rows: CancelCandidate[] }
  | { kind: 'nothing' }
  | { kind: 'vague' }

/**
 * Resolve a target description against the visible rows. Precision-first: a row matches when EVERY
 * content word of the target is in it ("call mum" ⊂ "Charli: call mum"). Only when nothing matches fully
 * is a partial match considered — the rows sharing the most words, and at least half of the target's
 * (the confirm card shows exactly what would go, so a near-miss is reviewed by a human, never applied
 * silently). Several matches with DIFFERENT contents are ambiguous: Baumy asks which instead of offering
 * to cancel all of them; identical contents (a duplicate) are one thing and go together.
 */
export function matchReminders(rows: CancelCandidate[], target: string): CancelMatch {
  const want = contentWords(target)
  if (want.length === 0) return { kind: 'vague' }
  const scored = rows.map((r) => {
    const have = new Set(contentWords(r.content))
    return { r, overlap: want.filter((w) => have.has(w)).length }
  })
  let hits = scored.filter((s) => s.overlap === want.length).map((s) => s.r)
  if (hits.length === 0) {
    const best = Math.max(0, ...scored.map((s) => s.overlap))
    if (best >= 1 && best * 2 >= want.length) hits = scored.filter((s) => s.overlap === best).map((s) => s.r)
  }
  if (hits.length === 0) return { kind: 'nothing' }
  const distinct = new Set(hits.map((r) => `${r.personal}|${normalizeItem(r.content)}`))
  return distinct.size > 1 ? { kind: 'ambiguous', rows: hits } : { kind: 'match', rows: hits }
}

/** "⏰ put the bins out — every Friday 20:00" / "⏰ Charli: call mum — Sat 3 Oct 18:00 (just for you)". */
export function reminderLabel(r: Pick<CancelCandidate, 'content' | 'fireAt' | 'recurrence' | 'personal'>, tz: string): string {
  const at = DateTime.fromJSDate(new Date(r.fireAt)).setZone(tz)
  const repeat = describeRecurrence(r.recurrence)
  const when = repeat ? `${repeat} ${at.toFormat('HH:mm')}` : at.toFormat('ccc d LLL HH:mm')
  return `⏰ ${r.content} — ${when}${r.personal ? ' (just for you)' : ''}`
}

/**
 * The confirm TAP (the second half of the wall): cancel every unsent row of the series these reminders
 * start, in the pending action's STORED house scope. Re-checks visibility against the TAPPER, not the
 * proposer: a house reminder may be cancelled by any member's tap (like a forget card); a personal DM
 * reminder only by its own creator — a card that somehow reached someone else can never cancel it.
 * Started from the proposed ids (not only their still-scheduled state), so a series that delivered and
 * rolled on to its next occurrence between the card and the tap still has that next occurrence cancelled
 * (cancelUnsentSeries walks previous_reminder_id). Returns the cancelled row ids.
 */
export async function cancelRemindersOnTap(db: Database, groupId: string, ids: string[], tapperId: string): Promise<string[]> {
  if (!ids.length) return []
  const allowed = await db
    .select({ id: reminders.id })
    .from(reminders)
    .where(
      and(
        eq(reminders.groupId, groupId),
        inArray(reminders.id, ids),
        ne(reminders.anchorKind, 'event_offset'),
        or(eq(reminders.deliverChatId, reminders.groupId), and(eq(reminders.deliverChatId, tapperId), eq(reminders.createdBy, tapperId))),
      ),
    )
  return cancelUnsentSeries(
    db,
    groupId,
    allowed.map((r) => r.id),
  )
}
