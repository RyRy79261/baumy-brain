# Scenarios

Multi-turn house conversations run through the **real** Baumy pipeline, as described in
`docs/spec/chat-understanding-v2.md` §9. Each scenario is people, a start time, fixtures and a list of
steps. It runs on the sandbox harness (`lib/sandbox/harness.ts`), which provides PGlite, the real
ingest, real crons driven at simulated times, and captured Telegram sends. Only two things are
swapped out: the language model and the embedder.

```bash
pnpm test:scenarios          # offline: scripted model, deterministic, runs in CI (also part of `pnpm test`)
pnpm test:scenarios:live     # live: real Anthropic models + Voyage embeddings + an LLM judge
SCENARIOS_SHOW_GAPS=1 pnpm test:scenarios   # run known gaps as ordinary tests to see where each fails
```

## Offline mode (default)

- **Model.** `fake-model.ts` installs a scripted model for every role through the test-only
  `setModelOverride` seam in `lib/ai/registry.ts`.
  - It works out which call it is serving from the system prompt, by matching it against the
    constants in `lib/ai/prompts.ts`. The roles are triage, extract, reminder, list, forget, cancel-reminder, reply,
    reply-text, voice, reflect, headsup, expand, rerank, websearch, weekly, guests, issue,
    deliberate and dedupe (the nightly hygiene sweep's entity-merge proposal; default: no merges).
  - It answers from the scenario's `fixtures`, which are functions of the message text. Any role
    without a fixture gets a safe default.
  - It records every call as `{ role, tier, system, prompt, text, output }`.
  - A system prompt it doesn't recognise throws. When you add a prompt, register it in `ROLE_PROMPTS`.
    `scenarios/__tests__/fake-model.test.ts` enforces this.
- **Embeddings.** Embeddings go through `setEmbedOverride` (`lib/ai/embed.ts`) to the deterministic
  `embedSync`, so Voyage is never called.
- **Database.** The scenario's PGlite database is injected with `__setDbOverride` (`db/client.ts`).
- **Inngest.** `inngest.send` is captured into `run.events` and never sent.
- **Network.** `fetch` is trapped, so any code path that still reaches for the network fails the
  scenario loudly.

## Live mode

Set `SCENARIOS_LIVE=1` (the `test:scenarios:live` script does this) and provide
`ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`. Without both keys, every scenario is skipped cleanly.

- The same steps run against the real models. The recorder still wraps them, so `expectPrompt`
  assertions hold.
- Each `expectWords({ judge })` rubric is graded by an Anthropic LLM judge (`judge.ts`).
- Scenarios marked `offlineOnly` (e.g. a scripted outage) or `knownGap` are skipped.
- Live runs cost money and are not deterministic, so run them by hand. They are not part of CI.
  Run them after any prompt or schema change (triage, extractors, reply): the offline suite proves the
  pipeline does the right thing with a given model output; only live mode shows the real model produces
  it. A judge failure prints the rubric, the words and the judge's reason.
- `pnpm test:scenarios:live scenarios/time.scenario.test.ts` runs one file; `-t '<name>'` one scenario.

## What is covered

Every phase of `docs/spec/chat-understanding-v2.md` ships its user-visible behaviour as scenarios here,
each with a judge rubric wherever Baumy speaks. **No known gaps remain** — every phase-tagged gap was
flipped when its phase landed.

| File | Covers |
|---|---|
| `charli.scenario.test.ts` | the motivating bug: a statement is acked (not quoted back), and grounds a later question, attributed and dated (C1–C4, T1) |
| `voice.scenario.test.ts` | directedness by name (C10), ask-Baumy topic addressee (C6), re-addressed statements (K2), secrets in acks (C15), reply threading (C11), questions not stored (I3) |
| `routing.scenario.test.ts` | the planner table: ✍ vs words vs silence, housemates' questions, DM acks (K3), "yes" to Baumy (C7), reply-to context as data (C5), the volunteered-reply floor reading `replyValue` (I6) |
| `window.scenario.test.ts` | the 48h conversation window: follow-ups, secrets never persisted, 48h purge, DM isolation, forwards labelled (C5, §5) |
| `time.scenario.test.ts` | the time model: expiry (T2), bare hours (T9), "friday around 10pm" (T4), recurrence (A6), "the 9th" (T8), heads-ups written at delivery (T11), /weekly (T5) |
| `facts.scenario.test.ts` | the fact model: multi-valued predicates (F2), synonyms (F3), possessives (F1), object-side lookup (F7), the trust gate + conflicts (F5) |
| `reminders.scenario.test.ts` | confirm / clarify modes and the clarify follow-through (A2, A3), undirected reminders (A9), edits (I1), pause |
| `lists.scenario.test.ts` | list acks from the store outcome, article/plural-tolerant check-off (K4), list op + question (A10), list ops not notes (A11) |
| `kitchen-api.scenario.test.ts` | the kitchen kiosk API and a housemate's DM read and write ONE list, including under the `BAUMY_HOUSE_CHAT_ID` pin |
| `cancel-reminders.scenario.test.ts` | cancelling from chat through the confirm-tap wall: a weekly series stops for good, a creator cancels their DM reminder, another member cannot see it, nothing-matched lists what is scheduled |
| `forget.scenario.test.ts` | propose → card → tap in the stored house scope (A1), window clearing |
| `intake.scenario.test.ts` / `intake-actions.scenario.test.ts` | forwarded content (I5/D4), captions (I4), edits (I1), personal/DM reminders (A4, A5/D2), soft forget (A7, A8), new housemates (K6), a transient model error failing the ingest (I2) |
| `deep.scenario.test.ts` | the deep tier: expansion + re-rank + a graph hop into MEMORY |

## Writing a scenario

Add a `*.scenario.test.ts` file under `scenarios/`:

```ts
import { scenario, say, advance, expectReaction, expectWords, expectNoWords, expectPrompt, expectFact } from './dsl'
import { memoryLines } from './fake-model'
import { statement, question, chatter, fact } from './shapes'
import { HOUSE } from './house'

scenario('an undirected statement is noted', {
  people: HOUSE,                      // Charli (owner), Marco, Ryan
  startAt: '2026-09-24 19:00',        // local time in `tz` (default Europe/Berlin)
  consoleTopic: 77,                   // optional ask-Baumy topic; say(..., { topic: 'console' })
  fixtures: {
    triage: (t) => (/bins/.test(t) ? statement() : chatter()),
    extract: () => [fact({ subject: 'bins', predicate: 'collection_day', object: 'thursday' })],
  },
  steps: [
    say('Marco', 'bins go out on thursdays now'),
    expectReaction('✍'),
    expectNoWords(),
    expectFact({ subject: /bins/, by: 'Marco' }),
  ],
})
```

### Steps

These are the steps in `dsl.ts`. Expectations check the most recent turn.

| Step | What it does |
|---|---|
| `say(person, text, opts)` | A message. `opts` can include `dm`, `topic: 'console' \| threadId`, `replyToBaumy: true \| text`, `replyTo`, `mention` (exact @username), `forwarded`, `anonymousAdmin`, `edit` (an edited_message: same message_id as the speaker's previous message), `media` (the text is that media's caption — mapped exactly as the webhook maps it) and `throws` (ingest must throw). |
| `tap(person, 'confirm' \| 'cancel')` | Taps the latest confirm card's button as `person` — the real callback handler (the confirm-tap wall), in the chat the card was sent to. |
| `advance({ days, hours, minutes })` | Moves the clock. Each cron fires at its own instant, and whatever it posts becomes the turn. |
| `expectReaction(emoji \| null \| { not })` | The reaction left on the message once the turn settled. A 👀 that was later cleared counts as none. |
| `expectWords({ contains, notContains, judge })` | Words in the originating chat. `judge` is checked only in live mode. |
| `expectNoWords()` / `expectSilent()` | No words / nothing visible at all (not even a 👀 flash). |
| `expectPrompt(role, regex \| substring \| predicate, 'model was told …')` | What the latest `role` call was given. `memoryLines(prompt)` and `promptSection(prompt, 'MODE')` help here. |
| `expectNoPrompt(role, why)` | That role was never called on this turn. |
| `expectFact({ subject, predicate, object, by, current, trust, count })` | Facts in the house scope (`trust` = the stored tier). |
| `expectReminder({ content, at: 'yyyy-MM-dd HH:mm', status, count })` | Reminders in the house scope. |
| `expectDb(async (db, run) => …, why)` / `check(why, fn)` | Escape hatches. |

### Fixtures and the one adapter

Write fixtures in the **spec's** shapes, using `verdict()`/`statement()`/`question()`/... for triage
(spec §2), and `fact()` and `reminder()` for the extractors. `shapes.ts` is the only place that
converts them to the schemas the code validates today.

- When a phase changes a schema, update `shapes.ts`. No scenario should need to change.
- `verdict()` defaults `confidence` and `replyValue` to 0.9 — a clear, useful question. Set `replyValue`
  low for a rhetorical / pointless unaddressed question (it is what the owner's reply floor reads — I6).
- Since phase 1 the classifier schema IS the spec §2 shape, so the triage adapter is the identity;
  since phase 3 facts and reminders are the spec §6 shapes too. A fact's `when` may be the resolved
  `{ start, end?, allDay }` (local ISO) or just the verbatim phrase (`when: 'this weekend'` — the model
  resolved nothing, so the code's chrono fallback reads it), and `removes: true` marks a value that no
  longer holds (spec §7). A reminder fixture returns one
  `reminder({ content, when, fireAt?, recurrence?, forWhom? })`, an array of them (A6), or null; without
  `fireAt` the fallback reads `when`.
- Explicit reminders fire at their own instant in `advance()` (the production sleepUntil path — job
  `reminder`), before any cron due at the same minute; the digest stays the backstop.
- The scripted reply echoes the MODE when a fixture doesn't script it (`(scripted ack)`), and in
  MODE answer admits a miss when MEMORY is empty — so a scenario can see which mode was used.

A person with `unseen: true` is in the Telegram group (the sandbox's `getChatMember` directory knows
them) but not on Baumy's roster — how a new housemate who never spoke in the group looks (K6).

### Known gaps

There are none today. Sometimes the code doesn't yet do what the spec says. In that case, still write
the scenario, with
`knownGap: { refs: 'C1 C3', phase: 1, failsAt: 4 }` — `failsAt` is the 1-based step it is blocked at.

- It runs as `it.fails`, so it stays green while broken.
- It turns red the moment it starts passing. When that happens, delete the `knownGap` line.
- A known gap must fail **at an expectation, at or after its `failsAt` step**. If the harness itself
  crashes, or an EARLIER step fails (a regression in behaviour that works today), the scenario is
  reported red — neither ever passes as the known gap.
- Use `SCENARIOS_SHOW_GAPS=1` to see the exact step where each gap fails.
