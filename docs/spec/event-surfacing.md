# Proactive event surfacing — advance heads-ups for upcoming events

**Status:** v2 implemented. Nudges at **~1 week before · the day before · the morning of**, **one per
event** (not per extracted fact), with the **line written by the model**.

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
   (`upcomingDatedFacts`), **groups them into events** (`groupEvents` — same subject entity, same
   local day), and for each computes the still-future lead stages
   (`computeNudgeStages`: `event_at − 7d`, `− 1d`, and 08:00 morning-of). For each new stage it
   creates an **event-anchored reminder** (`anchor_kind = 'event_offset'`, `event_fact_id` set).
   These are **excluded from near-time arming** and delivered **batched by the daily digest**
   (`docs/spec/reminders.md`) at waking-hour slots — framed 🗓️ (advance notice), not ⏰ — claim-once
   so they never double-send.

The scan is the "production path that creates reminders" the old design lacked — now fed by data
that genuinely exists.

## The heads-up line is WRITTEN, not templated (v2)

v1 assembled the text from database columns — `Heads-up — <Subject> <predicate>, today (Thu 30 Jul)`.
In the wild that posted grammar-free row fragments to the group ("Heads-up — Ryan noble needs, today",
"Heads-up — Mad profile, today"): the *object* — the part carrying the actual information — was
dropped, and any row with a date attached became a "heads-up" whether or not it was an event.

v2 splits the two jobs along the golden rule. **Deterministic code decides what is eligible** (current,
non-secret, non-profile, dated inside the horizon, grouped into one event, not already nudged) and
**where it goes** (the fixed house group, code-resolved). **The model writes the sentence**
(`lib/ai/nudge.ts` `writeHeadsUp`, `assess`/Sonnet, plain `generateText` — prose, not a structured
object) from the event's facts and the freshly-rendered date, in Baumy's voice.

It is also the judge of whether a row is an event at all: it answers **`SKIP`** when the facts are a
description, a standing arrangement, or too fragmentary to say cleanly, and **a SKIP schedules
nothing** — an unwanted heads-up is worse than a missed one. Nothing is written on a skip, so a later
scan re-asks. Disposal stays deterministic: `sanitiseHeadsUp` collapses **all whitespace to single
spaces** (the digest joins reminders with newlines — a multi-line answer could otherwise forge extra
digest entries), strips a leading bullet, and drops an over-long line rather than truncating it.
Any model or API error → `null` → nothing scheduled (best-effort, never a crash-looped cron).

## Guardrails (over-notification is the #1 product-killer — risk-register #15)

- **One heads-up per EVENT, not per fact row.** A single message shreds into several fact triples
  ("Ryan returns home", "Ryan needs a lift", "Ryan's staying in his room"), each carrying the *same*
  resolved date — surfacing them row-by-row turned one arrival into a wall of lines. `groupEvents`
  keys on (subject entity × local day); the group's facts are written into **one** line, and the
  reminder is anchored to the group's earliest fact.
- **De-duped per (event × stage).** The scan skips any stage whose fire time already has a reminder
  for **any fact in the group** (any status — `remindersForEventFacts`), so a re-scan never
  double-schedules, a late-arriving sibling fact cannot re-open a stage, and a *sent* or *cancelled*
  stage is never recreated.
- **Profiles are never events.** Reflect writes each person's profile as a fact (`predicate =
  'profile'`) whose object is a prose paragraph, re-synthesised every few hours. Both
  `upcomingDatedFacts` and `recentUndatedFacts` exclude it — otherwise it is permanently "recent",
  any month name inside it reads as a date, and the house gets "Mad profile, today" forever.
- **Secret-excluded.** `upcomingDatedFacts` filters `is_secure = false` — a door-code/bank/wifi event
  is never surfaced to the group.
- **Graceful lead-in.** A stage only schedules if its fire time is still in the future *and* before
  the event, so an event captured late (2 days out) gets just day + morning, never a nudge after the
  fact.
- **Pause silences it.** `/pause` (`global_enabled=false`) stops the scan creating nudges — the same
  gate as the ingest reminder step. Group-delivered only (no per-user DM surface).
- **Fresh dates.** The date the model is given comes from `event_at` with delivery-relevant framing
  ("next week / tomorrow / today", `Thu 9 Jul`), never the stale stored phrase.

## Files

- `lib/ai/extract.ts` + `lib/ai/prompts.ts` — `whenText` extraction; `WRITE_HEADSUP_SYSTEM`.
- `lib/ai/nudge.ts` — `writeHeadsUp` (the model writes the line) + `sanitiseHeadsUp` (disposal).
- `lib/memory/facts.ts` — `reconcileFact` writes `event_at`; `upcomingDatedFacts` reads dated facts.
- `lib/surfacing/nudge.ts` — pure `computeNudgeStages` + `groupEvents` + lead/date framing.
- `lib/reminders/store.ts` — `createReminder({eventFactId})`, `remindersForEventFacts` (dedup).
- `lib/inngest/functions/surfacing.ts` — `runEventSurfacingScan` core + the `event-surfacing-scan` cron.
- `lib/inngest/functions/reminders.ts` — 🗓️ vs ⏰ delivery framing.

## End-of-day consolidation (catch-up + integrity)

The scan above only dates events **at capture** — so a date learned *before* the feature shipped, or
one the per-message extractor missed, never becomes a heads-up. A nightly **consolidation pass**
(`lib/inngest/functions/consolidation.ts` `consolidationSweep`, 22:30 house tz, ahead of the 08:00
scan) closes that, in two deterministic, decay-bounded passes:

- **A — catch up.** For each current, non-secret, non-profile fact learned in the last **14 days**
  (`recentUndatedFacts`) with `event_at IS NULL`, re-resolve its `object_value` with **`parseEventDate`
  anchored to the fact's own `recorded_at`** — so "tomorrow night" said last Tuesday correctly lands on
  the Wednesday after, the unambiguous resolution that is impossible at scan time. If it resolves to a
  *future* time, a targeted `setFactEventAt` UPDATE backfills `event_at` (not `reconcileFact`, which
  NOOPs on an unchanged value), and `runEventSurfacingScan` then schedules the heads-ups idempotently.

  **`parseEventDate` is precision-first, and deliberately not `parseWhen`.** Reading a *stored* value
  is nothing like reading a live "remind me friday", and a plain chrono call over arbitrary values is
  how the house ended up with heads-ups about sentences that were never events. Three guards the live
  path does not need:
  1. **No forward-dating.** An old value is read literally against `recorded_at`, so a past mention
     stays past ("was supposed to leave on Sunday" is *that* Sunday) instead of being rolled into a
     fake future event. `forwardDate` would happily turn "she moved in in March" into next March.
  2. **Coverage.** The matched phrase must be ≥60% of the value — chrono plucks "March" out of a
     200-character biography and hands back a confident date; that is a prose blob, not a date.
  3. **A known day or weekday.** A bare month or year is not an event date. Values over 120 chars are
     prose by definition and rejected outright.

  A plain attribute ("the extra room") still resolves to null, as before.
- **B — integrity.** The create-only scan never cancels, so a superseded/contradicted event ("Iman's
  coming" → "Iman cancelled") would still fire a stale heads-up. `orphanedEventReminders` finds
  scheduled `event_offset` reminders whose anchoring fact is no longer `is_current` and cancels them.

Two windows, not to be conflated: the **decay bound** is *backward* on `recorded_at` (which facts to
re-examine); the **surfacing horizon** is *forward* on `event_at` (which events get nudges). The pass
is LLM-free (deterministic parse + fact currency), honors `/pause`, and once a fact is dated it drops
out of the candidate set, so nothing re-processes.

## Cleaning up what v1 already wrote (migration `0011_retire_templated_nudges`)

The code fix stops *new* garbage, but three things were already in the DB, so the cleanup is a
**data migration** — it runs automatically on deploy (`scripts/maybe-migrate.mjs`), not a script
somebody has to remember:

- **Pending templated heads-ups are DELETED** (not cancelled). Rows already scheduled would still
  post `Heads-up — Mad profile, today` at their fire time. Delete, because the scan de-dupes against
  reminders of *any* status — a cancelled row would permanently block the properly-written
  replacement for that event×stage. The `LIKE` is anchored to the exact old template (prefix **and**
  the `, <lead> (` tail) so a model-written line that happens to open with "Heads-up" survives.
- **Invented `event_at` values are nulled** on profiles and on any fact whose value is longer than
  the parser's 120-char limit. They stay perfectly good facts; they are just not events.
- **The un-delivered backlog is cancelled** (audited, not deleted). `expireStaleScheduled` handles
  this on every digest run from now on; the migration clears what was already sitting there.

## Deliberately deferred

- **Coalescing across *different* events on the same day.** v2 collapses the facts of one event into
  one line, and the digest already batches everything due into one message — but two unrelated events
  on the same day are still two lines. A daily cap or a written roll-up ("three things today: …") is
  the additive follow-up if the house still finds it chatty.
- **Graph-aware contradiction integrity.** Pass B today cancels heads-ups only for a *same-predicate*
  supersession (the deterministic case). A contradiction stated across a *different* predicate ("Iman
  arrives Friday" stays current, but "Iman's not coming after all" is added) leaves the anchoring fact
  current, so its heads-up survives. Catching that needs walking the event's graph neighbourhood
  (`connectedEdges` / `entityTimeline`) and an LLM judging "is this event still on?" — LLM-proposes,
  code-cancels. Deferred as the richer next step.
- **Recurrence** (annual bills): `event_at` is a single timestamp; recurring dated facts are future work.
- ~~**LLM-voiced nudges**~~ — **done in v2** (`writeHeadsUp`). The deterministic template was cheap and
  never hallucinated an event, but it also could not tell an event from a biography and read like a
  fax machine printing table rows. The model writes the line; code still picks what is eligible and
  where it goes.
