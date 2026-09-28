# Shopping list — a first-class, stateful house list

**Status:** v1 implemented (single `shopping` list). Multi-list is a deferred, additive seam
(`list_name`), no migration required.

## What this adds (v1)

A house member can keep a **shared shopping list** — mostly from a **DM**, so they don't have to
pollute the house group:

- **Add** — "buy milk", "we need bin bags", "add oat milk and coffee" → items go on the house list.
- **Check off** — "got the milk", "bought bin bags", "picked up coffee" → the item leaves the open
  list (recorded as bought, with who + when).
- **Query** — "what's on the shopping list?", "what do we need?" → Baumy replies with the current
  open list.

It works from the house **group** too (someone says "we're out of dish soap" → it goes on the list),
but the DM lane is the point: manage the list privately without adding to the group scroll.

### Why a real table (the graduation rule)

The rest of Baumy's memory is deliberately schema-light — messages + a fuzzy {subject,predicate,
object} fact graph (`docs/spec/memory-core.md`). A shopping list is the textbook case where a domain
**graduates** to its own table (memory-core rule #10): it needs **current-state** ("what's open
*now*"), **uniqueness** (milk listed once, not five times), and **mutation** (add / check off) —
none of which fuzzy fact-memory gives cleanly. So the list is a first-class table
(`baumy_list_items`), distinct from the fact graph. Adding "buy milk" does **not** mint a
`{someone, buy, milk}` fact; the list is the single source of truth for list state (a co-mentioned
*durable* fact in the same message — "buy milk for when Zosia arrives friday" — is still captured
separately, because capture runs orthogonally, before the list op).

## The disposition (injection wall)

**The LLM proposes; deterministic code disposes** — the same wall as every other write:

1. **Propose (routing, Haiku):** the classifier returns a `list` flag ∈ `add | checkoff | query |
   none` (`lib/ai/classify.ts`). Routing only — no items yet. This is orthogonal to the single
   `decide()` Decision, so a list op never competes with reminder/forget/reply.
2. **Gate (deterministic):** `listOpProposed(origin, flag, policyEnabled, decision)`
   (`lib/core/decide.ts`) — requires `mutate_list` allowed for the lane, excludes quarantined
   content, honors pause lane-scoped (group silent when paused; DM still works), and **yields to an
   explicit reminder/forget** (so "remind us to buy bin bags friday" schedules the reminder rather
   than silently just adding bin bags — a list *query* is a question, Decision `reply`, which is
   NOT skipped, so "what's on the list?" still renders it). The caller also requires a non-empty
   house **scope**.
3. **Name the items (Sonnet, best-effort):** `extractListOp` (`lib/ai/list-extract.ts`) returns
   `{op, items}`. A malformed object degrades to `{op:'none'}` → the message falls through to normal
   handling (never crash-loops, never blackholes — MEMORY.md best-effort rule).
4. **Dispose (code):** `addListItems` / `checkOffItems` / `currentList` (`lib/lists/store.ts`) run
   against the group-scoped table. Deterministic acks (`lib/lists/format.ts`) — DM → words, group →
   a quiet reaction chosen from the **store outcome** (K4, chat-understanding-v2 §3): add → ✍ when
   something new went on, 👀 when it was all already listed; check-off → 👍 only when everything named
   was ticked, otherwise the `checkoffAck` words (what wasn't on the list, what's left).

A fully-compromised model can at most return an op enum + item strings; it can never name the scope,
the attribution, or a row id.

## Security invariants (must hold)

- **I1 — Scope from the authenticated lane, never text.** Every read/write keys `group_id` on
  `houseScopeForOrigin(origin, houseChatId)` — so a DM "buy milk" writes THROUGH to the shared house
  list, and a member of house A cannot name house B's list. Empty scope (ignore lane / bot not yet in
  a group) is a no-op.
- **I2 — Attribution is authenticated.** `added_by` / `checked_by` = `String(origin.fromId)`, nulled
  for a missing sender. Never a name lifted from the message body.
- **I3 — Quarantine cannot mutate.** Forwarded/bot content (`memoryTrust === 'quarantined'`) is
  rejected by `listOpProposed` — a housemate cannot launder attacker content onto the list by
  forwarding it into their DM.
- **I4 — Group-scoped every query.** Every `SELECT`/`UPDATE` filters `WHERE group_id = scope`
  (+ `list_name`). No cross-house row is ever readable or mutable.
- **I5 — Low-privilege, auto-commit — NOT confirm-gated.** Adding/checking is the capture/reminder
  tier (reversible, house-scoped) — it auto-commits with **no** confirm tap. The confirm-tap wall
  stays reserved for deletion/`forget` + GitHub issues; do **not** add a `list.*` pendingAction.
- **I6 — Fixed destination + exactly-once.** An ack sends only to `origin.chatId` via the same
  two-target allow-list as a reply (the house group, or the authenticated DM sender's own chat). The
  **mutation** is one memoized `step.run` whose RETURNING-derived result (added / already /
  checked-off) is captured there; the **words ack** is rendered + sent in a *following* step from
  the current list (an idempotent read) through the same `claimReply`/release belt. So a transient
  read/send failure re-runs only the ack step — never the mutation — which keeps the ack truthful
  (no "already there" / "couldn't find it" lie) and the send exactly-once (no double-send / no
  double-add).
- **I7 — Pause narrows, never opens.** A paused *group* processes no list op; a member *DM* still
  does (private, pollutes nothing) — mirrors DM query answering.

## Data model

`baumy_list_items` (`db/schema.ts`, migration `0010`):

- `group_id` (house scope, FK) · `list_name` (default `'shopping'` — the multi-list seam) · `item`
  (display) · `item_normalized` (`lower(trim)` dedupe key) · `added_by` / `checked_by` (member FKs,
  `set null`) · `checked_at` (null = open) · `is_active` (soft-remove) · `created_at`.
- **Partial-unique index** `baumy_list_items_open_uq` on `(group_id, list_name, item_normalized)
  WHERE is_active AND checked_at IS NULL` → **one OPEN copy of an item per house list**. Checking an
  item off drops it out of the predicate, so a later "buy milk again" legitimately creates a fresh
  open row. Dedupe is **exact-normalized only** (precision-first) — "milk" and "almond milk" stay
  distinct; the index is the race backstop, `onConflictDoNothing` + a pre-check give the friendly ack.
- **Check-off matching** (`checkOffItems`): exact normalized first; then a read-side loose key
  (`looseItemKey` — a leading article/quantifier and a plain plural dropped: "got the eggs" ticks
  "egg"), counted only when exactly ONE open item has that key. "milk" never ticks "almond milk" and an
  ambiguous pair is reported as a miss (audit K4, 2026-09-26). The add/dedupe key is unchanged.

## Kitchen API (the kiosk's front door)

The house kitchen kiosk (Baumy Olympics, ADR 0003 there) shares this list over HTTP, so there is
ONE list whether a housemate DMs Baumy or taps the kiosk. `lib/lists/kitchen-api.ts`, routes under
`app/api/kitchen/shopping/` (`runtime = 'nodejs'`, never cached):

| Route | Body | Response |
|---|---|---|
| `GET /api/kitchen/shopping` | — | `{ ok, items: [{ id, item, addedBy, createdAt }] }` (open items, oldest first) |
| `POST /api/kitchen/shopping/add` | `{ items: string[1..30], telegramUserId? }` | `{ ok, added, already, attributedTo, items }` |
| `POST /api/kitchen/shopping/checkoff` | `{ items: string[1..30], telegramUserId? }` | `{ ok, checkedOff, notFound, attributedTo, items }` |

Errors: `401 unauthorized` (missing/wrong token, or `KITCHEN_API_TOKEN` unset), `503 not_configured`
(no house yet), `400 bad_request` (malformed body).

Invariants:

- **K-I1 — Token wall.** `Authorization: Bearer $KITCHEN_API_TOKEN`, compared in constant time
  (`tokenMatches` in `lib/telegram/verify.ts`, shared with the webhook). An unset token authorizes
  nobody. The dashboard `middleware.ts` matcher (`/admin/:path*`) does not cover these routes — a kiosk
  has no session cookie.
- **K-I2 — Scope from config, never the request.** The house is `getHouseChatId(db)` — the stable
  SCOPE id, honouring the `BAUMY_HOUSE_CHAT_ID` pin, never the send id. A `groupId` in the query or
  body is ignored. `''` (the bot has not been added to a group) → `503 not_configured` before any read
  or write. A write registers the scope chat (`ensureRegistered`, idempotent) for the FK, as the
  Telegram lane does.
- **K-I3 — Attribution only for a real member.** `added_by`/`checked_by` is `null`, or the supplied
  `telegramUserId` when it is an ACTIVE roster member (`mapMember`); an unknown or deactivated id is
  attributed to nobody (`attributedTo: null` in the response). The kiosk is one shared device, so this
  is a convenience label, not authentication.
- **K-I4 — Same dispose layer.** `addListItems` / `checkOffItems` / `currentList` unchanged: re-adding
  an open item is a no-op (`already`, partial-unique index backstop); check-off is exact-normalized
  then the unambiguous loose key. Like the Telegram lane it auto-commits (capture tier, I5).

## Deliberately deferred

- **Multi-list** (`todo`, `guests`, …): `list_name` exists; wiring a second list is additive, no
  migration.
- **Remove-without-buying** (distinct from "bought"): `is_active` soft-remove exists in the schema;
  no op surfaces it in v1 (check-off covers "it's handled").
- **Fuzzy check-off matching** beyond articles/plurals (typos, synonyms — "semi-skimmed" for "milk"):
  still a miss ("couldn't find X") rather than a guess — precision-first.
- **Quantities / provenance link**: folded into the item string for now; a structured `quantity`
  column or a `source_memory_item_id` lineage link (mirroring `docs/spec/fact-lineage.md`) is an
  additive future column.
