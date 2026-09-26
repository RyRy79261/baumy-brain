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
- **Trust tiers:** forwarded / bot-origin content → `quarantined`; it is never attributed to a
  housemate and never grounds a reply or writes a fact (the conversation window may show a
  member-forwarded line as quoted context, labelled "X forwarded — not X's own words"; bot posts are
  never windowed — spec §5). Native group text is `untrusted`
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
- **Two human-authorization walls (don't conflate them):** (1) the **confirm-tap wall** —
  `callback_query` from a member's authenticated `from.id` (`lib/confirm/*`,
  `functions/callback.ts`) gates **memory deletion / "forget"** (the only chat-initiated
  privileged action). A "forget X" request only *proposes* a delete (LLM picks the target
  *description*; code resolves it to exact, group-scoped row ids the human reviews); nothing
  is removed until the tap. (2) the **dashboard-authz wall** — grants + response-policy/config
  changes commit via authenticated **owner/admin dashboard** server actions
  (`lib/auth/require-admin.ts` `requireAdmin`/`requireOwner`, re-checked live), **not** a
  Telegram tap. **Reminders and shopping-list add/check-off are exempt from both — they
  auto-commit** (`lib/turn/actions.ts` `runReminder` + `runList`): a reminder only posts text to the
  fixed house group, and a list op only mutates the house's own group-scoped list (reversible,
  low-privilege). Both are the capture tier. Do not re-add a confirm step to either. A reminder is
  only created from a **directed** ask (DM / @mention / reply / console topic — `decide()`, A9), is
  not confidence-gated, and every failure (no time / unreadable / past) is an explicit outcome the
  reply turns into a clarifying question — never a silent drop or a ✍.
- **LLM errors (I2):** only a *malformed object* degrades to a safe default
  (`lib/ai/errors.ts` `isMalformedObjectError`); a transient provider error (429/529/timeout)
  **rethrows** so the Inngest step retries — never swallow it into a memoized degraded value.
- **Fixed send destination:** `sendToHouse` targets a **code-resolved** chat id only. Replies
  are a **two-target allow-list** — the house group, or the authenticated DM sender's own chat
  (`origin.chatId`); reminders/digests → the fixed house group. The LLM never picks a recipient.
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
  display name is flattened and can never read as Baumy's own turn (`memberLabel`). **Nothing outlives 48h** (hourly `windowPurge` cron; every read also filters by 48h, clock
  seam `now()`). The ledger (`baumy_telegram_updates.raw`) still never holds the body. Appended:
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
- **Trust-gated facts:** a fact may supersede an incumbent only if its trust ≥ the incumbent's
  (`lib/memory/facts.ts`) — the memory-poisoning defense.
- **Fail closed** everywhere (roster, env, webhook secret).

## The turn & Baumy's voice (`lib/turn/*`, `docs/spec/chat-understanding-v2.md` §1–§4)

`runIngest` (`lib/inngest/functions/ingest.ts`) is intake (record → origin → directedness → noise
filter → slash commands, `lib/turn/commands.ts`) and then ONE turn:

1. **`TurnContext`** (`context.ts`, pure): sender, lane, trust, scope vs destination, topic,
   directedness + why, replied-to author/text, the @mention-stripped text, `sentAt` in the house tz.
2. **Triage in context** (`lib/ai/classify.ts`): intent (statement / question / request / reminder
   / forget / banter / chatter), `asksBaumy`, `worthRemembering`, confidence *in the intent*, vibe,
   tier (quick/deep), webSearch, list. It **does not decide whether Baumy speaks.** A malformed
   object → `SAFE_VERDICT` (captures nothing, `degraded`).
3. **Write-gate** (`lib/core/decide.ts`): `shouldCapture` = statements / info-carrying requests and
   reminders only — **never a question, chatter or a forget request** (I3).
4. **Capture** (`capture.ts`) returns `{memoryItemId, factIds, learned, rejected}`; **actions**
   (`actions.ts`: list, reminder, forget) return what actually happened. All land in `ctx.outcome`.
5. **`planResponse(ctx, policy)`** (`plan.ts`) — pure, table-driven, exhaustively tested — picks
   none / a reaction / the deterministic list or forget text / words in a **MODE** (answer, ack,
   confirm, clarify, banter). Paused house → none (DMs still work); quarantined content → none.
   Don't add voice logic anywhere else.
6. **Words** (`respond.ts` → `lib/ai/reply.ts` `answer(ctx, mode, grounding)`): the prompt is the
   verified CONTEXT (FROM / WHERE / NOW / REPLYING TO / THIS TURN) + dated, attributed MEMORY + MODE +
   `MESSAGE from <name>`. Grounding (`grounding.ts`) **excludes this turn's own note and facts** (C1).
   The model never third-persons the sender and never claims an action THIS TURN doesn't report.
   Words go out as a Telegram **reply** to the triggering message, through the `claimReply` /
   `releaseReply` exactly-once belt; Sonnet→Opus self-escalation and the malformed-object text
   fallback are kept.

Reactions are limited to `PLANNER_EMOJI` (`lib/turn/emoji.ts`, Bot-API-valid — ✍ is "noted").

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
  embedding. A near-verbatim restatement (≥0.97 cosine) **consolidates** onto the original
  (salience bump) instead of duplicating; secure and quarantined input are exempt.
- **Facts** (`facts.ts`): `extractFacts` (Haiku) → `reconcileFact` distils {subject,predicate,
  object} triples into a **trust-gated, bitemporal** knowledge graph. `resolveEntity`
  de-fragments subjects (normalize → exact → alias → conservative `strict_word_similarity`
  merge), so "the sink"/"kitchen sink" are one entity while "marta"/"marco" stay distinct —
  **write side is precision-first** (a bad merge corrupts the graph); read side fuzzes generously.
  Every fact carries **lineage** (`docs/spec/fact-lineage.md`): `source_memory_item_id` (the
  evidence note it came from — its origin, with `authored_by` = who) and `derived_from_fact_id`
  (the prior fact it follows from — a supersession target, or the previous thing said about the
  same subject). This chains a progression across predicates + people ("you said Zuzka's coming"
  → "Marco said she arrived"); `currentFactsForQuery` surfaces the author + parent into the reply
  grounding (a **secret** parent is redacted). Both nullable, additive.
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
  subject's full progression (incl. superseded and expired, tagged `(past)`). `gatherGraphContext` feeds both
  into the **deep-tier** reply grounding (best-effort). Group-scoped, secret-excluded, current-only.
- **Retrieve** (`retrieve.ts`): **hybrid RRF** — semantic (pgvector cosine) ⊕ lexical
  (`content_tsv` full-text), fused by Reciprocal Rank Fusion, then recency-composed. The **deep
  tier** adds query **expansion/HyDE** (`expand.ts` → `retrieveExpanded`, cross-probe RRF) and a
  Haiku **re-rank** (`rerank.ts`) — both best-effort, degrading to plain hybrid on any error.
- Every retrieval arm (semantic *and* lexical) is **group-scoped, active-only, quarantined-
  excluded, current-embedding-model-only** — preserve all four in any query you add.
- **Reflect** (`reflect.ts` + `functions/reflect.ts`): a slow **sleep-time cron** (every 6h)
  re-reads each person's own facts + attributed notes and synthesises a durable per-person
  **profile**, stored back as a `system`-trust fact (supersedes the prior; grounds "who is X").
  Reads **already-trusted, non-secret, non-quarantined** rows only; picks only people with fresh
  activity since their last profile (never churns). Material is **non-secret + non-quarantined**
  (untrusted native-group notes ARE included — it's already-captured evidence/facts, not live
  group text; only secret + forwarded/bot content is excluded). This is the "it learns" step.
- **Forget** (`forget.ts`, deletion on request): `findMemoryToForget` resolves a target
  description to exact **group-scoped** row ids (facts via trigram/substring, notes via hybrid
  recall); `forgetMemory` runs **soft** (hide: `is_current`/`is_active=false`, reversible) or
  **purge** (redact value/content + drop the embedding). Confirm-tap-gated + audited (above).
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
- **Scenarios** (`scenarios/`, `docs/spec/chat-understanding-v2.md` §9): declarative multi-turn house
  conversations through the REAL pipeline (sandbox harness), with a scripted model injected via the
  test-only `setModelOverride` seam (`lib/ai/registry.ts`) and `setEmbedOverride` (`lib/ai/embed.ts`).
  They assert routing, reactions, rows and **what the model was told**. Behaviour the code doesn't
  have yet is a `knownGap` (runs as `it.fails`, names the finding + phase) — when your change flips
  one, drop its `knownGap`. Fixtures use the spec's classifier shape through ONE adapter
  (`scenarios/shapes.ts`); a schema change edits that file, not the scenarios. See `scenarios/README.md`.

## Env & deploy

- Required at boot (`lib/env.ts`): `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
  `BAUMY_SESSION_SECRET`, `BAUMY_ENCRYPTION_KEY`. Optional overrides: `BAUMY_HOUSE_CHAT_ID`, `BAUMY_OWNER_ID`
  (both auto-captured when the bot is added to the group), `BAUMY_PUBLIC_URL`, `BAUMY_TIMEZONE`.
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
