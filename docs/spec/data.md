# Neon + Drizzle + pgvector Persistence

> The invisible substrate. This section specifies the database stack, the migration workflow (with pgvector's sharp edges), the consolidated schema, and the least-privilege/backup posture. Most of it is **lift-and-rename from camp-404's `packages/db`**; the net-new work is pgvector, the **secure-value app-side encryption columns**, **dated-events + recurrence**, and the **`scheduled_tasks`** feature.

## Overview

Baumy reuses camp-404's `packages/db` almost verbatim (clean-room renamed to `@baumy/db`): a minimal `drizzle.config.ts`, a **dual-driver client factory** (`neon-http` for routes/edge, `neon-serverless` `Pool` for transactions, plus a PGlite `__setDbOverride` test seam), `db:generate`/`db:migrate`/`db:studio` scripts, journal-**v7** versioned migrations, a `vercel-build` deploy hook, and a two-part CI safety net (generate-drift + apply smoke test). **camp-404 uses no pgvector** — that, plus app-side encryption and the scheduled-task/dated-event columns, is the only genuinely new ground.

The consolidated schema is ~16 tables across four concerns:
- **Registry / security** — `members` (auto-discovered, `role`, `can_access_dashboard`, `dm_chat_id`), `telegram_chats`, `telegram_updates` (dedupe), `messages` (**verbatim transcript, retained**), `house_config` (singleton, incl. `response_policy`), `audit_log`.
- **Tiered memory substrate** — `memory_items` + `memory_embeddings` (**embed BOTH raw messages and derived facts**), `entities`, `relationships`, `facts` (bitemporal graph w/ provenance, **secure-value + dated-event columns**). *(Shapes defined in `memory-core.md`.)*
- **The structured features** — `reminders` (absolute / relative / event-anchored) and `scheduled_tasks` (user-definable recurring queries; digests are a built-in instance).
- **Operability** — `prompts` (versioned persona/prompts), plus the `notify_*` tables from `proactive.md`.

**Memory is one shared house pool.** Baumy is a *house-management* tool, not a personal PA (decision A3). There is **no `visibility` column, no `owner_user_id` partition, and no per-user RLS** anywhere in the schema. Every memory/fact is still **attributed to its author** for citation and retrieval boosting (A3b), but house-owned, not member-owned. A single **`group_id` origin-scope column** rides on every house-data table so a second group / multi-house Baumy is an *additive flip*, not a rewrite (D-sec / OWNER & TENANCY). v1 is single-tenant, single house group.

## Decisions

| # | Decision | Why | Confidence |
|---|----------|-----|-----------|
| 1 | **Lift camp-404's `drizzle.config.ts` verbatim, but point the migration URL at `DATABASE_URL_UNPOOLED`** (`process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? ''`). | `drizzle-kit migrate` opens a direct connection and wraps DDL in transactions; Neon's **pooled PgBouncer (transaction-mode) endpoint discards prepared statements**, causing intermittent, hard-to-reproduce deploy failures. camp-404's config uses the pooled URL — this is the one change to make. | high |
| 2 | **Pin `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10`, `@neondatabase/serverless ^1.1.0`** (exactly camp-404's set). Do NOT adopt drizzle v1. | As of 2026-07-01 the npm `latest` for drizzle-orm is 0.45.2; v1 is only on the `rc` tag (1.0.0-rc.4) — not GA. A private house bot shouldn't ship on a non-GA ORM with a different journal/snapshot format. | high |
| 3 | **`generate` → `migrate` workflow only; never `drizzle-kit push`** in any environment. | `push` has no history/rollback and hits bug **#5792** (emits HNSW index DDL without the operator class). It also silently **drops** the hand-written raw-SQL HNSW indexes (unmanaged from Drizzle's view). | high |
| 4 | **Bootstrap pgvector as migration 0000** — a custom, hand-written `CREATE EXTENSION IF NOT EXISTS vector;` (+ `pg_trgm` for nickname/typo entity matching), ordered before any `vector(...)` DDL. **No `pgcrypto`** — encryption is app-side (decision 13). | drizzle-kit's snapshot doesn't model Postgres extensions, so it never emits `CREATE EXTENSION`; a generated migration referencing `vector(1536)` fails at apply time. On Neon this needs no superuser and no paid tier. | high |
| 5 | **Embeddings = `vector(1536)`, `vector_cosine_ops`, in a SEPARATE `memory_embeddings` table** keyed `(memory_item_id, model)` — not inlined on `memory_items`. **Embed BOTH raw messages AND derived facts** (`memory_items.source_kind ∈ {message, fact}`). | 1536 (text-embedding-3-small) is under pgvector's 2000-dim HNSW ceiling (no `halfvec` needed). Splitting lets items be written synchronously (neon-http) and embedded later in an Inngest step, and supports zero-downtime re-embed. Embedding both layers hedges against extraction misses — semantic search still finds a relevant message even when it wasn't structured into a fact (D17). | high |
| 6 | **Create ALL HNSW indexes in a hand-written raw-SQL migration**, kept OUT of the Drizzle index builder. | drizzle-orm **#5792**: `drizzle-kit` emits `USING hnsw ("embedding")` without the mandatory operator class, which pgvector rejects ("no default operator class"). Raw SQL sidesteps it; document the convention + a CI guard against `push`. | high |
| 7 | **Apply migrations on deploy via `vercel-build`**: `"vercel-build": "pnpm --filter @baumy/db db:migrate && next build"`. Not Vercel cron, not a runtime path. | Vercel auto-runs `vercel-build`; `drizzle-kit migrate` is idempotent (tracks applied by hash in `drizzle.__drizzle_migrations`). Runs **before** `next build`, against the branch-scoped Neon URL the integration injects. | high |
| 8 | **Neon native (Vercel-managed) integration for branch-per-preview**, with "Automatically delete obsolete Neon branches" ON. | Copy-on-write `preview/<branch>` DB per PR tests each migration against a real prod copy before merge, at $0. Auto-delete prevents exhausting the **Free 10-branch cap**. | high |
| 9 | **Bitemporal + soft-invalidate everywhere**; supersede runs in a pooled transaction; `telegram_updates(update_id PK)` with `INSERT … ON CONFLICT DO NOTHING`; **`reminders.deliver_chat_id` NOT NULL, resolved in code to the house group** (never from LLM output). | Implements grounded/auditable memory + "dedupe on update_id, fail closed" + fixed send destination. Reminders are **house-scoped, delivered to the group** (A3) — untrusted text can't steer where a notification lands. | high |
| 10 | **Retain messages VERBATIM** (`messages`: full text + `author_member_id` + `sent_at`) as the evidence/quote layer — **no 30-day prune**. Only `telegram_updates.raw` is nulled after processing. | D17 (FINAL): keep BOTH verbatim messages AND a derived knowledge graph. The verbatim store is a **bot-queryable transcript that fixes Telegram's no-scrollback limit** (Baumy searches its own copy), enables exact quoting, re-extraction on model upgrade, and audit. Storage is trivial at 4-person scale. | high |
| 11 | **`group_id` origin-scope column on every house-data table** (`members`, `messages`, `memory_items`, `entities`, `relationships`, `facts`, `reminders`, `scheduled_tasks`), FK → `telegram_chats.chat_id`. v1 = the single house group. | D-sec / OWNER & TENANCY: data access = membership of the group the data originated from. Adding the column now makes multi-group / a 2nd house an **additive flip, not a rewrite**. Multi-tenant SaaS remains a NON-GOAL. | high |
| 12 | **One shared house pool — REMOVE all per-user scoping**: no `visibility`, no `owner_user_id`, no RLS on memory. Facts carry an `authored_by` **provenance FK** (member) only for citation/boosting. | A3: Baumy manages the house, not personal secrets — there is no private lane. A3b: still attribute every fact to its author ("what did Tom say?") and boost by author when a query names a person. Drops the RLS/visibility work entirely. | high |
| 13 | **Secure-value encryption is APP-SIDE**, not pgcrypto. `facts.is_secure` flag; when set, plaintext is **never stored** — instead `value_ciphertext` (bytea) + `value_iv` (bytea) + `key_version` (smallint). Encrypt before write / decrypt on read in the app using a key held in a Vercel env secret. | D-sec: door/gate/alarm codes, wifi, bank details. **A DB dump alone is useless without the app key.** Preferred over DB-side pgcrypto because the key lives with the app, not the DB. Little secret data overall → proportionate ("standard secure, not military"). | high |
| 14 | **Dated events + recurrence on facts**: `event_at` (timestamptz, nullable), `recurrence` (`text`, RRULE-lite / `NULL`). A scheduled Inngest scan surfaces upcoming dated facts. **`reminders.anchor_kind ∈ {absolute, relative, event_offset}`** with `event_fact_id` FK + `lead_interval`. | A4: reminders must handle absolute times, relative lead-times ("in N days"), AND **event-offsets** ("a week before Tom arrives" / recurring bills). Proactive surfacing reads dated facts. Richer than "fire at timestamp T." | high |
| 15 | **New `scheduled_tasks` table** — `{group_id, prompt, cadence, next_run_at, until_expiry, until_condition, requester_member_id, model_tier, web_search_enabled, is_active}`; one `scheduled_tasks` row per task, run by a shared dispatch cron; reports to the house group; cancellable. **Digests are a built-in system-created instance.** | A4b: user-definable recurring queries ("specials + hardware stores near us, weekly, until done"). Deliberate tasks → heavier model (`assess`/`advisor`) + **web search allowed** (deliberate path only). Digest cadence becomes on-the-fly settable. | high |
| 16 | **`response_policy` config as JSONB on `house_config`** — `{ global_enabled, categories{scheduling,info_lookup,…}, confidence_threshold, muted_topics[] }`. Writes go **only through the deterministic write-gate**; every change lands in `audit_log`; always dashboard-reversible. | A5: auto-answer house questions, configurable and self-configurable ("don't respond to X"). Owner = full control; trusted housemates = safe-direction (reduce-noise) changes; **untrusted group text can NEVER reconfigure** (injection would otherwise mute Baumy). | high |
| 17 | **House timezone = `Europe/Berlin`**; `house_config.house_timezone` DDL default `'Europe/Berlin'` (was `'UTC'`). | B9: single shared house TZ, DST-aware (GMT+1 winter / GMT+2 summer). Reminder/digest DST-correctness across Berlin transitions is the exact case the engine must pass. | high |
| 18 | **Members are auto-discovered, not `/bind`-ed.** First group message from a new `telegram_user_id` → auto-create a `members` row (`user_id → name` from `from`). `role='owner'` set from the `my_chat_member` "added" event (or `BAUMY_OWNER_ID` env override). `left_chat_member`/`my_chat_member` → `is_active=false` (memory remains). | B10 / OWNER & TENANCY: group membership IS the roster; owner = bot inviter. `dm_chat_id` captured on `/start` **only** for members granted `can_access_dashboard` (magic-link surface). | high |

## Concrete design

### Client (lift + rename)
- `createHttpDb()` = `drizzle(neon(url))` (`drizzle-orm/neon-http`) — stateless, **no transactions**, for routes/edge reads.
- `createPooledDb()` = `drizzle(new Pool({ connectionString }))` (`drizzle-orm/neon-serverless`) — transactions, for supersede/multi-row writes.
- `__setDbOverride` PGlite seam for tests (verify PGlite 0.5.x can load or conditionally skip pgvector).
- `house_config` singleton pattern from camp-404: `boolean('id').primaryKey().default(true)` + `check('..._singleton', sql\`${id}\`)`.

### Schema notes
- **`chat_id`/`message_id` as `text` end-to-end** (supergroup/channel ids exceed JS safe-integer comfort); `update_id` as `bigint` PK.
- Every memory/fact/relationship row: `valid_from`/`valid_to`, `is_current`, `superseded_by` self-FK, `deleted_at` (GDPR forget). Partial-unique `WHERE is_current` indexes are the hard backstop against two live rows.
- **`group_id text NOT NULL` on every house-data table**, FK → `telegram_chats.chat_id`, defaulted to the seeded house group in v1. Index `(group_id, is_current)` on `facts` for scoped retrieval.

### New / changed columns (illustrative DDL)

```sql
-- members: auto-discovered roster + dashboard grant
role                text    NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
can_access_dashboard boolean NOT NULL DEFAULT false,
dm_chat_id          text,                                 -- captured on /start, dashboard members only
is_active           boolean NOT NULL DEFAULT true,
deactivated_at      timestamptz,

-- facts: shared pool (NO visibility / owner_user_id), attribution, secure-value, dated events
group_id            text        NOT NULL REFERENCES telegram_chats(chat_id),
authored_by         text        REFERENCES members(telegram_user_id) ON DELETE SET NULL,  -- provenance/citation
is_secure           boolean     NOT NULL DEFAULT false,
value_ciphertext    bytea,        -- present iff is_secure; plaintext NEVER stored
value_iv            bytea,        -- AES-GCM nonce
key_version         smallint,     -- for key rotation
event_at            timestamptz,  -- dated event (guest arrival, bill due)
recurrence          text,         -- RRULE-lite (e.g. 'FREQ=YEARLY') or NULL

-- reminders: house-scoped, three anchor kinds, deliver target resolved in code
group_id            text        NOT NULL REFERENCES telegram_chats(chat_id),
deliver_chat_id     text        NOT NULL,                 -- = house group, resolved in code (never LLM)
anchor_kind         text        NOT NULL,                 -- 'absolute' | 'relative' | 'event_offset'
fire_at             timestamptz NOT NULL,                 -- computed
event_fact_id       uuid        REFERENCES facts(id) ON DELETE CASCADE,  -- for event_offset
lead_interval       interval,                             -- 'a week before'
recurrence          text,                                 -- inherited from a recurring event
created_by          text        REFERENCES members(telegram_user_id) ON DELETE SET NULL,
```

```sql
-- scheduled_tasks: user-definable recurring queries (digests are a built-in instance)
CREATE TABLE scheduled_tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id           text NOT NULL REFERENCES telegram_chats(chat_id),
  prompt             text NOT NULL,
  cadence            text NOT NULL,               -- cron/interval; one `scheduled_tasks` row per task, run by a shared dispatch cron
  next_run_at        timestamptz,
  last_run_at        timestamptz,
  until_expiry       timestamptz,                 -- hard stop (nullable)
  until_condition    text,                        -- soft "until done" description (nullable)
  requester_member_id text REFERENCES members(telegram_user_id) ON DELETE SET NULL,
  model_tier         text NOT NULL DEFAULT 'assess',   -- 'assess' | 'advisor'
  web_search_enabled boolean NOT NULL DEFAULT false,   -- deliberate path only
  is_system          boolean NOT NULL DEFAULT false,   -- true for built-in digests
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- house_config singleton: timezone + response policy (+ model routing lives in config)
house_timezone   text  NOT NULL DEFAULT 'Europe/Berlin',
response_policy   jsonb NOT NULL DEFAULT
  '{"global_enabled":true,"categories":{"scheduling":true,"info_lookup":true},
    "confidence_threshold":0.7,"muted_topics":[]}',
daily_spend_cap_usd numeric NOT NULL DEFAULT 0.50,   -- reminder delivery never gated
secure_key_version  smallint NOT NULL DEFAULT 1,      -- current app encryption key version
```

### Secure-value encryption (app-side)
- Cipher: **AES-256-GCM** via Node `crypto` (Inngest/route runtime) — verify a WebCrypto path if any edge route must decrypt. Key held in `BAUMY_ENCRYPTION_KEY` (Vercel env); `key_version` column supports rotation.
- Write path: `is_secure` facts store `value_ciphertext` + `value_iv` only; the plaintext `value` column stays NULL.
- Read path: decrypt on demand to answer a house member; **never volunteer unprompted; never include in digests/broadcasts/scheduled-task reports** (D-sec disclosure discretion). The sensitivity scanner still soft-redacts secrets in public replies.

### Roles & backup
- Least-privilege Neon roles: an **app read-write** role (routes/Inngest) and a **read-only** role for the future MCP read path (`auth-identity.md`). Reserve destructive DDL to the migration role. **No per-user RLS** — the shared-pool model needs none.
- **`messages` retained verbatim** (evidence/quote layer + bot-queryable transcript, decision 10) — not pruned. `telegram_updates.raw` nulled after processing (privacy: the bot receives *all* group messages). Backup/export of house memory via Neon's PITR + a periodic logical dump. If storage ever pressures the Free 0.5 GB cap, revisit an archive-tier sweep — not expected at house scale.

### GDPR forget (reconciled with B10)
- **Leaving the group ≠ deletion.** `left_chat_member` → `members.is_active=false`; **contributed house-memory remains** (B10). `facts.authored_by` / `messages.author_member_id` therefore `ON DELETE SET NULL` (provenance drops, house memory survives).
- **Targeted erasure** (a person's PII) is a separate deliberate op, not a side effect of deactivation. `reminders.created_by` / `scheduled_tasks.requester_member_id` also `SET NULL` (both are house-scoped and outlive their requester).

## Gotchas

- **`drizzle-kit` NEVER emits `CREATE EXTENSION`.** Land `CREATE EXTENSION IF NOT EXISTS vector;` as migration 0000 or the first `vector(...)` migration fails. (Correct clause order — not `CREATE EXTENSION vector IF NOT EXISTS`.)
- **No `pgcrypto` extension** — secure values are encrypted app-side (decision 13). Don't reintroduce it; a DB-side key defeats the "dump is useless without the app key" property. `gen_random_uuid()` is built into Postgres 13+ and needs no extension.
- **Migrate against `DATABASE_URL_UNPOOLED`** (direct), never the `-pooler` PgBouncer host. Add a boot assertion that the migration URL host does not contain `-pooler`.
- **#5792 twice over**: `push` emits HNSW DDL without the opclass **and** would DROP the raw-SQL HNSW indexes it can't see. Enforce generate+migrate; CI-fail on `drizzle-kit push`.
- **`neon-http` has no transactions** — supersede ("invalidate old + insert new") and reminder re-arm MUST use `createPooledDb().transaction()`.
- **2000-dim HNSW cap**: `text-embedding-3-large` (3072) will NOT index as plain `vector` — use `halfvec` + `halfvec_cosine_ops`, or truncate via OpenAI's Matryoshka `dimensions` param. Standardize on 1536.
- **Free-plan 10-branch cap** — preview branches accumulate; enable auto-delete or previews silently stop getting a DB.
- **Journal is format v7, tied to drizzle-kit 0.31.x** — don't mix a 1.0 beta against the same `migrations/meta` folder.
- **`BUILD_PLACEHOLDER_URL`** (`postgres://build:build@localhost`) lets `next build` collect page data without secrets — but `db:migrate` in `vercel-build` runs first and needs the real injected `DATABASE_URL_UNPOOLED`; fail-closed if it's absent in Production/Preview.
- **`response_policy` writes bypass the write-gate = injection hole.** Never write `house_config.response_policy` from an LLM-extracted value directly; route through the deterministic gate + `audit_log` (decision 16). Untrusted group text muting Baumy is the exact failure to prevent.
- **`deliver_chat_id` / scheduled-task target are code-resolved to the house group**, never taken from model output — same fixed-destination rule as reminders.
- **A single shared `scheduled-task-dispatch` cron over all active tasks** (Inngest crons are static — you cannot register one per row; see `scheduled-tasks.md` ST2). Deactivating a task flips `is_active=false`; the dispatcher skips it on the next sweep — there is no per-task cron to deregister.

## Facts to lock at build time (verify)

- **pgvector 0.8.x on Neon Hobby ($0)**, `CREATE EXTENSION IF NOT EXISTS vector;`, no add-on. HNSW dim caps: `vector` ≤2000, `halfvec` ≤4000.
- **text-embedding-3-small = 1536 dims @ $0.02/1M**; text-embedding-3-large = 3072 @ $0.13/1M (verify pricing).
- **Neon Free**: 0.5 GB storage/project, ~100 CU-hours/mo, **10 branches**, scale-to-zero after 5 min.
- Drizzle stack (2026-07-01 `latest`): drizzle-orm 0.45.2, drizzle-kit 0.31.10, @neondatabase/serverless 1.1.0.
- **App-side encryption**: confirm AES-256-GCM via Node `crypto` in the Inngest/route runtime (and a WebCrypto path if any edge route decrypts); `BAUMY_ENCRYPTION_KEY` present in Production/Preview envs; `key_version` rotation is a documented (not automated) procedure for v1.
- **Recurrence representation**: confirm RRULE-lite string vs a small enum (`annual`/`monthly`) — pick the minimum the reminder/scan engine actually needs.

## Tasks (ordered)

1. **Scaffold `@baumy/db`** from camp-404 (renamed; pinned Drizzle stack; PGlite dev dep). *(1–2h)*
2. **`drizzle.config.ts`** with unpooled migration URL. *(15m)* — dep: 1
3. **Migration 0000** — custom `CREATE EXTENSION IF NOT EXISTS vector;` (+ `pg_trgm`; **no `pgcrypto`**). *(15m)* — dep: 2
4. **`src/schema.ts`** — the ~16 consolidated tables (see `memory-core.md` for substrate shapes); free-form text labels, bitemporal, `group_id` origin-scope on every house-data table, **no `visibility`/`owner_user_id`/RLS**; `members` roster columns (`role`, `can_access_dashboard`, `dm_chat_id`, `is_active`); NO HNSW in the Drizzle builder. *(3–4h)* — dep: 3
5. **`facts` secure-value + dated-event columns** (`is_secure`, `value_ciphertext`, `value_iv`, `key_version`, `event_at`, `recurrence`) + `reminders` anchor columns (`anchor_kind`, `event_fact_id`, `lead_interval`). *(1h)* — dep: 4
6. **`scheduled_tasks` table** + partial index on `(is_active, next_run_at)`; seed the built-in digest instance (`is_system=true`). *(1h)* — dep: 4
7. **`house_config` `response_policy` JSONB + `house_timezone='Europe/Berlin'` + `daily_spend_cap_usd` + `secure_key_version`.** *(30m)* — dep: 4
8. **App-side encryption helper** (`encryptSecureValue`/`decryptSecureValue`, AES-256-GCM, `BAUMY_ENCRYPTION_KEY`, `key_version`); wire into the fact write/read path. *(1–2h)* — dep: 5
9. **`db:generate`, then a hand-written raw-SQL HNSW migration** (`USING hnsw (embedding vector_cosine_ops)`) for both message- and fact-sourced `memory_embeddings`; verify emitted SQL. *(45m)* — dep: 4
10. **Lift dual-driver factory + `__setDbOverride`**. *(1h)* — dep: 4
11. **Wire `vercel-build`** migrate hook. *(20m)* — dep: 9
12. **Neon native Vercel integration** (branch-per-preview + auto-delete). *(1–2h)* — dep: 11
13. **Port the two-layer CI gate** (generate-drift + PGlite/ephemeral-branch apply smoke test). *(1–2h)* — dep: 9
14. **Seed migration** — `house_config` singleton + primary house group in `telegram_chats`; `group_id` defaults point here. *(30m)* — dep: 9
15. **Least-privilege roles + retention sweep** — app RW + read-only MCP role; Inngest sweep **nulls `telegram_updates.raw` only** (messages retained verbatim per decision 10). *(0.5d)* — dep: 4

## Risks & mitigations

| Severity | Risk | Mitigation |
|----------|------|-----------|
| High | **Migrating through the pooled endpoint** → intermittent prepared-statement failures that fail deploys nondeterministically. | `DATABASE_URL_UNPOOLED` in `drizzle.config.ts` + boot assertion host ≠ `-pooler`; verify on a real preview deploy. |
| High | **Prompt injection** steers privileged writes (facts/reminders/notifications/**`response_policy`**). | Code-side write-gate gates privileged writes on verified member identity + surface, never on any LLM-extracted value; `reminders.deliver_chat_id` and scheduled-task target resolved in code; every `response_policy` change audited + dashboard-reversible. |
| High | **Secure values leak** via DB dump, digest, or unprompted disclosure. | App-side AES-256-GCM (key in env, not DB); plaintext never stored for `is_secure` facts; disclosure only on direct member request; excluded from digests/broadcasts/scheduled reports; sensitivity scanner soft-redacts in public replies. |
| Medium | **Embedding-model change** breaks fixed `vector(1536)`. | `(item, model)` split in `memory_embeddings` + idempotent re-embed backfill; Matryoshka truncation or `halfvec` if a larger model is required. |
| Medium | **`push` in dev drops the raw-SQL HNSW indexes** → silent retrieval degradation. | generate+migrate only; CI/package-script guard fails on `push`; document the HNSW-in-SQL convention. |
| Medium | **Supersede outside a transaction** on neon-http → two `is_current` rows / gaps. | All supersede in `createPooledDb().transaction()`; partial-unique `WHERE is_current` as hard backstop. |
| Medium | **A deactivated/expired task still gets dispatched** → runaway spend. | The single shared dispatcher filters on `is_active=true` + `next_run_at`/`until` each sweep; deactivation just flips the flag (no per-task cron to orphan); daily spend cap governs. |
| Medium | **Preview branches exhaust the 10-branch Free cap** → new previews/migrations blocked. | Auto-delete obsolete branches; CI job deletes its ephemeral branch; periodic audit via Neon API. |
| Medium | **Erasure vs "memory remains on leave" confusion** → over/under-deletes. | Deactivation (`is_active=false`) keeps memory (B10); provenance FKs `SET NULL`; targeted GDPR erasure is a separate deliberate op, not a leave side effect. |

## Open questions (for the owner)

1. **Confirm the embedding model + dimension** (drives the `vector()` constant): `text-embedding-3-small` @1536 recommended. One-way door once rows are indexed.
2. **Model ids** for the config-driven routing tiers (`classify`=OpenAI nano, `reply`=Haiku, `assess`=Sonnet, `advisor`=Opus) — bootstrap-set in `house_config`/config to avoid baking stale ids; confirm current ids + prices at setup (per project rule).
3. **Recurrence encoding** — RRULE-lite string vs a minimal `annual`/`monthly` enum for `facts.recurrence`. Pick the smallest thing the scan + reminder engine needs.
4. **Secure-value key rotation** — v1 treats `key_version` bump as a manual re-encrypt procedure; confirm that's acceptable vs any automated rotation.
5. **Confirm at build time**: exact env-var names the Vercel-managed Neon integration injects in 2026; that Neon Free + native integration + branch-per-preview is genuinely $0; installed pgvector version (≥0.8); `BAUMY_ENCRYPTION_KEY` provisioned in all deploy envs.

_Resolved by the decision log (no longer open): house timezone → `Europe/Berlin` (B9); raw-message retention → keep `messages` verbatim, null `telegram_updates.raw` (D17); reminder delivery → house group, not per-member DM (A3); sensitive-fact encryption → app-side, not pgcrypto (D-sec)._
