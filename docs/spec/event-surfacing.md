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
   creates an **event-anchored reminder** (`anchor_kind = 'event_offset'`, `event_fact_id` set).
   These are **excluded from near-time arming** and delivered **batched by the daily digest**
   (`docs/spec/reminders.md`) at waking-hour slots — framed 🗓️ (advance notice), not ⏰ — claim-once
   so they never double-send.

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

## End-of-day consolidation (catch-up + integrity)

The scan above only dates events **at capture** — so a date learned *before* the feature shipped, or
one the per-message extractor missed, never becomes a heads-up. A nightly **consolidation pass**
(`lib/inngest/functions/consolidation.ts` `consolidationSweep`, 22:30 house tz, ahead of the 08:00
scan) closes that, in two deterministic, decay-bounded passes:

- **A — catch up.** For each current, non-secret fact learned in the last **14 days** (`recentUndatedFacts`)
  with `event_at IS NULL`, re-resolve its `object_value` with `parseWhen` **anchored to the fact's own
  `recorded_at`** — so "tomorrow night" said last Tuesday correctly lands on the Wednesday after, the
  unambiguous resolution that is impossible at scan time. If it resolves to a *future* time, a targeted
  `setFactEventAt` UPDATE backfills `event_at` (not `reconcileFact`, which NOOPs on an unchanged value),
  and `runEventSurfacingScan` then schedules the week/day/morning heads-ups idempotently. chrono returns
  null for a non-date value, so a plain attribute ("the extra room") is safely left undated.
- **B — integrity.** The create-only scan never cancels, so a superseded/contradicted event ("Iman's
  coming" → "Iman cancelled") would still fire a stale heads-up. `orphanedEventReminders` finds
  scheduled `event_offset` reminders whose anchoring fact is no longer `is_current` and cancels them.

Two windows, not to be conflated: the **decay bound** is *backward* on `recorded_at` (which facts to
re-examine); the **surfacing horizon** is *forward* on `event_at` (which events get nudges). The pass
is LLM-free (deterministic parse + fact currency), honors `/pause`, and once a fact is dated it drops
out of the candidate set, so nothing re-processes.

## Deliberately deferred

- **Coalescing** many same-day heads-ups into one digest message (the spec's fatigue lever) — v1
  sends one reminder per stage, riding the proven per-reminder delivery. A daily cap / digest roll-up
  is an additive follow-up if the house finds it chatty.
- **Graph-aware contradiction integrity.** Pass B today cancels heads-ups only for a *same-predicate*
  supersession (the deterministic case). A contradiction stated across a *different* predicate ("Iman
  arrives Friday" stays current, but "Iman's not coming after all" is added) leaves the anchoring fact
  current, so its heads-up survives. Catching that needs walking the event's graph neighbourhood
  (`connectedEdges` / `entityTimeline`) and an LLM judging "is this event still on?" — LLM-proposes,
  code-cancels. Deferred as the richer next step.
- **Recurrence** (annual bills): `event_at` is a single timestamp; recurring dated facts are future work.
- **LLM-voiced nudges**: content is deterministic (cheap, never hallucinates an event). A voice pass
  over the heads-up text is a later polish.
