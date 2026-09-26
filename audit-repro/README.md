# Chat-handling audit — reproduction tests

Characterisation tests from the 2026-09-26 audit of how Baumy reads, remembers and
replies to the house chat. Each test asserts **today's (buggy) behaviour** — what the
reply model is actually given, which reaction fires, what lands in the DB — with the
LLM and Telegram mocked, so the suite stays offline.

When you fix a finding, the matching test here should start failing: flip it to assert
the correct behaviour (and move it next to the code it covers) or delete it.

Folders map to audit areas: `reply/` (conversation understanding), `memory/`
(fact graph), `intake/`, `actions/` (reminders, list, forget), `spec-gap/`.
The findings, severities and fix directions are on the shared audit page (and `findings.json`).

Fixed and removed so far: phase 0 (intake, directedness, reactions, retries — A1, K1, K4, C7–C9,
C12, I2, I7–I10, A12) and phase 1 (the turn, triage in context, the response planner and the
rebuilt reply — C1–C4, C6, C10, C11, C13–C15, K2, K3, K5, A2, A3, A9, A10, I3, T1, and the first
half of I6), and phase 2 (the 48h conversation window — the rest of C5: recent turns, Baumy's own
replies included, reach triage and the reply), and phase 3 (the time model — T2–T13, A4, A6: the
`time/` and `time-skeptic/` repros are gone, `actions/reminders.test.ts` keeps only the open A5 case, and
the F9 consolidation repro moved to `memory/consolidation-attribution.test.ts`; see
`lib/core/__tests__/when.test.ts`, `lib/reminders/__tests__/{digest,recurrence}.test.ts`,
`scenarios/time.scenario.test.ts`), and phase 4 (the fact model — F1–F16: `memory/graph.test.ts`,
`memory/consolidation-attribution.test.ts`, `reply/speaker.test.ts` and the intake consolidation case are
gone; see `lib/memory/__tests__/{fact-model,predicates,lookup,hygiene,retrieve-arms}.test.ts` and
`scenarios/facts.scenario.test.ts`). Their correct behaviour is pinned next to the code
(`lib/turn/__tests__`, `lib/ai/__tests__/reply.test.ts`, `lib/inngest/functions/__tests__/ingest-turn.test.ts`)
and in `scenarios/` (phase 2: `lib/turn/__tests__/window.test.ts`, `scenarios/window.scenario.test.ts`).

And phase 5 (intake & actions — I1, I4, I5/D4, A4 enforced, A5/D2, A7, A8, A11, K6): `intake/ingest-intake.test.ts`,
`reply/conversation.test.ts`, `spec-gap/chat-routing.test.ts`, `actions/*` and the webhook-mapping half of
`intake/webhook-and-units.test.ts` are gone; see `lib/inngest/functions/__tests__/ingest-turn.test.ts` (phase 5
block), `lib/memory/__tests__/forget.test.ts`, `lib/reminders/__tests__/destination.test.ts`,
`lib/identity/__tests__/verify.test.ts`, `lib/telegram/__tests__/content.test.ts`,
`app/api/telegram/webhook/__tests__/webhook.test.ts` and `scenarios/intake-actions.scenario.test.ts`.

Still OPEN and kept here: I6's second half — the volunteered-reply floor (`replyAllowed`) still
compares the triage confidence (certainty of the INTENT) against "how useful would a reply be"
thresholds (`intake/webhook-and-units.test.ts`). It needs a product signal for "how useful would a
volunteered reply be"; the spec (§3, and §8 "as implemented") notes it as a known deviation.
