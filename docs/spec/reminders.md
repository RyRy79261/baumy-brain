# Reminders & the daily digest — delivery model

**Status:** implemented. Two delivery modes, one exactly-once guard, waking-hours only.

## The shape

Baumy is a house **secretary, not an alarm clock**, and reminders are a barely-used, low-traffic
feature — so the delivery model is built to be cheap and calm, not second-precise. Two modes:

1. **Explicit "remind me at X" — near-time.** A member says "remind us to call the landlord friday
   9am". Captured in the ingest reminder step → `createReminder` → **armed** (an immediate arm event
   + the daily `reminder-arm` cron) → `reminder-deliver` **sleeps until `fire_at`** and delivers once.
   Event-driven, ~2 DB touches per reminder, **no polling**. The fire time is **clamped to waking
   hours** (`clampToWakingHours`, `lib/reminders/parse.ts`): anything landing in the 02:00–06:00 dead
   zone is nudged to 06:00 — no 3am pings.

2. **Event heads-ups + the backstop — batched digest.** The `reminder-digest` cron
   (`lib/inngest/functions/reminders.ts`) fires at **waking-hour slots only** — `08:00` and `20:00`
   house tz — and delivers, as **one message per destination**, every reminder that is DUE:
   - the **event-surfacing heads-ups** (`anchor_kind = 'event_offset'`, the week/day/morning nudges
     from `docs/spec/event-surfacing.md`) — these are deliberately **excluded from near-time arming**
     (`reminder-arm` filters them out) so they arrive batched in the digest, not at odd individual
     times;
   - plus any **explicit reminder the sleepUntil path missed** (the backstop role the old poll had).

   This **replaces the old every-15/30-min sweeper poll** — the thing that kept Neon's compute awake
   ~24/7 and burned ~100 CU-hours/month for a feature nobody triggers that often. Reminder wakes
   went from ~48/day to **1–2/day**.

## Frequency (owner-settable)

`response_policy.reminder_frequency` (`lib/policy.ts`, `setReminderFrequency`):

- **`twice`** (default) — a morning (08:00) **and** an evening (20:00) batch, the day split into
  ~12h segments.
- **`once`** — the morning batch only; the 20:00 run no-ops.

The cron always fires at both slots; the 20:00 run self-skips when frequency is `once`. Both slots
are inside the 06:00–02:00 waking window, so the digest never sends at 3am.

## Invariants preserved

- **Exactly-once.** Both the sleepUntil path and the digest call `claimReminder` (atomic
  `scheduled → firing`) before sending — whichever claims a row wins, the other skips it, so a
  reminder is never double-sent even though two paths can reach it. A send failure calls
  `releaseReminder` (back to `scheduled`) so the next slot retries — never a zero-fire. `markSent`
  is separate from the send, and a row stuck in `firing` is reaped by the digest's `reapStaleFiring`.
- **Fixed destination.** Reminders/digests deliver only to the code-resolved house group
  (`deliverChatId`), never an LLM-picked recipient.
- **Honors `/pause`.** The digest is proactive output, so it skips when `global_enabled` is false
  (like the surfacing/consolidation crons).

## Deliberately deferred

- **Coalescing across the day into a single "here's everything" summary** beyond the per-slot batch.
- **`reminder_frequency` beyond once/twice** (e.g. 3×/day) — the slot logic generalizes, not wired.
- **The sleepUntil path honoring `/pause`** — a pre-existing behavior, untouched here.
