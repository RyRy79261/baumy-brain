# Dev loop, testing, observability & cost control

> Workstream key: `dev-test-obs`
> Scope: how a developer iterates on Baumy locally without deploying; how the untrusted-input security contract is regression-tested (including the new deliberative/web-search lane and scheduled tasks); and how LLM spend is measured, capped at **$0.50/day**, degraded, and alerted on so the bot cannot be turned into a denial-of-wallet target.
> Stack context (locked): Next.js on Vercel Hobby ($0), Neon Postgres + Drizzle + pgvector, Vercel AI SDK, Inngest for all async/scheduled work (no Vercel cron), Telegram privacy mode OFF (every group message is untrusted). Model routing is decoupled into a **reactive lane** (`classify` = OpenAI nano → `reply` = Haiku → `assess` = Sonnet for hard on-hand reasoning) and a **deliberative/advisor lane** (`advisor` = Opus + a web-search tool) reachable **only by explicit deliberate intent** — never by the classifier. All lifted reference code is clean-room renamed to `@baumy/*` — zero foreign identifiers.
> Pricing/limits verified 2026-07-01.

---

## Overview

This section covers two tightly-coupled concerns that share the same plumbing (the Telegram webhook route, the Inngest client, the Neon/Drizzle store):

1. **Dev loop & testing.** A three-tier nested local loop lets you iterate almost entirely without deploying:
   - **Tier 1 — fixture replay:** POST canned Telegram `Update` JSON straight at the local webhook route with the secret header. Deterministic, offline, no Telegram, no tunnel. This is where the **adversarial prompt-injection regression suite** lives (privacy mode OFF => every group message is untrusted). The suite now also proves the two model-routing invariants from the decisions: (a) the **reactive/reply path NEVER reaches `advisor` (Opus) and NEVER gets a tool** (no web search), and (b) untrusted group text can neither trigger a **deliberative/web-search** run nor a **scheduled task**.
   - **Tier 2 — long-poll bridge:** a local script calls Telegram `getUpdates` against a private *dev* test group and re-POSTs each update to `http://localhost:3000/api/telegram/webhook` with the secret header. Real messages, exact production code path, no tunnel, no `setWebhook` churn.
   - **Tier 3 — real webhook:** a `cloudflared`/`ngrok` tunnel + `setWebhook`. Used sparingly for pre-deploy end-to-end verification of TLS, the real `X-Telegram-Bot-Api-Secret-Token`, and `allowed_updates`.
   - Inngest runs locally via `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest` (UI on `:8288`) with `INNGEST_DEV=1`, so `inngest.send()` routes locally and no signing keys are needed. This is also where the **per-task scheduled-task crons** and the **cost digest** are exercised locally.
   - **Eval fixtures are synthetic and owner-reviewed** (decision #9): no real house data exists yet and the feature isn't live, so Baumy *generates* candidate fixtures (chats, injection attempts, scheduled-task prompts, deliberative "go research X" prompts) and the **owner approves them before they enter the committed suite**. No production transcripts are used.

2. **Cost control & observability.** Because privacy mode is OFF, the bot receives **every** group message, so LLM spend is dominated by the ambient-classify path and exposed to spam-driven denial-of-wallet. The design is: a deterministic tiered pipeline (free pre-filter → cheap OpenAI nano `classify` → Claude Haiku `reply` only on escalation, Sonnet `assess` only for hard on-hand reasoning) to minimize call volume; a **separate deliberative/advisor lane** (Opus + web-search tool, explicit-intent-only) and **scheduled tasks** that are heavier and web-search-capable but still governed by the same ledger + hard cap; an **authoritative self-hosted Neon/Drizzle spend ledger + O(1) daily counter** in integer nano-USD; a **fail-closed pre-call budget gate** checked cheaply at the webhook and authoritatively inside the Inngest step; **two-tier ceilings** (soft-cap alert + hard-cap degraded mode) bounded by per-call `maxOutputTokens`/context caps; alerts to a **private admin chat** (never the house group) via realtime threshold-crossing + an Inngest cron digest; and a **member-askable "how much have we spent this month?"** answer served from the same ledger (decision: nice-to-have). Reminder **delivery** (zero-token `sendMessage`) is kept structurally independent of the budget so the one hard feature never breaks.

Verified economics: a busy day (~500 messages) costs **~$0.13**, so the decided hard cap of **$0.50/day (~$15/mo)** gives ~3-4x headroom for normal reactive use while its real job — capping abuse — trips well before meaningful money is spent. The deliberative lane and scheduled tasks are the higher-cost-per-call paths, which is exactly why they are explicit-intent-only, model-tier-tagged, and gated by the same cap.

---

## Decisions (with rationale)

### Dev loop & testing

1. **Adopt a 3-tier local loop; default to Tier 1/2, reserve Tier 3 for pre-deploy.** *(confidence: high)*
   Fixture replay and the poll-bridge both hit the EXACT production route handler (`apps/web/app/api/telegram/webhook/route.ts`) but need no public URL, so you skip re-running `setWebhook` on every restart and get deterministic, offline iteration. Tier 3 is the only path that exercises real Telegram TLS delivery + the real secret header, so keep it but use it sparingly.

2. **Run Inngest locally with `INNGEST_DEV=1`.** *(confidence: high)*
   `INNGEST_DEV=1` makes the SDK connect to the local dev server (`:8288`) instead of Inngest Cloud, disables signing-key signature verification, and routes `inngest.send()` events locally — so no `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` plumbing is needed in dev (matches the key-less lifted client). The `-u` flag pins discovery to the Next app's serve endpoint instead of port scanning. Scheduled-task crons and the cost digest are registered on the same `serve()` and run locally here.

3. **Default Tier-3 tunnel = `cloudflared` quick tunnel; `ngrok` free persistent domain as the stable-URL alternative.** *(confidence: high)*
   `cloudflared tunnel --url http://localhost:3000` needs no account and one command, but mints a fresh random `*.trycloudflare.com` URL each run (=> re-run `setWebhook`). `ngrok` free gives ONE **persistent** dev domain per account (set webhook once, survives restarts) at the cost of a signup. The poll-bridge (Tier 2) removes the tunnel from the inner loop, so cloudflared's random-URL churn rarely bites. **[Verified 2026-07-01]** ngrok free's persistent-domain + no-session-timeout claim is confirmed against current official docs — see Gotchas note on the suffix change (`ngrok-free.dev` is now the default; `ngrok-free.app` is legacy).

4. **Ship dev-loop helpers (`set-webhook`, `delete-webhook`, `poll-bridge`, `replay-fixture`) as `tsx` scripts driven by pnpm, not committed cron/webhook wiring.** *(confidence: high)*
   The raw `TelegramClient` already exposes `setWebhook`/`deleteWebhook`/`sendMessage`, so these helpers are ~30 lines each. Keeps Vercel cron out (Inngest-only mandate) and keeps `setWebhook` a manual, explicit action rather than deploy-time magic.

5. **Always pass explicit `allowed_updates: ["message","edited_message","my_chat_member"]`.** *(confidence: high)*
   Telegram's default `allowed_updates` EXCLUDES `chat_member`/`message_reaction`/`message_reaction_count`, and "if not specified, the previous setting is used" — silent drift. Being explicit on both `setWebhook` and `getUpdates` prevents a stale prior setting from suppressing message delivery. (`my_chat_member` is load-bearing: owner = bot inviter is captured from it, and leave-group deactivation depends on it.)

6. **Maintain an adversarial fixture library (synthetic, owner-reviewed) as first-class Tier-1 replay inputs.** *(confidence: high)*
   Privacy mode is OFF, so every group message is untrusted injection input per the security contract. Fixture replay is the cheapest way to regression-test "group text must never steer privileged writes/notifications" on every change, offline. Per decision #9 the fixtures are **synthetic and owner-approved** (no real data exists). The corpus now asserts FOUR things on every change: (i) the deterministic write-gate never fires and no `sendMessage` to the house chat is emitted from untrusted text; (ii) the **reactive/reply path never selects `advisor` (Opus)** — a misclassified message can reach at most `assess` (Sonnet); (iii) the **reactive/reply path is given zero tools** (no web search — exfil-safe); (iv) untrusted group text can neither launch a **deliberative/web-search** run nor create/mutate a **scheduled task** (those require explicit trusted intent through the write-gate).

7. **Eval-fixture generation is a Baumy-assisted, owner-gated workflow.** *(confidence: high)*
   Because there is no live traffic, candidate fixtures are LLM-generated (deliberate lane, one-off, budget-gated) into a `fixtures/telegram/_candidates/` staging dir; the owner reviews/edits and promotes approved ones into `fixtures/telegram/`. Only committed, owner-approved fixtures run in CI. This keeps the regression suite realistic without waiting for real house data or leaking any.

### Cost control & observability

8. **A self-hosted Neon/Drizzle spend ledger + daily counter is the AUTHORITATIVE hard budget cap — not a provider/gateway dashboard.** *(confidence: high)*
   The hard cap must survive across serverless invocations, be globally consistent, and work regardless of any external dashboard's availability/lag. A Postgres row-level atomic upsert gives an exact O(1) running total the pre-call gate can enforce deterministically at $0 extra cost. Vercel AI Gateway/console dashboards are lagging, observability-only, and (for spend caps) unverified on the free tier — keep them as optional secondary monitoring, never the enforcement point. The same ledger is the source of truth for both the admin `/cost` view AND the **member-askable "how much this month?"** answer.

9. **Account cost in integer nano-USD from a code-side `MODEL_PRICING` table, computed post-call from the AI SDK `usage` object; never floats, never provider-side dollar amounts.** *(confidence: high)*
   `$X/MTok == X*1000 nano-USD/token`, so every current rate (incl. cached `0.02` micro = `20` nano) is an exact integer -> no float drift in the ledger or cap comparison. A versioned in-repo price table means cost is known synchronously without a billing-API round-trip, and an unknown/renamed model can fail closed as most-expensive. The table includes `claude-opus-4-8` (the `advisor` role) and a **per-search web-search cost line** (verified at build) so deliberative spend is metered like everything else.

10. **Two-tier ceilings: soft cap (default 80%) alerts only; hard cap trips a fail-safe DEGRADED MODE. Bound overshoot with per-call `maxOutputTokens` + input-context caps, not a distributed lock.** *(confidence: high)*
    The AI SDK returns token usage only AFTER the call, so a pre-call gate checks the running total from completed calls and accepts *bounded* overshoot. Capping each call's max output/input makes max per-call cost known (classify <= ~150 nano, reply <= ~5,000 nano ≈ $0.005), so overshoot = `concurrentCalls x maxPerCallCost` = fractions of a cent at ~4-user scale. Deliberative/`advisor` calls and scheduled tasks are the exception: they can be large, so they are checked against the hard cap **before** running and are skipped/deferred in degraded mode (they are never reminder-delivery). A conditional-`UPDATE` atomic reserve-then-reconcile is the hardened variant if strict-hard is ever required.

11. **Keep reminder DELIVERY (deterministic `sendMessage`, zero tokens) independent of the LLM budget; only reminder PARSING (NL -> structured) is a paid, gated path.** *(confidence: high)*
    Reminders are the one hard-structured feature and must not fail when over budget. Firing existing reminders always works (decision: reminder delivery is NEVER gated); only NEW natural-language reminder creation degrades (fall back to a cheap regex parse or ask to restate after reset).

12. **Minimize call VOLUME first via a tiered reactive pipeline; keep the deliberative lane strictly explicit.** *(confidence: high)*
    Reactive: Tier 0 free deterministic pre-filter (dedupe on `update_id`, drop non-text/commands, rate limits, heuristics) -> `classify` cheap OpenAI nano (default `gpt-5.4-nano`) -> `reply` Claude Haiku 4.5 only on escalation, `assess` Sonnet 5 for hard on-hand reasoning. **HARD RULE (decision C): the reactive/reply path NEVER invokes `advisor` (Opus).** The deliberative/`advisor` lane (Opus + web search) is reached ONLY by explicit deliberate intent ("go research/assess X") and by scheduled tasks, both routed through the deterministic write-gate. Running Anthropic on every message would be the dominant cost; routing volume to a $0.20/$1.25-per-MTok nano classifier and reserving Haiku for rare escalation keeps the busy day ~$0.13. Model choice is the single biggest cost lever.

13. **Enforce the budget gate TWICE for reactive work; enforce it ONCE-before-run for deliberative/scheduled work.** *(confidence: high)*
    Reactive: a cheap read at the webhook + an authoritative check inside the Inngest step immediately before the model call. Deliberative/`advisor` runs and per-task scheduled crons are always durable Inngest work, so they check the authoritative gate immediately before the (potentially large) model call and skip/defer if over cap. Re-resolve the API key inside the step so secrets never cross the step boundary.

14. **Route budget alerts to a private admin chat (`BAUMY_ADMIN_CHAT_ID`), never the house group; expose a member-askable spend query separately.** *(confidence: high)*
    Announcing "I'm out of budget" to the untrusted group leaks operational state a malicious member (prompt-injection surface) could time-exploit, and adds noise. Use once-per-day `soft_alert_sent`/`hard_alert_sent` flags to avoid alert spam. Realtime threshold-crossing + Inngest cron digest (not Vercel cron). Separately — and by decision (nice-to-have) — **any member may ask "how much have we spent this month?"** and get a month-to-date figure from the ledger; this is a *read-only* answer (no thresholds, no operational alarm state) so it does not leak the exhaustion timing that the admin alerts protect.

15. **Web search is INPUT-only, deliberative-lane-only, and output-fixed to the house group.** *(confidence: high)*
    Per the CAP decision, only deliberative/`advisor` tasks (explicit trusted "go check/research X" + scheduled tasks) may use the web-search tool; the reactive reply path stays **memory-only, zero tools** (exfil-safe). Web search brings external text IN; the OUTPUT still goes only to the fixed `BAUMY_HOUSE_CHAT_ID`; it is never triggerable by untrusted group text; and every search is metered against the same hard cap. A regression test asserts each half of this invariant.

16. **Default caps (all env-tunable, conservative starting points):** `BAUMY_DAILY_BUDGET_USD=0.50`, `BAUMY_DAILY_SOFT_PCT=0.8`, `BAUMY_MONTHLY_BUDGET_USD=15` (≈ daily × 30, belt-and-suspenders); per-call `maxOutputTokens` classify=40 / reply=512 / assess≈1024 / advisor≈2048; retrieved-context cap ~2000 tokens; rate limits per-sender 10/min, per-chat 30/min, global classify 60/min. *(confidence: medium)*
    Verified economics put an expected busy day at ~$0.13, so $0.50/day is ~3-4x headroom while the cap's real job — capping denial-of-wallet spam — trips well before meaningful money is spent. Exact tier thresholds are TBD pending real UX (decision C) — ship defaults, tune from usage.

---

## Concrete design / APIs / DDL / config

### Repo layout (proposed)

```
apps/web/
  app/api/telegram/webhook/route.ts   # lifted + renamed; runtime="nodejs"
  app/api/inngest/route.ts            # serve(); runtime="nodejs"; maxDuration=60
  lib/telegram.ts                     # getWebhookSecret()/getTelegramClient() (fail-closed)
  lib/inngest/client.ts               # typed Inngest client, id:"baumy"
  lib/rate-limit.ts                   # lifted token bucket + getClientIp()
packages/telegram/                    # TelegramClient, verifyWebhookSecret, parseUpdate/updateSchema
packages/db/                          # Drizzle schema + migrations (llm_usage, llm_budget_day, scheduled_tasks)
packages/core/                        # MODEL_PRICING, costNanoUsd(), assertWithinBudget(), recordUsage()
scripts/  (or apps/admin-cli, tsx)    # set-webhook, delete-webhook, poll-bridge, replay-fixture, gen-fixtures
fixtures/telegram/*.json              # committed, owner-approved Update JSON incl. adversarial subset
fixtures/telegram/_candidates/*.json  # LLM-generated, PENDING owner review (git-ignored or clearly staged)
```
> Open question: helpers in `@baumy/admin-cli` (tsx) vs a top-level `scripts/` tree — pick one for the README.

### Webhook route contract (lifted, renamed)

`apps/web/app/api/telegram/webhook/route.ts`:
- `runtime = "nodejs"`.
- Reads header `x-telegram-bot-api-secret-token`; calls `verifyWebhookSecret(headerSecret, TELEGRAM_WEBHOOK_SECRET)` — constant-time compare (length check then XOR-accumulate; returns false on null header or empty expected).
- **401** on secret mismatch; **503** if `TELEGRAM_WEBHOOK_SECRET` unset; otherwise **always 200 `{ok:true}`** on a valid secret (even on parse failure) so Telegram doesn't retry-storm.
- Tier-0 pre-filter: dedupe on `update_id`, drop non-text/commands, apply rate limits, then `inngest.send()` and return 200 fast. The route NEVER selects a model or a tool — all routing (incl. any deliberative escalation) happens inside Inngest steps behind the write-gate.

### Dev-loop helper scripts (tsx, pnpm-driven)

| Script | pnpm alias | Behavior |
|---|---|---|
| set-webhook | `dev:webhook:set` | `TelegramClient.setWebhook({ url: PUBLIC_WEBHOOK_URL + '/api/telegram/webhook', secretToken: TELEGRAM_WEBHOOK_SECRET, allowedUpdates: ['message','edited_message','my_chat_member'] })`; print `getWebhookInfo` to confirm. |
| delete-webhook | `dev:webhook:delete` | `TelegramClient.deleteWebhook()`. |
| poll-bridge (Tier 2) | `dev:bridge` | `await client.deleteWebhook()`; loop `getUpdates({ offset, timeout:25, allowed_updates:['message','edited_message','my_chat_member'] })`; POST each update to `http://localhost:3000/api/telegram/webhook` with `{'content-type':'application/json','x-telegram-bot-api-secret-token': TELEGRAM_WEBHOOK_SECRET}`; `offset = max(update_id)+1`; log non-200s. |
| replay-fixture (Tier 1) | `dev:replay <file>` | POST `fixtures/telegram/<file>.json` to the local webhook with the secret header. |
| gen-fixtures (eval) | `dev:fixtures:gen` | One-off deliberate-lane call (budget-gated) that writes candidate Update JSON into `fixtures/telegram/_candidates/`; the owner reviews + promotes approved files into `fixtures/telegram/`. Synthetic only — never derived from production transcripts. |
| local orchestration | `dev:local` | `concurrently`/`npm-run-all`: `next dev` (:3000) + `dev:inngest`. |
| inngest dev | `dev:inngest` | `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`. |

> May need to add `getUpdates` + `getWebhookInfo` methods to `TelegramClient` if missing.

### External API reference (verified 2026-07-01)

- **Telegram `setWebhook`** — `POST bot<token>/setWebhook` with `{url, secret_token (A-Z a-z 0-9 _ - ; 1-256 chars), allowed_updates, drop_pending_updates}`. Public URL must use port **443/80/88/8443** with valid TLS. Telegram delivers `secret_token` in header `X-Telegram-Bot-Api-Secret-Token` on every update.
- **Telegram `getUpdates`** — `{offset: lastSeen+1, timeout: 25, allowed_updates:[...]}`. **Mutually exclusive with webhooks** — will not work while a webhook is set; the bridge must `deleteWebhook` first. `timeout` default 0 (short poll) — use ~25-30 for long polling. `limit` default 100 (1-100).
- **Inngest CLI dev server** — `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`; UI/API on **:8288**, `connect()` on **:8289**; auto-discovers `/api/inngest`, `/x/inngest`, `/.netlify/functions/inngest` (`--no-discovery` to disable). Some environments need `npx --ignore-scripts=false inngest-cli@latest dev` (verify at setup).
- **`INNGEST_DEV=1`** — SDK targets local dev server, disables signature verification, routes `inngest.send()` to :8288. **Local-only; must be unset in production.**
- **inngest `serve` (Next.js)** — `export const {GET,POST,PUT} = serve({client, functions}); export const runtime='nodejs'; export const maxDuration=60;` (Hobby ceiling). Register functions (incl. the cost digest and each scheduled-task cron) by adding to the `functions` array.
- **Web-search tool** — bound to the AI SDK only inside the deliberative/`advisor` and scheduled-task steps; **exact tool + provider (and whether a maps-capable search is needed for "near us" location queries) verified at build** (see Open questions). Per-search cost is metered in the ledger (`purpose='web_search'`).
- **`cloudflared` quick tunnel** — `cloudflared tunnel --url http://localhost:3000` -> random `https://*.trycloudflare.com` (account-free, auto-HTTPS). Fresh URL per run; 200 concurrent-request cap; no SSE (fine for a single webhook POST).
- **`ngrok` free tunnel** — `ngrok http 3000` -> **persistent** per-account dev domain, set webhook once. **[Verified 2026-07-01]** Current default suffix is `*.ngrok-free.dev` (legacy accounts keep `*.ngrok-free.app`; both valid). Limits: 3 online endpoints / 3 concurrent agents, 20,000 HTTP req/mo (4,000/min), 1 GB/mo egress, **no endpoint session timeout**. Browser interstitial affects HTML GET only (bypass with header `ngrok-skip-browser-warning`) — does NOT affect Telegram's server-to-server POST.

### Verified pricing (2026-07-01) — anchors `MODEL_PRICING`

| Model | Role | Input $/MTok | Cached-in $/MTok | Output $/MTok | Notes |
|---|---|---|---|---|---|
| `gpt-5.4-nano` | `classify` | 0.20 | 0.02 | 1.25 | **Reactive triage on every pre-filtered message.** |
| `gpt-5.4-mini` | classify fallback | 0.75 | 0.075 | 4.50 | Classifier fallback for harder intent parsing. |
| `claude-haiku-4-5` | `reply` | 1.00 | 0.10 | 5.00 | **Reactive reply/retrieval-grounded answers.** 5m cache write $1.25, 1h $2.00; Batch $0.50/$2.50. |
| `claude-sonnet-5` | `assess` | 3.00 | 0.30 | 15.00 | Hard on-hand/retrieved reasoning. Batch $1.50/$7.50. |
| `claude-opus-4-8` | `advisor` | 5.00 | 0.50 | 25.00 | **Deliberative lane ONLY — explicit intent / scheduled tasks. NEVER reachable from the reactive path.** |
| `claude-sonnet-5` | assess (alt) | 2.00 -> 3.00 | — | 10.00 -> 15.00 | **DATE-GATE:** $2/$10 through 2026-08-31, then $3/$15 from 2026-09-01. |
| `text-embedding-3-small` | embed | 0.02 | — | 0.00 | pgvector memory path (embeds BOTH raw messages and derived facts per D17); ~$0.0005/day. Batch $0.01/MTok. |
| web-search tool | tool (deliberative) | — | — | — | Per-search cost **verify at build**; metered as `purpose='web_search'`, counts against the hard cap. |

> `gpt-4.1-nano` is cheaper but is **retiring in 2026** and its price is inconsistently reported — do NOT hard-code it; keep the classifier model id in config (`ai_model_config`/`baumy_model_route`) so it can be swapped without a code change. All routing is config-driven + tweakable with no redeploy (decision C); exact model ids/prices are re-verified at build (project rule).

### `MODEL_PRICING` + `costNanoUsd()` (packages/core)

Store rates in **nano-USD/token** (`= per-MTok-dollar x 1000`):

```ts
// nano-USD per token
export const MODEL_PRICING = {
  'gpt-5.4-nano':           { input: 200,  cachedInput: 20,   output: 1250  },  // classify
  'gpt-5.4-mini':           { input: 750,  cachedInput: 75,   output: 4500  },  // classify fallback
  'claude-haiku-4-5':       { input: 1000, cachedInput: 100,  output: 5000  },  // reply
  'claude-sonnet-5':      { input: 3000, cachedInput: 300,  output: 15000 },  // assess
  'claude-opus-4-8':        { input: 5000, cachedInput: 500,  output: 25000 },  // advisor (deliberative only)
  'text-embedding-3-small': { input: 20,   cachedInput: 20,   output: 0     },
  // claude-sonnet-5 resolved via a date-gated getter (see below)
} as const;

// Date-gate Sonnet 5: $2/$10 through 2026-08-31, then $3/$15.
function sonnet5Pricing(at: Date) {
  return at < new Date('2026-09-01T00:00:00Z')
    ? { input: 2000, cachedInput: 200, output: 10000 }
    : { input: 3000, cachedInput: 300, output: 15000 };
}

export function costNanoUsd(
  model: string,
  { inputTokens, cachedInputTokens = 0, outputTokens }:
    { inputTokens: number; cachedInputTokens?: number; outputTokens: number },
  at = new Date(),
): bigint {
  const p = model === 'claude-sonnet-5' ? sonnet5Pricing(at) : MODEL_PRICING[model];
  if (!p) throw new UnknownModelError(model); // fail closed as most-expensive
  const uncached = inputTokens - cachedInputTokens;
  return BigInt(uncached) * BigInt(p.input)
       + BigInt(cachedInputTokens) * BigInt(p.cachedInput)
       + BigInt(outputTokens) * BigInt(p.output);
}

// Web-search tool cost is per-search (verify the exact rate at build), added
// to the same day's counter under purpose='web_search'.
export function webSearchCostNanoUsd(searches: number): bigint {
  return BigInt(searches) * WEB_SEARCH_NANO_PER_CALL; // WEB_SEARCH_NANO_PER_CALL verified at build
}
```

### DDL — spend ledger + daily counter (Drizzle -> Neon)

```sql
-- Append-only audit trail (idempotent under webhook retries)
CREATE TABLE llm_usage (
  id                  bigserial   PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  provider            text        NOT NULL,
  model               text        NOT NULL,
  -- reactive: classify|reply|assess ; deliberative: advisor|web_search|scheduled_task ; other: summarize|reminder_parse|embed
  purpose             text        NOT NULL,
  input_tokens        int         NOT NULL,
  cached_input_tokens int         NOT NULL DEFAULT 0,
  output_tokens       int         NOT NULL,
  cost_nano_usd       bigint      NOT NULL,
  chat_id             bigint,
  update_id           bigint,
  scheduled_task_id   bigint,               -- set when the cost came from a scheduled task
  provider_request_id text
);
CREATE INDEX llm_usage_created_at_idx ON llm_usage (created_at);
-- Idempotency: a given (update_id, purpose) is accounted at most once
CREATE UNIQUE INDEX llm_usage_update_purpose_uq
  ON llm_usage (update_id, purpose) WHERE update_id IS NOT NULL;

-- O(1) enforcement counter, one row per day in a single fixed TZ
CREATE TABLE llm_budget_day (
  day              date    PRIMARY KEY,   -- fixed TZ (BAUMY_BUDGET_TZ)
  spent_nano_usd   bigint  NOT NULL DEFAULT 0,
  input_tokens     bigint  NOT NULL DEFAULT 0,
  output_tokens    bigint  NOT NULL DEFAULT 0,
  calls            int     NOT NULL DEFAULT 0,
  soft_alert_sent  boolean NOT NULL DEFAULT false,
  hard_alert_sent  boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

> `scheduled_tasks` itself (`{prompt, cadence, until/expiry, requester, model_tier, group_id, status}` + a shared dispatch cron over the durable table) is owned by the proactive/scheduled-tasks workstream; this section only tests its cost behavior and joins its `scheduled_task_id` into `llm_usage` so per-task spend is attributable. The **member-askable monthly figure** is a plain `SUM(cost_nano_usd)` over `llm_usage` for the current month.

### Budget gate + accounting (packages/core)

- **`assertWithinBudget(db, estMaxNano, { lane })`** — read `llm_budget_day` for today's TZ day; if `spent_nano_usd >= HARD_CAP` throw `BudgetExceededError('hard', spent)`. For the deliberative lane (`advisor`/`web_search`/`scheduled_task`) the check runs once immediately before the (large) call and refuses if it would cross the cap. Two modes behind a flag:
  - **(a) DEFAULT check-then-reconcile** — cheap `SELECT`, accept bounded overshoot.
  - **(b) HARDENED atomic reserve** — upsert-seed the row, then
    `UPDATE llm_budget_day SET spent_nano_usd = spent_nano_usd + $estMax, calls = calls+1 WHERE day=$1 AND spent_nano_usd + $estMax <= $HARD_CAP RETURNING spent_nano_usd` (0 rows => reject); post-call reconcile by `(actual - estMax)`.
  - `estMax` from `chars/4` input heuristic + fixed system overhead + `maxOutputTokens` (per-lane; advisor/scheduled use the larger ceilings from decision 16). Web-search `estMax` also adds `expectedSearches * WEB_SEARCH_NANO_PER_CALL`.
- **`recordUsage()`** — after every model call (any lane, incl. web-search tool cost), map `result.usage`/`totalUsage` (+`providerMetadata` for cached tokens) to `{inputTokens, cachedInputTokens, outputTokens}`, compute `costNanoUsd` (+ `webSearchCostNanoUsd`), and in **one** transaction:
  ```sql
  INSERT INTO llm_usage (...) VALUES (...) ON CONFLICT (update_id, purpose) DO NOTHING;
  INSERT INTO llm_budget_day (day, spent_nano_usd, input_tokens, output_tokens, calls)
  VALUES ($day, $cost, $in, $out, 1)
  ON CONFLICT (day) DO UPDATE
    SET spent_nano_usd = llm_budget_day.spent_nano_usd + EXCLUDED.spent_nano_usd,
        input_tokens   = llm_budget_day.input_tokens   + EXCLUDED.input_tokens,
        output_tokens  = llm_budget_day.output_tokens  + EXCLUDED.output_tokens,
        calls          = llm_budget_day.calls + 1,
        updated_at     = now()
  RETURNING spent_nano_usd, soft_alert_sent, hard_alert_sent;
  ```
  Wrap in try/catch so accounting failure NEVER blocks the reply, but log loudly. Return the new total + prior alert flags so the caller can detect a threshold crossing in the same round-trip.

### AI SDK usage object (source of post-call token counts)

`generateText`/`streamText` return `usage` AND `totalUsage`:
`{ inputTokens, outputTokens, totalTokens, inputTokenDetails:{ noCacheTokens, cacheReadTokens, cacheWriteTokens }, outputTokenDetails:{ textTokens, reasoningTokens } }`. `streamText` `onFinish` receives `{ usage, totalUsage, providerMetadata }`. For deliberative runs that call the web-search tool, tool-call/search counts come from `providerMetadata`/tool result and are added to `webSearchCostNanoUsd`. Cached-token key names differ by provider (Anthropic: `cacheReadInputTokens`/`cacheCreationInputTokens`; OpenAI: cached prompt tokens) and are partly in `providerMetadata` — **verify exact field names against the installed SDK version before wiring cost math** (see Open questions).

### Tiered pipeline (per-call caps + routing)

**Reactive lane (default, capped):**
- **Tier 0 (webhook):** verify secret, dedupe `update_id`, drop non-text/commands, rate-limit (lifted `rate-limit.ts`), heuristics -> return 200 fast, enqueue Inngest.
- **`classify` (Inngest step):** `gpt-5.4-nano`, `maxOutputTokens=40`, minimal system prompt.
- **`reply` (escalation only):** `claude-haiku-4-5`, `maxOutputTokens=512`, retrieved-context capped ~2000 tokens, Anthropic prompt caching (`cache_control`) on the fixed system prompt (cache read = 0.1x input). **NO tools bound (memory-only, exfil-safe).**
- **`assess` (hard on-hand reasoning):** `claude-sonnet-5` (or date-gated `claude-sonnet-5`), `maxOutputTokens≈1024`. Reached only for genuinely hard reasoning over already-retrieved memory. **Still no web-search tool. NEVER escalates to Opus.**

**Deliberative/advisor lane (explicit-intent-only, web-search-capable):**
- Triggered ONLY by explicit deliberate intent through the write-gate ("go research/assess X") or by a scheduled task; NEVER by the reactive classifier and NEVER by untrusted group text.
- **`advisor`:** `claude-opus-4-8`, `maxOutputTokens≈2048`, **web-search tool bound (INPUT-only)**; output goes only to `BAUMY_HOUSE_CHAT_ID`.
- Checked against the hard cap immediately before running; skipped/deferred (not queued as a canned reply) in degraded mode.

Re-check `assertWithinBudget` INSIDE each step immediately before the model call; re-resolve API keys inside the step.

### Alerts, digest & spend queries (Inngest, never Vercel cron)

- **Realtime alert:** when `recordUsage`'s `RETURNING` shows `spent` crossed `SOFT_CAP (= DAILY_BUDGET x SOFT_PCT)` and `soft_alert_sent=false`, DM `BAUMY_ADMIN_CHAT_ID` and set the flag (same for hard). NEVER the house group.
- **Digest:** `inngest.createFunction({id:'baumy-cost-digest'}, {cron:'TZ=<houseTZ> 0 9 * * *'}, ...)` reads yesterday's `llm_usage` (SUM by model/purpose, incl. `web_search` and per-`scheduled_task_id`) and DMs a spend summary to admin. Register in the existing `serve()` functions array. (`<houseTZ>` = `Europe/Berlin` per decision B9.)
- **Admin `/cost` command:** admin-only Telegram command → `SELECT` today + month-to-date totals from the ledger (full source-of-truth monitoring, incl. per-purpose breakdown).
- **Member spend query (decision: nice-to-have):** any house member may ask "how much have we spent this month?" (natural language, matched by the reactive `reply` path). Answer is a single month-to-date dollar figure from `SUM(llm_usage.cost_nano_usd)`; it deliberately excludes cap/threshold/exhaustion state (that stays admin-only) so it cannot be used to time an abuse window. Zero extra LLM cost beyond the reply itself.

### Env config (`.env.example` + boot `assertServerEnv()`)

```
# Telegram (use a SEPARATE dev bot token locally)
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=      # A-Z a-z 0-9 _ - ; 1-256 chars
BAUMY_HOUSE_CHAT_ID=          # negative supergroup id, fixed send destination
BAUMY_ADMIN_CHAT_ID=          # private admin DM for ops alerts

# Store / AI
DATABASE_URL=

# Budget (USD -> nano-USD at load)
BAUMY_DAILY_BUDGET_USD=0.50
BAUMY_MONTHLY_BUDGET_USD=15   # ≈ daily x 30 (belt-and-suspenders)
BAUMY_DAILY_SOFT_PCT=0.8
BAUMY_BUDGET_TZ=Europe/Berlin # single fixed TZ for the day boundary (decision B9)
BAUMY_CLASSIFY_MAX_OUTPUT=40
BAUMY_REPLY_MAX_OUTPUT=512
BAUMY_ASSESS_MAX_OUTPUT=1024
BAUMY_ADVISOR_MAX_OUTPUT=2048

# Rate limits
BAUMY_RATE_PER_SENDER=10      # /min
BAUMY_RATE_PER_CHAT=30        # /min
BAUMY_RATE_GLOBAL_CLASSIFY=60 # /min

# Local dev ONLY — never set in Vercel production env / turbo.json globalEnv
INNGEST_DEV=1
PUBLIC_WEBHOOK_URL=           # Tier-3 tunnel URL, used by set-webhook helper
```

---

## Gotchas

**Dev loop**
- **cloudflared random-URL churn:** a fresh `*.trycloudflare.com` URL each launch => Tier 3 requires re-running `dev:webhook:set` every restart. Stay in Tier 1/2 for the inner loop, or use ngrok's persistent domain / a named cloudflared tunnel.
- **getUpdates and webhooks are mutually exclusive:** the poll-bridge MUST `deleteWebhook` first, and any prior `setWebhook` (e.g. your deployed Vercel bot on the same token) silently starves the bridge. **Use a SEPARATE dev bot token** so you never fight your deployed webhook over one token.
- **`allowed_updates` default omits `chat_member`/reactions**, and "if not specified, the previous setting will be used" — a stale setting can silently drop message delivery. Pass it explicitly on both `setWebhook` and `getUpdates`.
- **Privacy-mode change only takes effect after you REMOVE and RE-ADD the bot** to the test group — flipping `/setprivacy` alone won't start delivering all messages in an already-joined group. Capture the negative `chat_id` from the first incoming update.
- **Eval fixtures must be synthetic + owner-approved** (decision #9): never paste real house transcripts into `fixtures/`. LLM-generated candidates land in `_candidates/` and only enter CI after owner promotion — otherwise the "regression suite" quietly bakes in unreviewed or sensitive content.
- **`INNGEST_DEV=1` disables signature verification** and points at the local dev server — never set it in the Vercel production env or the `serve` endpoint becomes unauthenticated. Keep it strictly in local `.env` / the dev command; assert it is unset in the production boot check.
- **The webhook always returns 200 on a valid secret (even on parse error)** to avoid retry-storms — so a broken handler looks "delivered" to Telegram and fails silently. During dev, watch the Next.js server logs / the :8288 Inngest dashboard, NOT Telegram's delivery status.
- **Fixture replay/poll-bridge must send the EXACT `TELEGRAM_WEBHOOK_SECRET`** in `X-Telegram-Bot-Api-Secret-Token` (constant-time, length-sensitive compare) or the route returns 401 with no body — an easy-to-miss "nothing happens" failure.
- **ngrok interstitial** appears only on browser HTML GETs, not Telegram's POST — so it doesn't block webhook delivery but WILL block you from eyeballing the URL in a browser; add `ngrok-skip-browser-warning` or use curl.
- **[RESOLVED by verification]** the "ngrok free now caps sessions at 2h / forces random URLs" claim is **outdated third-party marketing**, contradicted by current official docs (persistent dev domain, no endpoint timeout). The only real 2026 change is the default suffix: `ngrok-free.dev` for new accounts (`ngrok-free.app` legacy).

**Cost control**
- **The reactive path must NEVER reach `advisor` (Opus) or bind a tool.** A misclassified message may reach at most `assess` (Sonnet); Opus + web search are explicit-intent-only. This is BOTH a cost control (Opus is 5x Haiku input / 5x output and a false-positive is a wallet hit) AND the exfil boundary (a tool-less reply path can't be steered to fetch/leak). The A5 adversarial suite asserts both halves; treat a regression here as security-critical, not cosmetic.
- **Web search is INPUT-only and output-fixed.** External text may come IN, but the OUTPUT still goes only to `BAUMY_HOUSE_CHAT_ID`, and only explicit trusted intent / scheduled tasks may search. Never let a web-search result string be treated as an instruction (it is untrusted data, same as group text).
- **Scheduled tasks are recurring PAID queries → slow-drip denial-of-wallet risk.** Each per-task cron run must pass `assertWithinBudget` before its (heavy) model call, honor `until/expiry`, be cancellable, and skip in degraded mode. An abusive/too-frequent cadence is bounded by the same $0.50/day hard cap; the digest surfaces per-`scheduled_task_id` spend so a runaway task is visible.
- **Member spend query is read-only and thresholds-blind.** Answer the monthly figure from the ledger only; do NOT expose cap/soft/hard/exhaustion state to the group (that stays in the admin alert channel) — leaking "we're near the cap" hands a prompt-injection attacker the timing to exploit degraded mode.
- **Local Inngest has no 60s cap, but Vercel Hobby forces `maxDuration=60` per invocation.** A multi-step AI function that runs fine locally can time out in prod. Split heavy AI work (esp. the deliberative/advisor lane and multi-fact scheduled tasks) into separate `step.run()` calls (each = a fresh ~60s invocation) and watch per-step timings in the :8288 dashboard.
- **AI SDK gives token usage only AFTER the call** => a pre-call gate can never be exactly hard without reserve-then-reconcile; enforce boundedness via per-call `maxOutputTokens` + input-context caps so worst-case overshoot is known and tiny. Advisor/scheduled runs use larger ceilings, so they are gated once *before* running rather than allowed to overshoot.
- **Telegram retries the webhook if you don't return 200 quickly** => the SAME message gets processed (and paid for) multiple times. Dedupe on `update_id` BEFORE any LLM call and return 200 fast; do heavy work in Inngest.
- **The lifted in-memory rate limiter is per-process and resets on cold start / isn't shared across Vercel instances** — treat it as a cheap soft first-line guard only; the durable Neon counter MUST be the money ceiling.
- **Claude Sonnet 5 introductory pricing flips $2/$10 -> $3/$15 on 2026-09-01.** A static price table silently UNDER-counts spend after that date unless the entry is date-gated.
- **Cached-input token fields differ by provider and are partly in `providerMetadata`.** Assuming zero cached tokens over-counts (harmless for the cap, wrong for reporting); a wrong field name silently reads `undefined -> 0`. Verify against the installed SDK version.
- **Opus 4.7+ / Sonnet 5 use a newer tokenizer emitting ~30% more tokens for the same text** — per-message token ceilings must be calibrated per model, not shared across models. This matters most for the `advisor` lane where Opus output is the priciest.
- **Accumulate in nano-USD (bigint), not micro-USD** — fractional cached rates (0.02, 0.1 micro/token) break integer math otherwise.
- **The classifier is the denial-of-wallet target** (privacy OFF): a single looping member can flood messages. Rate limits + hard cap + `update_id` dedupe are all needed together; any one alone is insufficient.
- **Day-boundary must be a single explicit TZ** (`Europe/Berlin`, decision B9) used consistently by the counter key, the reset, the digest cron, AND the "this month" boundary for the member spend query — mixing UTC storage with local-time digests double-counts or skips a window, and gets the month boundary wrong at DST transitions.
- **Do NOT announce budget exhaustion to the house group** — a member learning the bot is "resting" can time-exploit it. Alert the private admin chat instead; the member-askable spend query stays deliberately silent about the cap.

---

## Tasks (ordered, with dependencies + estimates)

> Two roughly-parallel tracks. Track A (dev loop) and Track B (cost control) share only the lifted webhook/Inngest plumbing (A1, B5-ish). Estimates: h = hours, d = days.

### Track A — Dev loop & testing

- **A1. Lift + rename Telegram plumbing and confirm the webhook route.** *(deps: none; ~1-2h)*
  Copy `packages/telegram` (`client.ts`/`webhook.ts`/`handlers.ts`/`index.ts` + `__tests__`), `apps/web/app/api/telegram/webhook/route.ts`, `apps/web/lib/telegram.ts`; rename to `@baumy/telegram` and drop the invite/announcement domain handlers, keeping `TelegramClient`, `verifyWebhookSecret`, `parseUpdate`/`updateSchema`, `getWebhookSecret`/`getTelegramClient`. Verify the route returns 401 on bad secret, 503 if secret unset, 200 otherwise.
- **A2. Add dev env + BotFather test-bot/group setup doc.** *(deps: none; ~30-45m)*
  In `.env.local` set a SEPARATE dev `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `BAUMY_HOUSE_CHAT_ID`, `INNGEST_DEV=1`, `BAUMY_BUDGET_TZ=Europe/Berlin`. Document: create dev bot, `/setprivacy -> Disable`, create private test group, add bot, REMOVE + RE-ADD, capture negative `chat_id` from first update.
- **A3. Write `set-webhook` / `delete-webhook` tsx helpers.** *(deps: A1; ~1h)*
  Wire as `dev:webhook:set` / `dev:webhook:delete`; print `getWebhookInfo` to confirm. Add `getWebhookInfo` to the client if missing.
- **A4. Write the getUpdates -> localhost long-poll bridge (Tier 2).** *(deps: A1; ~2h)*
  `dev:bridge` per the design above; add `getUpdates`+`getWebhookInfo` to `TelegramClient` if missing.
- **A5. Build the fixture-replay harness + synthetic adversarial fixture library (Tier 1).** *(deps: A1; ~3-4h)*
  Store committed, owner-approved Update JSON under `fixtures/telegram/*.json` (reuse message/chat_member shapes from the lifted tests). `dev:replay <file>` POSTs with the secret header. Include an adversarial subset — "ignore previous instructions", fake `SYSTEM:`/admin commands, injected reminder-cancel text, **fake "go research/spend money on X" deliberative triggers, and fake "add a daily scheduled task" injections** — and a **Vitest that replays them asserting: (1) the deterministic write-gate never triggers a privileged write/notification; (2) the reactive path never selects `advisor` (Opus); (3) the reactive reply path is given no tools (no web search); (4) no deliberative run or scheduled-task create/mutate is launched from untrusted group text.**
- **A6. Add the Baumy-assisted eval-fixture generator + owner-review flow.** *(deps: A5; ~1-2h)*
  `dev:fixtures:gen` runs a one-off budget-gated deliberate-lane call to synthesize candidate chats/injections/scheduled-task prompts into `fixtures/telegram/_candidates/`; document the promote-after-owner-review step into `fixtures/telegram/`. CI runs only owner-approved committed fixtures. (Decision #9.)
- **A7. Lift Inngest client + serve endpoint and wire local dev server.** *(deps: none; ~1-2h)*
  Rename client id -> `"baumy"`, define the Baumy event map (message/reminder/deliberative/scheduled-task events), `serve` with `runtime="nodejs"`, `maxDuration=60`. Add `dev:inngest`. Confirm `INNGEST_DEV=1` lands `send()` in the :8288 dashboard with no keys; confirm a sample scheduled-task cron + the cost digest register.
- **A8. Add one-command local orchestration + README runbook.** *(deps: A4; ~1-1.5h)*
  `dev:local` (concurrently/npm-run-all) starts `next dev` + `dev:inngest`. Document Mode A (inner loop = `dev:local` + `dev:bridge`, no tunnel) and Mode B (pre-deploy = `dev:local` + tunnel + `dev:webhook:set`). List ports (3000 app, 8288 Inngest UI, 8289 connect), the mutual-exclusivity rule, and the `dev:webhook:delete` cleanup step.

### Track B — Cost control & observability

- **B1. Add spend-ledger + daily-counter schema (Drizzle) and migration.** *(deps: none; ~0.5d)*
  `llm_usage` (incl. `scheduled_task_id`) + `llm_budget_day` per DDL above; generate via drizzle-kit; verify the migration-drift check passes.
- **B2. Create the versioned `MODEL_PRICING` table + `costNanoUsd()`/`webSearchCostNanoUsd()` helpers (packages/core).** *(deps: none; ~0.5d)*
  Values per the table above incl. `claude-opus-4-8` (advisor) + the web-search per-call line (id/price verified at build); date-gate `claude-sonnet-5`; unknown model throws. Unit-test the arithmetic incl. cached path, the Sonnet-5 date flip, and the web-search cost line.
- **B3. Implement the deterministic pre-call budget gate + `BudgetExceededError`.** *(deps: B1; ~1d)*
  `assertWithinBudget(db, estMaxNano, {lane})` with the DEFAULT check-then-reconcile and HARDENED atomic-reserve modes behind a flag; deliberative/scheduled runs gated once-before-run with the larger per-lane `estMax`.
- **B4. Implement post-call accounting: `recordUsage()` writing ledger + atomic counter upsert.** *(deps: B2; ~1d)*
  Map SDK `usage`/`totalUsage` (+`providerMetadata`, + web-search count), one transaction, idempotent insert, `RETURNING` for threshold detection; accounting failure never blocks the reply.
- **B5. Wire the reactive tiered pipeline + the deliberative/advisor lane with per-call cost caps and config-driven model routing.** *(deps: B3; ~2d)*
  Tier 0 webhook (verify secret, dedupe, drop non-text, rate-limit via lifted `rate-limit.ts` renamed to `@baumy/*`, enqueue). Reactive: `classify` `gpt-5.4-nano` maxOut=40 -> `reply` `claude-haiku-4-5` maxOut=512 (no tools) -> `assess` `claude-sonnet-5` maxOut≈1024 (no tools), context <= ~2000, prompt caching on the system prompt. **Deliberative lane:** `advisor` `claude-opus-4-8` maxOut≈2048 + web-search tool, explicit-intent-only through the write-gate, output fixed to `BAUMY_HOUSE_CHAT_ID`. **Enforce the HARD RULE in code: the reactive router cannot resolve the `advisor` role or bind a tool.** Re-check budget + re-resolve keys inside each step. Model ids resolve from `ai_model_config`/`baumy_model_route` (no redeploy to retune).
- **B6. Implement the over-budget fail-safe / degraded mode.** *(deps: B3; ~1d)*
  Catch `BudgetExceededError`, ALWAYS return 200. User-directed reactive message => ONE canned rate-limited reply per chat/window. Ambient/classifier message => skip the LLM and (per open question) optionally enqueue `{update_id,text,ts}` into `deferred_intake` for next-day Batch-API reprocessing. Deliberative runs and scheduled-task crons that would cross the cap are **skipped/deferred** (not queued as replies). **CRITICAL:** reminder DELIVERY never calls `assertWithinBudget`; only NL reminder PARSING is gated (regex fallback / ask-to-restate).
- **B7. Implement alerts: realtime soft/hard-cap crossing + Inngest cron daily digest.** *(deps: B4; ~1d)*
  Threshold-crossing DM to `BAUMY_ADMIN_CHAT_ID` with once-per-day flags; `baumy-cost-digest` cron function (`TZ=Europe/Berlin`) registered in `serve()`, summing by model/purpose incl. `web_search` and per-`scheduled_task_id`. No Vercel cron. NEVER to the house group.
- **B8. Add env config, an admin `/cost` command, AND the member-askable monthly spend query, and defaults.** *(deps: B4; ~0.5-1d)*
  Add budget/rate-limit vars (incl. `BAUMY_MONTHLY_BUDGET_USD=15`, `Europe/Berlin` TZ, per-lane max-output) to `.env.example` + boot `assertServerEnv()`; convert USD->nano at load. Admin-only `/cost` command reading today + MTD (full breakdown) from the ledger. **Member-askable "how much this month?"**: reactive-`reply` intent that returns a single MTD dollar figure from `SUM(llm_usage.cost_nano_usd)` for the current `Europe/Berlin` month, deliberately excluding cap/threshold state. All custom vars under the `BAUMY_` prefix.
- **B9. Tests: cap enforcement, idempotency, degraded mode, deliberative/web-search + scheduled-task cost, pricing arithmetic.** *(deps: B6; ~1.5d)*
  Vitest with the PGlite/db seam: (1) `costNanoUsd` exactness incl. cached + Sonnet-5 flip + web-search line; (2) counter upsert atomicity + threshold flags; (3) gate rejects at the **$0.50/day hard cap**, per-call caps bound overshoot; (4) idempotent accounting under duplicate `update_id`; (5) **over-budget degraded mode** returns 200 + one canned reply, **reminder delivery still fires**, and a deliberative/scheduled run is **skipped** (not paid) while over cap; (6) denial-of-wallet burst trips the cap and stops spend; (7) a **deliberative/web-search run is metered** (tokens + per-search) and counts toward the cap; (8) a **scheduled-task run is metered** under its `scheduled_task_id` and is skipped in degraded mode; (9) the **member monthly-spend query** returns the ledger SUM and never leaks threshold/cap state. Wire into CI alongside the A5 adversarial suite and the migration-drift check.

---

## Risks & mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Local dev bot shares a token with the deployed Vercel bot; the deployed webhook and the local poll-bridge fight over updates (getUpdates fails, or `deleteWebhook` silently breaks prod). | High | Dedicated dev bot token + dedicated private test group; never run poll-bridge/delete-webhook against the production token. **Rule #1 in the runbook.** |
| R2 | `INNGEST_DEV=1` or a dev-only secret leaks into Vercel production, disabling Inngest signature verification on the public serve endpoint. | High | Keep `INNGEST_DEV` strictly in `.env.local`/the dev command; assert it is unset in the production boot check; never add to `turbo.json` globalEnv or Vercel project env. |
| R3 | Adversarial group text steers a privileged write / house-group notification during dev and the loop has no guard-rail test, so the regression ships. | High | Make the A5 adversarial fixture-replay Vitest a **required CI check**: replay injection fixtures, assert zero privileged writes / zero `sendMessage` to `BAUMY_HOUSE_CHAT_ID`. |
| R4 | **Reactive path reaches `advisor` (Opus) or a tool** — a misclassified/injected message escalates to the expensive, web-search-capable lane (denial-of-wallet AND exfil). | High | Decouple lanes in CODE: the reactive router cannot resolve the `advisor` role or bind a tool; deliberative lane is explicit-intent-only behind the write-gate. A5 tests assert both halves; treat a regression as security-critical. |
| R5 | Denial-of-wallet: privacy OFF => any member (or a looping account) floods messages that each trigger a paid classify call. | High | Layered: `update_id` dedupe + per-sender/per-chat/global rate limits + durable Postgres hard cap tripping degraded mode; Tier-0 free pre-filter keeps most messages from the LLM; **$0.50/day** cap bounds a worst-case abuse day to cents. |
| R6 | Over-budget degraded mode could break reminders if parsing and delivery share the gated path. | High (mitigated) | Structurally separate zero-token DELIVERY (never gated) from paid NL PARSING (gated, regex fallback). Test explicitly (B9-5) that reminders fire while over budget. |
| R7 | **Scheduled tasks drip-spend** — a recurring/too-frequent paid query quietly accrues cost or is abused to run past intent. | Medium | Per-run `assertWithinBudget` before the model call; honor `until/expiry`; cancellable; skipped in degraded mode; the same $0.50/day cap bounds the day; digest surfaces per-`scheduled_task_id` spend so runaways are visible. |
| R8 | Web-search results treated as instructions (injection via fetched content) or output leaked outside the house. | Medium | Web search is INPUT-only (fetched text is untrusted data, never a command); output fixed to `BAUMY_HOUSE_CHAT_ID`; deliberative-lane-only; every search metered under the cap; A5 covers the "search-result-as-instruction" case. |
| R9 | Handlers that pass locally (no time cap) time out on Vercel Hobby's 60s ceiling, surfacing only after deploy (worst on the multi-step advisor/scheduled lane). | Medium | Keep `maxDuration=60` on the serve route locally; split heavy AI work into separate `step.run()` calls; watch per-step durations in :8288; re-resolve secrets inside each step. |
| R10 | Pre-call gate can't be perfectly hard (usage known only post-call); concurrent in-flight calls overshoot. | Medium | Bound per-call cost with `maxOutputTokens` + input caps so overshoot = `concurrentCalls x knownMaxPerCall` (cents at ~4-user scale); gate advisor/scheduled once-before-run; offer the atomic reserve-then-reconcile variant if strict-hard is mandated. |
| R11 | Pricing/model drift (rename, new tokenizer, Sonnet-5 Sep-1 change, unverified web-search rate) silently makes the price table wrong, under-counting spend. | Medium | Single versioned `MODEL_PRICING`; date-gate time-boxed prices; web-search rate + all ids re-verified at build; unknown id throws (fail closed as most-expensive); ledger stores model+tokens so cost is recomputable. |
| R12 | Accounting write failure or webhook retry causes double-count (over-blocks) or under-count (over-spends). | Medium | `UNIQUE(update_id,purpose)` idempotency; counter upsert + ledger insert in one transaction; accounting wrapped so failure never blocks the reply but logs loudly; return 200 fast + dedupe. |
| R13 | cloudflared random-URL churn leaves a stale webhook pointing at a dead tunnel; Telegram silently queues/drops updates. | Medium | Prefer Tier-2 poll-bridge for the inner loop; when on Tier 3, always re-run `dev:webhook:set` after (re)starting the tunnel and confirm with `getWebhookInfo`; consider ngrok's persistent domain. |
| R14 | Eval fixtures contaminated with real/sensitive data or unreviewed LLM output entering CI. | Low | Decision #9: fixtures are synthetic; LLM candidates staged in `_candidates/` and only committed after owner review; never paste real transcripts. |
| R15 | The lifted in-memory rate limiter is per-process / resets on cold start, giving a false sense of a durable limit. | Low | Treat strictly as a soft first-line guard; the durable Neon counter is the authoritative money ceiling; document the seam so an Upstash-backed limiter can drop in later. |
| R16 | Member spend query leaks operational cap/exhaustion state to the untrusted group. | Low | The member query returns only a MTD dollar figure from the ledger; cap/soft/hard/exhaustion state stays in the admin-only channel. |
| R17 | Depending on Vercel AI Gateway / provider dashboards for enforcement — they lag and may not offer a hard spend cap on $0 tier. | Low | Use the self-hosted Postgres ledger as the sole enforcement point; treat any gateway dashboard as optional secondary observability. |
| R18 | `gpt-4.1-nano` (cheapest classifier) is retiring in 2026; hard-coding it creates a forced migration / silent breakage. | Low | Default the classifier to `gpt-5.4-nano`; keep the model id in `ai_model_config`/`baumy_model_route` so it can be swapped without code change. |

---

## Open questions (for the owner)

**Dev loop**
1. **Helper location:** do the poll-bridge/fixture-replay/gen-fixtures live in `@baumy/admin-cli` (tsx) or a top-level `scripts/` dir? Pick one for the README.
2. **Process orchestrator** for the 3 long-lived local processes (`next dev` :3000, `inngest dev` :8288, tunnel): single `dev:local` (concurrently/npm-run-all), a Procfile, or three terminals? Not a blocker — pick one.
3. **Inngest CLI invocation:** confirm `npx inngest-cli@latest dev` works headless in this environment, or whether `npx --ignore-scripts=false inngest-cli@latest dev` is needed.
4. **ngrok vs cloudflared as the documented Tier-3 default:** with the persistent-domain claim now verified, is a stable ngrok URL worth the signup, or keep cloudflared (account-free) as the default and ngrok as the noted alternative?

**Cost control**
5. **Actual daily message volume** for this house (drives cap tuning) — 500 msgs/day is an assumption; a chatty group could be 2-3x.
6. **Web-search tool selection:** which provider/tool, and is a **maps-capable search** needed for "near us"/location queries (uses house location)? Confirm the tool AND its per-search price at build so the ledger line is exact. (CAP decision.)
7. **Deliberative-lane spend sub-cap:** the daily $0.50 cap governs everything, but should `advisor`/scheduled/web-search have their own sub-ceiling (e.g. "no more than $X/day of Opus") so one deliberate task can't consume the whole day's budget?
8. **Over-budget ambient handling:** queue to a `deferred_intake` table for next-day 50%-off Batch reprocessing (preserves memory-first), or drop to guarantee zero spend?
9. **Strictness:** is bounded overshoot (simpler check-then-reconcile) acceptable, or is strict atomic reserve-then-reconcile mandated?
10. **SDK field verification:** confirm the exact cached-token field names (`usage.inputTokenDetails.cacheReadTokens` vs `providerMetadata` per provider) AND how the web-search tool reports search counts, against the installed AI SDK version before wiring cost math.

> **Resolved by the decision log:** the "quality summary" model is settled — `reply` = Haiku, `assess` = Sonnet, `advisor` = Opus (explicit-only); the monthly cap is kept (`$15` ≈ daily × 30); the day/month boundary TZ is `Europe/Berlin`; and eval fixtures are synthetic + owner-reviewed.
