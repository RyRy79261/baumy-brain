# Shopping list — a first-class, stateful house list

**Status:** v1 implemented (single `shopping` list); remove and rename added 2026-10-13 (issue #23). Multi-list is a deferred, additive seam
(`list_name`), no migration required.

## What this adds (v1)

A house member can keep a **shared shopping list** — mostly from a **DM**, so they don't have to
pollute the house group:

- **Add** — "buy milk", "we need bin bags", "add oat milk and coffee" → items go on the house list.
- **Check off** — "got the milk", "bought bin bags", "picked up coffee" → the item leaves the open
  list (recorded as bought, with who + when).
- **Remove** (2026-10-13, issue #23) — "remove milk", "take bin bags off the list" → the item leaves
  the open list WITHOUT being bought (a soft remove; never recorded as bought).
- **Rename** (2026-10-13, issue #23) — "change mlik to milk" → the item now reads "milk". If "milk" is
  already on the list, the old "mlik" is removed instead, so the list never holds two copies (a merge).
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

1. **Propose (routing, Haiku):** the classifier returns a `list` flag ∈ `add | checkoff | remove |
   rename | query | none` (`lib/ai/classify.ts`; `remove` / `rename` added 2026-10-13, issue #23). Routing only — no items yet. This is orthogonal to the single
   `decide()` Decision, so a list op never competes with reminder/forget/reply.
2. **Gate (deterministic):** `listOpProposed(origin, flag, policyEnabled, decision)`
   (`lib/core/decide.ts`) — requires `mutate_list` allowed for the lane, excludes quarantined
   content, honors pause lane-scoped (group silent when paused; DM still works), and **yields to an
   explicit reminder/forget** (so "remind us to buy bin bags friday" schedules the reminder rather
   than silently just adding bin bags — a list *query* is a question, Decision `reply`, which is
   NOT skipped, so "what's on the list?" still renders it). The caller also requires a non-empty
   house **scope**.
3. **Name the items (Sonnet, best-effort):** `extractListOp` (`lib/ai/list-extract.ts`) returns
   `{op, items, renames?}` — `renames` is `[{from, to}]`, item TEXT only, for a `rename`. A malformed object degrades to `{op:'none'}` → the message falls through to normal
   handling (never crash-loops, never blackholes — MEMORY.md best-effort rule).
4. **Dispose (code):** `addListItems` / `checkOffItems` / `removeItems` / `renameItem` / `currentList`
   (`lib/lists/store.ts`) run against the group-scoped table. Deterministic acks (`lib/lists/format.ts`) — DM → words, group →
   a quiet reaction chosen from the **store outcome** (K4, chat-understanding-v2 §3): add → ✍ when
   something new went on, 👀 when it was all already listed; check-off → 👍 only when everything named
   was ticked, otherwise the `checkoffAck` words (what wasn't on the list, what's left); remove and
   rename the same way → 👍 only when everything named was changed, otherwise the `removeAck` /
   `renameAck` words, which say what wasn't found and that nothing changed for it.

A fully-compromised model can at most return an op enum + item strings (and `from → to` pairs); it can
never name the scope, the attribution, or a row id.

## Security invariants (must hold)

- **I1 — Scope from the authenticated lane, never text.** Every read/write keys `group_id` on
  `houseScopeForOrigin(origin, houseChatId)` — so a DM "buy milk" writes THROUGH to the shared house
  list, and a member of house A cannot name house B's list. Empty scope (ignore lane / bot not yet in
  a group) is a no-op.
- **I2 — Attribution is authenticated.** `added_by` / `checked_by` / `removed_by` / `renamed_by` =
  `String(origin.fromId)`, nulled
  for a missing sender. Never a name lifted from the message body.
- **I3 — Quarantine cannot mutate.** Forwarded/bot content (`memoryTrust === 'quarantined'`) is
  rejected by `listOpProposed` — a housemate cannot launder attacker content onto the list by
  forwarding it into their DM.
- **I4 — Group-scoped every query.** Every `SELECT`/`UPDATE` filters `WHERE group_id = scope`
  (+ `list_name`). No cross-house row is ever readable or mutable.
- **I5 — Low-privilege, auto-commit — NOT confirm-gated.** Adding / checking / removing / renaming is
  the capture/reminder tier (a remove is soft and a re-add brings the item back) (reversible, house-scoped) — it auto-commits with **no** confirm tap. The confirm-tap wall
  stays reserved for deletion/`forget` + GitHub issues; do **not** add a `list.*` pendingAction.
- **I6 — Fixed destination + exactly-once.** An ack sends only to `origin.chatId` via the same
  two-target allow-list as a reply (the house group, or the authenticated DM sender's own chat). The
  **mutation** is one memoized `step.run` whose RETURNING-derived result (added / already /
  checked-off / removed / renamed) is captured there; the **words ack** is rendered + sent in a *following* step from
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
  `set null`) · `checked_at` (null = open) · `is_active` (soft-remove) · `removed_by` / `removed_at`
  (who took it off WITHOUT buying it, and when) · `renamed_by` / `renamed_at` (the last rename) ·
  `created_at`. The four removed/renamed columns are migration `0025` (2026-10-13, issue #23).
- **Partial-unique index** `baumy_list_items_open_uq` on `(group_id, list_name, item_normalized)
  WHERE is_active AND checked_at IS NULL` → **one OPEN copy of an item per house list**. Checking an
  item off drops it out of the predicate, so a later "buy milk again" legitimately creates a fresh
  open row. Dedupe is **exact-normalized only** (precision-first) — "milk" and "almond milk" stay
  distinct; the index is the race backstop, `onConflictDoNothing` + a pre-check give the friendly ack.
- **Check-off matching** (`checkOffItems`): exact normalized first; then a read-side loose key
  (`looseItemKey` — a leading article/quantifier and a plain plural dropped: "got the eggs" ticks
  "egg"), counted only when exactly ONE open item has that key. "milk" never ticks "almond milk" and an
  ambiguous pair is reported as a miss (audit K4, 2026-09-26). The add/dedupe key is unchanged.

### Remove and rename (2026-10-13, issue #23)

The owner asked for both, on the kitchen screen and in Telegram ("remove milk", "change mlik to milk").

- **Remove** (`removeItems`): the same matching as a check-off (exact normalized, then the ONE open
  item with that loose key). A matched row gets `is_active = false`, `removed_at`, `removed_by`. It is
  **not** a bought record: `checked_at` / `checked_by` stay NULL, so nothing that reads purchases
  counts it. A re-add later creates a fresh open row (the row left the partial-unique predicate).
- **Rename** (`renameItem`, one item at a time): `from` is matched like a check-off; `to` is the new
  display text (trimmed, clamped to 80 characters). Outcomes:
  - `renamed` — the same row now reads `to` (`item` and `item_normalized` change; its id and
    `added_by` stay; `renamed_by` / `renamed_at` are set). A case-only fix ("Milk" → "milk") renames in
    place.
  - `merged` — `to` (exact normalized, the add/dedupe key) is ALREADY open as another row, so the old
    row is removed (as a remove above, attributed to the renamer) instead of making a second copy. If a
    concurrent add of `to` wins the partial-unique index between the check and the write, the unique
    violation is caught and the rename becomes this merge.
  - `unchanged` — `to` is exactly the current text: nothing to do.
  - `not_found` — no open item matches `from`, or more than one does: nothing changes.
- **A miss changes nothing.** A missing or ambiguous match is reported (`notFound` / `not_found`), and
  the ack says what wasn't found — never a guess.
- **Same walls as add / check-off.** Group-scoped (I1, I4), attributed from the authenticated sender
  or the kiosk's mapped member (I2, K-I3), quarantined and forwarded content can never trigger either
  (I3, `listOpProposed`), no confirm tap (I5), the mutation is one memoized step (I6), and every
  remove or rename that changed the list asks for the shopping-topic repost.

## Kitchen API (the kiosk's front door)

The house kitchen kiosk (Baumy Olympics, ADR 0003 there) shares this list over HTTP, so there is
ONE list whether a housemate DMs Baumy or taps the kiosk. `lib/lists/kitchen-api.ts`, routes under
`app/api/kitchen/shopping/` (`runtime = 'nodejs'`, never cached):

| Route | Body | Response |
|---|---|---|
| `GET /api/kitchen/shopping` | — | `{ ok, items: [{ id, item, addedBy, createdAt }] }` (open items, oldest first) |
| `POST /api/kitchen/shopping/add` | `{ items: string[1..30], telegramUserId? }` | `{ ok, added, already, attributedTo, items }` |
| `POST /api/kitchen/shopping/checkoff` | `{ items: string[1..30], telegramUserId? }` | `{ ok, checkedOff, notFound, attributedTo, items }` |
| `POST /api/kitchen/shopping/remove` (2026-10-13) | `{ items: string[1..30], telegramUserId? }` | `{ ok, removed, notFound, attributedTo, items }` |
| `POST /api/kitchen/shopping/rename` (2026-10-13) | `{ from: string, to: string, telegramUserId? }` (each trimmed, 1..200) | `{ ok, outcome: 'renamed' \| 'merged' \| 'unchanged' \| 'not_found', from, to, attributedTo, items }` |

`items` in every write response is the open list after the write, in the `GET` shape. For a rename,
`from` is the open item it matched (or what was sent, when nothing matched) and `to` is the item as it
now reads (for `merged`, the copy that was already open). `not_found` is a `200`, not an error: it
changed nothing.

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
- **K-I3 — Attribution only for a real member.** `added_by` / `checked_by` / `removed_by` /
  `renamed_by` is `null`, or the supplied
  `telegramUserId` when it is an ACTIVE roster member (`mapMember`); an unknown or deactivated id is
  attributed to nobody (`attributedTo: null` in the response). The kiosk is one shared device, so this
  is a convenience label, not authentication.
- **K-I4 — Same dispose layer.** `addListItems` / `checkOffItems` / `removeItems` / `renameItem` /
  `currentList`, the same functions the Telegram lane calls: re-adding an open item is a no-op
  (`already`, partial-unique index backstop); check-off, remove and a rename's `from` are
  exact-normalized then the unambiguous loose key. Like the Telegram lane it auto-commits (capture tier, I5).

## Shopping topic (2026-10-13, issue #21)

The house can give the list its own forum topic. Baumy keeps the whole open list posted there, so
anyone can open the topic and see what to buy.

**Setting it.** A housemate sends `/shoppinghere` inside the topic (`/shoppingoff` turns it off). Code
handles it with no model involved (`lib/turn/commands.ts`):

- **Who:** an active roster member, any role, in the house lane, speaking in their own words. A
  forwarded message, an anonymous-admin post, a bot post, a DM and a foreign group are all refused.
  Refused means the command falls through to the house-group rule for unknown commands and is dropped
  (I7). This is wider than `/notifyhere` and `/baumyhere`, which only the owner may run, because the
  list belongs to the whole house.
- **Where:** `/shoppinghere` must come from inside a topic. The thread id it stores is the message's
  Telegram-authenticated `message_thread_id` (`house_config.shopping_thread_id`, migration 0024),
  never text. In the General topic nothing is stored, and Baumy says to run it inside a topic.
- `/shoppingoff` clears the topic and takes the last list message down. It deletes the message, or,
  if Telegram refuses, edits it to `This list is no longer updated.` It also clears the stored message
  id. Both commands are audited (`shopping.topic.set`) and confirmed in the chat where they were
  sent. `/shoppinghere` also asks for a repost, so the list shows up in the new topic without waiting
  for the next change.

**Reposting.** Every change to the list asks for a repost: an add, check-off, remove or rename from
Telegram (`runList`, and only when something was added, ticked, removed or renamed) and a kitchen API
add, check-off, remove or rename (`handleAdd` / `handleCheckOff` / `handleRemove` / `handleRename`, on
the same condition: a rename only when its outcome is `renamed` or `merged`). These are all the writers of
`baumy_list_items` today; a new one must call `requestShoppingRepost` too. The request is a
`lists/shopping.changed` event sent to Inngest. The `shopping-repost` function is **debounced for 2
minutes, keyed by the house** (`event.data.groupId`). It runs about 2 minutes after the LAST change,
so a burst of adds becomes one post. A concurrency limit of 1 per house means two runs never race on
the stored message id. The request is best-effort: if it fails, the list write still stands, and the
next change brings the topic up to date.

The run (`lib/lists/board.ts` `runShoppingRepost`):

1. Reads the house config. With no shopping topic it does **nothing**. With the house paused
   (`/pause`) it posts nothing either, like every other proactive post to the house group. Turning
   Baumy back on, with `/resume` or the dashboard switch, asks for a repost
   (`requestShoppingRepostForHouse`), so changes made while paused show up.
2. Posts the whole open list as ONE message in the topic, to the house's live send id. It is **not
   pinned**, because each pin adds a service line to the topic. If Telegram reports that the topic is
   gone or closed (`message thread not found`, `TOPIC_CLOSED`, `TOPIC_DELETED`), the run does not
   throw, so Inngest does not retry it. Instead it clears `shopping_thread_id`, audited as
   `shopping.topic.cleared`, and stops. The clear is compare-and-set: it only clears the topic this
   run tried to post in. Later changes then do nothing, instead of failing three times each. Any other
   send error is thrown, and Inngest retries it.
3. Swaps the new message's chat and id into `shopping_message_chat_id` / `shopping_message_id`, and
   gets back the previous ones, in **one statement** (`swapStoredBoard`). The statement locks the row
   with `FOR UPDATE`, so it reads and writes the row together. Inngest's concurrency limit applies to
   steps, not whole runs, so two reposts can interleave. Even then, each run gets a different previous
   post: the first gets the one before both runs, and the second gets the first run's post. Each run
   retires exactly the one it got back, so no post is orphaned.
4. Deletes that previous list message. Telegram refuses some deletes (for example, a message more than
   48 hours old). In that case Baumy **edits** the old message to `⬇️ The list moved down.`, so there
   are never two lists that both look current. If the edit fails too, it logs a warning and moves on.

Each stage is its own Inngest step, so a retry never posts twice.

**The message.** It is plain text, with no `parse_mode`, so item text can never become markup:

```
🛒 Shopping list (3)
• milk
• bin bags
• oat milk
```

An empty list posts `The list is empty.` Items are untrusted text, both from chat and from the kiosk.
Before an item is printed, it is collapsed to one line, so it can't fake a line of its own. These
characters are stripped:

- control characters;
- bidi marks, overrides and isolates;
- zero-width characters, the word joiner and the invisible operators (U+2060–U+2064);
- the Arabic letter mark;
- the soft hyphen;
- the BOM.

An `@` that starts a word, a `#` followed by any letter or digit, a `$` followed by a letter, and a `/`
that starts a word are swapped for their look-alikes (`＠`, `＃`, `＄`, `∕`). Telegram therefore never turns an
item into a mention that pings someone, a hashtag, a cashtag or a tappable `/command`. A list too long
for one Telegram message (4096 characters) ends with `…and N more.`

**Not in the conversation window.** The list post is Baumy's own send, but it is a status board, not
conversation. Like the sign-in card, it skips the window (`sendShoppingBoard` in
`lib/telegram/client.ts`). Each change would otherwise add a full copy of the list to the topic's
window, and those copies would crowd real turns out of the 12 that the models read. A copy is also
out of date after the next change. When someone asks "what's on the list?", Baumy reads the table
itself, so the models never need the board.

## Deliberately deferred

- **Multi-list** (`todo`, `guests`, …): `list_name` exists; wiring a second list is additive, no
  migration.
- **Fuzzy check-off matching** beyond articles/plurals (typos, synonyms — "semi-skimmed" for "milk"):
  still a miss ("couldn't find X") rather than a guess — precision-first.
- **Quantities / provenance link**: folded into the item string for now; a structured `quantity`
  column or a `source_memory_item_id` lineage link (mirroring `docs/spec/fact-lineage.md`) is an
  additive future column.
