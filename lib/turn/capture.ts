import { DateTime } from 'luxon'
import { createHttpDb } from '@/db/client'
import { captureMemory } from '@/lib/memory/write'
import { reconcileFactDetailed, tagMemoryAboutPerson } from '@/lib/memory/facts'
import { extractFacts } from '@/lib/ai/extract'
import { memberDisplayNames } from '@/lib/identity/roster'
import { eventWindowFromModel, eventWindowFromPhrase, type EventWindow } from '@/lib/core/when'
import { formatEventWindow } from '@/lib/core/calendar'
import { scanSensitivity } from '@/lib/core/sensitivity'
import { summarizeFact, type FactSummary, type TurnContext, type TurnOutcome } from './context'
import type { TurnStep } from './step'

// Capture (evidence + facts) for one turn. Returns WHAT was written — the evidence note id, the ids
// of the facts this message added/updated, and readable summaries of what was learned / refused —
// so the reply can (a) exclude this turn's own rows from its grounding (C1) and (b) say what it
// noted (THIS TURN) instead of guessing.
//
// The evidence note and the fact extraction are SEPARATE memoized steps: extraction calls the model
// and a transient error there rethrows (I2) so Inngest retries — splitting them means the retry
// re-runs ONLY the extraction, never re-stores the note (a secure note skips consolidation, so a
// re-run capture would duplicate it).

// Salience from the classifier signal (no extra LLM call): statements matter most, reminders /
// requests carrying info next (memory v2 §5). Questions and chatter are never captured (I3).
const SALIENCE: Record<string, number> = { statement: 0.85, reminder: 0.7, request: 0.7 }

export async function runCapture(step: TurnStep, ctx: TurnContext): Promise<NonNullable<TurnOutcome['captured']>> {
  const intent = ctx.verdict?.intent ?? 'statement'
  const memoryItemId = (await step.run('capture', async () =>
    captureMemory(
      // Scope = the house (houseScope), NOT the inbound chat: a member DM writes THROUGH to shared
      // house memory, never to a dead private-chat silo. In the house lane houseScope === chatId.
      // Attribution = the authenticated sender — never quarantined content or an anonymous admin.
      { groupId: ctx.houseScope, content: ctx.text, memoryType: intent, authoredBy: ctx.authorId, trustLevel: ctx.trust, salience: SALIENCE[intent] ?? 0.5 },
      { db: createHttpDb() },
    ),
  )) as string

  // Quarantined content never writes a fact (injection wall) — the note alone is kept for provenance.
  if (ctx.trust === 'quarantined') return { memoryItemId, factIds: [], learned: [], rejected: [] }

  const facts = (await step.run('extract-facts', async () => {
    const db = createHttpDb()
    const factIds: string[] = []
    const learned: FactSummary[] = []
    const rejected: FactSummary[] = []
    let secure: string | null = null
    // The speaker's name lets first-person references resolve ("my room" → their room).
    const speaker = ctx.authorId ? ((await memberDisplayNames(db)).get(ctx.authorId) ?? null) : null
    const { facts } = await extractFacts(ctx.text, speaker, { at: ctx.sentAt, tz: ctx.tz })
    for (const f of facts) {
      // The same scan reconcile runs on the triple (the secret marker usually lives in the subject /
      // predicate): the message carried a secret even when its raw text did not scan.
      const sens = scanSensitivity(`${f.subject} ${f.predicate} ${f.object}`)
      if (sens.isSecure) secure ??= sens.descriptor
      const window = eventWindow(f, ctx)
      // trust = the lane's: a member DM is 'trusted' and MAY supersede a group 'untrusted' fact,
      // never a 'system' reflect fact. memoryItemId links the fact back to THIS note (lineage).
      const r = await reconcileFactDetailed(db, {
        groupId: ctx.houseScope,
        fact: f,
        authoredBy: ctx.authorId,
        trustLevel: ctx.trust,
        memoryItemId,
        eventAt: window?.eventAt ?? null,
        validTo: window?.validTo ?? null,
      })
      const when = window ? formatEventWindow(window.eventAt, window.validTo, ctx.tz) : f.whenText?.trim() || null
      if ((r.result === 'add' || r.result === 'update') && r.factId) {
        factIds.push(r.factId)
        learned.push(summarizeFact(f, when))
      } else if (r.result === 'rejected') rejected.push(summarizeFact(f, when))
    }
    // Tag this note with the person it's about (memory v2 §3) — attributed, never scored.
    await tagMemoryAboutPerson(db, ctx.houseScope, memoryItemId, facts)
    return { factIds, learned, rejected, secure }
  })) as { factIds: string[]; learned: FactSummary[]; rejected: FactSummary[]; secure: string | null }

  return { memoryItemId, ...facts }
}

// When a fact happens (spec §6): the extractor's own `when` (resolved against MESSAGE SENT + the
// calendar table), validated — else the chrono fallback on its verbatim phrase, with the fixed defaults
// (lib/core/when.ts). Both are read at the message's own time, while "tomorrow" is unambiguous. When
// both exist and name different days, the model's reading wins (it saw the calendar) and the
// disagreement is logged — a misread is then visible in the ack (THIS TURN shows the resolved day).
function eventWindow(f: { when?: { start: string; end?: string; allDay?: boolean }; whenText?: string }, ctx: TurnContext): EventWindow | null {
  const fromModel = eventWindowFromModel(f.when, ctx.tz, ctx.sentAt)
  const fromPhrase = f.whenText?.trim() ? eventWindowFromPhrase(f.whenText, ctx.tz, ctx.sentAt) : null
  if (fromModel && fromPhrase) {
    const day = (d: Date) => DateTime.fromJSDate(d).setZone(ctx.tz).toISODate()
    if (day(fromModel.eventAt) !== day(fromPhrase.eventAt))
      console.warn(`[baumy/capture] event date cross-check: model ${day(fromModel.eventAt)} vs "${f.whenText}" → ${day(fromPhrase.eventAt)} (keeping the model's)`)
  }
  return fromModel ?? fromPhrase
}
