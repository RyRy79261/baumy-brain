# Architecture & Scaffolding

> Workstream: `architecture` — build-ready spec for the Baumy Brain scaffold, deploy topology, and request lifecycle.
> Verified against current official sources as of **2026-07-01**; reconciled to the owner decision log (`00-decisions.md`) on **2026-07-02**. Reference repos (`camp-404`, `ops-board`) are read-only sources to lift-and-rename; **zero foreign identifiers may survive into the Baumy codebase** (clean-room rule).

---

## Overview

Baumy Brain is a **single Next.js 16 (App Router) application deployed as one Vercel Hobby project** — not a Turborepo/pnpm monorepo. The reference repo's monorepo exists to share `packages/*` across `web` + `admin-cli` + `mobile`; Baumy ships only the web surface, so the monorepo's sole benefit (cross-app code sharing) vanishes while all its costs (`turbo.json`, `pnpm-workspace.yaml`, per-package `tsconfig`/`eslint`, `workspace:*`, `@camp404/*` scopes needing clean-room rename) remain. Collapsing to one app also **shrinks the rename surface** (imports become `@/db`, `@/lib/*` instead of `@camp404/*`) and preserves every test seam (the PGlite `__setDbOverride` db override is just a module).

That single app carries **two first-class surfaces**: (1) the **Telegram bot pipeline** (the async brain) and (2) an **admin dashboard at `/admin`, which is IN v1 scope** (memory browser + provenance, member management + user-to-member mapping, reminder management, prompt/response-policy editing, cost/usage view). **Login is Telegram-native**: a housemate DMs the bot `/dashboard`, Baumy replies with a one-time, short-TTL, single-use signed **magic link** bound to their `telegram_user_id` and gated on `can_access_dashboard`; the link mints a **self-hosted Better Auth** session. Better Auth is the **session layer only** — the identity is the Telegram user. **There is no Google OAuth, no Resend email, and no `/setdomain` login widget.** The **owner is whoever invited the bot to the house group** (captured from the `my_chat_member` "added" event, overridable via `BAUMY_OWNER_ID`); the owner holds admin/config/kill-switch/keys, and any member can be granted dashboard access via a `can_access_dashboard` boolean.

The runtime spine is the **"200-fast-then-defer-to-Inngest" pattern**. A deliberately thin Telegram webhook route does exactly four things — (1) constant-time verify the `X-Telegram-Bot-Api-Secret-Token` header, (2) minimal Zod parse, (3) a **deterministic structural write-gate** (`message.text` present AND the update comes from an in-scope chat — the house group `chat_id === BAUMY_HOUSE_CHAT_ID`, **or** a private DM from a known member for house-management commands), (4) `inngest.send()` keyed on Telegram's `update_id` then return `200` — and **all** heavy work runs durably inside Inngest steps, off the request path. This is simultaneously the performance design (Telegram redelivers slow/failed webhooks), the cost design (I/O-bound LLM work is billed as Provisioned Memory, not CPU), and the **security posture**: because privacy mode is OFF, every group message is untrusted prompt-injection input, and untrusted text can never synchronously steer a privileged write when the write-gate lives in the deferred function and the send destination is a hard-coded env constant.

The processing brain is split by a **reactive-vs-deliberative firewall** — the core cost/security invariant of the system:
- **Reactive path** (every pre-filtered inbound message): `classify` (OpenAI nano) → `remember` / `schedule-reminder` / `reply`. The reply model ceiling is **Haiku**; the reactive path is **memory-only, zero tools, and can NEVER invoke Opus** (a misclassified message must never reach the expensive model or the web).
- **Deliberative path** (explicit, trusted "go research/assess X" intent + scheduled tasks only): `assess` (Sonnet, reasoning over on-hand/retrieved info) and `advisor` (Opus, derived answers needing real research not on hand), and this path **alone** may use the **web-search tool**. It is never triggerable by untrusted group text; output still goes only to the fixed house group; the spend cap governs it.

Two more structural features round out v1. **Scheduled tasks** generalize digests: a user can say "run this query weekly until done" → a `baumy_scheduled_tasks` row + an Inngest cron scanner that runs it on the deliberative path and reports to the group (digests are a built-in seeded instance). **Retention keeps BOTH layers**: every message is stored **verbatim** (evidence/quote layer, a bot-queryable transcript that works around Telegram's no-scrollback limit) AND distilled into a **derived knowledge graph** (entities/facts/edges, bitemporal + provenance); **both** raw messages and derived facts are embedded so semantic search still finds a relevant message even when extraction missed it.

Reminders — a hard-structured, scheduled feature — fire via a **daily-arm + `step.sleepUntil` + catch-up sweeper "heartbeat"** design over a durable `baumy_reminders(fire_at)` table using `FOR UPDATE SKIP LOCKED`. Vercel cron is banned (cost); Inngest triggers its own crons at no extra Hobby cost.

Baumy is **single-tenant** (this one house only; others self-host by forking), but every origin-scoped table carries a `group_id` column as cheap future-proofing so a second group is an additive flip, not a rewrite. Multi-tenant SaaS is a **non-goal**.

---

## Decisions (with rationale)

### D1 — Single Next.js 16 app, one Vercel project. No Turborepo, no pnpm workspaces, no `packages/*`.
Only one deployable surface exists (the bot pipeline and the admin dashboard ship from the same app). The monorepo's cross-app sharing benefit is gone; its overhead and rename cost are not. Testability is preserved (pure `lib/core` logic + the PGlite db seam are plain modules unit-tested in-app). Bonus: eliminates all `@camp404/*` scope renames. *(Verification: Turborepo/monorepo IS supported on Hobby and would deploy — Hobby is limited to 1 concurrent build, a non-issue for one app — so this is a simplicity call, not a platform constraint.)* **Confidence: high.**

### D2 — Flat root layout: `app/`, `lib/`, `db/` at repo root; TS path alias `@/*` → `./` (no `src/`).
Mirrors the reference `apps/web` internal layout (which already uses `@/lib`, `@/app`), making the clean-room copy nearly mechanical — keep module folder names aligned to the source package names (`db`, `telegram`, `ai`, `core`) so lifting is a rename-imports-only operation. New Baumy-specific modules (`lib/auth`, `lib/memory`, `lib/ai/tools`) follow the same alias. **Confidence: high.**

### D3 — Route groups for pages; flat `api/` for machine endpoints. The admin dashboard is IN v1.
`app/(public)/page.tsx` → `/` (landing); `app/(private)/admin/**` → `/admin/*` behind an auth-gated `(private)/layout.tsx`. API handlers stay flat under `app/api/`: `telegram/webhook/route.ts`, `inngest/route.ts`, `auth/[...all]/route.ts` (Better Auth), `health/route.ts`. Route groups `(name)` don't affect the URL; their idiomatic use is giving the admin console its own auth shell. The Telegram/Inngest routes are machine endpoints with their own auth (secret token / Inngest signature) and **must be excluded from the auth proxy matcher**; `/api/auth/*` is included (it is the session layer itself). **Confidence: high.**

### D4 — Module placement.
`db/` (`schema.ts`, dual-driver `client.ts`, `drizzle.config.ts`, `migrations/`); `lib/telegram/` (raw fetch client + `verify` + `parse`); `lib/ai/` (Vercel AI SDK provider registry + `classify`/`assess`/`advisor`/`reply`/`summarize`/`embed` + `resolveModel` + `tools/websearch.ts`); `lib/memory/` (verbatim-message store + derived-graph write/retrieve/provenance substrate); `lib/auth/` (Better Auth config + Telegram magic-link issue/verify + session helpers); `lib/inngest/` (`client.ts` + `functions/`); `lib/core/` (deterministic write-gate + dedupe + reactive/deliberative tier clamp, pure/unit-tested); `lib/env.ts` + root `instrumentation.ts` (boot env-assert); root `proxy.ts` (auth matcher). `lib/ai` swaps the reference's raw `@anthropic-ai/sdk`+`groq-sdk` for the locked Vercel AI SDK abstraction. **Confidence: high.**

### D5 — Node.js runtime for BOTH `/api/telegram/webhook` and `/api/inngest`. Never Edge.
`runtime = 'nodejs'` is required for (a) the `neon-serverless` WebSocket/transaction driver on the memory-write and reminder-claim paths, (b) crypto timing-safe compare + magic-link token signing, and (c) Fluid Compute's optimized in-function concurrency (Node/Python only — the exact win for I/O-bound AI+DB calls). It is also Inngest's recommended runtime. On Hobby, Node already gets the full 300s, so Edge (25s-to-first-byte, no full Node API, no transactions) offers zero benefit. **Confidence: high.**

### D6 — Fast-ack webhook: verify → parse → structural gate → dedupe/enqueue → `200`.
Telegram redelivers any update whose webhook returns non-2xx or responds too slowly, causing retry storms and per-chat queue backpressure. Keeping the handler to a single outbound round-trip (`inngest.send`, typically <200ms) guarantees a sub-second ack. Set `maxDuration = 15` on the webhook (fail fast) so a hung `send` returns 5xx quickly rather than hanging to Telegram's own timeout. **Confidence: high.**

### D7 — Idempotency boundary = the Inngest event `id`, keyed on `update_id`.
`inngest.send({ id: \`tg:update:${update.update_id}\`, name: 'telegram/message.received', data })`. `update_id` is a positive integer, unique and monotonically increasing per bot (only randomly reset after ~a week of total inactivity) — a perfect natural dedup key. Inngest dedupes identical event `id`s for **24h**, vastly longer than Telegram's minutes-scale retry horizon, so a redelivered update never spawns a second run **without any synchronous DB dedup write in the ack path**. Add function-level `idempotency: 'event.data.updateId'` as a second independent 24h guard. A durable `baumy_inbound_messages(update_id UNIQUE)` upsert inside the first pipeline step is the beyond-24h backstop. **Confidence: high.**

### D8 — Fail closed on hand-off; fail open on poison input.
If `inngest.send` throws, return **503** so Telegram retries (the deterministic event id makes the re-send a no-op). If the body is unparseable or the message is out-of-scope (not the house group and not a known-member DM, or no text), return **200** — a poison update will never succeed on retry, so absorb it to keep Telegram's per-chat queue draining. A dropped update is worse than a duplicate here because dedup makes duplicates free. **Confidence: high.**

### D9 — Deterministic write-gate lives in deterministic places, never in model output; two inbound lanes, tightly-scoped outbound.
(a) **Webhook structural gate**: require `update.message?.text` present AND the update is in-scope, where in-scope means **either** `String(chat.id) === BAUMY_HOUSE_CHAT_ID` (the house lane) **or** a **private chat from a `from.id` that maps to a known active member** (the DM lane, for house-management commands: `/dashboard` magic-link login, `/start` binding, owner/admin commands). An unknown-sender DM → `200 {ignored}`. (b) **Fixed send destinations, enforced inside `lib/telegram/client.ts`** with an explicit two-mode allow-list: **house content** always targets the single `BAUMY_HOUSE_CHAT_ID` constant; the **only** other permitted destination is a **DM reply to the exact originating member's private chat** and **only** for the auth/login response path (the magic link). The classifier/LLM can never choose a recipient. Untrusted text can therefore only become memory/retrieval data or a reply back INTO the house group; LLM output is data, never a command. **Confidence: high.**

### D10 — Reactive pipeline = one staged Inngest function, cheapest gate first.
`record-inbound` (idempotent verbatim upsert + enqueue extraction) → `classify` (cheap OpenAI nano → constrained enum `{ignore, remember, reminder, reply, deliberate}`) → conditional `remember` / `schedule-reminder` / `reply` / emit-`deliberation-requested`. Privacy-off means high message volume; the nano classifier is the volume filter that short-circuits the expensive paths. `reply` is retrieval-grounded, **Haiku-ceiling, memory-only, zero tools**, gated by the `response_policy` config (reply on @mention/reply AND on house-relevant questions it can confidently ground; otherwise silent capture). The `deliberate` enum value only **emits an event** for the separate deliberative function after a deterministic trust check — the reactive classifier itself never invokes Sonnet/Opus or any tool. Each `step.run` is its own memoized ≤300s invocation with per-step retry isolation. **Re-resolve provider secrets INSIDE each step; never return secrets across a step boundary.** **Confidence: high.**

### D11 — Reminders via daily-arm + `step.sleepUntil` + a catch-up sweeper cron "heartbeat", not Vercel cron.
Reminders must fire reliably at the due moment and notify the group. A **daily arming function** (`createFunction({ triggers: { cron } })`, once/day) claims `scheduled` rows due within the next window (≤7d — Inngest Free caps one `sleep` at 7 days) and issues a `step.sleepUntil(fire_at)` per reminder for **exact-moment** firing. A **minute-cron catch-up sweeper** (the "heartbeat") independently scans `baumy_reminders WHERE status='scheduled' AND fire_at <= now()` for anything missed, redeployed-through, or beyond the arm window, and atomically claims rows via `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. Together they are precise (sleepUntil), unbounded in horizon (sweeper), redeploy-safe, and idempotent (atomic `scheduled→firing→sent` flips; `SKIP LOCKED` prevents double-claim; the send itself is claim-guarded). The claim needs the **pooled** Neon driver (`neon-serverless`), not `neon-http`. **Reminder delivery is never gated by the spend cap.** **Confidence: high.**

### D12 — Guard the non-idempotent reply/notify send with an insert-before-send claim.
`INSERT INTO baumy_replies(update_id) ON CONFLICT DO NOTHING RETURNING update_id`; only send if the row was claimed. `sendMessage` has no client-supplied idempotency key, so a re-run/replay could double-post to housemates. The DB claim gives a durable one-send-per-inbound guarantee beyond the 24h Inngest window. Trade-off: claim-then-send is at-most-once (a send that throws after claiming is skipped on retry) — for a group chat, dropping over double-posting is the safer failure. Keep the reply step `retries: 0`. The same claim pattern guards reminder and deliberative-result sends. **Confidence: medium.**

### D13 — Provider keys live in Vercel env vars as one shared set. Do NOT lift the per-user encrypted key table.
Baumy is **single-tenant** (~4 housemates share one bot), so the reference `user_api_keys` (`anthropicKeyEncrypted`/`groqKeyEncrypted`) BYO-key model is unnecessary complexity. `@ai-sdk/anthropic` reads `ANTHROPIC_API_KEY` and `@ai-sdk/openai` reads `OPENAI_API_KEY` automatically; all four routing tiers (classify/reply/assess/advisor) plus the web-search tool draw from the same shared keys. **Confidence: high.**

### D14 — Secrets marked Vercel "Sensitive" for Production + Preview; local dev uses `.env.local`.
Sensitive vars are encrypted at rest and unreadable after creation. Vercel's API **disallows Sensitive vars in the Development target**, so local dev must hand-maintain `.env.local`. Store every secret in a password manager at creation time — a lost value can only be rotated. This now covers the auth + encryption secrets (`BETTER_AUTH_SECRET`, `BAUMY_SESSION_SECRET`, `BAUMY_ENCRYPTION_KEY`) too. **Confidence: high.**

### D15 — Bind the real bot + webhook to Production only.
Telegram permits **exactly one webhook per bot token**; you cannot fan one bot's webhook out to every ephemeral preview URL. The fixed house send destination is the prod group `chat_id` anyway. For pre-merge testing, register a throwaway BotFather test bot against a single pinned preview, or POST synthetic updates with a valid secret token in tests. **Confidence: high.**

### D16 — Neon–Vercel integration provisions both a pooled and an unpooled URL.
`DATABASE_URL` (pooled, PgBouncer transaction mode) for app runtime; `DATABASE_URL_UNPOOLED` (direct) for `drizzle-kit migrate`/seed and any row-locking transaction — the pooled URL breaks prepared statements mid-migration. Preview deployments each get an isolated Neon branch DB automatically. **Confidence: high.**

### D17 — Let the Vercel↔Inngest integration inject `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`.
The SDK auto-reads both; the integration sets them across all environments and shares one pair across branch/preview envs. **Keep both OUT of `.env.example` and any `globalEnv`.** `INNGEST_SIGNING_KEY` verifying the serve callback **is** the auth for `/api/inngest`. **Confidence: high.**

### D18 — Fail-fast boot validation: `assertServerEnv()` from `instrumentation.ts`.
`lib/env.ts` iterates a `REQUIRED[]` of `{name, minLength, hint}` and throws one consolidated error on missing/short vars; no-ops under a test-mode flag. `instrumentation.ts register()` calls it **only when** `NEXT_RUNTIME==='nodejs'` && `NEXT_PHASE!=='phase-production-build'`, so `next build` does not fail when runtime secrets are absent. Keep the build-safe `BUILD_PLACEHOLDER_URL` in the db client for the same reason. **Confidence: high.**

### D19 — Non-secret DB config for runtime routing without redeploys: `baumy_model_route` + `baumy_prompt` + `baumy_response_policy`.
`baumy_model_route` maps a task label → provider/model/params (+ a `reactive` flag); `baumy_prompt` maps label/version → body; `baumy_response_policy` holds the reply-enable categories/threshold/mutes. Read at runtime, cached in-module with a short TTL (30–60s). **Fail closed to a hardcoded default per task** — the **reactive `reply` task fails closed to Haiku, NEVER Opus**; `classify` to nano; deliberative tasks to their tier default. These tables **hold NON-SECRET operational config only** — secrets stay in env vars. **Writes are admin/migration-only, through the deterministic write-gate**: the owner edits freely via the dashboard; a trusted housemate may make audited safe-direction (reduce-noise) response-policy changes via self-config; **untrusted group text can NEVER reconfigure Baumy** (an injection must not be able to mute it), and every change is reversible from the dashboard. **Confidence: high.**

### D20 — Env naming: prefix only custom vars with `BAUMY_`; keep vendor names neutral.
`BAUMY_HOUSE_CHAT_ID`, `BAUMY_OWNER_ID`, `BAUMY_PUBLIC_URL`, `BAUMY_SESSION_SECRET`, `BAUMY_ENCRYPTION_KEY`. Vendor/library SDKs expect neutral names verbatim (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INNGEST_*`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`), so renaming them breaks auto-resolution. Zero foreign identifiers (no `camp404`/`opsboard`/`intake`). **Confidence: high.**

### D21 — Reactive-vs-deliberative model routing (the core firewall). Default tiers seeded in `baumy_model_route`.
Decouple the **reactive** (cheap, capped, high-frequency) path from the **deliberative/advisor** (expensive, explicit-only) path so the expensive model is unreachable by a misclassified message:
| role | tier | default model | invoked by | tools |
|---|---|---|---|---|
| `classify` | reactive | OpenAI nano | every pre-filtered message | none |
| `reply` | reactive | **Haiku** (`claude-haiku-4-5`) | live chat / grounded answers | none, memory-only |
| `assess` | deliberative | **Sonnet** (`claude-sonnet-5`) | deliberative fn / scheduled task | web-search allowed |
| `advisor` | deliberative | **Opus** (`claude-opus-4-8`) | **explicit deliberate intent only** | web-search allowed |

**HARD RULE: the reactive/reply path NEVER invokes Opus** (false-positive cost control), enforced deterministically in `resolveModel` (a `reactive`-flagged task whose configured model is outside the reactive set is clamped back to its safe default). All routing is config-driven and tweakable with no redeploy; exact tier thresholds are TBD and tuned from real usage. **Opus 4.8 rejects `temperature`/`top_p`/`top_k` and `budget_tokens` with HTTP 400** → `temperature` is nullable, seeded NULL for Opus, and omitted in the AI-SDK call (pass adaptive thinking via `providerOptions.anthropic`). **Confidence: high.**

### D22 — `/admin` auth via **self-hosted Better Auth** with a **Telegram bot-DM magic link**; `proxy.ts` matcher scoped to `/admin` + `/api/auth` ONLY.
The dashboard is in v1. Auth is **self-hosted Better Auth as the session layer only** — `app/api/auth/[...all]/route.ts` exports `toNextJsHandler(auth)` (GET+POST) with a Drizzle/Postgres adapter over the same Neon DB. **Identity is the Telegram user, not an email/OAuth account**: a member DMs `/dashboard` → the pipeline (gated on `can_access_dashboard`) issues a one-time, short-TTL, single-use signed token bound to `telegram_user_id` (stored hashed in `baumy_login_tokens`) → Baumy DMs back `${BAUMY_PUBLIC_URL}/admin/login?token=…` → the callback verifies+consumes the token and mints a Better Auth session for that member. **No Google OAuth, no Resend email, no login widget / `/setdomain`.** Next.js 16 **renamed `middleware.ts` → `proxy.ts`**; the matcher is `['/admin/:path*','/api/auth/:path*']` and **must exclude** `/api/telegram/webhook` and `/api/inngest` (their auth is the secret-token header / Inngest signature; a session-cookie gate would 401 the platform callbacks and silently kill all async processing + reminders). The token-exchange callback must NOT require a pre-existing session (it is the session minter). **Confidence: high.**

### D23 — Strip reference web config to essentials.
Drop `transpilePackages` (no workspace pkgs), the mobile `output:'export'` branch, the `.well-known/*` MCP rewrites (MCP deferred), and `vercel.json` crons + Firebase env. **Keep** `typedRoutes`, the `vercel.json` security headers, the `instrumentation.ts` → `assertServerEnv()` fail-fast pattern, and pin `{"fluid": true}` in `vercel.json`. **Confidence: high.**

### D24 — Pin the Inngest major version deliberately before scaffolding.
The reference repo is on Inngest **v3** (3-arg `createFunction`, `EventSchemas().fromRecord`). Inngest **v4** (latest 4.11.0) moved `triggers` into the config object (2-arg form) and **removed** `EventSchemas` in favor of `eventType()` — copying v3 code onto v4 will not compile. Either pin **v3-lts (3.54.0)** to lift reference code verbatim, or start fresh on **v4 latest** with `eventType()` and the 2-arg form. Add a CI typecheck gate. **Confidence: medium** *(recommend v4 for longevity if writing fresh).*

### D25 — Deliberative pipeline is a separate, trust-gated Inngest function.
`run-deliberation` is triggered ONLY by (a) a `deliberation/requested` event emitted from the reactive pipeline **after a deterministic trust+command check** ("go research/assess X" from a member permitted to spend), or (b) the scheduled-tasks cron. It chooses `assess` (Sonnet, when the answer is derivable from on-hand/retrieved memory) vs `advisor` (Opus, when real external research is needed), may bind the **web-search tool** (input-only), and writes its result **only** to the fixed house group via the claim-guarded send. It is subject to the spend cap. This is the mechanism that keeps "a calm, deliberate thing" off the reactive hot path. **Confidence: high.**

### D26 — Scheduled tasks module (`baumy_scheduled_tasks` + `run-scheduled-tasks` cron scanner); digests are a built-in instance.
A user-definable recurring query: `{prompt, cadence, until/expiry, requester, model_tier, group_id, next_run_at, enabled}`. A minute/interval cron scanner claims due rows (`FOR UPDATE SKIP LOCKED`), runs each on the **deliberative path** (Sonnet/Opus + web search allowed), reports to the house group, recomputes `next_run_at` from `cadence`, and disables the row when `until` is reached or the task is cancelled. **Digests** (midweek + end-of-week, cadence settable on the fly) are seeded rows of this table. A companion scan surfaces upcoming **dated events** from the memory graph (~a week ahead) to feed digests + conservative nudges. Mirrors the reminder scanner's claim/idempotency shape rather than registering a literal Inngest cron per task (Inngest crons are deploy-time, not row-time). **Confidence: high.**

### D27 — Web search is a deliberate-path-only, input-only tool.
Only `assess`/`advisor` (explicit trusted requests + scheduled tasks) may call the web-search tool for external info (specials, nearby stores, prices; "near us" uses the house location, so a maps-capable search may be needed). **Security invariant held: the reactive reply path stays memory-only with zero tools (exfil-safe).** Web search is INPUT-only; OUTPUT still goes only to the fixed house group; it is never triggerable by untrusted group text; the spend cap governs it. The exact search tool/provider is verified at build. **Confidence: medium** *(provider TBD — see open questions).*

### D28 — Retention keeps BOTH verbatim messages AND a derived knowledge graph; embed both.
**Verbatim layer** (`baumy_inbound_messages`, full text + author + `tg_date` + `chat_id`/`group_id`) is the evidence/quote layer and a **bot-queryable transcript** that works around Telegram's no-scrollback limit (Baumy searches its OWN copy). **Derived layer** (`entities`/`facts`/`edges`, bitemporal + provenance, secure-value flag) is the understanding/reasoning layer that grounds replies and answers "what's due / what did X say", pointing back to source messages for exact quotes. **Both** raw messages (`memory_items` embeddings) AND derived facts are embedded so semantic search still hits a relevant message when extraction missed structure. This dual layer (pgvector + a relational graph, both in Postgres) is the deliberate ceiling — **no dedicated graph DB / heavy GraphRAG** at 4-person scale. Full memory schema is owned by the memory-core workstream; architecture pins the verbatim store, the embedding of raw messages, and `record-inbound` enqueuing extraction. **Note:** Telegram bots cannot backfill group history → memory starts empty at deploy; cold-start seeding matters. **Confidence: high.**

### D29 — Owner = bot inviter; single-tenant; `group_id` origin-scope hygiene.
The **owner** is whoever invited the bot to the house group, captured from the `my_chat_member` "added" event (`BAUMY_OWNER_ID` env override allowed) — this replaces any `/start <BOOTSTRAP_SECRET>` dance. Members are auto-discovered from group activity (first message from a new `user_id` → `baumy_members` row); leaving the group deactivates the member (their contributed memory remains). All members share equal usage rights (contribute/query/ask for scheduled tasks); the owner additionally holds admin/config/kill-switch/keys. Baumy is **single-tenant** (hosts only this house; others fork to self-host), but every origin-scoped table carries `group_id` so a second group is an additive flip. **Multi-tenant SaaS is a non-goal.** **Confidence: high.**

### D30 — App-side encryption of flagged "secure values"; spend cap as a deterministic gate.
Genuinely-secret facts (door/gate/alarm codes, wifi, bank details) carry a `secure_value` flag; those values are **encrypted app-side (AES-GCM) with `BAUMY_ENCRYPTION_KEY`** before write and decrypted on read to answer — a DB dump alone is useless without the app key (preferred over DB-side pgcrypto). Disclosure discretion: answer on request to a house member, never volunteer, never include in digests/broadcasts. Separately, a **hard daily spend ceiling (~$0.50/day, ~$15/mo, tweakable)** is enforced as a deterministic gate before any paid model/tool call, logged to `baumy_spend_ledger`; past the cap the system enters a degraded mode — **but reminder delivery is never gated**. (Ledger granularity/cost accounting coordinates with the cost workstream.) **Confidence: medium.**

---

## Concrete design / APIs / DDL / config

### Directory layout
```
baumy-brain/
├─ app/
│  ├─ (public)/page.tsx            # / landing
│  ├─ (private)/
│  │  ├─ layout.tsx                # auth-gated admin shell (Better Auth session required)
│  │  └─ admin/**                  # /admin/* console: memory+provenance, members+binding,
│  │                               #   reminders, prompt/response-policy editing, cost/usage
│  └─ api/
│     ├─ telegram/webhook/route.ts # runtime nodejs, maxDuration 15
│     ├─ inngest/route.ts          # runtime nodejs, maxDuration 300
│     ├─ auth/[...all]/route.ts    # Better Auth toNextJsHandler (GET, POST)
│     └─ health/route.ts
├─ db/
│  ├─ schema.ts                    # verbatim + derived-graph memory + reminders + scheduled
│  │                               #   tasks + dedup + reply-guard + config + members + auth
│  ├─ client.ts                    # dual-driver + __setDbOverride + BUILD_PLACEHOLDER_URL
│  ├─ drizzle.config.ts
│  └─ migrations/
├─ lib/
│  ├─ telegram/   (client.ts, verify.ts, parse.ts, index.ts)
│  ├─ ai/         (providers.ts, route.ts, classify.ts, assess.ts, advisor.ts,
│  │              reply.ts, summarize.ts, embed.ts, tools/websearch.ts)
│  ├─ memory/     (source-messages.ts, retrieve.ts, write.ts, graph.ts, provenance.ts, crypto.ts)
│  ├─ auth/       (config.ts [betterAuth], magic-link.ts [issue/verify], session.ts)
│  ├─ inngest/    (client.ts, functions/{ingest-message,run-deliberation,
│  │              run-scheduled-tasks,arm-reminders,fire-due-reminders,index}.ts)
│  ├─ core/       (write-gate.ts, dedupe.ts, tier-clamp.ts, spend-cap.ts)  # pure, unit-tested
│  └─ env.ts      (assertServerEnv)
├─ instrumentation.ts
├─ proxy.ts                        # auth matcher ['/admin/:path*','/api/auth/:path*']
├─ vercel.json                     # {"fluid": true} + security headers, NO crons
├─ next.config.ts                  # typedRoutes; no transpilePackages/mobile/.well-known
└─ package.json                    # name: "baumy-brain"
```
`tsconfig` paths: `"@/*": ["./*"]`.

### Locked dependency set (verified 2026-07-01)
```jsonc
// dependencies
"next": "^16.2.6",
"react": "^19.2.6", "react-dom": "^19.2.6",
"ai": "^7",                       // latest 7.0.11; peers zod ^3.25.76 || ^4.1.8
"@ai-sdk/anthropic": "^4",        // 4.0.5 — the v4 provider line pairs with ai@7
"@ai-sdk/openai": "^4",           // 4.0.5 — also the embeddings provider
"drizzle-orm": "^0.45.2",
"@neondatabase/serverless": "^1.1.0",
"inngest": "^4.11.0",             // OR "3.54.0" (v3-lts) if lifting reference verbatim — see D24
"zod": "^4",                      // ^4.4.3
"@vercel/functions": "latest",    // attachDatabasePool
"better-auth": "^1",              // self-hosted session layer + Drizzle adapter; verify exact minor at build

// devDependencies
"drizzle-kit": "^0.31.10",
"@electric-sql/pglite": "^0.5.3",
"vitest": "^4",
"typescript": "latest"
// NOTE: NO @neondatabase/auth — auth is self-hosted Better Auth, not Neon Auth.
```
Toolchain floor: `pnpm@10.33.0`, Node `>=22`.

### Model routing (seed `baumy_model_route`)
| task | reactive | provider | model_id | notes |
|---|---|---|---|---|
| `classify` | ✅ | openai | `gpt-5-nano` *(verify id/price)* | ~$0.05/$0.40 per MTok; constrained-enum output; no tools |
| `reply` | ✅ | anthropic | `claude-haiku-4-5` | $1/$5; grounded on retrieval; memory-only, **NEVER Opus** |
| `assess` | ❌ | anthropic | `claude-sonnet-5` | $3/$15 (intro $2/$10 to 2026-08-31); reasoning over on-hand info; web-search allowed |
| `advisor` | ❌ | anthropic | `claude-opus-4-8` | $5/$25; **explicit deliberate intent only**; web-search allowed; **temperature NULL** |
| `digest` | ❌ | anthropic | `claude-sonnet-5` | scheduled-task/digest summarization tier |

Anthropic reference: Opus 4.8 `$5/$25`; Sonnet 5 `claude-sonnet-5` `$3/$15` (intro `$2/$10` through 2026-08-31); Haiku 4.5 `claude-haiku-4-5` `$1/$5`. **Opus 4.8 rejects sampling + `budget_tokens`; use `thinking:{type:'adaptive'}` + `output_config.effort`.** Anthropic has **no embeddings API** — embeddings come from OpenAI (`text-embedding-3-small`, 1536 dims) or Voyage; **fix the dimension before writing the vector column** (a change forces a re-embed migration). Verify all model ids/prices at build (project rule).

### DDL — verbatim + graph memory, dedup, reply-guard, reminders, scheduled tasks, config, members, auth, spend
```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- inbound dedup + VERBATIM message store (evidence/quote layer + bot-queryable transcript)
CREATE TABLE baumy_inbound_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  update_id    bigint NOT NULL UNIQUE,
  group_id     text,                              -- origin-scope hygiene (single-tenant now)
  chat_id      text,
  message_id   bigint,
  from_user_id text,
  text         text,                              -- full verbatim text (re-extractable, quotable)
  edited       boolean NOT NULL DEFAULT false,    -- edited_message re-run marker
  tg_date      timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- one-send-per-inbound claim (guards non-idempotent sendMessage on reply/notify)
CREATE TABLE baumy_replies (
  update_id  bigint PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  message_id bigint
);

-- reminders: fire reliably at the due moment; daily-arm + sleepUntil + sweeper heartbeat
CREATE TYPE baumy_reminder_status AS ENUM ('scheduled','firing','sent','failed','cancelled');
CREATE TABLE baumy_reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         text,
  source_update_id bigint,
  created_by       text,
  chat_id          text,
  body             text NOT NULL,
  fire_at          timestamptz NOT NULL,          -- absolute, or computed from an event date - lead time
  status           baumy_reminder_status NOT NULL DEFAULT 'scheduled',
  armed_at         timestamptz,                   -- set by the daily-arm sleepUntil path
  message_id       bigint,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX baumy_reminders_due_idx ON baumy_reminders (fire_at) WHERE status = 'scheduled';

-- scheduled tasks: user-definable recurring deliberative queries (digests are seeded instances)
CREATE TABLE baumy_scheduled_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      text,
  requester     text,
  prompt        text NOT NULL,
  cadence       text NOT NULL,                    -- cron string or interval; representation TBD
  model_tier    text NOT NULL DEFAULT 'assess' CHECK (model_tier IN ('assess','advisor')),
  next_run_at   timestamptz NOT NULL,
  until         timestamptz,                       -- expiry ("until we're done")
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX baumy_scheduled_due_idx ON baumy_scheduled_tasks (next_run_at) WHERE enabled;

-- runtime routing config (NON-SECRET; admin/migration-write-only, write-gated)
CREATE TABLE baumy_model_route (
  task        text PRIMARY KEY,
  reactive    boolean NOT NULL DEFAULT false,     -- reactive tasks are clamped away from Opus
  provider    text NOT NULL CHECK (provider IN ('anthropic','openai')),
  model_id    text NOT NULL,
  max_tokens  integer NOT NULL DEFAULT 1024,
  temperature real,                               -- NULLABLE; NULL for Opus (rejects sampling)
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE baumy_prompt (
  label      text NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  body       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (label, version)
);
CREATE UNIQUE INDEX baumy_prompt_active_uq ON baumy_prompt (label) WHERE active;

-- reply/response policy (self-configurable via write-gate; owner full, trusted safe-direction only)
CREATE TABLE baumy_response_policy (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),  -- singleton row
  enabled             boolean NOT NULL DEFAULT true,                 -- global on/off
  answer_questions    boolean NOT NULL DEFAULT true,                 -- auto-answer house questions
  confidence_threshold real NOT NULL DEFAULT 0.6,
  muted_topics        text[] NOT NULL DEFAULT '{}',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          text
);

-- members / roster: auto-discovered from group activity; owner = bot inviter
CREATE TABLE baumy_members (
  telegram_user_id     text PRIMARY KEY,
  group_id             text,
  name                 text,
  role                 text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  can_access_dashboard boolean NOT NULL DEFAULT false,
  dm_chat_id           text,                       -- captured on /start; needed for magic link
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- NOTE: full identity/roster schema is owned by the auth-identity workstream; this is the
-- load-bearing subset the magic-link login + owner capture + DM lane depend on.

-- one-time Telegram magic-link login tokens (short TTL, single-use, hashed at rest)
CREATE TABLE baumy_login_tokens (
  token_hash       text PRIMARY KEY,
  telegram_user_id text NOT NULL,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- spend ledger for the daily cap gate (granularity coordinated with the cost workstream)
CREATE TABLE baumy_spend_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day           date NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Berlin'),
  provider      text,
  model_id      text,
  task          text,
  input_tokens  integer,
  output_tokens integer,
  cost_usd      numeric(10,6),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX baumy_spend_day_idx ON baumy_spend_ledger (day);

-- Better Auth adapter tables (users/sessions/accounts/verification) are generated by
-- `better-auth` (Drizzle adapter) — do not hand-write; run its schema generation into migrations.

-- Derived KNOWLEDGE GRAPH + raw-message embeddings (schema-light; owned by memory-core).
-- entities / facts / edges: bitemporal + provenance (-> source_update_id) + secure_value flag
--   (flagged values app-side AES-GCM encrypted with BAUMY_ENCRYPTION_KEY) + group_id.
-- memory_items: embeddings over BOTH raw messages AND derived facts.
-- Vector dimension is an OPEN QUESTION — isolate the constant in one place.
-- e.g. embedding vector(1536)  -- text-embedding-3-small
```
Seed: `('classify',true,'openai','gpt-5-nano',256,0,true)`, `('reply',true,'anthropic','claude-haiku-4-5',1024,0.3,true)`, `('assess',false,'anthropic','claude-sonnet-5',2048,NULL,true)`, `('advisor',false,'anthropic','claude-opus-4-8',4096,NULL,true)`, `('digest',false,'anthropic','claude-sonnet-5',2048,NULL,true)`. Seed one `baumy_response_policy` row and the built-in digest `baumy_scheduled_tasks` rows.

### Key APIs / config snippets
**Webhook (`app/api/telegram/webhook/route.ts`)**
```ts
export const runtime = 'nodejs';
export const preferredRegion = 'iad1';   // match Neon region
export const maxDuration = 15;           // fail-fast ack path
// 1) verify X-Telegram-Bot-Api-Secret-Token (constant-time) -> 401 on mismatch
// 2) parseUpdate(await req.json()) in try/catch -> 200 {ignored:'unparseable'} on throw
// 3) gate: text present AND in-scope where in-scope =
//      chat.id === BAUMY_HOUSE_CHAT_ID (house lane)
//      OR (chat.type === 'private' AND from.id is a known active member) (DM lane)
//    -> else 200 {ignored:'out-of-scope'}
// 4) await inngest.send({ id:`tg:update:${update_id}`, name:'telegram/message.received', data })
//    -> on throw return 503 (Telegram retries; the id makes it idempotent)
// 5) return 200 {ok:true}
```
**Inngest serve (`app/api/inngest/route.ts`)**
```ts
export const runtime = 'nodejs';
export const maxDuration = 300;          // Hobby + Fluid ceiling
export const { GET, POST, PUT } = serve({ client: inngest, functions });
// GET/POST/PUT ALL required — PUT is function registration/introspection.
// Not page-gated: the signing key IS the auth. (Contrast: Better Auth route needs only GET+POST.)
```
**Better Auth route (`app/api/auth/[...all]/route.ts`)**
```ts
import { auth } from '@/lib/auth/config';
import { toNextJsHandler } from 'better-auth/next-js';
export const runtime = 'nodejs';
export const { GET, POST } = toNextJsHandler(auth);
// lib/auth/config.ts: betterAuth({ database: drizzleAdapter(db,{provider:'pg'}),
//   secret: BETTER_AUTH_SECRET, baseURL: BETTER_AUTH_URL, session:{...} })
// Telegram magic link: /dashboard DM -> issue signed token (baumy_login_tokens) -> DM URL ->
//   /admin/login?token=… callback verifies+consumes -> auth server API mints the session.
```
**Inngest client (`lib/inngest/client.ts`)** — v4 `eventType()`+zod typed events, or v3-lts `EventSchemas().fromRecord<BaumyEvents>()`. Events: `'telegram/message.received'`, `'deliberation/requested'`, `'reminder/due'`.

**Reactive pipeline** — `createFunction({ id:'handle-telegram-message', triggers:{event:'telegram/message.received'}, idempotency:'event.data.updateId', retries:2, concurrency:{key:'event.data.chatId', limit:1} }, ...)`: `record-inbound` (verbatim upsert + enqueue extraction) → `classify` (nano → `{ignore,remember,reminder,reply,deliberate}`) → conditional `remember` / `schedule-reminder` / `reply` (Haiku, memory-only, claim-before-send, `retries:0`) / emit `deliberation/requested` (only after the deterministic trust+command check). **Resolve provider keys inside each step; never return secrets.**

**Deliberative function** — `createFunction({ id:'run-deliberation', triggers:{event:'deliberation/requested'}, retries:1 }, ...)`: spend-cap gate → `assess` (Sonnet) or `advisor` (Opus) with the web-search tool bound → claim-guarded send to `BAUMY_HOUSE_CHAT_ID`. Never reachable from raw untrusted text.

**Scheduled-tasks cron** — `createFunction({ id:'run-scheduled-tasks', triggers:{cron:'*/5 * * * *'}, retries:1 }, ...)`: claim due rows (`FOR UPDATE SKIP LOCKED`, pooled driver) → run on the deliberative path → report to group → recompute `next_run_at`, disable past `until`.

**Reminder functions** — `arm-reminders` (`triggers:{cron:'0 * * * *'}` daily/hourly arm: claim `scheduled` rows due within ≤7d → `step.sleepUntil(fire_at)` → send) + `fire-due-reminders` (`triggers:{cron:'* * * * *'}` sweeper heartbeat: `FOR UPDATE SKIP LOCKED` catch-up, pooled driver, reaper for stuck `firing`). Reminder sends are **never** spend-cap gated.

**Dual-driver db (`db/client.ts`)** — `createHttpDb` (neon-http, webhook fast path) + `createPooledDb` (neon-serverless WS, transactions/locking) + `__setDbOverride` (PGlite test seam) + `BUILD_PLACEHOLDER_URL`. Call `attachDatabasePool(pool)` from `@vercel/functions` after creating the pooled pool.

**setWebhook registration (one-time)** — `setWebhook({ url:\`${BAUMY_PUBLIC_URL}/api/telegram/webhook\`, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates:['message','edited_message','my_chat_member'] })`. `message` covers both group + DM lanes; `my_chat_member` covers owner capture (inviter) and member leave; generate the secret via `openssl rand -hex 32`. **BotFather privacy mode must be OFF.**

**`.env.example` (grouped; zero foreign identifiers)**
```bash
# Database (Neon) — auto-set by the Neon–Vercel integration
DATABASE_URL=
DATABASE_URL_UNPOOLED=
# AI providers
ANTHROPIC_API_KEY=
OPENAI_API_KEY=              # also the embeddings provider
# Telegram
TELEGRAM_BOT_TOKEN=          # from @BotFather
TELEGRAM_WEBHOOK_SECRET=     # openssl rand -hex 32; passed to setWebhook + checked per update
# App
BAUMY_HOUSE_CHAT_ID=         # fixed house group chat_id (the only house send destination)
BAUMY_OWNER_ID=              # optional override; else learned from my_chat_member "added" event
BAUMY_PUBLIC_URL=            # explicit; do NOT derive from VERCEL_URL
BAUMY_ENCRYPTION_KEY=        # AES-GCM key for flagged "secure value" facts (app-side crypto)
# Auth (self-hosted Better Auth — session layer only; NO Google/Resend)
BETTER_AUTH_SECRET=          # session signing secret
BETTER_AUTH_URL=             # base URL (may equal BAUMY_PUBLIC_URL)
BAUMY_SESSION_SECRET=        # signs the one-time Telegram magic-link login token
# NOTE: INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY are injected by the Vercel–Inngest
#       integration and intentionally omitted here.
```

### Verified platform facts (2026-07-01)
- **Hobby function duration** (with Fluid Compute, default-on for new projects since 2025-04-23): **300s default AND 300s max**. A project NOT on Fluid silently reverts to **10s default / 60s max** — pin `{"fluid": true}`. Hobby CPU/mem fixed at **1 vCPU / 2 GB**. Request/response body max **4.5 MB**. Single region (default `iad1`).
- **Hobby monthly free allowances**: 1,000,000 invocations, **4 Active CPU-hrs**, **360 GB-hrs Provisioned Memory**, 100 GB Fast Data Transfer. Runtime logs retained **1 hour** on Hobby.
- **Fluid billing**: bills **Active CPU** (ms of CPU actually consumed — I/O wait is FREE) **+ Provisioned Memory** (GB-hr for the instance's whole lifetime including I/O wait).
- **Inngest Free limits**: concurrency 5; ≤1,000 steps/function; step output 4 MiB; event payload 256 KiB; **sleep/delay max 7 days**; trace history 24h; up to 5,000 events per send. Monthly execution allowance ~50k *(third-party figure — verify)*.
- **Telegram**: one webhook per bot; retries any non-2xx with exponential backoff, buffers ~24h, then stops until `setWebhook` is re-called. Exact response timeout is undocumented (~seconds) — design for sub-second ack.
- **Better Auth**: `toNextJsHandler(auth)` exports GET+POST at `app/api/auth/[...all]/route.ts`; framework-agnostic, Drizzle/Postgres adapter, self-hosted; magic-link plugin exists (its `sendMagicLink` delivery channel is repurposed to a Telegram DM here). Verify exact minor + adapter table set at build.

---

## Gotchas

1. **Cost-meter correction:** For a per-message LLM app the compute meter that accrues is **Provisioned Memory (360 GB-hrs)**, NOT Active CPU. Vercel **pauses Active CPU billing while your code waits on the model**, so LLM calls are I/O and do *not* burn Active CPU. Provisioned Memory ticks for the whole instance lifetime *including* I/O wait — keep functions open as briefly as possible and split AI work across separate short `step.run` invocations rather than one long inline wait.
2. **The 300s ceiling exists only WITH Fluid.** A project off Fluid drops to 10s/60s. Pin `{"fluid": true}` and verify post-deploy.
3. Next.js 16 renamed **`middleware.ts` → `proxy.ts`** — a `middleware.ts` is ignored. Write `proxy.ts` (`export const proxy` + `config.matcher`).
4. The auth proxy matcher must **exclude** `/api/telegram/webhook` and `/api/inngest`, or session-cookie gating 401s the platform callbacks and silently kills all async + reminders. It must **include** `/api/auth/*` (Better Auth) and `/admin/*`.
5. **Do NOT run LLM/embeddings inline in the webhook.** Verify → dedupe → `inngest.send` → 200; heavy work in Inngest steps.
6. Inngest serve needs **GET, POST AND PUT**; Better Auth needs only **GET + POST**. Do not copy one route's exports onto the other.
7. `instrumentation.ts` must guard `NEXT_RUNTIME==='nodejs'` && `NEXT_PHASE!=='phase-production-build'`, and keep `BUILD_PLACEHOLDER_URL` in the db client, or `next build` fails without runtime secrets.
8. **Do NOT** put `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` in `.env.example`. Better Auth's own tables are **generated** by the CLI/adapter — run its schema generation into `db/migrations` rather than hand-writing users/sessions.
9. **Opus 4.8 rejects `temperature`/`top_p`/`top_k`/`budget_tokens` (HTTP 400).** Keep `baumy_model_route.temperature` nullable, seed NULL for Opus, omit `temperature` in the AI-SDK call for Opus. (Verify Sonnet 5 sampling support at build before seeding a non-NULL value.)
10. **Reactive firewall must be enforced in code, not just config.** `resolveModel` clamps any `reactive`-flagged task back to its safe default if the configured model is outside the reactive set — a bad config row (or injection targeting config) must never let `reply` reach Opus, and the reactive path must bind **zero tools**. Web-search binding lives ONLY in the deliberative code path.
11. **DM lane is a new attack surface.** Private-chat updates arrive on the same webhook; the gate must distinguish house-group vs known-member DM, and the DM lane must handle only deterministic commands (`/dashboard`, `/start`, owner commands) — never free-form privileged writes. Unknown-sender DMs → `200 {ignored}`. The only DM-directed send is the magic-link reply to that exact member.
12. **Magic-link tokens**: short TTL, single-use, bound to `telegram_user_id`, gated on `can_access_dashboard`, hashed at rest, HTTPS only. The token-exchange callback mints the session, so it must NOT itself require a session (don't let the proxy 401 it before Better Auth handles it).
13. Vercel **Sensitive vars are disallowed in the Development target** and unreadable after creation — maintain `.env.local` by hand and keep a password-manager copy (now including `BETTER_AUTH_SECRET`, `BAUMY_SESSION_SECRET`, `BAUMY_ENCRYPTION_KEY`).
14. Use **`DATABASE_URL_UNPOOLED`** for `drizzle-kit migrate`/seed and for reminder/scheduled-task/reply **locking claims** (`FOR UPDATE SKIP LOCKED`) — the pooled URL / `neon-http` cannot hold locks.
15. Inngest **step memoization only dedupes WITHIN one run** — the **DB claim guard** protects cross-run/replay double-sends (reply, reminder, deliberative result), not memoization alone.
16. **Ordering:** `inngest.send` does NOT preserve `update_id` order. Add `concurrency:{ key:'event.data.chatId', limit:1 }` if per-chat ordering matters.
17. **`waitUntil`/`after` are NOT durable** — use them only for throwaway logging; memory writes/reminders/notifications/deliberations go to Inngest.
18. Inngest Free **7-day sleep cap** bounds each `step.sleepUntil` — the daily-arm function only sleeps reminders due within the window; the sweeper cron covers the rest.
19. **Observability is thin on $0** (1h Hobby logs, 24h Inngest traces) — persist every stage to durable Neon rows.
20. **Edited messages** (`edited_message`): reread, **re-run the full write-gate**, and treat as a **correction/supersede** (never trust an edit more than the original). Mark the verbatim row `edited=true` and re-extract/supersede the derived fact; add `edited_message` to `updateSchema` + `allowed_updates`.
21. `update_id` can reset to a random number after ~a week of inactivity — safe as a **dedup key** but **NOT** for ordering/high-water-mark logic across such gaps.
22. Secret-token charset is `A-Za-z0-9_-` (1–256) — generate with `openssl rand -hex 32`, not base64.
23. Enforce fixed send destinations **in `lib/telegram/client.ts`** (two-mode allow-list: house group, or an auth DM to the originating member) — never a `chat_id` derived off an incoming untrusted message.
24. **Do NOT lift the reference `vercel.json` crons block or `/api/cron/*` routes** — port dispatch into Inngest cron functions.
25. **Spend cap must not gate reminder delivery.** The degraded-mode check wraps paid model/tool calls (reply/assess/advisor/web search), never the reminder send path.
26. **App Router refuses `.`-prefixed folders** — the deferred MCP `/.well-known/*` needs a rewrite if later lifted; drop it now.

---

## Tasks (ordered, with dependencies + estimates)

| # | Task | Depends on | Est. |
|---|---|---|---|
| T1 | **Scaffold single Next.js 16 app** (App Router, TS, no `src`). `package.json name: baumy-brain`; `tsconfig` `@/*`→`./*`; root `app/`, `lib/`, `db/`; `next.config.ts` keep `typedRoutes:true`, drop transpilePackages/mobile/.well-known. | — | 1h |
| T2 | **Install locked dependency set** (versions above), including `better-auth`; **no `@neondatabase/auth`**. | T1 | 0.5h |
| T3 | **Lift `db/` dual-driver + migrations.** `createHttpDb`/`createPooledDb`/`__setDbOverride`/`BUILD_PLACEHOLDER_URL`; `drizzle.config.ts`. Add `CREATE EXTENSION vector`. | T2 | 3h |
| T4 | **DDL/schema:** verbatim `baumy_inbound_messages` + derived-graph memory (entities/facts/edges + provenance + `secure_value` + embeddings over raw AND facts) + `group_id` columns; `baumy_replies`, `baumy_reminders` (+enum+partial idx+`armed_at`), `baumy_scheduled_tasks`, `baumy_model_route` (+`reactive`), `baumy_prompt`, `baumy_response_policy`, `baumy_members`, `baumy_login_tokens`, `baumy_spend_ledger`. Seed routing rows + response policy + digest tasks. | T3 | 2.5h |
| T5 | **Lift `lib/telegram/`** raw client + `verifyWebhookSecret` (constant-time) + `parseUpdate` (add `edited_message`). Two-mode send allow-list (house group / auth DM). Grep-guard: no foreign identifiers. | T2 | 2h |
| T6 | **`lib/core/`** write-gate (two-lane) + dedupe + **reactive/deliberative tier-clamp** + spend-cap check (pure, full Vitest coverage, no DB). | T2 | 3h |
| T7 | **`lib/ai/` provider registry + tasks + `resolveModel(task)` router** (in-module TTL cache; clamp reactive tasks off Opus; omit temperature for Opus; fail closed to per-task defaults — reply→Haiku). `classify` (generateObject+zod), `reply` (generateText, memory-only), `assess`/`advisor` (generateText + tools), `summarize`, `embed` (OpenAI embedMany). | T2 | 4h |
| T8 | **`lib/inngest/` client + serve wiring.** Typed event map (`telegram/message.received`, `deliberation/requested`, `reminder/due`); `serve({client,functions})` at `/api/inngest`. Ensure proxy skips `/api/inngest`. Pin Inngest version (D24). | T3 | 1h |
| T9 | **Reactive pipeline `handle-telegram-message`** (staged steps; nano classifier gate; Haiku reply claim-before-send; emit `deliberation/requested` only after trust check; secrets re-resolved per step; write-gate enforced here). | T8, T4, T6, T7 | 2d |
| T10 | **`lib/memory/` substrate** (verbatim store + `retrieve` pgvector similarity + recency; `write` derived facts with provenance/bitemporal; app-side AES-GCM crypto for `secure_value`; grounded replies only). | T7, T4 | 6h |
| T11 | **Reminder functions**: `arm-reminders` (daily-arm + `sleepUntil`) + `fire-due-reminders` (minute sweeper heartbeat, `FOR UPDATE SKIP LOCKED` pooled driver, idempotent send + reaper). Reminders exempt from spend cap. | T8, T4 | 1d |
| T12 | **Thin webhook route** (nodejs, maxDuration 15): verify → parse → two-lane structural gate → dedupe → `inngest.send` → 200; 503 on send failure. | T5, T8 | 0.5d |
| T13 | **`instrumentation.ts` + `lib/env.ts` `assertServerEnv()`** (REQUIRED: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET≥16, BAUMY_HOUSE_CHAT_ID, ANTHROPIC_API_KEY, OPENAI_API_KEY, BETTER_AUTH_SECRET≥16, BETTER_AUTH_URL, BAUMY_SESSION_SECRET≥16, BAUMY_ENCRYPTION_KEY≥32; optional: BAUMY_OWNER_ID). Guard nodejs runtime + skip build phase. Write `.env.example` (exclude INNGEST_*). | T1 | 1h |
| T14 | **`vercel.json`**: `{"fluid": true}` + security headers, NO crons. | T1 | 0.25d |
| T15 | **Provision Vercel env + integrations** (Neon → DATABASE_URL(+UNPOOLED)+branch DBs; Inngest → keys). Secrets Sensitive for Prod+Preview; `.env.local` for dev. `vercel-build` = `db:migrate && next build` (unpooled URL for migrate). Confirm no Vercel cron. | T14 | 1h |
| T16 | **One-time `setWebhook` script** (`allowed_updates`, `secret_token`, Production URL). BotFather privacy OFF. | T12 | 0.5d |
| T17 | **Deliberative function `run-deliberation`** (trust-gated `deliberation/requested`; spend-cap gate; assess/Sonnet vs advisor/Opus; web-search tool bound; claim-guarded send to house group). | T7, T8, T22 | 1d |
| T18 | **Scheduled-tasks module `run-scheduled-tasks`** (cron scanner over `baumy_scheduled_tasks`; deliberative path; recompute `next_run_at`; disable past `until`; seed digests as built-in instances; dated-event surfacing scan). | T17, T4 | 1d |
| T19 | **Admin dashboard + Better Auth + Telegram magic link (IN v1).** `(private)/layout.tsx` (session-gated) + `/admin` surfaces (memory browser+provenance, member management + user-to-member mapping + `can_access_dashboard` toggle, reminder management, prompt/response-policy editing, cost/usage view); `lib/auth/config.ts` (betterAuth + Drizzle adapter) + `/api/auth/[...all]`; magic-link issue (`/dashboard` DM) + verify (`/admin/login?token=`) + owner capture from `my_chat_member`; `proxy.ts` matcher `['/admin/:path*','/api/auth/:path*']` (excludes machine endpoints). | T13, T4, T9 | 2d |
| T20 | **`lib/ai/tools/websearch.ts`** — web-search tool for the deliberative path only (input-only; verify exact tool/provider at build; "near us" needs house-location/maps-capable search). | T7 | 4h |
| T21 | **Spend-cap gate + `baumy_spend_ledger` wiring** — deterministic daily-ceiling check before paid model/tool calls; degraded mode; reminder delivery exempt; member-askable spend query from the ledger. | T6, T4 | 4h |
| T22 | **Test harness + CI drift check.** Vitest (jsdom+node); unit-test `lib/core` (two-lane gate, tier-clamp, spend-cap) + db via PGlite `__setDbOverride`; lifecycle tests (secret 401, out-of-scope 200, DM-lane known vs unknown sender, single `send` per update_id, 503 on send throw, reply skipped on replay, reactive task never resolves Opus, reminders claimed once under concurrent cron, magic-link single-use). CI step `drizzle-kit generate --check`. | T9, T11, T16 | 3h |
| T23 | **Verify OpenAI classifier id + pricing** and Anthropic Haiku/Sonnet/Opus ids/prices + web-search tool against official pages; update seeded rows. | T4 | 0.5h |

---

## Risks & mitigations

| Risk | Sev | Mitigation |
|---|---|---|
| **Prompt injection** (privacy OFF): untrusted group text steers a privileged action (send elsewhere, exfiltrate memory, escalate to Opus/web, reconfigure Baumy, spoof a reminder). | High | Deterministic gates outside the model: two-lane structural gate; every house send hard-codes `BAUMY_HOUSE_CHAT_ID` (auth DM the only exception, to the originating member only); classifier output is a constrained enum; **reactive path is Haiku-ceiling, memory-only, zero tools**; deliberative/web-search reachable only via a trust-gated explicit command; config writes go through the write-gate (untrusted text can NEVER reconfigure); memory carries provenance. LLM output is only ever data or a reply INTO the house group. |
| **Reactive path escalates to the expensive model** via a bad config row or injection targeting config. | High | `resolveModel` clamps `reactive`-flagged tasks back to their safe default (reply→Haiku, classify→nano); reactive code binds zero tools; the tier-clamp is unit-tested; config UI is owner/write-gate-only. |
| **Inline AI work** in the webhook → >2s responses → Telegram retry storms. | High | Webhook = verify→dedupe→enqueue→200 only; all AI in Inngest steps; `update_id` dedup makes retries idempotent. |
| **Duplicate reply/notify** posted when a send step re-runs after a crash (no Telegram idempotency key). | High | `INSERT ... ON CONFLICT DO NOTHING RETURNING` claim-before-send; send step `retries:0`; accept at-most-once for the group. |
| **Magic-link token theft / replay** grants dashboard access. | High | Short TTL, single-use (consumed), bound to `telegram_user_id`, gated on `can_access_dashboard`, hashed at rest, HTTPS only, delivered only to the member's own DM; owner can revoke access via the boolean. |
| **DM lane opens a new attack surface** (private chat updates on the same webhook). | Med | DM lane accepts only known active members and only deterministic commands; unknown senders ignored; no free-form privileged writes; house content still fixed-destination. |
| **Web-search exfiltration / SSRF / injected-URL fetch.** | Med | Deliberate-path only, input-only, output to the fixed house group, trusted-command gated, spend-capped; verify the tool/provider at build. |
| **Spend-cap breach** on the $0.50/day ceiling from runaway deliberation or scheduled tasks. | Med | Deterministic daily-ceiling gate before paid calls; degraded mode past cap; scheduled tasks require `until`/expiry and are cancellable; **reminder delivery exempt**. |
| **Provisioned-Memory / free-tier exhaustion** from long-held instances or over-split steps (NOT Active CPU — LLM I/O wait is free). | Med | Short steps; split heavy AI across separate `step.run`s; cheap nano classifier + `lib/core` write-gate filter before any Anthropic call; batch embeddings. ~4-user volume is orders under both caps. |
| **Designing around the stale 60s cap** or someone disabling Fluid. | Med | `maxDuration=300` on the Inngest route; pin `{"fluid":true}`; verify post-deploy. |
| **Auth proxy accidentally matches** `/api/inngest` or `/api/telegram/webhook`, 401-ing platform callbacks and killing async + reminders; OR fails to reach the Better Auth token-exchange callback. | Med | Scope `proxy.ts` matcher to `['/admin/:path*','/api/auth/:path*']`; integration test asserting the two machine endpoints return non-401 unauthenticated and the token-exchange callback mints a session without a prior one. |
| **pgvector dimension hard-coded before embedding model finalized** → re-embed migration. | Med | Resolve embedding provider before schema freeze; isolate the dimension constant in one place; a change is a single edit + one backfill. |
| **Reminders stuck in `firing`** if the cron crashes mid-send. | Med | Reaper flips stale `firing` rows back to `scheduled`; `onFailure` marks stranded rows `failed`; daily-arm + sweeper double coverage. |
| **Inngest 7-day sleep cap** truncates long-horizon reminders/tasks. | Med | Daily-arm only sleeps within-window fires; the minute sweeper covers far-future + missed. |
| **One-webhook-per-bot** blocks end-to-end preview testing. | Med | Bind real bot+webhook to Production; throwaway test bot on a pinned preview, or POST synthetic updates in tests. |
| **Inngest version drift** (v3 reference code on v4 API). | Med | Pin one Inngest major before scaffolding (D24); CI typecheck gate. |
| **Secure-value leak** (encrypted secrets exposed in digests/logs, or key mishandled). | Med | App-side AES-GCM with `BAUMY_ENCRYPTION_KEY`; decrypt only to answer a member on request; never volunteer; excluded from digests/broadcasts; key stored Sensitive + password manager. |
| **Better Auth misconfig** (wrong adapter tables, missing secret, session not scoped to the Telegram member). | Med | Generate adapter schema into migrations; require `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` at boot; session identity derived from the consumed magic-link token's `telegram_user_id`; verify version at build. |
| **Model id/pricing sourced from aggregators** may be stale (mis-seed → 404). | Med | Treat as `verify_needed`; confirm on official OpenAI/Anthropic pages before seeding (T23). |
| **Out-of-order processing** corrupts conversational/memory sequencing. | Low | `concurrency:{key:'event.data.chatId', limit:1}`; timestamped provenance upserts. |
| **Single-app forecloses a future 2nd consumer.** | Low | Keep `db/` + `lib/core/` self-contained; `group_id` origin-scope already present; promote to `packages/*` later (mechanical). |
| **Dropping Turborepo drops the CI migration-drift check.** | Low | Standalone GitHub Actions `drizzle-kit generate --check` + lint/typecheck/test. |
| **DB connection exhaustion** under Fluid instance reuse. | Low | `attachDatabasePool(pool)` on the neon-serverless pool; prefer `neon-http` for the webhook fast path. |

---

## Open questions (for the owner)

1. **Embedding provider + dimension** — OpenAI `text-embedding-3-small` (1536) vs Voyage (Anthropic offers none). Fixes the pgvector column DDL/index; **decide before schema freeze** (T4).
2. **Exact OpenAI classifier model + price** — `gpt-5-nano` vs `gpt-5.4-nano` vs `gpt-4.1-nano`. Confirm against OpenAI's official page before seeding `baumy_model_route` (T23).
3. **Web-search tool/provider** — Anthropic server-side `web_search` tool vs a search API (Brave/Tavily) vs a maps-capable provider for "near us" location queries. Verify + pick at build (T20).
4. **Deliberative-intent detection** — the exact trust+command grammar the reactive classifier uses to emit `deliberation/requested` without ever escalating itself, and which members may spend on Opus/web search. Coordinate with the llm-pipeline workstream.
5. **Better Auth version + adapter table set** — pin the exact minor and generate its Drizzle schema into `db/migrations`; confirm the session-minting server API for the custom Telegram magic-link flow.
6. **Inngest major** — v4 (`eventType`) vs v3-lts (3.54.0) (D24). Pick one for the whole scaffold.
7. **Reactive→deliberative tier thresholds + reply confidence threshold** — ship conservative defaults in `baumy_response_policy`/`baumy_model_route`, tune from real usage.
8. **Scheduled-task cadence representation + max frequency** — cron string vs interval; a floor to bound cost (also feeds the spend cap).
9. **Spend ledger granularity** — per-call token accounting vs coarse daily rollup; coordinate ownership with the cost workstream.
10. **Reminder near-term precision** — is the daily-arm+`sleepUntil` window sufficient, or are sub-minute fires needed for specific cases?
11. **Confirm Neon free-tier pgvector** index support (HNSW/ivfflat) and any dimension/row limits before committing the index type.
12. **Confirm the Inngest Free monthly execution allowance** (~50k is third-party) and that no `cron`/`sleepUntil` API changed at scaffold time.
13. **Confirm the Neon project region** matches the Vercel function region (`iad1`); otherwise set `preferredRegion` to Neon's region.
14. **Webhook enqueue-vs-persist order** — enqueue Inngest AFTER persisting the raw update (return 200 even if send fails, reconcile later) OR fail the response so Telegram retries (dedup protects double-processing)? Pick one and make it deterministic.

> **Resolved by the decision log (no longer open):** dashboard IS in v1 (A1); login = Telegram bot-DM magic link via self-hosted Better Auth, no Google/Resend (A1b); owner = bot inviter, `BAUMY_OWNER_ID` override (Owner & Tenancy); single-tenant with `group_id` hygiene; reactive-vs-deliberative routing with Haiku reply ceiling / Opus advisor explicit-only (C); scheduled tasks + web search added (A4b/CAP); retention keeps BOTH verbatim messages + derived knowledge graph (D17); reply policy = auto-answer house questions + @mention/reply, configurable (A5); edited messages = reread + re-run gate + supersede (D18); reminders = daily-arm + `sleepUntil` + sweeper heartbeat (E22); house timezone `Europe/Berlin` (B9).
