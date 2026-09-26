# Chat-handling audit — reproduction tests

Characterisation tests from the 2026-09-26 audit of how Baumy reads, remembers and
replies to the house chat. Each test asserts **today's (buggy) behaviour** — what the
reply model is actually given, which reaction fires, what lands in the DB — with the
LLM and Telegram mocked, so the suite stays offline.

When you fix a finding, the matching test here should start failing: flip it to assert
the correct behaviour (and move it next to the code it covers) or delete it.

Folders map to audit areas: `reply/` (conversation understanding), `time/`, `memory/`
(fact graph), `intake/`, `actions/` (reminders, list, forget), `spec-gap/`, `critic/`.
The findings, severities and fix directions are on the shared audit page.
