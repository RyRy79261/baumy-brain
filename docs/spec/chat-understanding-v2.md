# Chat understanding v2 — the turn, the planner, time, and the fact model

**Status:** approved design (2026-09-26), implemented in phases 0–5 below.
**Why:** the 2026-09-26 chat-handling audit (72 findings, reproductions in `audit-repro/`) traced
Baumy's "I don't know, Charli said Zuzka's staying" failures to five root causes: (1) no model of the
current *turn* (who is speaking, where, why it is for Baumy, what just happened), (2) memory without
time, (3) an uncontrolled fact vocabulary, (4) intake gaps, (5) action-flow bugs. This spec replaces
the ad-hoc voice logic in `ingest.ts` with explicit, testable seams. Finding refs (C1, T4 …) are the
audit page's.

**Everything in AGENTS.md "Security invariants" still holds unless a section below says otherwise
and AGENTS.md is updated in the same change.** The LLM still proposes; code disposes.

---

## Decisions taken (owner gave free rein; these were the recommended defaults)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Conversation window**: store recent message text for 48h, secret-redacted | `baumy_messages` becomes the window (below). Relaxes "never persist the body" to "never persist a secret, and nothing beyond 48h". |
| D2 | **DM reminders deliver to the creator's DM** | Reminder send allow-list gains "the creator's own DM chat" — code-resolved from the authenticated `member_dm` origin, never LLM. |
| D3 | **Recurring reminders are supported** | `reminders.recurrence` (RRULE-lite) is honoured; delivery schedules the next occurrence. |
| D4 | **Forwarded-by-member content is recallable** | New trust tier `forwarded`: grounds replies *labelled* "forwarded by X", never writes facts, never drives actions, never attributed as X's own words. Bot-origin stays `quarantined` (never grounds). |
| D5 | **"Noted" reaction = ✍** | 🧠 is not a valid Bot API reaction (K1). The planner's reaction set is restricted to Bot-API-valid emoji and checked by a unit test. |

---

## 1. The turn (`lib/turn/context.ts`)

A `TurnContext` is built **deterministically** by ingest before any LLM call and enriched as steps
run. Every field comes from Telegram-authenticated transport data or from our own code — never from
message text.

```ts
interface TurnContext {
  updateId: number; messageId: number; chatId: string          // destination
  houseScope: string                                          // memory scope (houseScopeForOrigin)
  lane: 'house' | 'member_dm'
  sender: { id: number; name: string; firstName: string; role: 'owner' | 'member' }
  trust: Trust                                                 // from origin
  sentAt: Date; tz: string                                     // message time (now() at ingest)
  topic: { threadId: number | null; isConsole: boolean }
  directed: { value: boolean; why: 'mention' | 'reply_to_baumy' | 'console_topic' | 'dm' | 'name' | null }
  replyTo: { author: 'baumy' | string /*name*/ ; text: string | null } | null
  text: string                                                 // normalised: @botname stripped (C12), caption folded in (I4)
  recent: WindowTurn[]                                         // phase 2: last N turns of this chat
  verdict?: ClassifierVerdict
  outcome: TurnOutcome                                         // filled in as steps run
}
interface TurnOutcome {
  captured?: { memoryItemId: string; factIds: string[]; learned: FactSummary[]; rejected: FactSummary[] }
  reminder?: { status: 'set'; fireAt: Date; content: string; recurrence?: string; deliverTo: 'house' | 'dm' }
           | { status: 'needs_time' | 'past' | 'unparsed'; content: string }
  list?: { op: 'add' | 'checkoff' | 'query'; added: string[]; already: string[]; checkedOff: string[]; notFound: string[] }
  forget?: { proposed: boolean }
}
```

**Directedness (C8–C10, K5):** `dm` is always directed. `reply_to_baumy` only when
`reply_to_message.from.id === bot id` (the webhook forwards the replied-to message's author id, its
text, and whether it is the forum topic-root service message — a topic root never counts). `mention`
= exact `@username`. `name` = the short name used as a vocative/at the start ("Baumy, …",
"hey baumy"), not merely mentioned mid-sentence ("Baumy's reminders are annoying" is not directed).

## 2. Triage (`lib/ai/classify.ts`)

The classifier receives a **context header** (lane, directed + why, console topic, replied-to
author/text, and in phase 2 the last few turns) plus the message. Its output:

```ts
{
  intent: 'statement' | 'question' | 'request' | 'reminder' | 'forget' | 'banter' | 'chatter',
  asksBaumy: boolean,     // is a question/request aimed at Baumy (vs at another housemate)?
  worthRemembering: boolean, // durable house info (statements/facts only — never true for a pure question)
  confidence: number,     // DEFINED: confidence in `intent` (I6)
  vibe: '🔥'|'🎉'|'🤯'|'😁'|null,
  tier: 'quick'|'deep',   // 'think' removed (C13)
  webSearch: boolean,
  list: 'add'|'checkoff'|'query'|'none',
}
```
`needsReply`/`respond`/`reaction` are removed — **responding is the planner's decision**, not the
classifier's. The SAFE_VERDICT on a malformed object is `intent:'chatter', worthRemembering:false`
(it no longer captures everything — I3). Transient API errors are **rethrown** (I2) everywhere an
LLM is called; only a malformed object degrades to a safe default. Helper: `lib/ai/errors.ts`
`isMalformedObjectError(err)`.

## 3. The response planner (`lib/turn/plan.ts`) — pure, exhaustively unit-tested

`planResponse(ctx, policy) → Plan`, where
`Plan = { kind: 'none' } | { kind: 'react', emoji } | { kind: 'words', mode, alsoReact? }` and
`mode ∈ 'answer' | 'ack' | 'clarify' | 'confirm' | 'banter'`.

| Situation | Plan |
|---|---|
| paused (house lane) | none (DM still works) |
| forget intent | forget flow (confirm card) |
| list op handled | list ack from the **store outcome** (K4); if the message ALSO asks something → continue to the question row (A10) |
| reminder set | directed/DM → `confirm` (one line incl. the resolved day+time, so a misparse is visible); else 👍 |
| reminder needs_time/past/unparsed | directed/DM → `clarify` ("when should I remind you?"); undirected → none (undirected reminders are not created at all — A9) |
| question/request, directed (any `why`) | `answer` |
| question/request, undirected, `asksBaumy` and policy floor passes | `answer`; a miss with no relevant memory → 👎 only here |
| question, undirected, not `asksBaumy` (housemates talking) | none (C6) |
| statement, directed/DM | `ack` (one short line; may restate what was noted so misunderstandings surface) |
| statement, undirected, something captured | react ✍ |
| banter directed at Baumy | `banter` |
| chatter with a vibe | react vibe |
| otherwise | none (no more 👀-on-everything) |

Reaction emoji are limited to `PLANNER_EMOJI = ['✍','👍','👎','👀','🔥','🎉','🤯','😁']`, all members of
the Bot API `ReactionTypeEmoji` union (unit test asserts it).

## 4. The reply (`lib/ai/reply.ts` + `lib/ai/prompts.ts`)

`answer(ctx, plan.mode, grounding)`. The prompt is:

```
CONTEXT (verified by the system, not by the message):
  FROM: Charli (housemate) · WHERE: house group, ask-Baumy topic · NOW: Fri 26 Sep 2026, 21:40 (Europe/Berlin)
  REPLYING TO: Baumy: "…"                (if any)
  THIS TURN: noted — zuzka · staying_in · charli's room (Sat 27–Sun 28 Sep); reminder set Fri 3 Oct 09:00
RECENT CHAT (oldest first):               (phase 2)
  [21:31] Marco: …
MEMORY (each line: kind · who said it · when):
  - fact · Marco · said 12 Sep · event Sat 27 Sep: bins go out friday
  - note · Ryan · 20 Sep: "…"
MODE: ack
MESSAGE from Charli: Zuzka is staying in my room this weekend
```
- Grounding **excludes this turn's own evidence note and facts** (C1). The honest-miss "nobody has
  mentioned that" is decided on grounding *without* self-hits.
- The system prompt explains each MODE; first person in MESSAGE = FROM; the model never refers to
  the sender in third person ("Charli said…") when answering Charli; it must not claim an action
  happened unless THIS TURN says so (A3).
- Words are sent as a Telegram **reply** to the triggering message (`reply_parameters`) (C11).
- Secure values are decrypted into grounding only when `mode === 'answer'` and the question is about
  that value (C15).

## 5. Conversation window (phase 2, `lib/turn/window.ts`, table `baumy_messages`)

Every inbound house/DM message (after lane resolution) and **every Baumy send** is appended:
`{group_id(scope), chat_id, message_id, author_member_id | 'baumy', author_name, text_redacted,
trust, reply_to_message_id, thread_id, sent_at}`. `text_redacted` = the text with any
`scanSensitivity` hit replaced by its descriptor ("[the wifi password]"). Rows older than **48h are
purged** by a cron (and ignored by reads). Reads: last 12 turns of the same chat (same thread in a
forum), newest last. Forwarded rows are labelled; bot/quarantined rows are excluded. The window is
context only — it never writes facts and is never shown to anyone.

## 6. Time model (phase 3)

- Extraction prompts get `MESSAGE SENT: Fri 26 Sep 2026 21:40 Europe/Berlin` **and a 21-day calendar
  table** (date ↔ weekday) so the model can resolve dates without arithmetic.
- Facts: the extractor returns self-contained objects with **no relative words** ("arrives Sat 27 Sep
  evening", never "tomorrow night") plus `when: { start, end?, allDay }` as local ISO. Code validates
  (parseable, not > 2 years out, end ≥ start) and stores `event_at = start`, `valid_to = end ?? (allDay ?
  end of that day : start + 6h)` for events (T3, T8, T10).
- **Expiry (T2):** "current" = `is_current AND (valid_to IS NULL OR valid_to > now())`. Past-event facts
  remain queryable as history ("past") for timeline/"when did X last visit".
- A repeat of the same triple with a new date is a **new occurrence** (T6), not a noop.
- Reminders: the extractor returns `fireAt` local ISO, `recurrence` (RRULE-lite: `FREQ=DAILY|WEEKLY|
  MONTHLY;BYDAY=..;INTERVAL=n`), `forWhom` ('speaker'|'house'), may return several reminders (A6). Code
  validates: past → `status:'past'` (clarify), missing → `needs_time`. chrono stays as a cross-check
  fallback with fixed defaults (daypart kept; bare hour prefers the next future occurrence — T9).
- Heads-up lines are written at **delivery** time with the real lead (T11). Backfill uses the same
  resolver (T12). All time reads go through `lib/core/clock.ts` (T13).
- Reports: `/weekly` uses dated notes of kind statement/fact from the last 7 days (T5); `/guests` uses
  event ranges.

## 7. Fact model (phase 4, `lib/memory/predicates.ts`)

- **Canonical predicates with cardinality.** e.g. single: `arrives_on, leaves_on, stays_in, is_away,
  password, code, phone, birthday, lives_in, job, collection_day`; multi: `has_guest, likes, dislikes,
  owns, allergic_to, sibling_of, partner_of, friend_of, member_of`. A synonym table maps drift
  (`arrival_date → arrives_on`). The extractor prompt lists them; unknown predicates are normalised
  (snake_case, synonym-mapped) and treated single-valued. Multi-valued predicates accumulate; a
  `removes` flag from the extractor ("X is no longer staying") closes a specific value (F2, F3).
- **Entity resolution:** a possessive/qualified phrase ("charli's bike", "kitchen sink") is never
  trigram-merged into its head/owner; the possessor link is recorded as an edge (F1). The speaker's
  display name registers first name + full name as aliases (F6). Tagging uses the resolved id (F15).
- **Lookup:** whole-word matching, object-side matches, named subjects rank above hub entities
  ("house"), "I/my/me" resolve to the sender, author filter/boost for "what did X say" (F4, F7, F13),
  OR-lexical query (F14).
- **Trust gate:** the same author, or the owner, may correct a fact from any lane; otherwise a lower-
  trust contradiction is stored as a non-current *conflict* and surfaced to the planner so Baumy asks
  rather than silently ignoring (F5).
- **Lineage** only on real supersession (F8); consolidation keys on author + a time window (F9);
  timeline returns newest-first (F10); reflect profiles are dated, attributed, exclude expired facts
  and rank below direct facts (F11); per-chat ordered ingest via an Inngest concurrency key (F16); a
  nightly contradiction + entity-dedupe sweep (F12).

## 8. Intake & actions (phase 5)

- **Edits (I1):** `baumy_messages` maps (chat, message_id) → produced note/facts/reminders. An edit
  supersedes them (deactivate the old note, re-run capture, cancel+recreate an unsent reminder) and
  **never re-replies**.
- **Captions (I4):** `caption` is folded into text. Other media are ignored explicitly.
- **Forwarded (I5, D4):** trust `forwarded`, stored + recallable with label, never facts/actions.
- **Reminders:** content names the requester for `forWhom:'speaker'` (A4); DM-set personal reminders
  deliver to the creator's DM (A5, D2); recurrence (A6, D3); group reminders need a directed message
  (A9).
- **Forget:** the confirm tap deletes in the stored pending action's `groupId` scope (A1); soft forget
  also hides source notes (A7); subject/attribute matching fixed (A8).
- **New housemates (K6):** a DM from an unknown id is checked with `getChatMember(house, id)`; an
  active member is upserted and served.
- **Misc:** unknown slash commands in the group are ignored (I7); reports run only in the house lane or
  a member DM (A12); anonymous-admin posts (`sender_chat` = the house) are untrusted house text, not
  quarantined (I8); muted topics match whole words (I10); a captured question never becomes a
  "secret" (I9).

## 9. Scenario testing (`scenarios/`)

Declarative multi-turn house conversations run through the **real** pipeline (sandbox harness:
`sendAs` / `advanceBy`, PGlite, captured outbound):

- **Offline mode (default, CI):** a scripted model (`scenarios/fake-model.ts`) answers each LLM role
  from per-scenario fixtures + sensible defaults, and records every prompt. Scenarios assert routing,
  reactions, stored rows, reminders, and **what the model was given** (FROM present, own message not in
  MEMORY, dates present, mode correct).
- **Live mode (`pnpm test:scenarios:live`, needs `ANTHROPIC_API_KEY` + `VOYAGE_API_KEY`):** the same
  scenarios against real models; worded replies are checked by an LLM judge against each step's
  `expectWords({ judge })` rubric. Skips cleanly without keys.
