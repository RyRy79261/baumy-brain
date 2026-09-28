<!-- A copy of baumy-olympics docs/brain-operations-spec.md (branch feat/brain-operations-spec, commit 813a652, RyRy79261/baumy-olympics#71). Olympics generates it from its action registry with `pnpm brain:spec`; do not edit it here. To refresh it, copy the file again from baumy-olympics main. -->

# Baumy Olympics: operations spec for Baumy (baumy-brain)

<!-- GENERATED FILE. Do not edit docs/brain-operations-spec.md by hand. Edit apps/web/lib/brain/operations-spec.template.md (the prose) or apps/web/lib/brain/operations-spec-notes.ts (the per-action notes), then run `pnpm brain:spec`. A unit test fails while the doc is out of date with the action registry. -->

This is everything the Telegram bot Baumy (baumy-brain, `@baumy_bot`) needs to
run the household's Olympics for its members: what the household is, how to
call Olympics, and every action it may call. The action list, input schemas,
risks, gates and limits below are generated from Olympics' action registry, so
they are exactly what the endpoint enforces. The short contract is
`docs/brain-integration.md` in baumy-olympics; this doc is the long form.

**Owner rulings (2026-09-28, baumy-olympics issue #70).**

1. Baumy gets **every member action**, the destructive ones included
   (`delete_event`, `delete_note`), always behind its inline confirm button.
   Admin actions stay in the Olympics app only (SPEC §12 decision 10).
2. **Baumy can act on behalf of housemates.** With `X-Baumy-On-Behalf-Of` the
   action runs as that housemate; the audit trail records both the housemate
   and the linked member who asked. Any write on someone's behalf needs the
   asker's confirm tap, even a `safe` one.

## 1. Calling Olympics

| Method | Path                     | What it does                                                                                 |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/actions`        | `{ok: true, actions: [{name, title, description, input_schema, kind, risk, member_field?}]}` |
| `POST` | `/api/v1/actions/{name}` | Runs one action. The JSON body is its input; an empty body is `{}`.                          |

### Headers

| Header                              | When          | Meaning                                                                                                                       |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <token>`     | always        | `BRAIN_SERVICE_TOKEN`. Olympics stores only its sha256. Missing, unknown or revoked: 401.                                     |
| `X-Baumy-Actor: tg:<telegram id>`   | every `POST`  | The authenticated sender (`from.id`), never text. Mapped to an active member on every call.                                   |
| `X-Baumy-On-Behalf-Of: <member id>` | optional      | Run the action as this housemate (section 4).                                                                                 |
| `X-Baumy-Confirmed: 1`              | see section 3 | Send it only from the confirm-tap handler, after the asker tapped. Any other value counts as not confirmed.                   |
| `Idempotency-Key: <key>`            | every write   | 8 to 128 of `A-Z a-z 0-9 . _ : -`, minted once per intended action (when the card is proposed). A retry resends the same key. |

The endpoint checks, in this order: the token and its `brain` scope, 300
calls a minute per token, that the action is offered to Baumy, the actor
header and its link, the on-behalf header, the confirm header, and the
idempotency key. Then the action runs exactly as it would in the app, with
`source=brain`.

### Answers

A success is `200 {ok: true, data}`. A failure is `{ok: false, code, message}`
plus `issues` (with `INVALID_INPUT`), `retryAt` (with `COOLDOWN`) or
`retryAfterSeconds` (with `RATE_LIMITED`, also sent as `Retry-After`).
`message` is a sentence written to be shown to the person as it is.

| Status | `code`                          | What Baumy does                                                                                           |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT`                 | A bug on our side or a bad slot: `issues` says which field or header. Ask the person to rephrase.         |
| 401    | `UNAUTHENTICATED`               | Olympics is not (correctly) connected. "Baumy Olympics isn't connected to me yet."                        |
| 403    | `FORBIDDEN`                     | Not allowed for this member (for example confirming your own claim). Show `message`.                      |
| 403    | `SURFACE_FORBIDDEN`             | Not Baumy's to do (admin or app-only). "That's done in the Olympics app."                                 |
| 403    | `TELEGRAM_NOT_LINKED`           | "Link your Telegram first: Olympics → Settings → Create a link code, then DM me /link <code>."            |
| 404    | `UNKNOWN_ACTION`, `NOT_FOUND`   | No such action, or the thing (event, note, reminder, claim, housemate) is gone. Show `message`.           |
| 409    | `IDEMPOTENCY_CONFLICT`          | The key was used for a different call: our bug. Mint a new key and propose again.                         |
| 409    | `IN_PROGRESS`                   | The same key is still running. Retry with the same key in a moment.                                       |
| 422    | domain codes (`COOLDOWN`, …)    | The action understood and said no. Show `message`; each action below lists its own.                       |
| 428    | `CONFIRMATION_REQUIRED`         | The call needed the confirm tap. Show the card; never retry without a tap.                                |
| 429    | `RATE_LIMITED`                  | Wait `retryAfterSeconds`.                                                                                 |
| 500    | `INTERNAL`                      | Something broke on Olympics' side. Retry with the same key, then say it is not answering.                 |
| 503    | `NOT_CONFIGURED`, `UNAVAILABLE` | Google Calendar (or brain itself) is not set up or did not answer. Say so; retry later with the same key. |

### Idempotency

Repeating a write with the same `Idempotency-Key` and the same input returns
the stored answer without running it again. The ledger is keyed on the member
the action runs as, the source and the key. A failed write may be retried with
the same key. A different input under a used key is `IDEMPOTENCY_CONFLICT`.

### Time

The household lives in **Europe/Berlin**. Days (`date`, `from`, `to`) are
Berlin `YYYY-MM-DD`; event times are Berlin wall-clock `HH:MM` (24h). Instants
in answers (`occurredAt`, `retryAt`, `createdAt`, …) are ISO 8601 in UTC:
convert them to Berlin time before showing them. An instant sent to Olympics
(`occurredAt`) must carry its offset. Seasons are Berlin calendar years.

## 2. Linking Telegram (`/link`)

1. The member opens **Settings** in Olympics and taps **Create a link code**
   (10 characters, valid 10 minutes, single use).
2. They DM Baumy `/link <code>`. Refuse `/link` in the group: whoever reads a
   code first could claim it.
3. Baumy calls `link_telegram` `{"code": "<code>"}` with the sender in
   `X-Baumy-Actor` and an `Idempotency-Key` fixed for that message (a retry
   replays the answer instead of spending the code twice). This is the only
   action an unlinked sender may call.
4. The answer is `{memberId, displayName}`: "Linked you as <displayName>."

`LINK_CODE_INVALID` (wrong, used, expired, or its member left) and
`TELEGRAM_ALREADY_LINKED` (another member has this Telegram account; an admin
can clear it) are 422 with a `message` to show.

## 3. Confirmations

Baumy's rule stays: the language model proposes, deterministic code calls
Olympics. Which calls need the asker's tap on an inline confirm button, sent
with `X-Baumy-Confirmed: 1`:

| Call                                      | Tap needed | Why                                                                               |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| a read (`kind: read`)                     | never      | Nothing changes, for the asker or on anyone's behalf.                             |
| a `safe` write for the asker              | no         | Low stakes and reversible (a note, a reminder, "seen").                           |
| a `confirm` write                         | always     | It changes the score or the shared calendar.                                      |
| a `destructive` write                     | always     | It removes something for everyone. Name the exact thing (title, day) on the card. |
| **any** write with `X-Baumy-On-Behalf-Of` | always     | It speaks for someone else.                                                       |

Without the header Olympics answers 428 `CONFIRMATION_REQUIRED` and nothing
runs. Only the asker's tap resolves the card (the call runs as them, or with
them as the initiator). The tap sends the key minted when the card was
proposed, so a retried tap, or a card reopened after Olympics did not answer,
runs at most once.

## 4. Acting on a housemate's behalf

"Mark the plumber reminder seen for Sam", "Jo says she's seen it", "what's
waiting on Sam?": send `X-Baumy-On-Behalf-Of: <Sam's member id>`.

- The target must be an **active member of this household**; anyone else is
  404 `NOT_FOUND` ("That person is not an active member of the household.").
  A malformed id is 400.
- The action runs **as the housemate**: their permissions, their idempotency
  ledger, their answer (`whoami` answers as them). The audit row has the
  housemate as the actor, and the asker as `initiated_by_member_id`, with
  `source=brain`.
- Any **write** on someone's behalf needs the asker's tap (section 3). Reads
  do not.
- The asker's own id in the header is the same as no header.
- Not for `link_telegram`, and not for an action that names its member in its
  own input (`member_field` in the tool list): those answer 400. Today that is
  `log_completion`: "Jo did the dishes" is `log_completion` with
  `doneBy: <Jo's id>`. The asker logs it and **vouches** for Jo, so it counts
  at once, and the record says truthfully who logged it. On-behalf would
  claim Jo logged it herself.
- Admin actions stay unavailable, on anyone's behalf.
- To turn a name into a member id, read the roster: `list_reminders` answers
  `members` (id, name) for every active member; `get_standings` lists them
  with their points. Match the name to exactly one member, or ask.

## 5. The household, as Olympics models it

- **Members.** Each housemate is a member with a display name, a colour and a
  16-bit character. One or more are admins; admin work happens in the app.
  Nobody is hard-coded: always read names from Olympics.
- **Bounties are chores.** Each chore has a `kind`: `consumable` (buy or
  refill: toilet paper, dish soap) or `maintenance` (clean or fix: trash,
  bathroom). It has base points and a cooldown. `urgent` means due now or
  falling due before midnight in Berlin; `isNew` means added in the last 3
  days. Logging a chore inside its cooldown is refused (`COOLDOWN`, with
  `retryAt`).
- **Streaks and break bonuses.** Each chore has one streak holder. Doing a
  chore again while you hold it grows the streak (+25% of base per step, no
  cap). Doing a chore someone else holds **breaks** their streak: you get a
  break bonus (20% of base per broken step, capped at 10 steps) and start your
  own at 1. Nobody loses points; scores only go up. Streaks reset on 1 January
  (a season is a Berlin calendar year).
- **Points and the pot.** Season points are scored completions plus approved
  adjustments. The pot is a savings ledger in euro cents; the leader at the
  end of the season takes it all (money moves at the bank, not in Olympics).
- **Confirmations and the 24-hour dispute window.** Logging for someone else
  verifies the claim at once. A self-claim is `pending`: it counts
  provisionally and finalizes 24 hours after logging, unless someone confirms
  it sooner or disputes it inside those 24 hours (a dispute needs a reason). A
  disputed claim scores nothing; it is voided when the window ends unless the
  doer attached a photo in time. The disputer can withdraw, the doer can
  concede, and the logger can undo within 10 minutes. Some chores are in
  partner mode: a self-claim counts only once someone confirms it (72 hours,
  then it is voided).
- **Weights.** Every week Olympics suggests new points for chores from how
  often they are really done. An admin schedules a change; any other member
  may veto it before it applies (next Monday, 00:00 Berlin, at least 48 hours
  ahead).
- **Reminders** are full-screen messages on the kitchen screen, for things
  everyone must read. Each shows every member's character with a Seen button.
  It stays until every member who had joined when it was posted has seen it,
  or someone dismisses it. These are not Baumy's own timed Telegram
  reminders; those stay in Baumy.
- **Notes** are the household message board: a title, a short markdown body,
  a colour, and pinned ones on the kitchen screen. Never put a secret in a
  note; Baumy keeps secrets encrypted itself.
- **Calendar.** The house Google Calendar. Events are timed or all day, in
  Berlin days and times. Private events are never shown.
- **Shopping** is Baumy's own list (`baumy_list_items`). Olympics shows it on
  the kitchen screen by calling Baumy's kitchen API; Baumy never needs to call
  Olympics to change it.

## 6. Actions at a glance

| Action | Kind | Risk | Confirm tap | On behalf |
| --- | --- | --- | --- | --- |
| [`whoami`](#whoami-who-am-i) | read | safe | never | yes |
| [`link_telegram`](#link_telegram-link-a-telegram-account) | write | safe | never | no |
| [`list_chores`](#list_chores-list-chores) | read | safe | never | yes |
| [`log_completion`](#log_completion-log-a-chore) | write | confirm | always | no, use `doneBy` |
| [`get_pending_confirmations`](#get_pending_confirmations-claims-waiting-for-an-ok) | read | safe | never | yes |
| [`confirm_completion`](#confirm_completion-confirm-a-chore) | write | confirm | always | yes |
| [`dispute_completion`](#dispute_completion-dispute-a-chore) | write | confirm | always | yes |
| [`undo_completion`](#undo_completion-undo-a-logged-chore) | write | confirm | always | yes |
| [`withdraw_dispute`](#withdraw_dispute-withdraw-a-dispute) | write | confirm | always | yes |
| [`concede_completion`](#concede_completion-concede-a-dispute) | write | confirm | always | yes |
| [`get_standings`](#get_standings-get-the-standings) | read | safe | never | yes |
| [`get_streaks`](#get_streaks-get-the-streaks) | read | safe | never | yes |
| [`get_pot`](#get_pot-get-the-pot) | read | safe | never | yes |
| [`get_weights`](#get_weights-weights) | read | safe | never | yes |
| [`veto_weight`](#veto_weight-veto-a-weight-change) | write | confirm | always | yes |
| [`list_events`](#list_events-calendar) | read | safe | never | yes |
| [`create_event`](#create_event-add-a-calendar-event) | write | confirm | always | yes |
| [`update_event`](#update_event-change-a-calendar-event) | write | confirm | always | yes |
| [`delete_event`](#delete_event-delete-a-calendar-event) | write | destructive | always | yes |
| [`list_notes`](#list_notes-notes) | read | safe | never | yes |
| [`create_note`](#create_note-add-a-note) | write | safe | on behalf only | yes |
| [`update_note`](#update_note-change-a-note) | write | confirm | always | yes |
| [`pin_note`](#pin_note-pin-a-note) | write | safe | on behalf only | yes |
| [`delete_note`](#delete_note-delete-a-note) | write | destructive | always | yes |
| [`list_shopping`](#list_shopping-shopping-list) | read | safe | never | yes |
| [`list_reminders`](#list_reminders-reminders) | read | safe | never | yes |
| [`create_reminder`](#create_reminder-post-a-reminder) | write | safe | on behalf only | yes |
| [`acknowledge_reminder`](#acknowledge_reminder-mark-a-reminder-seen) | write | safe | on behalf only | yes |
| [`dismiss_reminder`](#dismiss_reminder-dismiss-a-reminder) | write | confirm | always | yes |

## 7. The actions

### `whoami`: Who am I

Says which household member Baumy is acting as.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** Before a write, to check the sender is linked (an unlinked sender gets TELEGRAM_NOT_LINKED here, before any confirm card), and to learn their member id and name.

**Tool description** (the registry's, verbatim): Returns the household member making this request: their member id, display name, role (admin or member), colour and avatar sprite. Use it to learn who 'me' is before acting for them.

**Examples.**

- "who am I in the Olympics?" → `whoami {}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**Returns** (`data`): `memberId`, `displayName`, `role` (admin or member), `color`, `avatarSprite` and `actorKind` (always `service` for brain).

**Its errors:** `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** Nothing, unless asked. If asked: "You're linked as <displayName>."

### `link_telegram`: Link a Telegram account

Links the sender's Telegram account to the member who created the code in Olympics' Settings.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `safe`: runs straight away |
| Who may | the service token alone; the member comes from the code, so an unlinked sender may call it |
| On a housemate's behalf | no: linking is always for the sender |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 5 per Telegram user and 30 per IP in 10 minutes |

**When to use it.** Only for `/link <code>` sent in a DM. Refuse it in the group: anyone who reads a code there could claim it first.

**Tool description** (the registry's, verbatim): Links the calling Telegram user to the household member who created the one-time link code in Baumy's Settings. Call it when someone sends /link <code>.

**Examples.**

- "/link K7PQ2MX9RT" → `link_telegram {"code": "K7PQ2MX9RT"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "minLength": 8,
      "maxLength": 32,
      "pattern": "^[A-Za-z0-9]+$"
    }
  },
  "required": [
    "code"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `memberId` and `displayName` of the member the account is now linked to.

**Its errors:** `LINK_CODE_INVALID` (422), `TELEGRAM_ALREADY_LINKED` (422). Every call can also get the endpoint's codes (above).

**Say back:** "Linked you as <displayName>." On LINK_CODE_INVALID: "That code didn't work. Make a new one in Olympics → Settings (it lasts 10 minutes)." On TELEGRAM_ALREADY_LINKED: show `message`.

### `list_chores`: List chores

Lists the bounties (chores): what is due, urgent or new, and what each would score now.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** To answer "what needs doing?", and to turn a chore someone names into its `choreId` before log_completion. Match the words to exactly one chore; if none or several match, list them and ask.

**Tool description** (the registry's, verbatim): Lists the household's chores with their ids, kind (consumable: buy or refill; maintenance: clean or fix), base points, cooldown, who holds each chore's streak this season and how long it is, whether each is due, cooling down (with availableAt) or done for now, `urgent` (due now or falling due before midnight in Berlin), `isNew` (added in the last 3 days), and `next`: what logging it right now would score for you (total points, streak length, break bonus). Times are ISO 8601 in UTC; the household lives in Europe/Berlin. Archived chores are left out unless includeArchived is true.

**Examples.**

- "what needs doing?" → `list_chores {}`
- "what's urgent?" → `list_chores {} (keep `urgent: true`)`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "includeArchived": {
      "description": "Also list archived chores. Default false.",
      "type": "boolean"
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `chores`: each one's `id`, `name`, `kind` (consumable or maintenance), `basePoints`, `cooldownMinutes`, `state` (due, cooling down with `availableAt`, or done for now), `urgent`, `isNew`, `streak` (holder and length) and `next` (what logging it now would score the asker).

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** Urgent ones first, then due, then the rest; say points as "+N". Times in Berlin time.

### `log_completion`: Log a chore

Logs that someone did a chore, and scores it.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | any linked member; logging for someone else (`doneBy`) vouches for them, which brain may do as the asker (on the kiosk it would need a PIN). |
| On a housemate's behalf | no (400): name the housemate in `doneBy` instead |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When someone says they (or a named housemate) did a chore. For "Jo did the dishes", send `doneBy: <Jo's id>`: the asker logs it and vouches for Jo, so it counts at once. Never use X-Baumy-On-Behalf-Of for this (it is refused with 400): that would claim Jo logged it herself.

**Tool description** (the registry's, verbatim): Logs that a household member did a chore and scores it (streaks and break bonuses). doneBy defaults to you; logging for someone else vouches for them. Refused with COOLDOWN (and retryAt) if the chore was done too recently, and with other codes for times in the future, more than 24h ago, or before the chore's last completion. Get chore and member ids from list_chores and whoami.

**Examples.**

- "I took the trash out" → `log_completion {"choreId": "<Trash, from list_chores>"}`
- "Jo did the dishes last night at 11" → `log_completion {"choreId": "<Dishes>", "doneBy": "<Jo's member id>", "occurredAt": "2026-09-27T23:00:00+02:00"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "choreId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The chore's id, from list_chores."
    },
    "doneBy": {
      "description": "The member id of whoever did the chore. Defaults to you. Logging for someone else vouches for them.",
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "occurredAt": {
      "description": "When the chore was done, ISO 8601. Defaults to now; at most 24 hours ago, and not before the chore's last completion.",
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
    },
    "note": {
      "description": "An optional short note.",
      "type": "string",
      "maxLength": 280
    }
  },
  "required": [
    "choreId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `completionId`, `choreName`, `doneBy`/`doneByName`, `status`, `counted` (false while a partner-mode claim waits for someone to confirm), `totalPts`, `streakLen`, and a break (`breakPts`, `brokenMemberName`, `brokenLen`) if one happened.

**Its errors:** `COOLDOWN` (422), `FUTURE` (422), `BACKDATE_TOO_FAR` (422), `OUT_OF_ORDER` (422), `SEASON_CLOSED` (422), `PHOTO_REQUIRED` (422), `ARCHIVED_CHORE` (422), `NO_RULE_VERSION` (422), `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** "Logged <choreName> for <doneByName>: +<totalPts> (streak <streakLen>)", plus "and broke <brokenMemberName>'s streak of <brokenLen> for +<breakPts>" when there was a break, or "it counts once someone confirms it" when `counted` is false. On COOLDOWN say when it can be logged again (`retryAt`, in Berlin time). On PHOTO_REQUIRED: "that one needs a photo, log it in the app".

### `get_pending_confirmations`: Claims waiting for an OK

Lists chore claims still waiting to settle, and what the asker may do to each.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "anything waiting on me?", and to find the `completionId` before confirming, disputing, undoing, withdrawing or conceding. Use `can` to offer only what is allowed.

**Tool description** (the registry's, verbatim): Lists the household's chore claims still waiting to settle (pending or disputed), with who did and logged each, when its dispute window ends, any open dispute and its reason, and `can`: which of confirm, dispute, withdraw, concede, undo and attach a photo you may do to it now. `needsYou` marks the ones waiting on you. `recent` lists your own claims of the last 7 days that have settled (finalized, confirmed or voided). Times are ISO 8601 in UTC.

**Examples.**

- "anything I need to confirm?" → `get_pending_confirmations {}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**Returns** (`data`): `claims` (pending or disputed; who did and logged each, when its window ends, any dispute and reason, `can`, `needsYou`) and `recent` (the asker's own claims settled in the last 7 days).

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** The ones with `needsYou` first, each as "<doer> did <chore> <when>" with the actions `can` allows.

### `confirm_completion`: Confirm a chore

Confirms a housemate's self-claimed chore, which verifies it.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When someone says a housemate really did it ("yes, Sam did clean the bathroom"). Not for your own claims.

**Tool description** (the registry's, verbatim): Confirms a housemate's self-claimed chore that is waiting for an OK (pending), which verifies it. You cannot confirm your own. Refused with INVALID_STATE once it has finalized, expired or been disputed. Get ids from get_pending_confirmations.

**Examples.**

- "yes Sam did the bathroom" → `confirm_completion {"completionId": "<from get_pending_confirmations>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "completionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The completion's id, from get_pending_confirmations."
    }
  },
  "required": [
    "completionId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `completionId`, `choreName`, the new `status` and `finalizesAt`.

**Its errors:** `NOT_FOUND` (404), `INVALID_STATE` (422), `WINDOW_CLOSED` (422), `FORBIDDEN` (403). Every call can also get the endpoint's codes (above).

**Say back:** "Confirmed <doer>'s <choreName>."

### `dispute_completion`: Dispute a chore

Disputes a housemate's self-claimed chore inside its 24-hour window, with a reason.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When someone says a claimed chore was not done. Ask for the reason if none was given; it is required.

**Tool description** (the registry's, verbatim): Disputes a housemate's self-claimed chore within 24 hours of logging, with a reason. While disputed it scores nothing but still blocks the chore's cooldown. It is voided when the window ends unless the doer attached a photo in time. You cannot dispute your own.

**Examples.**

- "Sam didn't do the bathroom, it's still dirty" → `dispute_completion {"completionId": "<id>", "reason": "Still dirty"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "completionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The completion's id, from get_pending_confirmations."
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 280,
      "description": "Why you think it was not done."
    }
  },
  "required": [
    "completionId",
    "reason"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `completionId`, `choreName`, the new `status` (disputed).

**Its errors:** `NOT_FOUND` (404), `INVALID_STATE` (422), `WINDOW_CLOSED` (422), `FORBIDDEN` (403), `REASON_REQUIRED` (422). Every call can also get the endpoint's codes (above).

**Say back:** "Disputed <doer>'s <choreName>. It scores nothing unless they attach a photo in time or you withdraw it."

### `undo_completion`: Undo a logged chore

Undoes a chore the asker logged, within 10 minutes of logging it.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** For "oops, undo that" right after a log. After 10 minutes it is WINDOW_CLOSED; say so.

**Tool description** (the registry's, verbatim): Undoes a chore you logged yourself, within 10 minutes of logging it. It is voided and scores nothing. Refused with WINDOW_CLOSED after 10 minutes and FORBIDDEN for anyone but the person who logged it.

**Examples.**

- "undo that, wrong chore" → `undo_completion {"completionId": "<the one just logged>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "completionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The completion's id, from get_pending_confirmations."
    }
  },
  "required": [
    "completionId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `completionId`, `choreName`, `status` (voided).

**Its errors:** `NOT_FOUND` (404), `INVALID_STATE` (422), `WINDOW_CLOSED` (422), `FORBIDDEN` (403). Every call can also get the endpoint's codes (above).

**Say back:** "Undone: <choreName> no longer counts."

### `withdraw_dispute`: Withdraw a dispute

Withdraws a dispute the asker raised; the claim counts again.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When the disputer says they were wrong ("ok Sam did do it").

**Tool description** (the registry's, verbatim): Withdraws a dispute you raised. The claim goes back to pending and counts again; it finalizes at the later of its original time and one hour from now. Only the person who disputed it can withdraw.

**Examples.**

- "I take back my dispute on the bathroom" → `withdraw_dispute {"completionId": "<id>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "completionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The completion's id, from get_pending_confirmations."
    }
  },
  "required": [
    "completionId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `completionId`, `choreName`, `status` (pending), `finalizesAt`.

**Its errors:** `NOT_FOUND` (404), `INVALID_STATE` (422), `WINDOW_CLOSED` (422), `FORBIDDEN` (403). Every call can also get the endpoint's codes (above).

**Say back:** "Withdrawn. <choreName> counts again."

### `concede_completion`: Concede a dispute

Concedes a dispute on the asker's own claim; it is voided.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When the doer agrees they did not do it ("fair, I didn't finish it").

**Tool description** (the registry's, verbatim): Concedes a dispute on your own chore claim: the claim is voided and scores nothing. Only the person who did the chore can concede.

**Examples.**

- "fine, I'll concede the bathroom" → `concede_completion {"completionId": "<id>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "completionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The completion's id, from get_pending_confirmations."
    }
  },
  "required": [
    "completionId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `completionId`, `choreName`, `status` (voided).

**Its errors:** `NOT_FOUND` (404), `INVALID_STATE` (422), `WINDOW_CLOSED` (422), `FORBIDDEN` (403). Every call can also get the endpoint's codes (above).

**Say back:** "Conceded. <choreName> is off your score."

### `get_standings`: Get the standings

The season scoreboard.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "who's winning?", points, gaps and the recent scores.

**Tool description** (the registry's, verbatim): Returns the season scoreboard: each member's rank and points (scored completions plus approved adjustments), the part of those points that is still provisional (claims that can still be disputed), how far each member is behind the leader, the leader (who would take the pot now, or null on a tie), the prize mode, dispute counts this month, the latest scored completions with their breakdown (base, streak bonus, break bonus) and the point adjustments. Times are ISO 8601 in UTC; the household lives in Europe/Berlin.

**Examples.**

- "who's winning?" → `get_standings {}`
- "how did last year end?" → `get_standings {"year": 2025}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "year": {
      "description": "The season (Berlin calendar year). Defaults to the current season.",
      "type": "integer",
      "minimum": 2000,
      "maximum": 2100
    },
    "recent": {
      "description": "How many recent completions to include. Default 10.",
      "type": "integer",
      "minimum": 0,
      "maximum": 50
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `standings` (rank, member, points, provisional points, gap to the leader), `leaderId` (null on a tie), the season and its prize mode, `recent` scored completions with their breakdown, and `adjustments`.

**Its errors:** `PRIZE_MODE_NOT_SUPPORTED` (422). Every call can also get the endpoint's codes (above).

**Say back:** The top of the table as "1. Ryan 240 (+30 provisional)", and the leader, or that it is a tie.

### `get_streaks`: Get the streaks

Who holds each chore's streak, and the season's best runs.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "who has the trash streak?" or "longest streak this year?".

**Tool description** (the registry's, verbatim): Returns the season's streak board: who holds each chore's streak now and how long it is, and the season's best runs (current or already broken), longest first, each with its chore, member, length, weight (base points added up) and dates. Times are ISO 8601 in UTC.

**Examples.**

- "who's on a streak?" → `get_streaks {}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "year": {
      "description": "The season (Berlin calendar year). Defaults to the current season.",
      "type": "integer",
      "minimum": 2000,
      "maximum": 2100
    },
    "best": {
      "description": "How many best runs to return. Default 5.",
      "type": "integer",
      "minimum": 1,
      "maximum": 50
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `current` (each chore's holder and length) and `best` (the season's best runs: chore, member, length, weight, dates).

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** "<member> holds <chore> ×<length>."

### `get_pot`: Get the pot

The season's savings pot (a ledger; money moves at the bank).

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "how much is in the pot?" and who would take it.

**Tool description** (the registry's, verbatim): Returns the season's savings pot: each month's contributions (amounts in euro cents, who paid, notes), the running total after each month, the total, and the current leader who would take the whole pot at the end of the season (null when nobody leads outright). The pot is a ledger only; money moves at the bank.

**Examples.**

- "how big is the pot?" → `get_pot {}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "year": {
      "description": "The season (Berlin calendar year). Defaults to the current season.",
      "type": "integer",
      "minimum": 2000,
      "maximum": 2100
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `months` (each month's contributions in euro cents and the running total), `totalCents` and `leader`.

**Its errors:** `PRIZE_MODE_NOT_SUPPORTED` (422). Every call can also get the endpoint's codes (above).

**Say back:** Amounts in euros ("€120.00"), and who would take it now, or that nobody leads outright.

### `get_weights`: Weights

Each chore's points and cooldown, how often it is really done, and the weight changes scheduled for next Monday.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "why is the trash worth so little?" or "any weight changes coming?" (`scheduledOnly: true`), and to find a `suggestionId` to veto.

**Tool description** (the registry's, verbatim): Lists each chore's points and cooldown, how often it is really done (the median gap and the sample), the weight change the frequency formula suggests, and the changes scheduled to apply next Monday.

**Examples.**

- "any point changes coming?" → `get_weights {"scheduledOnly": true}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "scheduledOnly": {
      "description": "Only the scheduled changes, without measuring every chore.",
      "type": "boolean"
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `chores` (current points and cooldown, the measured median gap, the suggestion) and `scheduled` (changes about to apply, with `appliesAt` and `canVeto`).

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** "<chore> goes from <old> to <new> points on <Berlin date>, unless someone vetoes it."

### `veto_weight`: Veto a weight change

Vetoes a scheduled weight change before it applies. Only a member other than the one who scheduled it may.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When someone objects to a scheduled change. Use `canVeto` from get_weights first; the scheduler cannot veto their own change.

**Tool description** (the registry's, verbatim): Vetoes a scheduled weight change before it applies. Only a member other than the one who scheduled it can veto it; a vetoed change never applies.

**Examples.**

- "veto the trash points change" → `veto_weight {"suggestionId": "<from get_weights scheduled>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "suggestionId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    }
  },
  "required": [
    "suggestionId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `suggestionId`, `choreId`, `status` (vetoed).

**Its errors:** `NOT_FOUND` (404), `INVALID_STATE` (422), `WINDOW_CLOSED` (422), `SELF_VETO` (422). Every call can also get the endpoint's codes (above).

**Say back:** "Vetoed. <chore> keeps its points."

### `list_events`: Calendar

The house calendar between two Berlin days.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "what's on this weekend?", and to find an `eventId` before changing or deleting an event.

**Tool description** (the registry's, verbatim): Lists the house calendar's events between two Berlin days (inclusive; both default to today), soonest first, with each event's id, title, notes, place, whether it is all day, its first and last day, its Berlin start and end time (HH:MM) and who added it (a member id). Private events are left out.

**Examples.**

- "what's on this weekend?" → `list_events {"from": "2026-10-03", "to": "2026-10-04"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "from": {
      "description": "The first day, YYYY-MM-DD in Europe/Berlin. Defaults to today.",
      "type": "string"
    },
    "to": {
      "description": "The last day (inclusive). Defaults to `from`. At most 62 days after it.",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `events`: id, title, notes, place, all day or not, first and last day, Berlin start and end (HH:MM), who added it.

**Its errors:** `INVALID_INPUT` (400), `NOT_CONFIGURED` (503), `UNAVAILABLE` (503). Every call can also get the endpoint's codes (above).

**Say back:** One line per event: "Sat 3 Oct 19:00–20:00 Dinner with Anna". Nothing on: say so.

### `create_event`: Add a calendar event

Adds an event to the house Google Calendar.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |
| Calls out | yes (Google or brain): may answer 503 `NOT_CONFIGURED` or `UNAVAILABLE` |

**When to use it.** When someone asks to add something to the calendar. Resolve the day and time to Berlin `YYYY-MM-DD` and `HH:MM` first; no time means `all_day`.

**Tool description** (the registry's, verbatim): Adds an event to the house calendar. Dates are Berlin days (YYYY-MM-DD) and times Berlin wall-clock times (HH:MM, 24h); give startTime and endTime for a `timed` event, or kind `all_day`. endDate is the last day, inclusive, and defaults to date.

**Examples.**

- "add dinner with Anna Saturday 19:00" → `create_event {"title": "Dinner with Anna", "kind": "timed", "date": "2026-10-03", "startTime": "19:00", "endTime": "20:00"}`
- "Mum visits 10 to 12 October" → `create_event {"title": "Mum visits", "kind": "all_day", "date": "2026-10-10", "endDate": "2026-10-12"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "description": "Notes for the event. Optional.",
      "type": "string",
      "maxLength": 2000
    },
    "location": {
      "description": "Where. Optional.",
      "type": "string",
      "maxLength": 200
    },
    "kind": {
      "type": "string",
      "enum": [
        "timed",
        "all_day"
      ],
      "description": "`timed` needs startTime and endTime; `all_day` fills whole days."
    },
    "date": {
      "type": "string",
      "description": "The first day, YYYY-MM-DD, in Europe/Berlin."
    },
    "endDate": {
      "description": "The last day (inclusive), YYYY-MM-DD. Defaults to `date`.",
      "type": "string"
    },
    "startTime": {
      "description": "Timed events: the Berlin wall-clock start, HH:MM (24h).",
      "type": "string",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
    },
    "endTime": {
      "description": "Timed events: the Berlin wall-clock end, HH:MM (24h), on endDate.",
      "type": "string",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
    }
  },
  "required": [
    "title",
    "kind",
    "date"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `event`: the event as stored, with its `id`.

**Its errors:** `NOT_CONFIGURED` (503), `UNAVAILABLE` (503). Every call can also get the endpoint's codes (above).

**Say back:** "Added <title> on <day> <time>."

### `update_event`: Change a calendar event

Changes a calendar event; every field is replaced.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |
| Calls out | yes (Google or brain): may answer 503 `NOT_CONFIGURED` or `UNAVAILABLE` |

**When to use it.** When someone moves or renames an event. Read it with list_events and send ALL its fields, changed and unchanged.

**Tool description** (the registry's, verbatim): Changes an event on the house calendar: send its id (from list_events) and ALL of its fields as they should be, the same as for create_event.

**Examples.**

- "move dinner with Anna to 20:00" → `update_event {"eventId": "<id>", "title": "Dinner with Anna", "kind": "timed", "date": "2026-10-03", "startTime": "20:00", "endTime": "21:00"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "eventId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_]{5,1024}$",
      "description": "The event's id, from list_events."
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "description": "Notes for the event. Optional.",
      "type": "string",
      "maxLength": 2000
    },
    "location": {
      "description": "Where. Optional.",
      "type": "string",
      "maxLength": 200
    },
    "kind": {
      "type": "string",
      "enum": [
        "timed",
        "all_day"
      ],
      "description": "`timed` needs startTime and endTime; `all_day` fills whole days."
    },
    "date": {
      "type": "string",
      "description": "The first day, YYYY-MM-DD, in Europe/Berlin."
    },
    "endDate": {
      "description": "The last day (inclusive), YYYY-MM-DD. Defaults to `date`.",
      "type": "string"
    },
    "startTime": {
      "description": "Timed events: the Berlin wall-clock start, HH:MM (24h).",
      "type": "string",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
    },
    "endTime": {
      "description": "Timed events: the Berlin wall-clock end, HH:MM (24h), on endDate.",
      "type": "string",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
    }
  },
  "required": [
    "eventId",
    "title",
    "kind",
    "date"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `event`: the event as it is now.

**Its errors:** `NOT_FOUND` (404), `NOT_CONFIGURED` (503), `UNAVAILABLE` (503). Every call can also get the endpoint's codes (above).

**Say back:** "Moved <title> to <day> <time>."

### `delete_event`: Delete a calendar event

Deletes an event from the house calendar.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `destructive`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |
| Calls out | yes (Google or brain): may answer 503 `NOT_CONFIGURED` or `UNAVAILABLE` |

**When to use it.** Only when someone clearly asks to remove an event. Name the exact event (title and day) on the confirm card.

**Tool description** (the registry's, verbatim): Deletes an event from the house calendar, by its id from list_events. Always confirm with the person first.

**Examples.**

- "cancel dinner with Anna on Saturday" → `delete_event {"eventId": "<id from list_events>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "eventId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_]{5,1024}$",
      "description": "The event's id, from list_events."
    }
  },
  "required": [
    "eventId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `eventId` and `title` of the deleted event.

**Its errors:** `NOT_FOUND` (404), `NOT_CONFIGURED` (503), `UNAVAILABLE` (503). Every call can also get the endpoint's codes (above).

**Say back:** "Deleted <title>."

### `list_notes`: Notes

The household message board.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "what's on the board?", and to find a `noteId` before changing, pinning or deleting a note.

**Tool description** (the registry's, verbatim): Lists the household's notes, pinned ones first and then the most recently changed, each with its id, title, markdown body, colour, whether it is pinned to the hub, who wrote it (member id and name) and when it was created and last changed (ISO 8601, UTC). Notes are shared household text, never secrets.

**Examples.**

- "what's pinned on the board?" → `list_notes {"pinnedOnly": true}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "pinnedOnly": {
      "description": "Only the pinned notes (the hub shows these). Default false.",
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "enum": [
            "true",
            "false",
            "on"
          ]
        }
      ]
    },
    "limit": {
      "description": "How many notes at most. Default 100.",
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  },
  "additionalProperties": false
}
```

**Returns** (`data`): `notes`: id, title, markdown body, colour, pinned, author, created and changed times.

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** Titles first, pinned ones marked; the body only when asked.

### `create_note`: Add a note

Posts a note on the household message board.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `safe`: runs straight away for the asker; on a housemate's behalf it needs `X-Baumy-Confirmed: 1` |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** For "put a note up: …". Never put a secret (door code, wifi password, bank details) in a note; brain keeps those encrypted itself. For something everyone must see now, create_reminder is better.

**Tool description** (the registry's, verbatim): Adds a note for the household: a short title, an optional markdown body (bold, italic, lists, links), an optional colour and whether to pin it to the hub and the kitchen screen. Never put secrets (passwords, codes that unlock anything) in a note.

**Examples.**

- "put a note up: recycling goes out on Tuesdays" → `create_note {"title": "Recycling", "bodyMd": "Goes out on **Tuesdays**."}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80,
      "description": "A short title."
    },
    "bodyMd": {
      "description": "The note itself, in markdown (bold, italic, lists, links). Optional.",
      "type": "string",
      "maxLength": 2000
    },
    "color": {
      "description": "The note's colour, or \"none\". Default none.",
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "yellow",
            "pink",
            "blue",
            "green",
            "orange",
            "purple"
          ]
        },
        {
          "type": "string",
          "const": "none"
        }
      ]
    },
    "pinned": {
      "description": "Pin it to the hub and the kitchen screen. Default false.",
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "enum": [
            "true",
            "false",
            "on"
          ]
        }
      ]
    }
  },
  "required": [
    "title"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `note`: the note as stored, with its `id`.

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** "Posted <title> on the board."

### `update_note`: Change a note

Rewrites a note: title, body and colour are all replaced.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** When someone changes a note. Read it first and send the whole note; a body or colour left out is emptied.

**Tool description** (the registry's, verbatim): Rewrites a note: its title, markdown body and colour are all replaced, so send the whole note (a body or colour left out is emptied). Pinning is pin_note. Anyone in the household may change any note.

**Examples.**

- "change the recycling note to Wednesdays" → `update_note {"noteId": "<id>", "title": "Recycling", "bodyMd": "Goes out on **Wednesdays**."}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "noteId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The note's id, from list_notes."
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80,
      "description": "The new title."
    },
    "bodyMd": {
      "description": "The new text, in markdown. Leaving it out empties the note.",
      "type": "string",
      "maxLength": 2000
    },
    "color": {
      "description": "The colour, or \"none\". Leaving it out makes the note plain.",
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "yellow",
            "pink",
            "blue",
            "green",
            "orange",
            "purple"
          ]
        },
        {
          "type": "string",
          "const": "none"
        }
      ]
    }
  },
  "required": [
    "noteId",
    "title"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `note`: the note as it is now.

**Its errors:** `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** "Updated <title>."

### `pin_note`: Pin a note

Pins a note to the hub and the kitchen screen, or unpins it.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `safe`: runs straight away for the asker; on a housemate's behalf it needs `X-Baumy-Confirmed: 1` |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** For "pin the recycling note" or "take it off the screen".

**Tool description** (the registry's, verbatim): Pins a note to the hub and the kitchen screen (pinned: true), or takes it off (pinned: false).

**Examples.**

- "pin the recycling note" → `pin_note {"noteId": "<id>", "pinned": true}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "noteId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The note's id, from list_notes."
    },
    "pinned": {
      "description": "True to pin it to the hub, false to unpin it.",
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "enum": [
            "true",
            "false",
            "on"
          ]
        }
      ]
    }
  },
  "required": [
    "noteId",
    "pinned"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `note`: the note as it is now.

**Its errors:** `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** "Pinned <title>." or "Unpinned <title>."

### `delete_note`: Delete a note

Deletes a note for everyone.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `destructive`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | the member themself: brain counts as the member (the kiosk would need their PIN) |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** Only when someone clearly asks to remove a note. Name it on the confirm card.

**Tool description** (the registry's, verbatim): Deletes a note for everyone in the household. Always ask before doing this.

**Examples.**

- "delete the recycling note" → `delete_note {"noteId": "<id>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "noteId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The note's id, from list_notes."
    }
  },
  "required": [
    "noteId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `noteId` and `title` of the deleted note.

**Its errors:** `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** "Deleted the note <title>."

### `list_shopping`: Shopping list

The house shopping list, as the kitchen screen shows it. The list is brain's own, so this reads brain back through Olympics.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** Almost never: brain has the list itself (`baumy_list_items`). It exists so every surface can read it.

**Tool description** (the registry's, verbatim): Lists what is on the house shopping list (the same list the house Telegram group keeps with Baumy), oldest first: each item's id, its name and when it was added (ISO 8601, UTC).

**Examples.**

- "(brain reads its own list instead)" → `list_shopping {}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**Returns** (`data`): `items`: id, name, when added.

**Its errors:** `NOT_CONFIGURED` (503), `UNAVAILABLE` (503). Every call can also get the endpoint's codes (above).

**Say back:** Use brain's own list.

### `list_reminders`: Reminders

The reminders on the kitchen screen, who has seen each, and the household's active members.

| | |
| --- | --- |
| Kind | `read` |
| Risk | `safe`: runs straight away, on anyone's behalf too |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` |
| `Idempotency-Key` | not needed |
| Rate limit | 120 per Telegram user and 300 per IP in a minute |

**When to use it.** For "any reminders up?" and "who hasn't seen the plumber one?". Its `members` is also the roster: use it to turn a housemate's name into the member id for X-Baumy-On-Behalf-Of or `doneBy`.

**Tool description** (the registry's, verbatim): Lists the household's active reminders (posted, and neither dismissed nor seen by every member yet), the oldest first, each with its id, title, body, who posted it, when (ISO 8601, UTC), the member ids who have seen it and those still to see it; and the active members (id, name, colour, character).

**Examples.**

- "who hasn't seen the plumber reminder?" → `list_reminders {}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**Returns** (`data`): `members` (id, name, colour, character) and `reminders` (id, title, body, who posted it, when, `seenBy`, `waitingFor`).

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** "<title>: still waiting for <names of waitingFor>." Name people, never ids.

### `create_reminder`: Post a reminder

Posts a full-screen reminder on the kitchen screen until every member has seen it.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `safe`: runs straight away for the asker; on a housemate's behalf it needs `X-Baumy-Confirmed: 1` |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** For something everyone must read (a tradesperson coming, the water off). Not for chores (list_chores) or lasting info (create_note). This is not brain's own timed Telegram reminder: it has no time, it shows now.

**Tool description** (the registry's, verbatim): Posts a reminder for the whole household: a short title and an optional plain-text body of a sentence or two. The kitchen screen shows it full-screen until every member has tapped Seen, or someone dismisses it. For things everyone must read (a tradesperson coming, the water off), not for chores or notes.

**Examples.**

- "put up a reminder: plumber Wednesday 9am, leave the door unlocked" → `create_reminder {"title": "Plumber Wednesday 9:00", "body": "Leave the door unlocked."}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80,
      "description": "A short headline, e.g. \"Handyman on Wednesday\"."
    },
    "body": {
      "description": "A sentence or two of detail, as plain text. Optional.",
      "type": "string",
      "maxLength": 280
    }
  },
  "required": [
    "title"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `reminderId` and `title`.

**Its errors:** none of its own. Every call can also get the endpoint's codes (above).

**Say back:** "It's on the kitchen screen until everyone taps Seen."

### `acknowledge_reminder`: Mark a reminder seen

Marks a reminder as seen by the asker (or, on their behalf, a housemate).

| | |
| --- | --- |
| Kind | `write` |
| Risk | `safe`: runs straight away for the asker; on a housemate's behalf it needs `X-Baumy-Confirmed: 1` |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** For "seen it" / "got it" about a reminder. "Mark it seen for Sam" is X-Baumy-On-Behalf-Of: <Sam's id>, which needs the asker's confirm tap.

**Tool description** (the registry's, verbatim): Records that you have read a reminder. Once every member has, it leaves the kitchen screen for good. Seeing it twice changes nothing.

**Examples.**

- "seen the plumber one" → `acknowledge_reminder {"reminderId": "<id>"}`
- "mark the plumber reminder seen for Sam, he knows" → `acknowledge_reminder {"reminderId": "<id>"} with X-Baumy-On-Behalf-Of: <Sam's id>`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "reminderId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The reminder's id, from list_reminders."
    }
  },
  "required": [
    "reminderId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `reminderId`, `memberId` (who it was marked for) and `seenByEveryone`.

**Its errors:** `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** "Marked seen." Add "Everyone has seen it now, it's off the screen." when `seenByEveryone`.

### `dismiss_reminder`: Dismiss a reminder

Takes a reminder off the kitchen screen for everyone, seen or not.

| | |
| --- | --- |
| Kind | `write` |
| Risk | `confirm`: always send `X-Baumy-Confirmed: 1`, only after the asker tapped the confirm button (428 without it) |
| Who may | any linked member |
| On a housemate's behalf | yes, with `X-Baumy-On-Behalf-Of` and the asker's confirm tap |
| `Idempotency-Key` | required; the same key again replays |
| Rate limit | 30 per Telegram user and 120 per IP in a minute |

**When to use it.** Only when someone asks to take it down (it's no longer true, or it was a mistake).

**Tool description** (the registry's, verbatim): Takes a reminder off the kitchen screen for everyone, whether or not everyone has seen it. Ask first.

**Examples.**

- "take the plumber reminder down" → `dismiss_reminder {"reminderId": "<id>"}`

**Input** (JSON Schema of the body):

```json
{
  "type": "object",
  "properties": {
    "reminderId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "description": "The reminder's id, from list_reminders."
    }
  },
  "required": [
    "reminderId"
  ],
  "additionalProperties": false
}
```

**Returns** (`data`): `reminderId` and `title`.

**Its errors:** `NOT_FOUND` (404). Every call can also get the endpoint's codes (above).

**Say back:** "Took <title> off the kitchen screen."

## 8. Not available to Baumy

- `update_my_profile`: The member's own account settings: only in the app, signed in.
- `update_avatar`: The member's own account settings: only in the app, signed in.
- `redeem_invite`: Joining the household: only in the app, signed in.
- `join_as_founder`: Joining the household: only in the app, signed in.
- `mint_invite`: An admin action: UI only (SPEC §12 decision 10).
- `revoke_invite`: An admin action: UI only (SPEC §12 decision 10).
- `manage_members`: An admin action: UI only (SPEC §12 decision 10).
- `set_kiosk_pin`: The member's own account settings: only in the app, signed in.
- `create_telegram_link_code`: The member's own account settings: only in the app, signed in.
- `authorize_mcp_client`: The member's own account settings: only in the app, signed in.
- `list_mcp_connections`: The member's own account settings: only in the app, signed in.
- `revoke_mcp_connection`: The member's own account settings: only in the app, signed in.
- `pair_kiosk`: An admin action: UI only (SPEC §12 decision 10).
- `revoke_kiosk`: An admin action: UI only (SPEC §12 decision 10).
- `check_kiosk_pin`: Checks a PIN typed on the kitchen screen; only the kiosk has one.
- `manage_chore`: An admin action: UI only (SPEC §12 decision 10).
- `resolve_dispute`: An admin action: UI only (SPEC §12 decision 10).
- `attach_completion_photo`: A proof photo arrives only through the app's upload route, which stores the file first; brain cannot send one. Tell the person to attach it in the app.
- `adjust_points`: An admin action: UI only (SPEC §12 decision 10).
- `add_pot_contribution`: An admin action: UI only (SPEC §12 decision 10).
- `set_prize_mode`: An admin action: UI only (SPEC §12 decision 10).
- `schedule_weight`: An admin action: UI only (SPEC §12 decision 10).
- `dismiss_weight`: An admin action: UI only (SPEC §12 decision 10).
- `add_shopping_items`: The shopping list is brain's own (`baumy_list_items`); brain changes it directly, and Olympics calls brain to do the same.
- `check_off_shopping_items`: The shopping list is brain's own; brain ticks items off directly.
