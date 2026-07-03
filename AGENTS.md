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
  classify/reply = Haiku, assess = Sonnet, advisor = Opus; the reply path self-escalates up that
  ladder. **Do not add another language-model vendor.**
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
pnpm test           # vitest run (offline; PGlite)
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
  housemate and never grounds a reply or writes a fact. Native group text is `untrusted`
  (grounds replies, never privileged). Member DM text is `trusted`.
- **Two human-authorization walls (don't conflate them):** (1) the **confirm-tap wall** —
  `callback_query` from a member's authenticated `from.id` (`lib/confirm/*`,
  `functions/callback.ts`) gates **memory deletion / "forget"** (the only chat-initiated
  privileged action). A "forget X" request only *proposes* a delete (LLM picks the target
  *description*; code resolves it to exact, group-scoped row ids the human reviews); nothing
  is removed until the tap. (2) the **dashboard-authz wall** — grants + response-policy/config
  changes commit via authenticated **owner/admin dashboard** server actions
  (`lib/auth/require-admin.ts` `requireAdmin`/`requireOwner`, re-checked live), **not** a
  Telegram tap. **Reminders are exempt from both — they auto-commit** (`ingest.ts` reminder
  step): a reminder only posts text to the fixed house group, so there's nothing to escalate.
  Do not re-add a confirm step to them.
- **Fixed send destination:** `sendToHouse` targets a **code-resolved** chat id only (house
  config / stored `deliver_chat_id` / task `group_id`). The LLM never picks a recipient.
- **Secrets at rest:** wifi/door/bank values are AES-256-GCM encrypted (`lib/core/crypto.ts`);
  only a non-secret descriptor is stored/embedded; decrypt only to answer a direct request,
  never in digests.
- **Dashboard authz is live:** re-checked against the DB on every request
  (`lib/auth/require-admin.ts`) — never cached in the cookie.
- **Trust-gated facts:** a fact may supersede an incumbent only if its trust ≥ the incumbent's
  (`lib/memory/facts.ts`) — the memory-poisoning defense.
- **Fail closed** everywhere (roster, env, webhook secret).

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
  default (classify→SAFE_VERDICT, extract→[], reminder/forget→none, reply→text fallback) so no
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
  growing PGlite suite — don't remove them).
- Add a test for every security-relevant change (the poisoning/authz/exactly-once paths).

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
- Reminders are exactly-once: claim → send → mark-sent, with release-on-failure + a stale-firing
  reaper. Don't reorder that.

---

*For Claude Code specifically: add a `CLAUDE.md` containing `@AGENTS.md` to auto-load this file.*
