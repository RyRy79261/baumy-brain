# Chat-handling audit — reproduction tests

Characterisation tests from the 2026-09-26 audit of how Baumy reads, remembers and
replies to the house chat. Each test asserts **today's (buggy) behaviour** — what the
reply model is actually given, which reaction fires, what lands in the DB — with the
LLM and Telegram mocked, so the suite stays offline.

When you fix a finding, the matching test here should start failing: flip it to assert
the correct behaviour (and move it next to the code it covers) or delete it.

Folders map to audit areas: `reply/` (conversation understanding), `time/`, `memory/`
(fact graph), `intake/`, `actions/` (reminders, list, forget), `spec-gap/`.
The findings, severities and fix directions are on the shared audit page (and `findings.json`).

Fixed and removed so far: phase 0 (intake, directedness, reactions, retries — A1, K1, K4, C7–C9,
C12, I2, I7–I10, A12) and phase 1 (the turn, triage in context, the response planner and the
rebuilt reply — C1–C4, C6, C10, C11, C13–C15, K2, K3, K5, A2, A3, A9, A10, I3, T1, and the first
half of I6), and phase 2 (the 48h conversation window — the rest of C5: recent turns, Baumy's own
replies included, reach triage and the reply). Their correct behaviour is pinned next to the code
(`lib/turn/__tests__`, `lib/ai/__tests__/reply.test.ts`, `lib/inngest/functions/__tests__/ingest-turn.test.ts`)
and in `scenarios/` (phase 2: `lib/turn/__tests__/window.test.ts`, `scenarios/window.scenario.test.ts`).

Still OPEN and kept here: I6's second half — the volunteered-reply floor (`replyAllowed`) still
compares the triage confidence (certainty of the INTENT) against "how useful would a reply be"
thresholds (`intake/webhook-and-units.test.ts`). No phase of chat-understanding-v2 schedules it yet;
the spec §3 notes it as a known deviation.
