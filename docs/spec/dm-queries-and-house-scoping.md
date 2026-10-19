# DM queries & house-scoping (resilient single→multi-house model)

**Status:** v1 implemented (single-house). Multi-house sections are a *design*, deliberately
deferred as an additive flip — no v1 migration.

## What this adds (v1)

A house member can **DM Baumy to get info privately** instead of asking in the group:

- **Free-form Q&A in a DM** — "when's bin day?", "who cleaned the sink?", "what's the wifi
  password?", "catch me up on this week" — answered **privately in the DM**, grounded in the
  **house** group's shared memory. No new commands; plain DM text is the surface.
- **DM answers work even when the owner has `/paused`** the bot. Pause silences the *group*;
  a private 1:1 query pollutes nothing, so it still answers. (Pause bypass is lane-scoped to
  `member_dm`; the house lane and reminder delivery still honor pause.)
- **A fact stated in a DM writes through to shared house memory** at trust `trusted` — it can
  supersede group-origin facts (which are `untrusted`/`observed`), never a `system` (reflect)
  fact. This is the one deliberate write from the private channel.

Baumy **cannot** initiate a DM (Telegram 403 until the user messages it first), and the spec
forbids a per-user push lane — so "updates" here are strictly **pull**: the member always
speaks first. There is no DM notification.

## The core realization: scope ≠ destination ≠ identity

Today the code conflates three values because in the house lane they are numerically equal
(`chatId === houseChatId === group_id`):

| Concept | Question | v1 source | Key used for |
| --- | --- | --- | --- |
| **Scope** | *whose data?* | `addressingFor(origin, house, roster, threadId).scope` | the `group_id` on every read/write (retrieve, facts, capture, reminder) |
| **Destination** | *where does the reply go?* | `addressingFor(…).reply` (= `origin.chatId`, or null off the belt) | `send` (`lib/telegram/send.ts`) / `reactToMessage` target |
| **Identity** | *who is speaking?* | `origin.fromId` (vs roster) | attribution, membership, authz |

A member DM is exactly where they diverge: **scope = the house**, **destination = the private
chat**, **identity = the member**. Two pre-existing spots already had to un-collapse this by
hand — the report path (`scope = houseChatId || chatId`) and per-reminder `deliverChatId`.
This feature makes the split a named seam instead of an ad-hoc `||`.

## The seam (v1 code)

`addressingFor(origin, house, roster, threadId).scope` (`lib/core/origin.ts`) — the *scope*
resolver. Derived from the **authenticated lane** (never from message text — injection wall):

- `house` or `member_dm` → `houseChatId` (v1 has one house; the `member_dm` lane already
  required `roster.isMember`, so the member belongs to it).
- anything else → `''` ("nothing in scope").

In the ingest handler this scope drives **every** read/write (`captureMemory`, `reconcileFact`,
`retrieve`/`retrieveExpanded`, `currentFactsForQuery`, reminder `groupId`, forget resolution),
while `origin.chatId` drives every **send**. In the house lane the two are equal, so behavior
is byte-for-byte identical; in a DM they correctly diverge.

## Security invariants (must hold)

- **I1 — Scope is from authenticated membership, never text/LLM.** A member of house A must be
  structurally incapable of naming house B's scope. `addressingFor` keys off the lane,
  which is transport-derived.
- **I2 — DM reply destination is exactly `origin.chatId`.** The reply/ack goes only to the
  authenticated sender's own private chat — never `houseChatId`, never an LLM-supplied id. The
  reply step enforces a **two-target allow-list** (house group *or* the sender's DM), replacing
  the old `if (chatId !== houseChatId) return` guard — relaxed, not deleted.
- **I4 — DM writes are scoped + trust-gated.** `reconcileFact(groupId = scope, trust =
  origin.memoryTrust)`. `trusted` (rank 3) may supersede group `untrusted` (rank 2), never
  `system` (rank 4).
- **I5 — Quarantine survives the DM lane.** Forwarded/bot content in a DM stays `quarantined`,
  is never attributed, never grounds a reply, `reconcileFact → rejected`. A member cannot
  launder attacker content to `trusted` by forwarding it into their DM.
- **I6 — Secrets: DM is an allowed decrypt sink, exfil wall unchanged.** A DM is *more* private
  than the group (one authenticated reader), so decrypt-to-answer on a direct request is
  correct. The DM reply funnels through the **same** `runReplyBody`, so the web-search path
  still receives only `!isSecure` rows.
- **I7 — Pause narrows, never opens.** The pause bypass is gated to `member_dm` only.
- **I8/I9 — Exactly-once + live fail-closed roster.** DM reply claims on the unique `updateId`
  with release-on-failure; membership is re-checked per update; a left member → `ignore`.

### Documented residual risks

- **Trusted-DM fact poisoning.** A compromised member account can write `trusted` facts from a
  DM with no confirm-tap (capture auto-commits; only *forget* is tap-gated). Contained: capped
  below `system`, `authoredBy` retained for retraction, forget-reversible, dashboard-auditable.
  Higher blast radius than a group write — accepted per the owner's decision to allow DM writes.
- **Pause ≠ DM-off.** `/pause` no longer silences DMs. The owner's mental model must include
  "members can still DM me while paused." A separate full kill-switch is a possible follow-up.

## Multi-house (deferred design — DO NOT build without an explicit decision)

v1 is single-tenant by spec (`00-decisions.md:94`); this only records how expansion stays
*additive*. Verified blocker: **`baumy_members` PK is global** (`telegram_user_id`), and six
FKs depend on it — so a user belongs to exactly one house today, and you **cannot** flip the
members PK to composite.

- **Membership → a join table.** Add `baumy_house_members (telegram_user_id, group_id)` with
  per-house `role`/`can_access_dashboard`/`dm_chat_id`, composite PK **there** (not on
  `members`, which stays the global human-identity FK anchor). Backfill one row per member.
  `resolveHousesForMember(db, fromId): HouseRef[]` then returns all active rows; `houseScopeFor*`
  widens from scalar to list. Additive + reversible.
- **`house_config` singleton → `baumy_houses`** rows (per-house timezone/policy/spend). Two-phase
  backfill; singleton stays authoritative until readers repoint. `BAUMY_HOUSE_CHAT_ID` becomes
  the *primary/default* pin (never enumerates N houses); `BAUMY_OWNER_ID` stays a global owner.
- **`HouseRef`** — `{ houseGroupId (the only scope key), houseId?, name?, timezone }`. Only
  `houseGroupId` is ever a query key, so a real `houseId` later changes no queries.
- **DM disambiguation UX** — when a member is in >1 house: **sticky active house**, seeded by an
  **ask-once**, switched by explicit `/house`, with the active house **shown on every answer**
  (`(House: Baker St)`). Reject per-query inference — a silent scope guess is a cross-house leak.
- **Coupling points that stay single-house in v1** and flip later: `loadRoster`/`upsertMember`
  (the hardest — isolate the `onConflict` target), `resolveOrigin*` (accept a house-id list),
  reflect/dispatch crons (loop over houses), dashboard (house-switcher + per-house authz).

The MVP writes **zero migrations**: every resilient move is a code seam over the existing
schema. The two schema changes above are additive + reversible and deferred until a real 2nd
house exists.
