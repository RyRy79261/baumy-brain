# Shopping list — a first-class, stateful house list

**Status:** v1 implemented (single `shopping` list); remove and rename added 2026-10-13 (issue #23); the
live, pinned, tap-to-tick list replaced the shopping-topic repost 2026-10-13 (issue #25, §Live list).
Multi-list is a deferred, additive seam (`list_name`), no migration required.

## What this adds (v1)

A house member can keep a **shared shopping list** — mostly from a **DM**, so they don't have to
pollute the house group:

- **Add** — "buy milk", "we need bin bags", "add oat milk and coffee" → items go on the house list.
- **Check off** — "got the milk", "bought bin bags", "picked up coffee" → the item leaves the open
  list (recorded as bought, with who + when). On the live list it stays, ticked (☑), until someone
  taps "Clear done" (2026-10-13, issue #25). A tap on its button does the same as these words.
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
   `renameAck` words, which say what wasn't found, what matched more than one item, and that nothing
   changed for those. A rename that **merged** is always words, in the group too (`Merged "mlik" into
   "milk" — it was already on the list.`), because a bare 👍 would hide that the old item is gone.

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
- **I5 — Low-privilege, auto-commit — NOT confirm-gated.** Adding / checking / removing / renaming (and
  ticking, un-ticking or clearing on the live list by tap) is
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
  `cleared_at` (migration `0026`, issue #25) — a bought row stays on the live list, ticked, until
  "Clear done" sets it; null on an open row. Custom migration `0027` backfilled
  `cleared_at = checked_at` for rows bought before the live list (idempotent: only rows whose
  `cleared_at` is still null), so old purchases never show up as ticked items.
- `baumy_house_config.shopping_updated_by` / `shopping_updated_at` (migration `0026`) — who last
  changed the list and when, for the live list's "Last updated by" line. The id is an authenticated
  actor (a chat sender, a tapper, the kiosk's mapped member); one that is not a member row is stored
  as null. `shopping_message_chat_id` / `shopping_message_id` / `shopping_thread_id` (migration
  `0024`) now hold the live list and its topic.
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
  - `not_found` — no open item matches `from`: nothing changes.
  - `ambiguous` — `from` loosely fits more than one open item (`matches` names them): nothing changes.
- **A miss changes nothing.** A missing match is reported as not found; an ambiguous one separately,
  with the items it could mean (`ambiguous: [{item, matches}]` for a remove, outcome `ambiguous` +
  `matches` for a rename), and the ack asks which one — never a guess. (A check-off keeps folding an
  ambiguous name into `notFound`, its K4 wording.)
- **Routing.** `remove` / `rename` are for SHOPPING items only: the triage and extractor prompts say
  that removing or renaming a calendar event, a chore, a reminder or a house fact ("remove dinner from
  the calendar", "rename the wifi to BaumyNet") is list `none`.
- **Same walls as add / check-off.** Group-scoped (I1, I4), attributed from the authenticated sender
  or the kiosk's mapped member (I2, K-I3), quarantined and forwarded content can never trigger either
  (I3, `listOpProposed`), no confirm tap (I5), the mutation is one memoized step (I6), and every
  remove or rename that changed the list signals the live list (§Live list).

## Kitchen API (the kiosk's front door)

The house kitchen kiosk (Baumy Olympics, ADR 0003 there) shares this list over HTTP, so there is
ONE list whether a housemate DMs Baumy or taps the kiosk. `lib/lists/kitchen-api.ts`, routes under
`app/api/kitchen/shopping/` (`runtime = 'nodejs'`, never cached):

| Route | Body | Response |
|---|---|---|
| `GET /api/kitchen/shopping` | — | `{ ok, items: [{ id, item, addedBy, createdAt }] }` (open items, oldest first) |
| `POST /api/kitchen/shopping/add` | `{ items: string[1..30], telegramUserId? }` | `{ ok, added, already, attributedTo, items }` |
| `POST /api/kitchen/shopping/checkoff` | `{ items: string[1..30], telegramUserId? }` | `{ ok, checkedOff, notFound, attributedTo, items }` |
| `POST /api/kitchen/shopping/remove` (2026-10-13) | `{ items: string[1..30], telegramUserId? }` | `{ ok, removed, notFound, ambiguous: [{ item, matches }], attributedTo, items }` |
| `POST /api/kitchen/shopping/rename` (2026-10-13) | `{ from: string, to: string, telegramUserId? }` (each trimmed, 1..200) | `{ ok, outcome: 'renamed' \| 'merged' \| 'unchanged' \| 'not_found' \| 'ambiguous', from, to, matches?, attributedTo, items }` (`matches` only with `ambiguous`) |

`items` in every write response is the open list after the write, in the `GET` shape. For a rename,
`from` is the open item it matched (or what was sent, when nothing matched) and `to` is the item as it
now reads (for `merged`, the copy that was already open). `not_found` and `ambiguous` are a `200`,
not an error: they changed nothing.

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

## Live list (2026-10-13, issue #25)

Owner task, 2026-10-13: replace "post the list as a new message" with ONE live list message per house —
posted once, pinned silently, edited in place on every change — where housemates tick items by tapping
inline buttons. It replaces the shopping-topic repost of issue #21 (below).

### The message

`lib/lists/live.ts` `renderLiveList` is pure: rows in, `{ text, keyboard }` out. PLAIN TEXT (no
`parse_mode`).

```
🛒 Shopping list
3 to buy · 1 done
Last updated by Ryan, Tue 13 Oct, 18:05
[ ☐ Ginger ]
[ ☐ bin bags ]
[ ☐ coffee ]
[ ☑ oat milk ]
[ 🧹 Clear done ] [ 🔄 Refresh ]
```

- **Header:** the title; the open count (`N to buy`, `· N done` when something is ticked, `Nothing to
  buy.` for an empty list, `Nothing left to buy` when everything is ticked); `Last updated by <name>,
  <day time>` in the house timezone (Europe/Berlin), without "by" when the change named nobody (the
  kiosk with no member); `Page p of n` when there is more than one page.
- **One button per item per row.** Open items first (`☐ name`, oldest first), then ticked ones
  (`☑ name`, in the order they were ticked). Ticked items stay until "Clear done". Item names appear
  ONLY as button labels: flattened and defanged by `boardItem` (control/bidi/invisible characters
  stripped, `@`/`#`/`$`/`/` sigils swapped for look-alikes) and clipped to 40 characters with `…` (by
  code point). The housemate name in the header gets the same treatment, clipped to 32.
- **Pages of 30** (`SHOP_PAGE_SIZE`). `◀` / `▶` appear only when needed (no `◀` on page 1, no `▶` on the
  last page). An out-of-range page is clamped. After a tap on an item, the page holding that item is
  shown; Refresh and Clear done show page 1; an ordinary change shows page 1.
- **Footer:** `🧹 Clear done` · `🔄 Refresh`, always.

### Callback data

Every button carries one of four shapes, each ≤ 64 bytes (the longest is `shop:chk:` + a uuid = 45):

| Data | Effect |
|---|---|
| `shop:chk:<itemId>` | toggle one item (`itemId` = the row's uuid, lower-case) |
| `shop:clear` | clear every ticked item |
| `shop:refresh` | re-render (page 1) |
| `shop:page:<n>` | show page `n` (1–9999) |

`parseShopCallback` accepts exactly these and refuses anything else (oversized, a non-uuid id, a page
of 0 or with a leading zero, trailing text, other case). Callback data is not trusted just because
Telegram delivered it: a modified client can send any string.

### A tap (`lib/lists/tap.ts`, reached from `runCallback`)

1. **Who:** `runCallback`'s roster check runs first, so only an ACTIVE member's Telegram-authenticated
   `from.id` gets further ("Not authorized." otherwise). The `shop:` branch sits BEFORE the confirm-card
   parse (`c:` / `x:` / `l:`), so list data can never resolve a pending action, and vice versa.
2. **What:** the data must parse; anything else is answered with an empty toast and dropped.
3. **Where:** the tapped message's chat must be the house (`acceptIds`), and the message must be the
   stored live list — the same chat (`shopping_message_chat_id`) AND message id (`shopping_message_id`);
   otherwise the toast says "This list is no longer updated —
   use the pinned one." and nothing changes. Baumy never edits the tapped message in that case (a
   crafted tap on some other Baumy message must not rewrite it).
4. **The change**, in one memoized step (an Inngest retry replays it, never toggles twice):
   - `shop:chk:<id>` → `toggleListItem` **sets the state the tapped button showed** — it does not flip.
     [CORRECTION 2026-10-13, review of PR #26] The webhook finds the tapped button in the keyboard
     Telegram delivers with the callback (`callback_query.message.reply_markup`, whose `callback_data`
     equals the tapped data) and forwards `want`: `tick` for `☐ name`, `untick` for `☑ name`
     (`tapWant`, `lib/lists/live.ts`). That payload arrives over the secret-verified webhook. The
     UPDATE then sets the state outright, guarded: `SET checked_at = now, checked_by = <tapper> WHERE
     id = $id AND group_id = <house scope> AND list_name AND is_active AND cleared_at IS NULL AND
     checked_at IS NULL` for a tick (`… AND checked_at IS NOT NULL`, clearing both, for an untick). It
     is **idempotent**: N housemates tapping the same ☐ at once tick it once (Postgres re-checks the
     guard on the row the first tap left); the rest change nothing and hear "<item> is already ticked"
     (or "<item> is already on the list" for an untick) — tested on real Postgres. When zero rows
     change, the row is re-read by id + scope to tell "already in that state" from gone ("That item
     isn't on the list any more."). The list is re-rendered either way, so a stale keyboard catches
     up. Only when the keyboard cannot be read (an inaccessible message has no `reply_markup`, `want`
     is null) does a tap fall back to a flip computed under the row lock (`CASE WHEN checked_at IS
     NULL …`; concurrent flips serialise, none is lost). The scope comes from config, never from the
     button: another house's item id matches nothing. Re-opening a ticked item that has been re-added
     since would make a second open copy (the partial-unique index refuses it): the ticked row is
     cleared instead and the toast says "<item> is already on the list".
   - `shop:clear` → `clearDoneItems` (sets `cleared_at` on every ticked, uncleared row of the house).
   - `shop:refresh` / `shop:page:<n>` → no change.
   A change stamps `shopping_updated_by` / `shopping_updated_at` with the tapper (a no-op tap does not).
5. **The toast** (`answerCallbackQuery`, always, best-effort, in its own memoized step so a replay
   never answers twice): `✓ Ginger – ticked by Ryan`, `↩ Ginger – back on the list by Ryan`, `Ginger is
   already ticked`, `🧹 Cleared 2 done items`, `Nothing to clear.`, `Up to date.` If the handler fails
   before any toast, the tapper gets `Something went wrong — try again.` at once (the error still
   propagates, so Inngest retries), and `handle-callback-query`'s `onFailure` answers every callback
   whose retries all failed — a button never spins with no word.
6. **The render**, at once (no debounce): a `lists/shopping.render` event; if Inngest cannot be reached,
   the render runs inline.

Taps are list writes: they auto-commit like every list op (I5). They are not a confirm wall.

### Every other change

Every writer of `baumy_list_items` that changed something — `runList` (Telegram text: add, check-off,
remove, rename), the kitchen API (add, check-off, remove, rename) — calls `noteShoppingChange(db, scope,
by)`: stamp who and when, then send `lists/shopping.changed` (no event id). A new writer must call it
too. Best-effort: a failure never fails or retries the write.

`shopping-changed` (Inngest) is **debounced 5 seconds, keyed by the house, with a 30-second timeout**
(Inngest's max wait): it runs 5 seconds after the LAST change, but never later than 30 seconds after
the first, so a long burst still shows. Concurrency 1 per house. It renders nothing itself: it sends
one `lists/shopping.render` (reason `change`).

### The render (`lib/lists/board.ts` `runShoppingRender`, function `shopping-render`)

ONE Inngest function renders, **concurrency 1 per house, no debounce**, for taps, commands and the
debounced change alike — so two renders never interleave, and the last one shows the last state. It is
the only writer of the stored message id (besides `/shoppingoff`'s clear).

[CORRECTION 2026-10-13, review of PR #26] Inngest's concurrency limit bounds executing **steps**, not
whole runs, so two runs' steps can interleave; and a retried step replays the memoized results of the
steps before it. So the list is read and the message built **inside the same step that sends it** (the
edit step `live-render`, the post step `live-post`): every edit carries the list as it is when it goes
out, and a retried edit (a 429) rebuilds its text. A retry still never posts twice: a send and the store
of its id are one step.

1. Load: the event's house must BE the house (one house today); a command's place must be the house
   chat. A `change` render is held while the house is paused (`/pause`); taps and commands still render
   (`/resume` and the dashboard switch send a change signal, so a held edit shows up). No stored live
   message and no place → nothing: **an ordinary change never posts a message**.
2. Edit the stored message in place (`editLiveList`, text + keyboard), compare-and-set on the stored
   id: just before the edit, the stored live message must still be the one being edited (else
   `superseded`, no edit); and if it stopped being the live list WHILE the edit was in flight
   (`/shoppingoff` cleared the id and marked the message), the `This list is no longer updated.` marker
   is put back over the edit. Telegram's `message is not modified` is a success (`unchanged`). A 429 is thrown as `RetryAfterError` with Telegram's
   `retry_after`, so Inngest retries after the wait.
3. If Telegram says the message is gone (`message to edit not found`, `MESSAGE_ID_INVALID`, `message
   can't be edited`): post a new one where the list lived (its stored topic; for `/list`, where the
   command was sent), pin it silently, store its id. Before posting, the stored id is re-read: if it
   changed since the render loaded it (`/shoppingoff`, another post), the render stops (`superseded`).
   The store is compare-and-set on the id it expected; if that loses, the fresh post is deleted again.
   A topic that is gone (`message thread not found`, `TOPIC_CLOSED`, `TOPIC_DELETED`) clears the topic
   and the message (compare-and-set on that topic, audited `shopping.topic.cleared`), with no retries.
4. Pin with `disable_notification` (`pinMessage`). Pinning needs the **Pin messages** admin right; a
   refused pin is logged and returns false — the list is still posted, stored and edited.

### /list, /shoppinghere, /shoppingoff (`lib/turn/commands.ts`)

Any active member, in the house lane, in their own words (a forward, an anonymous-admin post, a bot
post or a DM never runs one; refused commands fall through to the unknown-command drop, I7). The place
is the command's authenticated chat and `message_thread_id` (null = General), never text. Independent
of `/pause`, like the other house commands.

- **`/list`** (in General or a topic): no live list yet → post it HERE, pin it silently, store it (and
  its topic). A live list already exists → **re-render it where it is** (edit) and make sure it is
  pinned. If it lives in another place than where `/list` was sent, Baumy also replies there with
  `🛒 The live shopping list is pinned here: <link>` (a `t.me/c/…` link to the message) — it does not
  move. If the stored message is gone, the new one is posted where `/list` was sent.
- **`/shoppinghere`** (inside a topic) = `/list` here, but it **moves** the list: if the live list
  lives elsewhere, a new one is posted and pinned here, then the old one is unpinned and deleted (or
  edited to `This list is no longer updated.`, buttons gone, when Telegram refuses the delete). Audited
  `shopping.topic.set`; Baumy confirms in the topic. In General it moves nothing and says to run it
  inside a topic (or use `/list`).
- **`/shoppingoff`**: clears the topic (audited), then `retireShoppingBoard`: the stored id is cleared
  FIRST (so no render can edit or re-post it), then the message is unpinned and deleted, or edited to
  `This list is no longer updated.` without buttons. Baumy confirms.

**One live list per house — General vs a topic (decision, 2026-10-13).** The house has exactly one
live message. `/list` never makes a second one and never moves it: it re-renders the existing one in
place and points to it. Only `/shoppinghere` moves it into a topic. To move it back to General:
`/shoppingoff`, then `/list` in General.

### Not windowed

The live list is Baumy's own send, but it is a status board, not conversation: neither the post nor
its edits enter the 48h conversation window (`sendLiveList` / `editLiveList` in
`lib/telegram/client.ts`). "What's on the list?" reads the table itself.

### Setup (owner)

Give Baumy the **Pin messages** admin right in the house group, then run `/list` (or `/shoppinghere` in
the shopping topic) once. A house that had the issue #21 topic keeps working without it: the next
change edits its last repost in place (adding the buttons), but it is not pinned until `/list` runs.

## Shopping topic (2026-10-13, issue #21) — superseded by §Live list

[CORRECTION 2026-10-13] Issue #21 reposted the whole list as a NEW plain-text message in the shopping
topic, 2 minutes after the last change, and deleted the previous post (`⬇️ The list moved down.` when
the delete was refused). Issue #25 replaced that with the live list above: the topic is still set by
`/shoppinghere` and cleared by `/shoppingoff`, but the list is now one message edited in place, and
`requestShoppingRepost` / `runShoppingRepost` / `shopping-repost` are gone (now `noteShoppingChange` /
`runShoppingRender` / `shopping-changed` + `shopping-render`). The rules for untrusted item text
(`boardItem`) and "not windowed" carry over unchanged.

## Deliberately deferred

- **Multi-list** (`todo`, `guests`, …): `list_name` exists; wiring a second list is additive, no
  migration.
- **Fuzzy check-off matching** beyond articles/plurals (typos, synonyms — "semi-skimmed" for "milk"):
  still a miss ("couldn't find X") rather than a guess — precision-first.
- **Quantities / provenance link**: folded into the item string for now; a structured `quantity`
  column or a `source_memory_item_id` lineage link (mirroring `docs/spec/fact-lineage.md`) is an
  additive future column.
