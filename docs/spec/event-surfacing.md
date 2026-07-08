# Proactive event surfacing — advance heads-ups for upcoming events

**Status:** v1 implemented. Nudges at **~1 week before · the day before · the morning of**.

## What this adds

Baumy proactively **gives the house advance notice** of upcoming dated events it already knows
about — a guest arriving, a party, a deadline — instead of only firing reminders someone explicitly
asked for. "Iman's staying Thursday" quietly becomes a 🗓️ heads-up to the group a week out, the day
before, and that morning.

## Why the old version was dead (and the fix)

A "proactive event-surfacing scan" was spec'd (`00-decisions.md` A4) but the scheduled-tasks
subsystem that would have carried it was **deleted as unwired** (`25351fd`) — *nothing ever created
the rows it scanned*. The deeper reason: **dated events weren't stored in a queryable form.** Fact
extraction produced `{iman, staying, "tomorrow night"}` with the date as a **freeform string in the
object** — and `"tomorrow night"` is **meaningless at scan time** (tomorrow relative to *when?*). The
`facts.event_at` column existed but nothing populated it.

So this is a **two-part** feature:

1. **Capture dates (wire it to real data).** Fact extraction now returns an optional `whenText` (the
   time phrase, verbatim) for a fact about a specific happening. The ingest capture step resolves it
   with `parseWhen` **at capture time** — while "tomorrow" is still unambiguous — into an absolute
   `event_at` on the fact (`lib/ai/extract.ts`, `lib/memory/facts.ts` `reconcileFact`). No migration:
   `event_at` already existed. Additive + best-effort (unparseable → `null`, no behaviour change).
2. **Scan + nudge.** A daily Inngest cron (`event-surfacing-scan`, 08:00 house tz) reads current,
   **non-secret**, group-scoped facts with a future `event_at` in an 8-day horizon
   (`upcomingDatedFacts`), and for each computes the still-future lead stages
   (`computeNudgeStages`: `event_at − 7d`, `− 1d`, and 08:00 morning-of). For each new stage it
   creates an **event-anchored reminder** (`anchor_kind = 'event_offset'`, `event_fact_id` set) — and
   the **existing** arm → claim → send → mark-sent machinery delivers it **exactly-once**. Delivery
   frames an event-offset reminder as 🗓️ (advance notice), not ⏰ (`lib/inngest/functions/reminders.ts`).

The scan is the "production path that creates reminders" the old design lacked — now fed by data
that genuinely exists.

## Guardrails (over-notification is the #1 product-killer — risk-register #15)

- **De-duped per (event × stage).** The scan skips any stage whose fire time already has a reminder
  for that fact (any status), so a re-scan never double-schedules, and a *sent* or *cancelled* stage
  is never recreated (`remindersForEventFact`).
- **Secret-excluded.** `upcomingDatedFacts` filters `is_secure = false` — a door-code/bank/wifi event
  is never surfaced to the group.
- **Graceful lead-in.** A stage only schedules if its fire time is still in the future *and* before
  the event, so an event captured late (2 days out) gets just day + morning, never a nudge after the
  fact.
- **Pause silences it.** `/pause` (`global_enabled=false`) stops the scan creating nudges — the same
  gate as the ingest reminder step. Group-delivered only (no per-user DM surface).
- **Fresh dates.** The heads-up text is rendered from `event_at` at delivery-relevant framing
  ("next week / tomorrow / today (Thu 9 Jul)"), never the stale stored phrase.

## Files

- `lib/ai/extract.ts` + `lib/ai/prompts.ts` — `whenText` extraction.
- `lib/memory/facts.ts` — `reconcileFact` writes `event_at`; `upcomingDatedFacts` reads dated facts.
- `lib/surfacing/nudge.ts` — pure `computeNudgeStages` + `nudgeContent`.
- `lib/reminders/store.ts` — `createReminder({eventFactId})`, `remindersForEventFact` (dedup).
- `lib/inngest/functions/surfacing.ts` — `runEventSurfacingScan` core + the `event-surfacing-scan` cron.
- `lib/inngest/functions/reminders.ts` — 🗓️ vs ⏰ delivery framing.

## Deliberately deferred

- **Coalescing** many same-day heads-ups into one digest message (the spec's fatigue lever) — v1
  sends one reminder per stage, riding the proven per-reminder delivery. A daily cap / digest roll-up
  is an additive follow-up if the house finds it chatty.
- **Recurrence** (annual bills): `event_at` is a single timestamp; recurring dated facts are future work.
- **LLM-voiced nudges**: content is deterministic (cheap, never hallucinates an event). A voice pass
  over the heads-up text is a later polish.
