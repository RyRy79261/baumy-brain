# Shopping list — a first-class, stateful house list

**Status:** v1 implemented (single `shopping` list); remove and rename added 2026-10-13 (issue #23); the
live, pinned, tap-to-tick list replaced the shopping-topic repost 2026-10-13 (issue #25, §Live list);
categories, auto-sorting and the live list's order modes added 2026-10-13 (issue #29, §Categories,
§Live list → Order modes and headings).
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
- **Sort** (2026-10-13, issue #29) — every item lands in one of six sections (Pantry, Fresh, Coffee,
  Cleaning, Maintenance, Household) or "Not sorted", automatically after the add; "put coffee
  filters under coffee" (or the kiosk) moves it, and the house remembers that for next time.
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
   rename | categorize | query | none` (`lib/ai/classify.ts`; `remove` / `rename` added 2026-10-13, issue #23;
   `categorize` added 2026-10-13, issue #29). Routing only — no items yet. This is orthogonal to the single
   `decide()` Decision, so a list op never competes with reminder/forget/reply.
2. **Gate (deterministic):** `listOpProposed(origin, flag, policyEnabled, decision)`
   (`lib/core/decide.ts`) — requires `mutate_list` allowed for the lane, excludes quarantined
   content, honors pause lane-scoped (group silent when paused; DM still works), and **yields to an
   explicit reminder/forget** (so "remind us to buy bin bags friday" schedules the reminder rather
   than silently just adding bin bags — a list *query* is a question, Decision `reply`, which is
   NOT skipped, so "what's on the list?" still renders it). The caller also requires a non-empty
   house **scope**.
3. **Name the items (Sonnet, best-effort):** `extractListOp` (`lib/ai/list-extract.ts`) returns
   `{op, items, renames?, categories?}` — `renames` is `[{from, to}]`, item TEXT only, for a `rename`;
   `categories` is `[{item, category}]` for a `categorize`, where `category` is the section WORD the
   message used (a plain string — code checks it against the six, §Categories). A malformed object degrades to `{op:'none'}` → the message falls through to normal
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

A fully-compromised model can at most return an op enum + item strings (and `from → to` pairs, and
`item → section word` pairs); it can never name the scope, the attribution, or a row id.

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
- **Categories** (migration `0028`, 2026-10-13, issue #29): `baumy_list_items.category` (one of the six
  keys or null = Not sorted) · `category_source` (`picked` / `remembered` / `similar` / `guessed`, or
  null = not sorted yet) · `categorized_by` (who picked it; member FK, `set null`) · `categorized_at`.
  CHECK constraints hold both to the enum (`lib/lists/categories.ts`). `baumy_list_categories` — the
  house's remembered picks, one row per `(group_id, list_name, item_normalized)` (unique).
  `baumy_list_item_embeddings` — one Voyage vector per `(group_id, list_name, item_normalized, model)`
  (unique; no HNSW index — a house's item names are a few hundred rows). `baumy_house_config.shopping_sort`
  (`groups` default / `az` / `added`, CHECK). All additive; every new column is nullable or defaulted.
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

## Categories (2026-10-13, issue #29)

Owner rulings: 2026-10-11 — six groups, **Pantry, Fresh, Coffee, Cleaning, Maintenance, Household**,
plus **Not sorted**; smart sorting that works the same from the app and the bot (a remembered pick,
else the nearest known item by embedding, else an AI guess), and every correction teaches it.

### The enum

A fixed list (`lib/lists/categories.ts`): the stored keys are `pantry`, `fresh`, `coffee`, `cleaning`,
`maintenance`, `household`; null is "Not sorted". Not a `pgEnum` (brain keeps free-form text columns),
but CHECK constraints on `baumy_list_items.category` / `category_source` and
`baumy_list_categories.category` refuse anything else, so a bad value can never be stored by any path.

### Auto-sorting (after the add, never inside it)

An add commits first, exactly as before, with `category` null. Then the writer (`runList` in its own
step `list-categorize`, the kitchen add after its write) sends `lists/shopping.categorize` with
`{ groupId, itemIds }` — the ids of the rows that add inserted (`addListItems` returns `addedIds`).
`shopping-categorize` (Inngest, concurrency 1 per house, retries 2; `lib/lists/categorize.ts`
`runCategorize`, one memoized step per item) sorts each row that is still this house's, active, and
has `category_source` NULL:

1. **remembered** — the house's pick for this exact item name (`baumy_list_categories`, keyed on
   `item_normalized`, the add/dedupe key).
2. **similar** — the nearest item NAME the house has already sorted, by pgvector cosine over
   `baumy_list_item_embeddings` **of the current model only** (`model = EMBED_MODEL`; a vector of
   another model is never compared). A name's category is its remembered pick when there is one, else
   the category its most recently sorted row got; a name whose latest sort was a "Not sorted" pick
   lends nothing. Copied only at or above **`SIMILAR_FLOOR` = 0.80**. Why 0.80: precision-first — a
   fall-through costs one Sonnet call, a wrong copy is a visible mistake. It sits between brain's two
   other thresholds: retrieval keeps anything above 0.2 (recall: "related at all?") and consolidation
   folds at 0.97 (the same statement restated). Short item names in one embedding space share a high
   baseline, so a low floor would copy across sections; 0.80 keeps name variants and close kin ("oat
   milk" / "oatly barista", "bin bags" / "bin liners") and sends anything looser to the model.
   [UNRESOLVED 2026-10-13] The value is reasoned, not yet measured on Voyage vectors of real item
   names: a live calibration run may move the constant (tests pin both sides of it).
3. **guessed** — Sonnet (`assess`; Haiku stays routing-only) via `guessCategory`
   (`lib/ai/category-guess.ts`, `CATEGORY_GUESS_SYSTEM`): ONE call per item, the item fenced as
   untrusted data, structured output `{ category: <six keys> | "unknown" }`. Code re-checks it
   (`asCategory`); a malformed object (a value outside the enum) degrades to null; a transient provider
   error rethrows so the step retries (I2). One item per call, so one item's text can never steer
   another's category — the most an injection can do is pick a section for itself.

The item's vector is embedded and stored whatever tier wins (once per name), so every sorted item can
be the next one's anchor. The write is compare-and-set (`… WHERE category_source IS NULL`), so a
housemate's pick that lands first is never overwritten. Nothing here can block or fail the add: the
event is best-effort (`requestCategorize` logs and returns false when Inngest is down), an embedder
failure skips only tier 2, and a row every tier passes on stays Not sorted. When anything was sorted,
the run sends the debounced change signal (`requestShoppingRefresh` — no "last updated by" stamp:
nobody changed the list), so the live list re-renders with its groups.

### A housemate's pick (teaches the house)

`setItemCategory` (`lib/lists/store.ts`): the row is named by id (a row still shown on this house's live
list) or by text (an open item, matched like a check-off: exact normalized, then the ONE open item with
that loose key; more than one → `ambiguous`, none → `not_found`, nothing changes). The row gets
`category`, `category_source = picked`, `categorized_by` (the authenticated actor or null),
`categorized_at`; then the house memory for that item name is upserted (`ON CONFLICT … DO UPDATE`), so
a later add of the same item is `remembered`. A pick of null ("Not sorted") deletes the memory row.
Group-scoped (an id from another house matches nothing). A pick changes the list, so it calls
`noteShoppingChange` (stamp + debounced render).

- **Kiosk:** `POST /api/kitchen/shopping/category` (§Kitchen API).
- **Telegram** (it fit the existing list-op pattern, so it is in): the `categorize` list op — "put
  coffee filters under coffee", "bin bags go in cleaning", "move oat milk to fresh". Same classifier
  flag, `listOpProposed` gate (quarantine and forwards can never sort; pause lane-scoped), extractor
  and memoized `list` step as every list op; at most 10 picks per message. The section word is matched
  by code (`pickedCategory`): a key in any case → that category, `unsorted` / `not sorted` / `none` →
  null, anything else → reported as not a section, nothing changed. Acks (`categorizeAck`): group →
  👍 when everything named was sorted, otherwise words (what wasn't found, what was ambiguous, which
  sections exist); DM → words ("Put coffee filters under Coffee. I'll remember that next time.").

## Kitchen API (the kiosk's front door)

The house kitchen kiosk (Baumy Olympics, ADR 0003 there) shares this list over HTTP, so there is
ONE list whether a housemate DMs Baumy or taps the kiosk. `lib/lists/kitchen-api.ts`, routes under
`app/api/kitchen/shopping/` (`runtime = 'nodejs'`, never cached):

| Route | Body | Response |
|---|---|---|
| `GET /api/kitchen/shopping` | — | `{ ok, items: [{ id, item, addedBy, createdAt, category }] }` (open items, oldest first) |
| `POST /api/kitchen/shopping/add` | `{ items: string[1..30], telegramUserId? }` | `{ ok, added, already, attributedTo, items }` |
| `POST /api/kitchen/shopping/checkoff` | `{ items: string[1..30], telegramUserId? }` | `{ ok, checkedOff, notFound, attributedTo, items }` |
| `POST /api/kitchen/shopping/remove` (2026-10-13) | `{ items: string[1..30], telegramUserId? }` | `{ ok, removed, notFound, ambiguous: [{ item, matches }], attributedTo, items }` |
| `POST /api/kitchen/shopping/rename` (2026-10-13) | `{ from: string, to: string, telegramUserId? }` (each trimmed, 1..200) | `{ ok, outcome: 'renamed' \| 'merged' \| 'unchanged' \| 'not_found' \| 'ambiguous', from, to, matches?, attributedTo, items }` (`matches` only with `ambiguous`) |

| `POST /api/kitchen/shopping/category` (2026-10-13, issue #29) | `{ id?: uuid, item?: string (trimmed, 1..200), category: 'pantry' \| 'fresh' \| 'coffee' \| 'cleaning' \| 'maintenance' \| 'household' \| null, telegramUserId? }` — `id` or `item` required; with both, `id` is used; `category` is required (null = Not sorted) | `{ ok, outcome: 'set' \| 'not_found' \| 'ambiguous', id?, item, category, matches?, attributedTo, items }` (`id` only when a row matched; `matches` only with `ambiguous`; `item` is the item as it reads, the text sent when nothing matched, or null for an `id` that matched nothing) |

`items` in every write response is the open list after the write, in the `GET` shape. Every item
carries `category` (2026-10-13, issue #29): one of the six keys, or null = Not sorted — also null for
an item just added, until auto-sorting has run (a few seconds; the add response is sent before it).
A `category` pick that matched nothing (`not_found`, `ambiguous`) is a `200` that changed nothing,
like a rename's miss; a category outside the six (a label such as `"Coffee"`, or `"dairy"`) is a `400`. For a rename,
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
  `setItemCategory` / `currentList`, the same functions the Telegram lane calls: re-adding an open item is a no-op
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
8 to buy · 1 done
Last updated by Ryan, Tue 13 Oct, 18:05
[ ── Pantry ── ]
[ ☐ Pasta ]
[ ── Fresh ── ]
[ ☐ apples ]
[ ── Coffee ── ]
[ ☐ oat milk ]
[ ☐ coffee beans ]
[ ── Cleaning ── ]
[ ☐ bin bags ]
[ ── Maintenance ── ]
[ ☐ light bulbs ]
[ ── Household ── ]
[ ☐ candles ]
[ ── Not sorted ── ]
[ ☐ zorblax ]
[ ── Done ── ]
[ ☑ sponges ]
[ 🗂 Groups ] [ 🧹 Clear done ] [ 🔄 Refresh ]
```

- **Header:** the title; the open count (`N to buy`, `· N done` when something is ticked, `Nothing to
  buy.` for an empty list, `Nothing left to buy` when everything is ticked); `Last updated by <name>,
  <day time>` in the house timezone (Europe/Berlin), without "by" when the change named nobody (the
  kiosk with no member); `Page p of n` when there is more than one page.
- **One button per item per row.** Open items first (`☐ name`, in the house's order — §Order modes
  and headings below), then ticked ones (`☑ name`, in the order they were ticked). Ticked items stay until "Clear done". Item names appear
  ONLY as button labels: flattened and defanged by `boardItem` (control/bidi/invisible characters
  stripped, `@`/`#`/`$`/`/` sigils swapped for look-alikes) and clipped to 40 characters with `…` (by
  code point). The housemate name in the header gets the same treatment, clipped to 32.
- **Pages of 30 items** (`SHOP_PAGE_SIZE`; heading buttons don't count). `◀` / `▶` appear only when needed (no `◀` on page 1, no `▶` on the
  last page). An out-of-range page is clamped. After a tap on an item, the page holding that item is
  shown; Refresh and Clear done show page 1; an ordinary change shows page 1.
- **Footer:** the order button (`🗂 Groups` / `🔤 A–Z` / `🕒 Added` — it shows the CURRENT mode) ·
  `🧹 Clear done` · `🔄 Refresh`, always.

### Order modes and headings (2026-10-13, issue #29)

Owner ruling 2026-10-13: the live list gets an order toggle and headings, "all of it in one go". The
order is one value for the whole house (`baumy_house_config.shopping_sort`), cycled by the footer
button: **Groups** (default) → **A–Z** → **Added** → Groups. `lib/lists/live.ts` `orderRows`:

- **Groups** — open items under one heading per category, in the fixed order Pantry, Fresh, Coffee,
  Cleaning, Maintenance, Household, then Not sorted last; a group with no items has no heading; within
  a group, oldest first (the order they were added).
- **A–Z** — open items alphabetically (case-insensitive); no headings at all.
- **Added** — open items newest first, under **Today** (added today in the house timezone,
  Europe/Berlin — `created_at` is written from the clock seam) and **Earlier**.
- **Done items** always stay below the open ones, in the order they were ticked. Decision: in the
  modes that have headings (Groups, Added) they sit under their own **Done** heading, so a ticked item
  never reads as part of the last group above it; A–Z has none (it has no headings at all).

A heading is a button `── Label ──` with callback `shop:noop`: a tap is answered silently (no toast
text) and changes and renders nothing. A page holds 30 ITEMS; headings come on top and don't count; a
heading is shown before the first item of each group on the page, so a group that carries on from the
previous page gets its heading again at the top. A tapped item's page (focus) is found in the mode's
order.

```
🛒 Shopping list
8 to buy · 1 done
Last updated by Ryan, Tue 13 Oct, 18:05
[ ☐ apples ]
[ ☐ bin bags ]
[ ☐ candles ]
[ ☐ coffee beans ]
[ ☐ light bulbs ]
[ ☐ oat milk ]
[ ☐ Pasta ]
[ ☐ zorblax ]
[ ☑ sponges ]
[ 🔤 A–Z ] [ 🧹 Clear done ] [ 🔄 Refresh ]
```

```
🛒 Shopping list
8 to buy · 1 done
Last updated by Ryan, Tue 13 Oct, 18:05
[ ── Today ── ]
[ ☐ coffee beans ]
[ ☐ candles ]
[ ☐ apples ]
[ ☐ zorblax ]
[ ── Earlier ── ]
[ ☐ light bulbs ]
[ ☐ Pasta ]
[ ☐ oat milk ]
[ ☐ bin bags ]
[ ── Done ── ]
[ ☑ sponges ]
[ 🕒 Added ] [ 🧹 Clear done ] [ 🔄 Refresh ]
```

### Callback data

Every button carries one of six shapes, each ≤ 64 bytes (the longest is `shop:chk:` + a uuid = 45):

| Data | Effect |
|---|---|
| `shop:chk:<itemId>` | toggle one item (`itemId` = the row's uuid, lower-case) |
| `shop:clear` | clear every ticked item |
| `shop:refresh` | re-render (page 1) |
| `shop:page:<n>` | show page `n` (1–9999) |
| `shop:noop` | a heading (issue #29): answered silently, nothing else |
| `shop:sort:<mode>` | set the house's order to `mode` (`groups` / `az` / `added`, issue #29) — the button carries the NEXT mode, so a double tap sets the same mode twice and never skips one |

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
   - `shop:sort:<mode>` → `setShoppingSort` (one guarded UPDATE, a no-op when the house already has
     that mode); toast `Sorted: 🔤 A–Z`; page 1. A house setting, not a list change: no stamp.
   - `shop:noop` → answered silently right after the parse; no read, no change, no render.
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
- **More categories / per-house categories**: the six are an owner ruling (2026-10-11); a seventh is a
  constant + a migration of the CHECK constraints.
- **Quantities / provenance link**: folded into the item string for now; a structured `quantity`
  column or a `source_memory_item_id` lineage link (mirroring `docs/spec/fact-lineage.md`) is an
  additive future column.
