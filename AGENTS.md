# AGENTS.md — working guide for AI agents in this repo

Baumy Brain is a **private Telegram house-management secretary bot** for one shared house.
It listens in the house group, remembers house facts, answers questions, schedules
reminders, and exposes a small admin dashboard. It is **not** a personal assistant and not
multi-tenant.

## Golden rule

**The LLM proposes; deterministic code disposes.** Telegram privacy mode is OFF, so *every*
group message is untrusted, attacker-controlled input. No code path lets group text directly
cause a privileged effect. Preserve this in every change.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**, flat root layout, `@/*` → `./`.
- **Language models = Anthropic only** (`@ai-sdk/*` + `ai` SDK). Roles (`lib/ai/models.ts`):
  classify = Haiku (routing/triage ONLY); reply = assess = Sonnet (all reasoning + memory
  ops); advisor = Opus. The reply path self-escalates Sonnet→Opus when it signals it needs
  more; the other Sonnet ops (extract/expand/rerank/reflect/forget) are fixed-tier.
  **Do not add another language-model vendor.** (Rationale + when to revisit — incl. why not an
  open-weights model like Hermes, and why not the Agent OS dev framework — in
  `docs/decisions/0001-agent-os-and-hermes.md`.)
- **Embeddings = Voyage `voyage-3.5-lite`** (512-dim), a plain fetch in `lib/ai/embed.ts` (needs
  `VOYAGE_API_KEY`). Anthropic ships no embedding model, so Voyage is the one deliberate exception
  to "Anthropic only" — not OpenAI. `embedSync` (a deterministic lexical hash) is a **tests/
  fallback** embedder, never the production space; retrieval filters `model = EMBED_MODEL` so the
  two spaces are never cosine-compared.
- **Drizzle ORM + Neon Postgres + pgvector + pg_trgm**. `Inngest` for all async/background work.
- **Tests: Vitest + PGlite** (offline, in-memory Postgres w/ pgvector + pg_trgm) **plus a real
  pgvector Postgres e2e** via testcontainers (`db/__tests__/`, needs Docker; skips cleanly if absent).

## Commands

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (offline; PGlite) — includes the offline scenarios
pnpm test:scenarios # just the multi-turn house scenarios (scenarios/, offline)
pnpm test:scenarios:live  # same scenarios vs real models + LLM judge (needs ANTHROPIC_API_KEY + VOYAGE_API_KEY)
SCENARIOS_SHOW_GAPS=1 pnpm test:scenarios   # run knownGap scenarios as ordinary tests (see where each fails)
pnpm test:time-shift      # the suite with Date moved forward (TIME_SHIFT_TO=<iso> optional)
pnpm build          # next build
pnpm db:generate    # drizzle-kit generate (migrations)
pnpm db:migrate     # apply migrations (needs DATABASE_URL_UNPOOLED)
pnpm dev            # next dev
pnpm inngest:dev    # local Inngest dev server
node --experimental-strip-types scripts/set-webhook.ts   # register the Telegram webhook
```

## Working cadence (follow this)

1. **Read the spec first.** `docs/spec/` is the source of truth. Before implementing a
   subsystem, read its spec section — do not guess. (Most past mistakes came from guessing.)
2. **One focused change at a time**, each fully verified before committing:
   **`pnpm typecheck` + `pnpm test` + `pnpm build` must all be green.**
3. **Commit small, message clearly** (what changed + why + which spec/audit item). Push to
   `main` only when the work is green (Vercel auto-deploys `main`).
4. Match the surrounding code's style, comment density, and idioms. Reference `file:line`.

## Security invariants — do NOT break these

- **Injection wall (lane-based):** origin/lane is derived from Telegram-authenticated
  `chat.type`/`chat.id`/`from.id`, never from message text (`lib/core/*`). House-group text is
  `privileged: false`, always.
- **Trust tiers** — set from the authenticated transport, never from text: `trusted` (a member's DM) ·
  `untrusted` (native house-group text) · `forwarded` (a housemate relayed someone else's words) ·
  `quarantined` (bot-origin) — plus `system` for Baumy's own derived rows (reflect profiles, the
  structural possessor edge) and its window turns. Bot-origin content → `quarantined`: never
  attributed to a housemate, never grounds a reply, never writes a fact, never windowed. A message a
  housemate **forwarded** → `forwarded` (spec D4, phase 5): stored and **recallable, but only ever labelled** "forwarded by X"
  (`baumy_memory_items.forwarded_by`; `authored_by` stays NULL — the words are the landlord's, not
  X's) in grounding, the window, `/weekly` and `/guests`; it **never reaches the web-search call** (the one
  tool-enabled generation — `grounding.forWeb` leaves it out); it **never writes a fact, never drives an action**
  (reminder / list / forget / follow-up — `isRelayed()` in `lib/core/origin.ts`), is never privileged,
  never consolidates, never feeds reflect; in the group a kept one gets ✍, in a DM a deterministic ack
  (never the reply model). A forwarded bot post stays `quarantined`. Native group text is `untrusted`
  (grounds replies, never privileged). Member DM text is `trusted`. One exception: an
  **anonymous-admin post** (`from` = @GroupAnonymousBot, `sender_chat.id` = the house itself) is
  native `untrusted` house text, never attributed and never registered as a member (I8).
  **Directedness** (`lib/pipeline/directed.ts` `directedness`, spec §1) is transport-derived and
  changes verbosity, never trust: a DM; a reply to Baumy (`reply_to_message.from.id === Baumy's bot
  id` — never `is_bot` alone, never the forum topic-root service message); the exact `@username`; the
  short name as a **vocative** only ("Baumy, …", "…, baumy?" — not "Baumy's reminders are annoying");
  or the ask-Baumy topic (except a reply to another housemate there).
- **DM queries (`member_dm` lane, `docs/spec/dm-queries-and-house-scoping.md`):** a member can
  DM Baumy to **read** house memory (answered privately) and **write** facts through to shared
  house memory at `trusted`. The **scope** a message reads/writes is `houseScopeForOrigin(origin,
  houseChatId)` — derived from the authenticated lane, NEVER the inbound `chatId` — while the
  reply **destination** stays `origin.chatId`. Keep scope/destination/identity distinct. DM
  answers **bypass `/pause`** (lane-scoped: house + reminders still honor it).
- **Shopping list (`docs/spec/shopping-list.md`, `lib/lists/*`, `baumy_list_items`):** rides the
  same scope seam — a member DMs "buy milk" / "got the milk" / "what's on the list?" and it writes
  THROUGH to the house's group-scoped list. Classifier `list` flag proposes → `listOpProposed`
  (quarantine-excluded, pause lane-scoped) + the store dispose. First-class stateful table (crosses
  the memory-core "graduation rule"), not a fact; auto-commits (capture tier), never confirm-gated.
  The kitchen kiosk reads/writes the SAME list over `app/api/kitchen/shopping/*` (Bearer
  `KITCHEN_API_TOKEN`, scope = `getHouseChatId`, never request input; 503 before a house exists).
- **Two human-authorization walls (don't conflate them):** (1) the **confirm-tap wall** —
  `callback_query` from a member's authenticated `from.id` (`lib/confirm/*`,
  `functions/callback.ts`) gates the chat-initiated privileged actions: **memory deletion /
  "forget"** and **reminder CANCELLATION** (`reminder.cancel`, `lib/reminders/cancel.ts`,
  `docs/spec/reminders.md` §Cancelling from chat). A "forget X" / "stop the bins reminder" request
  only *proposes* (LLM picks the target *description*; code resolves it to exact, group-scoped row
  ids the human reviews on the card); nothing is removed until the tap, which executes in the
  pending action's STORED scope. Cancellation resolves only reminders the asker may SEE (house
  reminders; in their own DM also their personal ones — never someone else's DM reminder, re-checked
  against the tapper), cancels every unsent row of a recurring series, and is audited. No tap-skip,
  not even for a creator's own DM reminder. (2) the **dashboard-authz wall** — grants + response-policy/config
  changes commit via authenticated **owner/admin dashboard** server actions
  (`lib/auth/require-admin.ts` `requireAdmin`/`requireOwner`, re-checked live), **not** a
  Telegram tap. **Reminder CREATION and shopping-list add/check-off are exempt from both — they
  auto-commit** (`lib/turn/actions.ts` `runReminder` + `runList`): a reminder only posts text to a
  fixed, code-resolved destination (the house group, or its creator's own DM — D2), and a list op only mutates the house's own group-scoped list (reversible,
  low-privilege). Both are the capture tier. Do not re-add a confirm step to either. (Cancelling a reminder is the
  opposite case — it removes something the house may rely on — so it stays behind the tap.) A reminder is
  only created from a **directed** ask (DM / @mention / reply / console topic — `decide()`, A9), is
  not confidence-gated, and every failure (no time / unreadable / past) is an explicit outcome the
  reply turns into a clarifying question — never a silent drop or a ✍.
- **LLM errors (I2):** only a *malformed object* degrades to a safe default
  (`lib/ai/errors.ts` `isMalformedObjectError`); a transient provider error (429/529/timeout)
  **rethrows** so the Inngest step retries — never swallow it into a memoized degraded value.
- **Fixed send destination:** `sendToHouse` targets a **code-resolved** chat id only. Replies
  are a **two-target allow-list** — the house group, or the authenticated DM sender's own chat
  (`origin.chatId`). Reminders are the same two targets (spec D2, phase 5): a **house** reminder
  (`deliver_chat_id = group_id`) → the current live house id via `sendToHouseResilient`; a
  **personal reminder set in a member DM** (`forWhom` speaker, or a literal "remind me" / a DM ask
  with no `forWhom`) → `deliver_chat_id = created_by` = that authenticated DM chat, delivered with a
  plain `sendToHouse` to it — never through the house path, retired (never re-routed) if its creator
  has left (`lib/reminders/store.ts` `reminderDestination`). Personal reminders never appear in the
  group's `/reminders` or `/weekly` (`visibleReminders`), and a reminder request asked in a DM that set
  no HOUSE reminder is **not captured** into shared house memory either (no note, no facts — so no
  `/weekly` event, recall or heads-up in the group; `privateDmReminder` in `ingest.ts`, which runs the
  reminder step before capture). Digests / heads-ups → the house group only.
  Both lanes' reminders still honour `/pause`. The LLM never picks a recipient.
- **Supergroup migration (alias seam, `docs/spec/telegram.md` D9):** the house `chat_id` changes on a
  group→supergroup upgrade, but `house_group_chat_id` is ALSO the memory `group_id` — so it is the
  stable **scope** and is NEVER rewritten. `house_config.live_chat_id` holds the current transport id;
  `resolveHouseIds` → `{scopeId, sendId, acceptIds}` (lane accepts the alias set, sends use `sendId`,
  memory stays on `scopeId`). It self-heals inbound (`convergeMigration`, bound to a known-house id —
  no hijack) + outbound (`sendToHouseResilient` 400-retry); `scripts/heal-house.ts` is the manual kick.
- **Reminder topic ("notification channel"):** `house_config.reminder_thread_id` routes reminders into
  a forum topic via `message_thread_id`; set by the owner's `/notifyhere` (capture-tier auto-commit,
  house lane, audited — value from the authenticated `message_thread_id`, never text). Read receipts are
  **not** obtainable via the Bot API (D9a) — don't try to add them.
- **Ask-Baumy topic + introspection (`docs/spec/telegram.md` D9c):** `house_config.console_thread_id`
  (owner `/baumyhere`) marks a topic where Baumy is fully conversational (a message there is treated as
  `directed`, except a reply to another housemate; a question there is answered only when triage says
  it is for Baumy — `asksBaumy`, C6). `/reminders` + `/recent` are deterministic, **secret-safe** read-only introspection
  (exclude `is_secure`). The topic changes **verbosity, not trust** — still untrusted house text, no
  privileged path rides on the topic id. A real introspection API belongs in the authed dashboard.
- **Secrets at rest:** wifi/door/bank values are AES-256-GCM encrypted (`lib/core/crypto.ts`);
  only a non-secret descriptor is stored/embedded; decrypt only to answer a direct request
  (`lib/turn/grounding.ts` `disclose`: MODE answer + `asksForSecret` on that value — never for an
  ack/confirm, never because a message merely mentions the door), never in digests, never into the
  tool-enabled web-search generation.
- **Message text at rest = the 48h conversation window only** (`lib/turn/window.ts`,
  `baumy_messages`, spec `chat-understanding-v2.md` §5/D1 — this replaced the old "never persist the
  message body" rule). **A secret is never persisted**: text is redacted with `scanSensitivity`
  BEFORE insert (a secure message is kept only as its descriptor, whole — never span-edited), a
  reply that disclosed a decrypted secret is windowed as a placeholder (`grounding.disclosed`); a
  message whose EXTRACTED fact scans secure on its triple ("wifi is hunter2 now" — the sentence does
  not scan) is withheld after capture (`captured.secure`), and so are Baumy's words for that turn; a
  forget-looking request (the classifier's `intent`, whatever the decision) and the forget card are
  withheld; and a confirmed forget — **soft or purge** — withholds the rows that produced the
  forgotten facts/notes (`withholdProducing`) and scrubs the value from every other row. A member's
  display name is flattened and can never read as Baumy's own turn (`memberLabel`). **No text outlives 48h** (hourly `windowPurge` cron; every read also filters by 48h, clock
  seam `now()`); a row whose produced reminder series still has a scheduled occurrence survives the
  purge as its produced-map only (text replaced by `EXPIRED_WINDOW_TEXT`), so an edit days later still
  replaces the reminder (I1). The ledger (`baumy_telegram_updates.raw`) still never holds the body. Appended:
  every in-scope inbound message after lane resolution (never the `ignore` lane, never another bot's
  post; a member-forwarded message is labelled `forwarded`, attributed to the forwarder only as
  forwarder) and every Baumy send — at the **send seam** (`lib/telegram/client.ts`, scope resolved
  from the destination, best-effort after the send so a window hiccup never re-posts). Reads are one
  chat (+ the same forum topic): a DM never shows up in the group's window or vice versa. The window
  is **context only** — the models see it as a quoted `RECENT CHAT` data block (never inside the
  verified CONTEXT block); it never writes a fact, never drives an action, and is never shown to
  anyone (console policy marks `text_redacted` secret).
- **Dashboard authz is live:** re-checked against the DB on every request
  (`lib/auth/require-admin.ts`) — never cached in the cookie.
- **Trust-gated facts:** a fact may supersede (or close) an incumbent only if its trust ≥ the
  incumbent's (`lib/memory/facts.ts` `mayOverride`) — the memory-poisoning defense. Two authenticated
  exceptions (spec §7, F5): the **same author** may correct their own fact from any lane, and the
  **owner** (roster role) may correct anything below `system`; identity comes from the turn, never text.
  Any other lower-trust contradiction is stored as a **non-current conflict row**
  (`conflicts_with_fact_id`) and surfaced in `ctx.outcome.captured.conflicts` → the planner's
  `statement-conflict` row asks which is right. A conflict row never grounds anything; the hygiene
  sweep retires it. A `system` (reflect) fact is never correctable by chat — except the structural
  possessor edge ("marco's room —belongs_to→ marco", `isStructuralEdge`: `system`, no author), which is
  a name-derived default, not a statement: any stated owner replaces it (reconcile and the hygiene replay).
- **New housemates (K6):** an unknown PRIVATE sender is checked with `getChatMember(house live id,
  from.id)` (`lib/identity/verify.ts`) — an active member is upserted (role `member`, audited
  `member.verified`) and served as a member DM; anyone else stays `ignore`. Fail-closed (a transport
  error = not a member, uncached), a definite "no" cached 10 min. Grants only the `member_dm` lane —
  never owner, never the dashboard.
- **Edits (I1, `lib/turn/edit.ts`):** an `edited_message` (`isEdit`, same `message_id`) supersedes what
  the original produced via the window's produced-map — its note retired, facts it no longer states
  soft-retracted (`deleted_at`), unsent reminders (+ their series) cancelled and re-created from the
  edited text — and **never gets words** (planner `quietForEdit`; reactions only). A note another
  window row also produced (a consolidated near-verbatim repeat) is not retired; while `/pause`d the
  original's reminders are kept (the edit cannot re-create them). An edited slash command is not
  re-run; an edit of a message with no window row is handled as new, silently.
- **Fail closed** everywhere (roster, env, webhook secret).

## The turn & Baumy's voice (`lib/turn/*`, `docs/spec/chat-understanding-v2.md`)

The design contract is `docs/spec/chat-understanding-v2.md` (fully implemented; the 2026-09-26 audit's
72 findings are all closed — `audit-repro/README.md` has the per-finding status). `runIngest`
(`lib/inngest/functions/ingest.ts`, **one message at a time per chat** — Inngest concurrency key on
`event.data.chatId`, F16) is intake and then ONE turn, in this order:

1. **Intake** — record the update (ledger, never the body) → captionless media dropped as `media` (a
   photo/document caption IS the text, folded in at the webhook — I4) → origin/lane from transport ids
   (an unknown PRIVATE sender is checked with `getChatMember` first, K6) → `ignore` lane dropped before
   anything can reply (A12) → directedness → edit lookup (I1) → **window append** → noise pre-filter
   (after directedness, so "yes" to Baumy survives, C7) → slash commands (`lib/turn/commands.ts`;
   unknown ones in the group are dropped, I7; an edited command is not re-run).
2. **`TurnContext`** (`context.ts`, pure, transport-derived): sender (+ role), lane, trust, **scope vs
   destination**, topic, directedness + `why`, replied-to author (+ its text as quoted data, only for
   Baumy or a housemate's own words), the @mention-stripped text (C12), `sentAt` + house tz, `recent`
   (the window), `forwardedBy`, `edit`.
3. **Triage in context** (`lib/ai/classify.ts`, spec §2): intent (statement / question / request /
   reminder / forget / banter / chatter), `asksBaumy` (for Baumy vs another housemate, C6),
   `worthRemembering`, `confidence` (in the intent — never a reason to speak), **`replyValue`** (how
   useful a VOLUNTEERED answer would be — the only thing the owner's `reply_frequency` floor reads, I6),
   vibe, tier (quick/deep), webSearch, list. It reads a verified CONTEXT header (lane, directed + why,
   FROM, FORWARDED, HOUSEMATES, REPLYING TO) + the last 6 window turns as quoted data. It **does not
   decide whether Baumy speaks.** Malformed object → `SAFE_VERDICT` (captures nothing, `degraded`).
4. **Write-gate** (`lib/core/decide.ts`): `shouldCapture` = statements / info-carrying requests and
   reminders only — **never a question, chatter or a forget request** (I3); a reminder needs a
   **directed** ask and is not confidence-gated (A9, I6); relayed content (`isRelayed`) drives nothing.
5. **Actions, then capture** (`actions.ts`, `capture.ts`), each result into `ctx.outcome`: the list op
   first (a list op is **not** captured, A11) → reminders (+ a pending clarify draft, below) → capture
   (skipped for a private DM reminder, D2) → edit settle → forget proposal. Capture returns `{memoryItemId,
   factIds, learned, rejected, conflicts, secure}`; every action returns what actually happened.
6. **`planResponse(ctx, policy)`** (`plan.ts`, pure, table-driven, exhaustively tested — spec §3)
   picks none / a reaction / the deterministic list, forget or forward-ack text / words in a **MODE**
   (answer, ack, confirm, clarify, banter), naming the table `row` that fired. In short: paused house →
   none (DMs still work); quarantined → none; forwarded → ✍ (group) / the forward ack (DM); an edit →
   never words; a directed question → answer; an undirected one → answer only when `asksBaumy` AND
   `replyValue` clears the floor (a miss is a quiet 👎), housemates asking each other → none; a directed
   statement → ack, an undirected captured one → ✍; a set reminder → confirm (with day + time), a failed
   one → clarify; a refused correction (conflict) → clarify. **Don't add voice logic anywhere else.**
7. **Words** (`respond.ts` → `lib/ai/reply.ts` `answer(ctx, mode, grounding)`, spec §4): verified
   CONTEXT (FROM / WHERE / NOW / REPLYING TO / THIS TURN) → the replied-to text and RECENT CHAT as
   quoted data → MEMORY (each line kind · who · said <date> · event <day>, forwarded notes labelled) →
   MODE → `MESSAGE from <name>`. Grounding (`grounding.ts`) **excludes this turn's own note and facts**
   (C1). The model never third-persons the sender and never claims an action THIS TURN doesn't report
   (A3). Words go out as a Telegram **reply** to the triggering message (C11), through the `claimReply`
   / `releaseReply` exactly-once belt; Sonnet→Opus self-escalation and the malformed-object text
   fallback are kept.

- **Clarify is answerable:** a reminder with no / unreadable / past time stores a short-lived draft
  (`lib/reminders/draft.ts`, `pending_actions` type `reminder.draft`, never tap-able); the requester's
  next directed message in that chat completes it ("at 8pm").
- **Reactions** are limited to `PLANNER_EMOJI` (`lib/turn/emoji.ts`, Bot-API-valid, unit-tested — ✍ is
  "noted"; 🧠 is not a Telegram reaction, K1).
- **The window** (`window.ts`, `baumy_messages`, spec §5 — rules under "Message text at rest" above):
  the last 12 turns of the same chat + forum topic within 48h, Baumy's own sends included, read once per
  turn (`window-read`); triage gets 6, the reply 12. It also carries each message's produced-map
  (note / facts / reminders) — what an edit supersedes (`edit.ts`).
- **Time** and **facts** are under "Memory & retrieval" below (spec §6, §7).

## Auth reality (read before touching auth)

Login is **Telegram magic-link**: DM the bot `/dashboard` → one-time link → a signed **HMAC
session cookie** (`lib/auth/session.ts`, `BAUMY_SESSION_SECRET`). That is the whole login.

- **Neon is the database, NOT the auth.** Neon Auth (the product) is **not** wired.
- **Better Auth is NOT used.** Do not reintroduce it (it was a spec-generation artifact).
- Do not swap the session layer without an explicit request.

## Memory & retrieval (the core subsystem)

The whole point of Baumy is recall — treat `lib/memory/` + the retrieval AI in `lib/ai/` as the
crown jewels. The pipeline:

- **Capture** (`write.ts` `captureMemory`): store the message as an evidence item + Voyage
  embedding. A near-verbatim restatement (≥0.97 cosine) **by the same author within 24h**
  **consolidates** onto the original (salience bump) instead of duplicating (F9 — keyed on cosine
  alone, Charli's "I'm away" folded onto Marco's month-old note); secure and relayed (forwarded /
  bot) input are exempt. A message handled as a **list op is not captured** (A11 — it lives in the list
  table). A photo/document **caption is the message text** (folded in at the webhook,
  `lib/telegram/content.ts`, I4); media without one is dropped explicitly (`reason: 'media'`).
- **Facts** (`facts.ts`, spec §7): `extractFacts` → `reconcileFact` distils {subject,predicate,
  object} triples into a **trust-gated, bitemporal** knowledge graph. **Predicates are a controlled
  vocabulary** (`lib/memory/predicates.ts`): canonical names with a **cardinality** + a synonym map
  (`arrival_date → arrives_on`); the extractor prompt lists them, reconcile normalises whatever comes
  back. **single** = one live value, a new one supersedes; **multi** (`has_guest`, `likes`,
  `allergic_to`, `sibling_of`…) = values accumulate and only a `removes` fact closes one; unknown
  predicates are single. `resolveEntity` de-fragments subjects (normalize → exact → alias → a
  **near-equal** trigram merge: least of both `strict_word_similarity` directions ≥ 0.7, same word
  count), so a typo merges while "marta"/"martha" stay distinct — **write side is precision-first**.
  **Never merged:** a person by trigram, a **possessive** ("charli's bike" gets a `belongs_to` edge to
  charli at `system` trust instead — F1), or a qualified phrase into its head ("kitchen sink" never
  folds into "sink"); only a bare head resolves to the ONE qualified node ending in it ("the sink" →
  "kitchen sink"), re-checked every time (never stored as an alias). The speaker is ONE person node carrying their full + first name as aliases
  (`ensureSpeakerEntity`, F6); notes are tagged by the entity id reconcile resolved (F15).
  Every fact carries **lineage** (`docs/spec/fact-lineage.md`): `source_memory_item_id` (the
  evidence note it came from — its origin, with `authored_by` = who) and `derived_from_fact_id`
  (the fact it **replaced**, or the previous occurrence of the same key — F8: never "the last thing
  said about the subject", and never a forgotten or conflict row). `currentFactsForQuery` surfaces
  the author + parent as "(earlier: …)" (a **secret** parent is redacted). Both nullable, additive.
- **Lookup** (`lib/memory/lookup.ts` + `currentFactsForQuery`, `resolveSeedEntities`): names match as
  **whole words** (plural-tolerant); a fact is found from its **subject or object** (node or value —
  "who's in the cave?"), from a predicate cue ("who's staying…"), or — for "what did X say" — its
  author (`askedAuthor`, roster names only). Ranked: named subject > named object > value > the
  `house` hub (capped) > cue > typo; "I/my/me" are the **authenticated sender** (passed from the
  turn); a reflect profile always ranks last. The retrieval lexical arm is an **OR** tsquery (F14)
  and "what did X say" adds X's notes as an author arm (F13).
- **Time** (`docs/spec/chat-understanding-v2.md` §6): the fact + reminder extractors get a `MESSAGE
  SENT` line and a 21-day calendar table (`lib/core/calendar.ts`) and resolve times themselves (local
  ISO); code validates (`lib/core/when.ts` — parseable, ≤2 years out, end ≥ start) and falls back to
  chrono on the verbatim phrase with FIXED defaults (bare hour = next occurrence, dayparts, "this
  weekend" on a weekend, "the 9th", late-night "tomorrow"). A dated fact stores `event_at` +
  `valid_to` (its end). **"Current" = `is_current AND (valid_to IS NULL OR valid_to > now)`**
  (`lib/memory/current.ts` `liveFact`) in EVERY read that grounds a reply / report / graph / reflect /
  heads-up — an event that is over is history (the entity timeline shows it "(past, date)"), never
  "current". Pass `now` from the clock seam, never Postgres `now()`. The same triple with a new date
  is a new occurrence (expired incumbent) or a reschedule (live one) — never a noop that drops the date.
  Something already over when said is history if the live incumbent is itself dated (a past visit
  never closes an upcoming one), but a past-dated CHANGE of an undated state ("fixed yesterday" over
  "broken") supersedes it, trust-gated, and stays live (`event_at` = when, `valid_to` NULL). A model
  `when` with a date-only start is all-day whatever its flag. Legacy dated rows (pre-time-model,
  `valid_to` NULL) were closed by migration 0020.
  All time reads in `lib/**` go through `lib/core/clock.ts` `now()` (auth excepted, on purpose).
- **Graph traversal** (`graph.ts`, `docs/spec/fact-graph-traversal.md`): the facts form a property
  graph (relationship edges = a fact row with `object_entity_id` set). `connectedEdges` walks it
  with a **bounded recursive CTE** (≤2 hops / node+edge caps, both directions) from a query's seed
  entities — the cross-subject hop ("Charl's sister → the cave"); `entityTimeline` walks one
  subject's progression **newest first** (incl. superseded and expired, tagged `(past)`; never conflict
  rows). `gatherGraphContext` feeds both
  into the **deep-tier** reply grounding (best-effort). Group-scoped, secret-excluded, current-only.
- **Retrieve** (`retrieve.ts`): **hybrid RRF** — semantic (pgvector cosine) ⊕ lexical
  (`content_tsv` full-text), fused by Reciprocal Rank Fusion, then recency-composed. The **deep
  tier** adds query **expansion/HyDE** (`expand.ts` → `retrieveExpanded`, cross-probe RRF) and a
  Haiku **re-rank** (`rerank.ts`) — both best-effort, degrading to plain hybrid on any error.
- Every retrieval arm (semantic *and* lexical) is **group-scoped, active-only, quarantined-
  excluded, current-embedding-model-only** — preserve all four in any query you add. (`forwarded`
  notes pass the quarantine filter by design and come back with `trustLevel`/`forwardedBy`, so the
  reply labels them; they have no author, so the author arm never returns them.)
- **Reflect** (`reflect.ts` + `functions/reflect.ts`): a slow **sleep-time cron** (every 6h)
  re-reads each person's own facts + attributed notes and synthesises a durable per-person
  **profile**, stored back as a `system`-trust fact (supersedes the prior; grounds "who is X").
  Reads **already-trusted, non-secret, non-quarantined** rows only; picks only people with fresh
  activity since their last profile (never churns). Material is **non-secret + non-quarantined**
  (untrusted native-group notes ARE included — it's already-captured evidence/facts, not live
  group text; only secret + forwarded/bot content is excluded). This is the "it learns" step.
  The material is **live** facts only, each **dated + attributed** (who said it, when, when it
  happens — F11), and the profile grounds as its own `profile` kind ("Baumy's summary · as of <day>"),
  ranked below every direct fact.
- **Hygiene** (`hygiene.ts` + `functions/hygiene.ts`, nightly 03:40 Berlin, F12): predicate
  canonicalisation, **proven** entity merges (same normalised name / an alias / the same housemate —
  audited `memory.entity_merge`), look-alike THING/PLACE merges the model only **proposes**
  (`lib/ai/dedupe.ts`; code offers the pairs and re-checks every guard — never people, never a
  possessive, never a qualified/head pair), contradiction resolution through the same trust gate, and
  conflict-row retirement. Ingest runs **one message at a time per chat** (Inngest concurrency key on
  `event.data.chatId`, F16) so a correction is never superseded by the message it corrected.
- **Forget** (`forget.ts`, deletion on request): `findMemoryToForget` resolves a target
  description to exact **group-scoped** row ids — a named value that IS an entity, or a subject with no
  detail, proposes that entity's current facts; a detail matches loosely (cue words / predicate +
  synonym words / stems / the value — A8); notes by whole-word value match **plus the proposed facts'
  source notes**. `forgetMemory` runs **soft** (hide the facts AND those notes: `is_current` /
  `is_active=false`, reversible — A7, so the verbatim note can no longer answer) or **purge** (redact
  value/content + drop the embedding). Confirm-tap-gated + audited (above).
  A "forget" message is **never captured** (storing "delete X" would re-add X).
- **Extraction has NO fact ceiling** (`extract.ts`): a dense message **paginates** (re-ask for
  new facts until a short page drains; `MAX_PASSES` backstop is logged, never a silent drop).
  Every hot-path `generateObject` is **best-effort** — a malformed object degrades to a safe
  default (classify→SAFE_VERDICT (stores nothing), extract→[], reminder/forget→none, reply→text fallback) so no
  single LLM hiccup crash-loops ingest. See the structured-output rule before adding one.
- Reserved + intentionally unused: `entities.name_embedding` (semantic entity resolution —
  today it's redundant with expansion; wire it only if recall proves thin in the wild).

## Database & migrations

- Schema lives in `db/schema.ts`; config at repo-root `drizzle.config.ts`.
- **Generate migrations with `pnpm db:generate`** (keeps drizzle's snapshot in sync).
- **Hand-edit an emitted migration only** for things drizzle can't model: `CREATE EXTENSION`,
  pgvector **HNSW indexes**, and index-dependent column-type changes (drop index → alter →
  recreate). Always run the generator first, then edit the file it produced.
- Migrations run automatically on deploy via `scripts/maybe-migrate.mjs` (skips when no DB).

## Testing

- Fast DB tests use `makeTestDb()` (`lib/memory/__tests__/pglite.ts`), an in-memory PGlite
  Postgres with pgvector + pg_trgm. It is a **hand-maintained DDL that can drift** — when you add
  a table/column/extension to `db/schema.ts`, mirror it there in the same step.
- Slower **e2e** (`db/__tests__/`) applies the REAL migrations to a testcontainers pgvector
  Postgres — the check that catches migration/SQL bugs PGlite can't. Needs Docker; skips cleanly
  without it. Add an e2e case for anything touching raw SQL or a migration.
- LLM and Telegram calls are **mocked**; the deterministic `embedSync` stand-in is the test
  embedder so recall tests stay offline + repeatable.
- Keep the suite **offline and deterministic** (vitest timeouts + worker caps are set for the
  growing PGlite suite — don't remove them). **Deterministic includes the calendar**: a test that
  stores a dated fact / reminder must read it at a pinned instant (`withSimulatedTime`), never on the
  wall clock. `pnpm test:time-shift` (optionally `TIME_SHIFT_TO=<iso>`) runs the suite with `Date`
  moved forward — run it whenever a change touches what "current" / "due" / "stale" means.
- Add a test for every security-relevant change (the poisoning/authz/exactly-once paths).
- **Scenarios** (`scenarios/`, `scenarios/README.md`, spec §9): declarative multi-turn house
  conversations through the REAL pipeline (sandbox harness: PGlite, real ingest, crons at simulated
  instants, captured sends, `tap()` for the confirm-tap wall) with a scripted model injected via the
  test-only `setModelOverride` seam (`lib/ai/registry.ts`) and `setEmbedOverride` (`lib/ai/embed.ts`).
  They assert routing, reactions, rows, reminders and **what the model was told** (`expectPrompt`).
  Offline (default, part of `pnpm test`) is deterministic: fetch is trapped, `inngest.send` captured, and
  a system prompt the fake model does not recognise throws (register a new prompt in `ROLE_PROMPTS`).
  **Live mode** — `pnpm test:scenarios:live` (sets `SCENARIOS_LIVE=1`; needs `ANTHROPIC_API_KEY` +
  `VOYAGE_API_KEY`, skips cleanly without them) — runs the same steps against the real models and grades
  each `expectWords({ judge })` rubric with an LLM judge (`scenarios/judge.ts`); `offlineOnly` and
  `knownGap` scenarios are skipped. It costs money and is not deterministic: run it by hand after a prompt
  change, never in CI. Every user-visible behaviour change adds a scenario **with a judge rubric**.
  Behaviour the code doesn't have yet is a `knownGap` (`it.fails`, names the finding + phase + `failsAt`)
  — when your change flips one, drop its `knownGap`. Fixtures use the spec's shapes through ONE adapter
  (`scenarios/shapes.ts`); a schema change edits that file, not the scenarios.
- **`audit-repro/`** held characterisation tests asserting the 2026-09-26 audit's bugs; every finding is
  now fixed and no repro test remains (`audit-repro/README.md` maps each finding to the test/scenario that
  proves it; `findings.json` is the record). A future audit's repros go there the same way: assert the
  bug, and when you fix it delete the repro and pin the CORRECT behaviour next to the code or as a scenario.

## Env & deploy

- Required at boot (`lib/env.ts`): `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
  `BAUMY_SESSION_SECRET`, `BAUMY_ENCRYPTION_KEY`. Optional overrides: `BAUMY_HOUSE_CHAT_ID`, `BAUMY_OWNER_ID`
  (both auto-captured when the bot is added to the group), `BAUMY_PUBLIC_URL`, `BAUMY_TIMEZONE`.
  Optional feature: `KITCHEN_API_TOKEN` (Bearer for the kitchen kiosk's shopping API — unset = 401).
- Boot is **non-fatal** and `/api/health` **reports which required vars are missing** (503 with
  a `notReady` list) — use it to diagnose, don't crash the whole app on a missing secret.
- Env changes need a **redeploy** to take effect. Secrets can be any random ≥32-char value
  (`openssl rand -hex 24`); the encryption key is SHA-256-derived, so encoding doesn't matter.

## Gotchas

- The webhook is fast-ack only (verify secret → forward to Inngest → 200); all real work is in
  Inngest functions. Scope (house vs DM vs ignore) is resolved downstream from `house_config`.
- `.env*` files may be blocked by local permissions — edit `SETUP.md`/`.env.example` guidance
  instead of assuming you can read them.
- Reminders are exactly-once: claim → send → mark-sent (→ create next, for a recurring one), with
  release-on-failure + a stale-firing reaper. Don't reorder that. A recurring series is a chain of
  one-off rows; "create next" is an insert on the UNIQUE `previous_reminder_id` (ON CONFLICT DO
  NOTHING), and the digest's `repairRecurringSeries` heals a crash after mark-sent. Exactly-once is a
  **ceiling, not a floor** — a reminder more than
  `STALE_AFTER_HOURS` (24h) past its moment is **cancelled, not delivered** (`expireStaleScheduled` +
  the `dueScheduled` floor; a retired recurring occurrence still schedules its next one). Removing that
  grace window is how a months-old backlog gets flushed into
  the group as if it were today's news (`docs/spec/reminders.md` §Staleness). A reminder time that is
  already past at creation is never written (it would fire instantly) — it is a clarifying question.
  A personal ("remind me") reminder is prefixed with the AUTHENTICATED sender's first name (A4).
  **`/pause` holds delivery on both paths** (the digest, and `deliverReminderNow` for the armed
  sleepUntil path): the row stays scheduled, nothing posts, and a recurring series does not grow —
  after `/resume` the digest delivers it inside the grace window or retires it and continues the
  series. A heads-up model error never holds back an explicit line in the same digest.
- Proactive event heads-ups (`docs/spec/event-surfacing.md`): the **line is written by the model**
  (`lib/ai/nudge.ts`), never templated from `{subject, predicate}` columns — that printed row
  fragments ("Heads-up — Mad profile, today") into the house group. Code still picks what is eligible
  (grouped **per event**, not per fact triple; profiles excluded; secrets excluded) and where it goes.
  A `SKIP` from the model — or any error — schedules **nothing**. Stages are digest slots (08:00 a week
  before, 20:00 the evening before, 08:00 on the day; the scan runs at 07:45), and the line is
  **re-written at DELIVERY** from the event's facts as they are then, with the lead measured from the
  delivery instant (`headsUpAtDelivery` — one line per event per digest; an event that moved, ended or
  started is dropped). The scan de-dupes per (event, stage) — `nudgeStageOf`, nearest slot — never per
  exact minute (a row at a pre-slot offset would otherwise get a twin). Dates on stored facts are read with `parseEventWindow`/`parseEventDate` (the
  capture resolver + precision guards: coverage + known-day, a past marker read literally), never a
  bare chrono call over arbitrary values.

---

*For Claude Code specifically: add a `CLAUDE.md` containing `@AGENTS.md` to auto-load this file.*
