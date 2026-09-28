# Baumy Olympics from Telegram

Baumy Olympics (`RyRy79261/baumy-olympics`) owns the house Google Calendar, the chores and the
season scoreboard. Baumy reaches them through Olympics' action endpoint; the contract is Olympics'
`docs/brain-integration.md` (ADR 0003 there). Tracked as RyRy79261/baumy-olympics#28.

## What a housemate can do

| Say (DM, or directed in the group) | Op | What happens |
|---|---|---|
| "add dinner with Anna Saturday 19:00" | `calendar_add` → `create_event` (`confirm`) | a confirm card; the asker's tap creates the event |
| "what's on the calendar this weekend?" | `calendar_list` → `list_events` (read) | the events, straight away |
| "I took the trash out" | `chore_log` → `log_completion` (`confirm`) | a confirm card; the tap logs it for the asker |
| "who's winning?" | `standings` → `get_standings` (read) | the table, straight away |
| `/link <code>` (DM only) | `link_telegram` (`safe`) | links the sender's Telegram id to the Olympics member who made the code |

## The flow (LLM proposes, code disposes)

1. **Triage** sets `olympics` (routing only): `calendar_add | calendar_list | chore_log | standings | none`.
2. **Gate** (`lib/core/decide.ts` `olympicsOpProposed`): a *directed* ask (DM, @mention, reply,
   vocative, ask-Baumy topic — A9) from an authenticated housemate. Never relayed (forwarded / bot)
   content, never an anonymous admin, never on an edit. An explicit reminder / cancellation / forget
   or a shopping-list op wins. A paused group is silent; a DM still works.
3. **Extract** (`lib/ai/olympics-extract.ts`, Sonnet, with the calendar table): the op and string
   slots. A malformed object degrades to `none`; a transient error rethrows (I2).
4. **Dispose** (`lib/turn/actions.ts` `runOlympics` + `lib/olympics/intents.ts`), one memoized step:
   - reads run now and are rendered by code;
   - `calendar_add`: `whoami` first (unlinked → "link first"), then `buildEventInput` validates the
     slots (a day `YYYY-MM-DD`, not past, ≤ 2 years out; no time → all day; no end → one hour; an end
     before the start runs past midnight) — anything else is a clarifying line, never a card;
   - `chore_log`: `list_chores` (unlinked → "link first"), the description is resolved to exactly
     one unarchived chore by its words (`matchChore`; none / ambiguous → the list of chores), and a
     chore cooling down or without points gets a line, not a card;
   - a write is stored as a `pending_actions` row, type `olympics.action`, holding the exact Olympics
     input and an `Idempotency-Key` (`brain-<uuid>`) minted now, `requested_by` = the asker.
5. **Voice** (`plan.ts` row `olympics`): the card or the line, deterministic — never the reply model.
   The message is not captured as a memory note (the calendar / chore log is its home).
6. **Tap** (`functions/callback.ts`): only the asker's tap resolves an `olympics.action`
   (`resolvePendingAction` with the tapper; anyone else hears "Only the person who asked…"). The call
   goes out with `X-Baumy-Confirmed: 1`, `X-Baumy-Actor: tg:<tapper>` and the stored key, in its own
   memoized step. It is audited (`olympics.action`). If Olympics did not answer (timeout, 5xx,
   `IN_PROGRESS`), the card is put back to pending (`reopenPendingAction`) and the asker taps again —
   with the **same** key, so Olympics runs it at most once. Olympics audits each run with
   `source=brain`.

## The client (`lib/olympics/client.ts`)

- `listOlympicsActions()` → `GET /api/v1/actions`; `callOlympicsAction(name, input, {actor,
  idempotencyKey?, confirmed?})` → `POST /api/v1/actions/{name}`.
- Result union: `ok` · `not_configured` (env unset, or a 401) · `unavailable` (network, 5s timeout,
  5xx, `IN_PROGRESS`, `UNAVAILABLE`, `INTERNAL`, a body of the wrong shape) · `refused` (`code`,
  `message` written for people, `retryAt` / `retryAfterSeconds`). It never throws and never logs the
  token.
- Inside the sandbox (captured sends) it never reaches the network: without a test transport
  (`setOlympicsTransport`, test-only) every call is `not_configured`.

## Env

`OLYMPICS_BASE_URL` and `BRAIN_SERVICE_TOKEN`, both optional; unset = "Baumy Olympics isn't connected
to me yet". The token is minted in Olympics (`service-token mint baumy-brain`) — see `SETUP.md`.

## Tests

`lib/olympics/__tests__/` (client headers + error mapping, validation, matching, rendering),
`lib/identity/__tests__/commands.test.ts` (`/link`), `lib/confirm/__tests__/store.test.ts`
(requester-only resolve, reopen), `lib/core/__tests__/decide.test.ts` (the gate),
`lib/turn/__tests__/plan.test.ts`, and `scenarios/olympics.scenario.test.ts` end to end against an
in-memory Olympics (`scenarios/olympics-fake.ts`).
