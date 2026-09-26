# Chat-handling audit — reproduction tests (all closed)

Characterisation tests from the 2026-09-26 audit of how Baumy reads, remembers and replies to the house
chat. Each test asserted **the buggy behaviour of the day** — what the reply model was actually given,
which reaction fired, what landed in the DB — with the LLM and Telegram mocked, so the suite stayed
offline. `findings.json` is the record: 72 findings with mechanism, scenario, files and fix direction.

The rule was: when you fix a finding, delete its repro here and pin the CORRECT behaviour next to the
code it covers or as a scenario (`scenarios/`). The fixes landed in the phases of
`docs/spec/chat-understanding-v2.md` (0: intake, directedness, reactions, retries · 1: the turn, triage
in context, the planner, the rebuilt reply · 2: the 48h conversation window · 3: the time model · 4:
the fact model · 5: intake & actions) plus a final verification pass.

**No reproduction test remains — no assertion here asserts a bug any more.** The last one (I6's second
half: the volunteered-reply floor compared the triage *confidence in the intent* against "how useful
would a reply be" thresholds) was deleted in the verification pass, when triage gained a defined
`replyValue` that the floor now reads. This folder keeps `findings.json` and this map.

## Per-finding status (verified 2026-09-26 against the code and the passing suite)

Paths are under `lib/**/__tests__/` unless given in full; `scenarios/x` is `scenarios/x.scenario.test.ts`.
A "residual" is a narrower edge the finding's fix direction did not require, recorded in the spec.

| Ref | Status | Proven by |
|---|---|---|
| C1 | fixed | `lib/turn/__tests__/grounding.test.ts` (C1: excludes this turn's note + facts); `ingest-turn.test.ts` "the Chloe bug"; `scenarios/chloe` |
| C2 | fixed | `lib/ai/__tests__/reply.test.ts` (CONTEXT FROM/WHERE/NOW, "MESSAGE from <name>"); `scenarios/chloe` |
| C3 | fixed | `plan.test.ts` statements → MODE ack; `reply.test.ts` (no QUESTION framing); `scenarios/chloe` |
| C4 | fixed | `plan.test.ts` (C3/C4/K3); `ingest-turn.test.ts` undirected statement → ✍ only; `scenarios/routing` |
| C5 | fixed | `reply.test.ts` + `classify.test.ts` (REPLIED TO line, RECENT CHAT); `lib/turn/__tests__/window.test.ts`; `scenarios/window` |
| C6 | fixed | `plan.test.ts` ask-housemates / console rows; `directed.test.ts`; `scenarios/routing`, `scenarios/voice` |
| C7 | fixed | `prefilter.test.ts`; `ingest-intake.test.ts` C7; `scenarios/routing` "yes" to Baumy |
| C8 | fixed | `directed.test.ts` repliesToBaumy; `client.test.ts` getBotId; `ingest-intake.test.ts` C8/C9 |
| C9 | fixed | webhook `isTopicRoot`; `directed.test.ts`, `harness.test.ts` topic root not directed (the live update shape is modelled in the harness) |
| C10 | fixed | `directed.test.ts` vocative only; `scenarios/voice` talking ABOUT Baumy |
| C11 | fixed | `scenarios/voice` reply threading; `ingest-turn.test.ts` / `ingest.test.ts` reply_parameters |
| C12 | fixed | `directed.test.ts` stripBotMention; `ingest-intake.test.ts` C12; `scenarios/routing` |
| C13 | fixed | `classify.test.ts` "tier is quick | deep only (C13)" |
| C14 | fixed | `reply.test.ts` persona: noted / offer to remember / flag old or past |
| C15 | fixed | `grounding.test.ts` C15 (decrypt only for a direct ask in MODE answer); `reply.test.ts` C15 ×3; `scenarios/voice` |
| K1 | fixed | `lib/turn/__tests__/emoji.test.ts` (Bot API union); `ingest-intake.test.ts` K1 |
| K2 | fixed | `ingest-turn.test.ts` K2; `scenarios/voice` re-addressing a statement |
| K3 | fixed | `ingest-turn.test.ts` K3 DM ack; `scenarios/routing` DM statement ack |
| K4 | fixed | `plan.test.ts` list rows; `ingest-intake.test.ts` K4; `lib/lists/__tests__/store.test.ts` article/plural check-off; `scenarios/lists` |
| K5 | fixed | `plan.test.ts` degraded triage; `ingest-turn.test.ts` K5; `classify.test.ts` |
| K6 | fixed | `lib/identity/__tests__/verify.test.ts`; `ingest-turn.test.ts` K6; `scenarios/intake-actions` new housemate. Residual: a departed member who rejoins is reactivated by a chat_member update or their next DM, not by group speech (an owner's removal must not be undone by text) |
| T1 | fixed | `reply.test.ts` T1 (kind · who · said <date> · event); `grounding.test.ts`; `scenarios/chloe` |
| T2 | fixed | `facts.test.ts` T2; `reports.test.ts`, `reflect.test.ts`; `db/__tests__/e2e.test.ts` migration 0020; `scenarios/time` |
| T3 | fixed | `extract.test.ts` T3 (MESSAGE SENT + calendar); `ingest-turn.test.ts` T3/T8 |
| T4 | fixed | `when.test.ts` T4; `ingest-turn.test.ts` T4; `scenarios/time` friday around 10pm |
| T5 | fixed | `reports.test.ts` weeklyReport T5; `scenarios/time` /weekly |
| T6 | fixed | `facts.test.ts` T6 new occurrence / reschedule |
| T7 | fixed | `when.test.ts` T7 |
| T8 | fixed | `when.test.ts` T8; `ingest-turn.test.ts`; `scenarios/time` the 9th |
| T9 | fixed | `when.test.ts` T9; `scenarios/time` remind me at 5 |
| T10 | fixed | `when.test.ts` T10 (dayparts, late-night tomorrow, durations, end of month); `parse.test.ts` |
| T11 | fixed | `nudge.test.ts`, `surfacing.test.ts`, `digest.test.ts` T11; `scenarios/time` heads-up at delivery |
| T12 | fixed | `lib/reminders/__tests__/parse.test.ts` T12 |
| T13 | fixed | `lib/core/__tests__/clock.test.ts` — no wall-clock read in lib/** outside the clock seam (auth excepted, on purpose) |
| F1 | fixed | `fact-model.test.ts` entity resolution; `scenarios/facts` chloe's bike |
| F2 | fixed | `fact-model.test.ts` cardinality; `predicates.test.ts`; `scenarios/facts` two guests |
| F3 | fixed | `fact-model.test.ts`, `predicates.test.ts`; `db/__tests__/e2e.test.ts` 0022; `scenarios/facts` synonym correction |
| F4 | fixed | `lookup.test.ts`; `fact-model.test.ts` lookup; `graph.test.ts` seeds (F4) |
| F5 | fixed | `fact-model.test.ts` trust gate; `plan.test.ts` statement-conflict; `scenarios/facts` ×2 |
| F6 | fixed | `fact-model.test.ts` the speaker is ONE node (F6) |
| F7 | fixed | `fact-model.test.ts`, `lookup.test.ts`; `scenarios/facts` who's in the cave |
| F8 | fixed | `facts.test.ts` lineage is a real relation only; soft-forgotten parent never returns |
| F9 | fixed | `fact-model.test.ts` consolidation by author; `db/__tests__/e2e.test.ts` |
| F10 | fixed | `graph.test.ts` timeline newest first (F10) |
| F11 | fixed | `reflect.test.ts` F11; `reply.test.ts` profile kind; `fact-model.test.ts` profile ranks last |
| F12 | fixed | `hygiene.test.ts`; `dedupe.test.ts`; `functions-config.test.ts` sweep registered. The v2 design (spec §7) replaces the old spec's LLM write-time ADD/UPDATE/DELETE with the predicate vocabulary + cardinality, and access-reinforced decay with `valid_to` expiry + recency ranking |
| F13 | fixed | `retrieve-arms.test.ts` author arm; `lookup.test.ts`, `fact-model.test.ts` askedAuthor |
| F14 | fixed | `retrieve-arms.test.ts` OR lexical arm |
| F15 | fixed | `fact-model.test.ts` tagging by resolved id (F15) |
| F16 | fixed | `functions-config.test.ts` per-chat concurrency key |
| I1 | fixed | `webhook.test.ts` isEdit; `ingest-turn.test.ts` I1; `plan.test.ts` edits never speak; `window.test.ts`; `scenarios/intake-actions`, `scenarios/reminders`. Residual (spec §8): an edit that deletes a correction does not resurrect the superseded fact; a list op is not undone |
| I2 | fixed | `errors.test.ts`; `extract.test.ts`, `reply.test.ts`, `websearch.test.ts`, `reports.test.ts` transient rethrow; `ingest-intake.test.ts` I2; `scenarios/intake` |
| I3 | fixed | `decide.test.ts` shouldCapture; `ingest-turn.test.ts` I3; `grounding.test.ts` old question notes; `scenarios/voice` |
| I4 | fixed | `content.test.ts`; `webhook.test.ts` caption; `ingest-turn.test.ts` media drop; `scenarios/intake-actions`. Per spec §8, captionless media (voice, location, contact) is ignored explicitly — never fetched or interpreted |
| I5 | fixed | `decide.test.ts`; `scenarios/intake` + `scenarios/intake-actions` forwarded recall, labelled (D4) |
| I6 | fixed | `classify.test.ts` (confidence + replyValue defined); `decide.test.ts` reminders not confidence-gated; `plan.test.ts` floor reads replyValue; `scenarios/routing` I6 |
| I7 | fixed | `ingest-intake.test.ts` I7 |
| I8 | fixed | `core.test.ts`; `ingest-intake.test.ts` I8; `ingest-turn.test.ts`; `harness.test.ts` anonymousAdmin |
| I9 | fixed | `core.test.ts` isSecretQuestion; `ingest-intake.test.ts` I9 |
| I10 | fixed | `lib/__tests__/policy.test.ts` mentionsTopic whole words |
| A1 | fixed | `callback.test.ts` stored house scope; `store.test.ts` (confirm); `scenarios/forget` DM forget |
| A2 | fixed | `plan.test.ts` reminders; `ingest-turn.test.ts`; `draft.test.ts`; `scenarios/reminders` clarify + follow-through |
| A3 | fixed | `reply.test.ts` A3 THIS TURN; `ingest-turn.test.ts`; `scenarios/reminders` confirm mode |
| A4 | fixed | `ingest-turn.test.ts` A4; `actions.test.ts`; `scenarios/time`, `scenarios/intake-actions` |
| A5 | fixed | `destination.test.ts`; `ingest-turn.test.ts` A5/D2; `scenarios/intake-actions` DM reminder |
| A6 | fixed | `recurrence.test.ts`; `digest.test.ts`; `reminder-extract.test.ts`; `ingest-turn.test.ts` A6; `scenarios/time` every friday |
| A7 | fixed | `forget.test.ts` A7; `db/__tests__/e2e.test.ts`; `scenarios/intake-actions` soft forget |
| A8 | fixed | `forget.test.ts` A8; `scenarios/intake-actions` |
| A9 | fixed | `decide.test.ts` A9; `plan.test.ts`; `ingest-turn.test.ts` A9; `scenarios/reminders` undirected |
| A10 | fixed | `plan.test.ts` A10; `ingest-turn.test.ts` A10; `scenarios/lists` |
| A11 | fixed | `scenarios/intake-actions` list op not a note; `scenarios/lists` A11 negative case |
| A12 | fixed | `ingest-intake.test.ts` A12 |
