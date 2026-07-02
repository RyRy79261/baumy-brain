# Proactive Digests, Nudges & Event Surfacing

> When Baumy speaks *unprompted* — mid-week/end-of-week digests, upcoming-event surfacing, and the occasional conservative nudge — it must be useful and rare, never annoying or steerable. This section specifies the single outbound chokepoint, the deterministic notify-gate, fatigue control by coalescing, dated-event surfacing over memory, and the injection/exfiltration defenses on everything Baumy sends. **All proactive output lands in the house group** (`BAUMY_HOUSE_CHAT_ID`) — Baumy is a house-management tool, not a personal PA, so there is no per-user DM notification lane (A3).

## Overview

Governing principle: **"the LLM proposes, deterministic code disposes."** Because Telegram privacy mode is OFF, every group message is untrusted prompt-injection input, so there is **no code path where parsing group text directly causes a send.** Two boundaries:

1. **Ingest boundary** — untrusted message → cheap classifier → provenance/trust-tagged *facts and signals* in the memory store. Text is data, never an instruction.
2. **Egress boundary** — a separate, pure, fail-closed **notify-gate** evaluates only internally-generated candidates against a fixed ordered sequence of hard checks before any Telegram send.

**Scope split (important).** This section owns Baumy's **unprompted** traffic: user-set **reminders** firing (P0), **conservative nudges** (P2), scheduled **digests** (P3), and **dated-event surfacing**. It does **NOT** own the reactive reply/auto-answer decision — *when to reply to a house question and how confidently* lives in **`llm-pipeline.md`** (the deterministic addressing gate + auto-answer response policy). Proactive's job for replies (P1) is only to share the same per-chat send budget. Here we keep nudges **conservative + configurable + self-configurable** (A5).

The binding constraint is **human annoyance, not Telegram's API limits** — a 4-person house never approaches Telegram's ceilings. So the primary fatigue lever is **coalescing** low-value items into a scheduled digest; caps, quiet hours, and snooze are backstops.

All outbound traffic — reminders, digests, nudges, event-surfacing pings — routes through **one server-side chokepoint** (an Inngest `notify/candidate.raised` → `notify-gate` → throttled `telegram-send` chain), never sent directly from a message handler. One enforcement point makes fatigue caps, quiet hours, dedupe, destination-pinning, and the injection write-gate impossible to bypass.

## Decisions

| # | Decision | Why | Confidence |
|---|----------|-----|-----------|
| 1 | **One outbound chokepoint.** Every proactive candidate emits `notify/candidate.raised` → `notify-gate` applies all policy → `notify/send.ready` → throttled `telegram-send`. Never send from a handler. Inline reply-lane sends (owned by `llm-pipeline.md`) must account against the **same per-chat counter** — route through `telegram-send` or a shared limiter. | Single point makes caps, quiet hours, dedupe, destination-pin, and the injection gate unbypassable. Matches the ops-board Inngest trigger→gate→act pattern. | high |
| 2 | **Two-stage funnel + pure deterministic gate.** Stage 0: deterministic regex/keyword pre-filter *in the webhook*. Stage 1: cheap OpenAI nano classifier that may return **only** a bounded schema `{ intentClass: enum, confidence: 0..1, topicKey, rationale(audit-only) }`. The **schema is the injection firewall** — a fully compromised classifier can at most raise one typed flag + a number. | Satisfies "group text must never steer privileged writes/notifications." No LLM output ever directly triggers a send. Pre-filter also cuts LLM calls and Inngest executions (most house chatter is banter). | high |
| 3 | **Four priority tiers, all delivered to the house group; fatigue gates apply ONLY to bot-initiated tiers.** P0 = user-set **reminder due** (exempt from cap/confidence/mute; honors its set time; delivery never gated). P1 = **direct reply / auto-answer** (decisioned in `llm-pipeline.md`; shares the send budget). P2 = **conservative nudge** (fully gated). P3 = **digest-only**. | Fatigue comes from unsolicited pings; gating replies/reminders would make Baumy feel broken. An exempt P0 tier guarantees a reminder the house set actually fires. Delivery-to-group matches A3 (house-scoped, not per-user DM). | high |
| 4 | **Priority + destination set by deterministic code from the trigger-source trust level, never by the LLM.** All house notifications target the **fixed `BAUMY_HOUSE_CHAT_ID`**. A group message can raise **at most a P2 nudge** candidate; it can never self-escalate to P0, never redirect destination, and never drive a privileged config write. Reminder *creation* is write-gated in `llm-pipeline.md` (must be addressed to Baumy). | The notification-side expression of the deterministic write-gate. Privacy mode is OFF → group text is untrusted; there is no DM targeting to abuse (A3). | high |
| 5 | **Coalescing is the primary fatigue lever, not blocking.** Sub-threshold items land in a digest buffer and emit as ONE scheduled message. **The digest is a built-in instance of the user-definable `scheduled_tasks` engine** (`scheduled-tasks.md`): its cadence is **settable on the fly**, not a hardcoded cron. Defaults ship as seeded config: mid-week + end-of-week (plus an optional daily "fatigue sink"). Summarize **from DB records**, never chat recall. | One digest of 6 items is far less fatiguing than 6 pings. Generalizing digest scheduling to `scheduled_tasks` (A4b) means the house can retune cadence without a redeploy, and arbitrary recurring queries reuse the same machinery. | high |
| 6 | **Proactive event surfacing from dated facts.** A scheduled Inngest **dated-fact sweep** scans memory for facts with a future event date and surfaces those entering a ~7-day horizon → emits `proactive/candidate.created` that **feeds digests (P3) and conservative nudges (P2)**. Event-anchored reminders ("a week before Tom arrives") resolve their fire time from the same dated facts. | Baumy is "privy to" dated events in memory (guest arrivals, event dates, dated bills); advance notice is the highest-value unprompted output (A4). Reuses the memory substrate, no new watcher process. | high |
| 7 | **Composite usefulness score, not raw model output.** `final = clamp(w_model·modelUsefulness + w_corrob·f(sourceCount) + w_recency·decay(age) − w_novelty·simToRecent)`. The model term is **bounded**; high-stakes classes require **two-model corroboration** (nano flags → Anthropic Haiku independently confirms). | The classifier reads untrusted facts, so it is itself injectable ("this is SUPER urgent!!!"). Bounding the model term + corroboration shrinks false positives and injection leverage. | high |
| 8 | **Conservative nudges are configurable AND self-configurable via natural language.** Nudge/proactivity settings (`proactivity_enabled`, caps, muted topics/categories, confidence floor) are editable in the dashboard and adjustable by a trusted member telling Baumy "stop nagging us about X" — routed through the **deterministic write-gate**: owner = full control; trusted housemates = **safe-direction only** (reduce noise), audited; **untrusted group text can NEVER reconfigure** (injection would otherwise mute Baumy); always reversible in the dashboard. | The auto-answer counterpart (`response_policy`/`adjust_response_policy`) lives in `llm-pipeline.md`; here the same gated pattern governs unprompted volume (A5). Self-mute must be safe against injection or an attacker silences Baumy. | high |
| 9 | **Map each fatigue mechanism to the correct Inngest primitive** (they are NOT interchangeable): per-chat 1 msg/s → `concurrency: [{ key: chat_id, limit: 1 }]`; group 20/min → `throttle: { key: chat_id, limit: 20, period: "60s", burst: 3 }`; **daily cap + min-gap → an application-level DB ledger** (`notify_outbox`), never `rateLimit` (lossy drop) and never `throttle` (builds a stale backlog draining forever). | throttle *queues+delays* (no loss); rateLimit *drops*; only a DB ledger applies a durable per-local-day cap while redirecting overflow to the digest instead of losing it. | high |
| 10 | **Destination pinned to `BAUMY_HOUSE_CHAT_ID`** (env constant, validated at boot vs the stored active group). Any `chat_id` present on a candidate is **ignored**. | Exfiltration defense: an injected fact must never redirect a ping to an attacker-controlled chat. Reinforces the single-destination model of A3. | high |
| 11 | **Bounded plain-text templates.** Per-`reason_code` length-capped templates filled from the scorer's `oneLineSummary`/`suggestedAction`; **no `parse_mode`**, `disable_web_page_preview=true`, `disable_notification=true` for silent/quiet-hours delivery. | Untrusted-derived text can carry markdown/entities that break MarkdownV2/HTML parsing or smuggle links; plain text neutralizes it. | high |
| 12 | **Roster = group membership, no curated allowlist.** Authorization to influence proactive volume = being a member of `BAUMY_HOUSE_CHAT_ID` (auto-discovered, per B10); owner tier for privileged config; trusted housemates for safe-direction self-config. | Removes the "authoritative allowlist" ambiguity; trust boundary is the house group itself (B10). | high |

## Concrete design

### Tables
- **`notify_prefs`** (house-group scope; single active row for `BAUMY_HOUSE_CHAT_ID` in v1, `group_id`-scoped for future multi-group) — `telegram_chat_id`, `tz` (IANA, default `Europe/Berlin`), `quiet_start_min`/`quiet_end_min`, `daily_cap` (default 5), `min_gap_sec` (default ~90 min), `min_confidence` (default 0.75), `proactivity_enabled`. **No per-member DM notification prefs** — house content is group-only (A3). (A `dm_chat_id` is captured elsewhere *only* for dashboard-magic-link members; it is NOT a notification target here.)
- **`notify_outbox`** — queue + gate audit ledger and the durable per-day cap ledger. `target_scope` (always the house group in v1), `kind` (`reminder|digest|nudge|reply|event`), `reason_code`, `dedupe_key`, `status ENUM('queued','sent','suppressed','failed')`, `suppressed_reason`, `sent_at`.
- **`notify_mute`** — per-scope / per-topic mutes and snoozes (`muted_until`, `muted_categories`); the write target of safe-direction self-config (decision 8).

> `scheduled_tasks` (the digest/recurring-query engine) is defined in **`scheduled-tasks.md`**; the digest is a seeded instance and is not re-declared here.

### The gate (pure, unit-tested in `packages/core`)
`gateNotification(candidate, prefs, now, sentTodayCount, lastSentAt) -> { decision: 'send'|'defer'|'suppress'|'digest', sendAfter?, silent?, reason? }`, an **ordered, all-must-pass, fail-closed** chain — cheap deterministic rejects first (reason_code on closed allowlist → destination pinned to house group → global kill switch → quiet hours → mute/snooze → daily cap → per-topic cooldown), then the fuzzy composite-score check last (minimizes classifier spend and injection surface).

- **P0 (reminder due) and P1 (reply) bypass** cap/confidence/mute; only a per-reminder snooze can silence a specific P0.
- **Overflow past the daily cap or below the confidence floor → `decision: 'digest'`** (coalesced), never a silent drop.
- There is **no `no_dm_channel` branch and no private→group downgrade logic** — house content has exactly one destination (the group), so the historical "private content leak" failure mode is designed out (A3).

### Dated-event surfacing sweep
- Inngest cron `proactive-dated-sweep` (TZ `Europe/Berlin`, e.g. daily `0 7`): query committed **facts with a future event date** entering the **~7-day horizon** (from the bitemporal memory store — cross-ref `memory-core.md` for the dated-fact/`valid_from` representation and recurrence).
- For each, emit `proactive/candidate.created` with `reason_code` (`event.imminent`, `guest.arriving`, `bill.due`, `supply.restock`, …). These flow into the same notify-gate → most coalesce into the next **digest (P3)**; only high-salience, corroborated items surface as a **conservative nudge (P2)**.
- **Event-anchored reminders** (offset "a week before <dated event>") are armed off the same dated facts by the reminder engine (daily-arm + `sleepUntil`, see `inngest.md`/`llm-pipeline.md`); the sweep is the safety net that also catches events added after a reminder was first considered.
- **Condition-based watches** ("tell us WHEN the landlord replies") are **deferred to v1.1** — a standing per-message subscription, out of v1 scope (A4).

### Inngest wiring
- `notify-gate` (`retries: 2`, `rateLimit: { key: dedupeKey, limit: 1, period: "24h" }` for exact-dup suppression only).
- `telegram-send` (`throttle: { key: chat_id, limit: 20, period: "60s", burst: 3 }`, `concurrency: [{ key: chat_id, limit: 1 }]`, `retries: 3`, honoring `parameters.retry_after` with full jitter on 429). Route **all** send*/editMessage/sendChatAction through this — they share the per-chat counter.
- **Digests via the `scheduled_tasks` engine (`scheduled-tasks.md`), NOT hardcoded crons.** The digest is a seeded built-in `scheduled_tasks` row; the engine registers/reschedules its Inngest cron when the cadence changes. Seeded defaults: mid-week `TZ=Europe/Berlin 0 18 * * 3`, end-of-week `TZ=Europe/Berlin 0 17 * * 0`, optional daily `0 8` fatigue-sink. Cadence is settable on the fly (A4b). Inngest cron is allowed (Vercel cron is not — see `inngest.md`).
- `proactive-dated-sweep` cron (above) for event surfacing.
- **Reminder delivery (P0)** is the daily-arm + short-`sleepUntil` engine specified in `inngest.md` (D5) / `llm-pipeline.md`; it emits into `telegram-send` to the fixed house group and is **never gated** (E22). Not re-specified here.
- Classifier/scorer: Vercel AI SDK `generateObject` + Zod verdict schema (validated, no free-form outbound text — itself a defense).

### Facts to lock at build time (verify — see `provider-verify.md`)
- Telegram limits: **20 msg/min per group**, **~1 msg/s per chat**, **~30 msg/s global**; `429` returns `parameters.retry_after`. Current **Bot API 10.1 (2026-06-11)**. `disable_notification: true` for silent delivery. `adaptive_retry` is SEO-spam fiction — honor only `parameters.retry_after`.
- **GPT-5-nano ≈ $0.05/$0.40 per 1M** (verify); a per-candidate score (~1.5k in + 200 out) ≈ **$0.0002** → ~$0.47/mo at 100/day. **Haiku 4.5 $1/$5** (verify) for corroboration/summaries. Spend counts against the shared **~$0.50/day** cap (C); **reminder delivery is never gated by the cap**.

## Gotchas

- **`throttle` ≠ `rateLimit` ≠ `debounce`.** `rateLimit` silently **drops** overflow (lose info) — use only for exact-dup dedupe. `throttle` for a min-interval builds a **stale backlog** that drains 1/period forever. Per-day cap + min-gap MUST be an application-level DB ledger.
- **Daily cap resets at LOCAL-TZ midnight**, not UTC: `sent_at >= date_trunc('day', now() AT TIME ZONE tz)` with `tz = 'Europe/Berlin'`. A UTC boundary shifts the reset and leaks extra pings.
- **`Europe/Berlin` is DST-shifting (CET/CEST).** Digest/sweep crons and quiet-hours are the exact case the tz-aware helper must pass across the March/October transitions — a naive UTC offset drifts an hour twice a year (B9).
- **Quiet-hours window usually crosses midnight** (22:00–08:00): in-quiet test is `nowMin >= quiet_start OR nowMin < quiet_end`; centralize the tz-aware compute in one helper and unit-test both cross-midnight and same-day.
- **Digest cadence is config, not code.** Changing it edits the `scheduled_tasks` row and reschedules the cron (via the engine in `scheduled-tasks.md`) — do NOT hardcode the schedule in the digest function, or the on-the-fly setting silently no-ops.
- **Per-chat/minute counters include `editMessageText`, `sendChatAction` ('typing'), and media**, not just `sendMessage`. Route everything through the throttled function.
- **The in-memory token bucket (camp-404/ops-board) resets on cold start** and isn't shared across invocations — it can't enforce a durable daily cap. Use it only for cheap per-invocation checks; the DB ledger is the durable enforcer.
- **Injection defense lives in the gate, not the model** — never let the classifier's proposed priority/target raise a group-originated candidate above P2, aim it anywhere but the house group, or flip a config flag. Self-config writes come only through the write-gate on verified member identity + surface, never from message text.

## Tasks (ordered)

1. **DDL: `notify_prefs` (house-group scope), `notify_outbox`, `notify_mute`** (Drizzle, `baumy_` clean-room names; `group_id`-scoped for future multi-group). *(0.5d)*
2. **Extend Inngest typed event map** — `notify/candidate.raised`, `notify/send.ready`, `proactive/candidate.created`, `proactive/sweep.requested`. *(0.25d)* — dep: 1
3. **`gateNotification` pure function + exhaustive unit tests** (fail-closed ordered chain; destination pinned to house group; P0/P1 exemptions; overflow→digest; Berlin DST quiet-hours + local-midnight cap reset). *(1.5d)* — dep: 1,2
4. **Internal rule evaluators** (one per `reason_code`) reading committed facts/signals — never raw messages. *(1.5d)* — dep: 1
5. **Confidence scorer** via AI SDK `generateObject` + composite score + two-model corroboration (nano → Haiku) for sensitive classes. *(1d)* — dep: 2
6. **`telegram-send` throttled function + 429 backoff**; route all send methods + inline replies' sends through it (shared per-chat counter). *(0.75d)* — dep: 3
7. **Dated-event surfacing sweep** (`proactive-dated-sweep` cron over future-dated facts → `proactive/candidate.created`; ~7-day horizon). *(0.75d)* — dep: 2,4 · cross-ref `memory-core.md` (dated-fact shape)
8. **Digest as a seeded `scheduled_tasks` instance** — register the built-in digest task with default mid/end-week cadence, summarizing coalesced `notify_outbox` items **from DB**; cadence editable via the scheduled-tasks surface. *(0.75d)* — dep: 6 · **cross-ref `scheduled-tasks.md` (engine)**
9. **Self-configurable nudge/proactivity config surface** — dashboard + NL self-config through the write-gate: owner full control; house-group members safe-direction (only ever *reduce* Baumy's activity: mute topic, lower cap, pause); every change audited + reversible. *(1d)* — dep: 1

## Risks & mitigations

| Severity | Risk | Mitigation |
|----------|------|-----------|
| High | **Over-notifying erodes trust** → house mutes Baumy entirely. | Conservative caps (≤5/day group), silent-by-default, per-reason cooldowns, actionability requirement, coalesce into digests; self-config safe-direction lets housemates dial it down without a deploy. |
| High | **Injection** crafts an urgent/spammy nudge, self-mutes Baumy, or accuses a housemate. | Two-boundary, no text→send path; closed `reason_code` allowlist; group candidates clamped to P2; model score capped + corroboration for sensitive classes; config writes only via the write-gate on verified identity, never message text. |
| High | **Over-suppression eats a user-set reminder** (cap/mute swallows P0). | P0/P1 hard-exempt from caps/confidence/global mute; reminder delivery never gated (E22); only a per-reminder snooze can silence a specific one. |
| High | **Exfiltration** — injected fact redirects a ping off-house. | Destination = `BAUMY_HOUSE_CHAT_ID` env constant; any candidate `chat_id` ignored; single house-group destination (A3) removes DM-targeting attack surface entirely. |
| Medium | **Notification storm** from retries / redelivered `update_id` / double-classification. | `dedupe_key` UNIQUE + `rateLimit{key:dedupeKey,1,24h}` + `update_id` dedupe + per-chat throttle (belt-and-suspenders). |
| Medium | **Dated-event sweep misses or double-surfaces** an event (recurrence/DST edge). | Idempotent `dedupe_key` per (fact, horizon-window); surface into the coalesced digest by default (nudge only on high salience); Berlin-tz horizon math unit-tested; event-anchored reminders re-armed daily as the safety net. |
| Medium | **On-the-fly cadence change desyncs the cron** from the `scheduled_tasks` row. | Cadence lives only in the `scheduled_tasks` engine (`scheduled-tasks.md`); the digest function reads it, never hardcodes it; engine reschedules the Inngest cron on edit. |
| Medium | **Thresholds mis-tuned** → still fatiguing, or Baumy feels mute. | Log every decision + `suppressed_reason` in `notify_outbox`; start conservative and tune from the audit trail. |

## Open questions (for the owner)

1. **Quiet-hours window** — single shared tz is resolved to **`Europe/Berlin`** (B9); the window itself (default 22:00–08:00) is still a placeholder — confirm the real hours.
2. **Which `reason_codes` ship in v1?** Proposed minimal, guest/event/supplies-focused (per batch #4, not bills-centric): `guest.arriving`, `event.imminent`, `supply.restock`, `commitment.followup`, `conflict.detected`. `question.unanswered` is handled by auto-answer in `llm-pipeline.md`, not as a nudge.
3. **Starting caps/thresholds** — group ≤5/day, `min_confidence` 0.75, min-gap 60–90 min: acceptable, or stricter? *(Log classifier scores for a week and tune — batch #6.)*
4. **Digest defaults** — seeded mid-week + end-of-week (settable on the fly via `scheduled_tasks`); add a daily 08:00 fatigue-sink by default, or opt-in? Max items before overflow rolls off?
5. **Dated-fact horizon** — is ~7 days the right advance-notice window for event surfacing, uniformly, or per-category (e.g. longer for guest arrivals, shorter for supplies)?
6. **Subscribe to `message_reaction` updates** (extra `allowed_updates` + webhook noise) for engagement-based back-off, or replies-only for v1? *(Deferred per batch #8; confirm.)*
7. **Verify 2026 pricing** for GPT-5-nano + Haiku 4.5 before pinning the scorer/corroborator (see `provider-verify.md`).
