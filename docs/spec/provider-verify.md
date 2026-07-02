# Provider / Model IDs, Pricing & AI SDK (verified 2026-07-01; roles per decision C)

> Workstream key: `provider-verify`
> Scope: the **source-of-truth** for exact model ID strings, per-MTok pricing, caching/batch discount mechanics, the Vercel AI SDK version pin, and the SDK call-shape (`generateText` + `Output.object`, `tool()`, `providerOptions` caching) that every other workstream imports. This doc owns the *constants* and the *routing/spend-cap config surface*; `llm-pipeline` owns *how they're wired into the hot path*.
> **Reconciled to `00-decisions.md`.** The owner's finalized model-routing decision (§C) and spend cap OVERRIDE the earlier "pick a quality tier" framing: four config-driven roles — `classify`=OpenAI nano, `reply`=Haiku, `assess`=Sonnet, `advisor`=Opus (explicit-only, **never** reactive) — under a **hard ~$0.50/day spend cap**. All routing and the cap are DB-config-driven and tweakable without redeploy.
> All pricing and every Anthropic/OpenAI figure below was **independently verified against official Anthropic & OpenAI docs on 2026-07-01** and returned `confirmed` (see verdict trail at the bottom of §Concrete design). SKUs, SDK versions, and AI-SDK field names rotate frequently — **re-verify exact IDs, prices, and SDK field names at build** (project rule / decision batch #7). Read §Gotchas and §Open questions before locking `package.json` or a cost model.

---

## Overview

This section fixes five things the rest of the build depends on:

1. **Exact model IDs** for each of the four owner-decided routing roles, in the precise dateless-alias format the AI SDK expects.
2. **Verified per-MTok pricing** (base, cache, batch) for every candidate model, plus the discount *multipliers* (cache read/write, batch, data-residency) that stack on top.
3. **A cost verdict** for a ~4-person house: the architecture lands at **~$2–4/mo** in the realistic Haiku-default base case and is *token-bound, not infra-bound* (Vercel Hobby / Neon / Inngest free tiers are $0). The entire cost story is the Anthropic `reply`/`assess`/`advisor` tier — the OpenAI `classify` tier is mathematically incapable of breaching budget (<$2/mo even for a chatty house running every message through nano).
4. **A hard spend cap**: **~$0.50/day (~$15/mo)**, config-tweakable, with a **degraded mode past the cap** — and **reminder delivery is never gated** by it (decision C).
5. **The AI SDK version pin and call-shape**: `ai@^7` (or `^6` conservative) with provider factories using direct API keys (never the bare-string gateway form, which would break the $0 constraint).

**Model roster for Baumy — four config-driven roles (decision C):**

The core principle: **REACTIVE (cheap, capped) is decoupled from DELIBERATIVE/ADVISOR (Opus, explicit-only).** The expensive model must NOT be reachable by a misclassified message.

| Role | Model | ID string | Trigger path | Why |
|---|---|---|---|---|
| **`classify`** | OpenAI GPT-5.4 nano | `gpt-5.4-nano` | reactive — every pre-filtered message | triage + extract; `reasoning_effort` defaults `none`; ~$0.0002/msg |
| **`reply`** | Claude Haiku 4.5 | `claude-haiku-4-5` | reactive — live chat replies, retrieval-grounded answers, trigger management | cheapest Anthropic tier + old tokenizer; ~$0.007/reply. **HARD RULE: this path NEVER invokes Opus.** |
| **`assess`** | Claude Sonnet 5 | `claude-sonnet-5` | deliberate/on-demand — multi-fact reasoning over on-hand/retrieved info (audits, scheduled tasks) | near-Opus quality; **intro $2/$10 through 2026-08-31**, then $3/$15 |
| **`advisor`** | Claude Opus 4.8 | `claude-opus-4-8` | **explicit deliberate intent ONLY** ("go research/assess X"); routed through the write-gate; never the reactive classifier | derived answers needing real reasoning/research NOT directly on hand; "a calm, deliberate thing"; web-search-capable |
| `classify` escalation | OpenAI GPT-5.4 mini | `gpt-5.4-mini` | reactive — low-confidence nano output only | nano→mini cascade for the minority of ambiguous messages |
| `classify` cost-floor fallback | OpenAI GPT-4.1 nano | `gpt-4.1-nano` | swappable env alias | non-reasoning, deterministic cost; legacy → behind alias |
| Embeddings | (owned by storage workstream) | — | — | negligible cost (<$0.10/mo); confirm exact 2026 model ID there |

The two decisions that carry the entire budget: **the reactive path defaults to Haiku and can never reach Opus**, and **per-reply context is bounded**. Sonnet (`assess`) is reachable from the reactive path *only* for grounded multi-fact reasoning; Opus (`advisor`) is reachable *only* via explicit deliberate intent through the deterministic write-gate. Everything else is cents, and the hard daily cap is the backstop.

---

## Decisions (with rationale)

### Model routing & spend governance (owner decision C — authoritative)

- **DR1 — Four named roles, decoupling reactive from deliberative.** `classify` (nano) triages every pre-filtered message; `reply` (Haiku) handles reactive live chat + retrieval-grounded answers + trigger management; `assess` (Sonnet) does multi-fact reasoning over on-hand/retrieved information (on-demand audits per A4, scheduled tasks per A4b); `advisor` (Opus) produces derived answers needing real reasoning/research not directly on hand. The role→model map is the routing contract every other workstream imports. *(high)*
- **DR2 — HARD RULE: the reactive/reply path NEVER invokes Opus (`advisor`).** A misclassified or prompt-injected message must be structurally incapable of reaching the most expensive tier — this is a *cost-control invariant*, not a tuning knob. The reactive classifier may escalate `reply`→`assess` (Haiku→Sonnet) for grounded multi-fact reasoning, but `advisor` (Opus) is reachable **only** through explicit deliberate intent gated by the deterministic write-gate ("go research/assess X"). This is the same injection wall that gates privileged config writes (A5) — reused here to cap reply-tier spend. *(high)*
- **DR3 — All routing is config-driven and tweakable without a redeploy.** The role→model map, per-role `maxOutputTokens`, enable flags, and the `reply`→`assess` escalation thresholds live in a DB config table (`ai_model_config`), overriding the compiled defaults at runtime; env vars (`BAUMY_*_MODEL`) provide the fallback layer. **Exact tier thresholds are TBD pending real UX** — ship conservative defaults, tune from usage. Owner-only writes; a boot health-check validates each resolved ID. *(high)*
- **DR4 — Hard daily spend cap ~$0.50/day (~$15/mo), config-tweakable, with a degraded mode past the cap.** A `spend_config.daily_cap_usd` (default `0.50`) is checked (against a `Europe/Berlin`-day rollup per B9) *before every discretionary LLM call* (`reply`/`assess`/`advisor`). Past the cap Baumy enters **degraded mode**: cheap `classify`+store capture continues (sub-cent, so nothing is lost), but discretionary `reply`/`assess`/`advisor` calls are suppressed (or reduced to a one-line "daily spend cap reached" notice, config-selectable). **Reminder delivery is NEVER gated by the cap** — reminders bypass the spend gate entirely and, in degraded mode, use a templated (LLM-free) phrasing fallback so they always fire (E22). *(high)*
- **DR5 — Web search is a DELIBERATE-path tool only (`advisor`/`assess` scheduled tasks); the reactive `reply` path is memory-only, zero-tool.** External lookups (specials, nearby stores, prices — decision CAP) are INPUT-only and available only on the explicit deliberate path; output still goes only to the fixed house group, never triggerable by untrusted group text, governed by the spend cap. The exact web-search tool (maps-capable for "near us" using the house location) is **verified at build**. The reactive reply path carries no tools (exfil-safe). *(high)*
- **DR6 — Member-askable spend query.** "How much have we spent this month?" is answered from the spend ledger (`spend_day` + per-request rows) — low priority, the ledger already exists for the cap. *(low)*

### Anthropic (`reply` / `assess` / `advisor` tiers)

- **D1 — `reply` = Claude Haiku 4.5 (`claude-haiku-4-5`).** Reactive replies are the *sole* high-frequency cost driver. Haiku is ~$0.007/reply vs ~$0.035 on Opus (5×) and uses the **old tokenizer** (~30% fewer tokens for the same text), giving a second discount on top of the lower sticker rate. Letting the reactive path drift to Opus is the single biggest way to blow the budget — forbidden by DR2. *(high)*
- **D2 — `assess` = Sonnet 5 (`claude-sonnet-5`) for multi-fact reasoning over retrieved/on-hand info, while introductory pricing lasts.** Intro $2/$10 through **2026-08-31**, then $3/$15 (+50%). Even post-intro it is half of Opus. *Note the tokenizer offset:* Sonnet 5's lower sticker vs Sonnet 4.6 is partly cancelled by ~30% higher token counts — do not treat $2 vs $3 as a straight 33% saving. Reachable from the reactive path only for grounded multi-fact reasoning; the primary users are on-demand audits (A4) and scheduled tasks (A4b). *(medium)*
- **D3 — `advisor` = Opus 4.8 (`claude-opus-4-8`), explicit deliberate intent ONLY.** At ~$0.035/reply × 300 replies/mo it would be ~$10.5/mo on replies *alone* — straight into the $10–20 band; at chatty volume >$30/mo. It is gated behind an explicit escalation signal through the write-gate and is **never** reachable by the reactive classifier (DR2). Maps to the on-demand audits / deliberate research of A4/A4b; web-search-capable (DR5). *(high)*
- **D4 — Route ALL non-realtime Anthropic work (nightly memory consolidation, daily/weekly digests, bulk back-processing, scheduled tasks) through the Batch API for a flat 50% discount.** Baumy already routes async work through Inngest, which absorbs the ≤24h turnaround (most batches <1h). Batch stacks with prompt caching. **Never** route the interactive `reply` path through Batch (it's latency-sensitive and Batch is 24h-async). *(high)*
- **D5 — Prompt-cache the stable reply prefix (persona system prompt + tool schema + retrieved-memory block) with a 5-minute ephemeral breakpoint — but size it above the model minimum.** Cache reads are 0.1× input (90% off). **Minimum cacheable prefix is 4096 tokens on Haiku 4.5 AND Opus 4.8, 2048 on Sonnet** — a ~2,500-token prefix caches on Sonnet but *silently does not* on Haiku/Opus. Treat caching as a **burst optimizer**, not a guaranteed discount: a quiet house chats in bursts with long gaps, so many one-off queries miss the 5-min TTL. *(high)*
- **D6 — Keep inference on default global routing; do NOT set `inference_geo`.** `inference_geo:"us"` applies a flat 1.1× multiplier across all token categories. Baumy has no data-residency requirement; omit the parameter entirely (it also 400s on pre-4.6 models). *(high)*

### OpenAI (`classify` tier)

- **D7 — `classify` = `gpt-5.4-nano`, with `reasoning_effort` explicitly pinned to `"none"`.** It's the current maintained nano gen and its *default* effort is already `none`, so it behaves like a fast completion model with no reasoning-token surcharge. Input $0.20/MTok dominates (classifier outputs are short), and the 90% cached-input discount ($0.02/MTok) applies automatically to the stable prefix. Run **one combined triage+extract structured-output call** per surviving message (~750 in / ~50 out) — do NOT make a second Anthropic extraction call. *(high)*
- **D8 — `gpt-4.1-nano` is the swappable cost-floor fallback.** True non-reasoning ($0.10 in / $0.40 out), half the input and a third the output of gpt-5.4-nano, for trivial binary/enum classification. It's legacy (dropped off the main pricing table, snapshot flagged deprecated) → pin behind an env-overridable alias. **Its cached discount is only 75%** (25% of input), not the GPT-5 family's 90% — cost models must not assume a flat 90%. *(medium)*
- **D9 — Escalate `classify`→`gpt-5.4-mini` only on low-confidence nano output (nano→mini cascade), never as the default.** 3.75× the input cost of nano; reserve for ambiguous fact/entity parsing. Log which tier handled each message to track blended cost. *(medium)*
- **D10 — Rely on OpenAI's AUTOMATIC prompt caching by making the classifier system prompt a stable prefix ≥1024 tokens.** Caching activates automatically at ≥1024 tokens with zero code and no fee; cache stays warm ~5–10 min (up to 1h). No custom caching code. *(high)*
- **D11 — Do NOT build on `gpt-5-nano`, `gpt-5.6` "Luna", or an assumed `gpt-5.5-nano`/`gpt-5.6-nano`.** `gpt-5-nano` ($0.05 in) is cheaper on paper but is legacy/delisting AND does not default `reasoning_effort` to `none` (an unset value silently inflates output-token cost). The gpt-5.6 (Sol/Terra/Luna) family is limited-preview, not GA, and "Luna" at $1/MTok is a mid-tier, not a nano replacement. Restrict build-time constants to GA models on developers.openai.com. *(high)*

### AI SDK & provider abstraction

- **D12 — Pin `ai@^7` for the greenfield build** (`ai@^7.0.11`, `@ai-sdk/anthropic@^4`, `@ai-sdk/openai@^4`, `@ai-sdk/provider-utils@^5`, `zod@^4`); **conservative alternative `ai@^6`** (`^6.0.218`, providers `@^3`) if the ~2-week-old v7 stable line feels too fresh. The API surface Baumy needs (`generateText`, `Output.object`, `tool({ inputSchema })`, `cacheControl`, `isStepCount`) is **identical in v6 and v7**, so v6→v7 is a lockfile bump, not a code change. Node **≥22** required; lock exact versions in the pnpm lockfile (SDK ships daily patches). *(medium)*
- **D13 — Use `generateText({ output: Output.object({ schema }) })` (read `.output`), NOT `generateObject`.** `generateObject`/`streamObject` are **deprecated in v6+** (still shipped & functional in v7, but writing new code on them is day-one tech debt). Same zod schema, supported forward path. *(high)*
- **D14 — Call models via provider factories (`createAnthropic`/`createOpenAI` with explicit `apiKey`), never the bare-string `'anthropic/model'` form.** The bare-string model id routes through the **Vercel AI Gateway** (separate key/billing), silently breaking the $0 direct-key requirement. Factories read `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` and hit the vendor APIs directly. *(high)*
- **D15 — Centralize every model ID in one typed constants module; never inline literals.** Dateless 4.6-gen+ IDs are pinned snapshots — appending a date suffix 404s. The DB routing table (`ai_model_config`, DR3) and env overrides (`BAUMY_*_MODEL`) let OpenAI's deprecations and role re-tuning be absorbed without a redeploy. Add a boot health-check that resolves each configured ID. *(high)*
- **D16 — Use `zod@^4.4.3` for all AI SDK schemas.** The SDK's peer range is `^3.25.76 || ^4.1.8`; v4.1.8+ is explicitly recommended to avoid TS performance issues. *(high)*

---

## Concrete design / APIs / DDL / config

### Verified Anthropic pricing (per 1M tokens — MTok) — all `confirmed` 2026-07-01

| Model | ID (alias) | Base in | Base out | Cache 5m write (1.25×) | Cache 1h write (2×) | Cache read/hit (0.1×) | Batch in | Batch out | Context | Max out |
|---|---|---|---|---|---|---|---|---|---|---|
| Opus 4.8 (`advisor`) | `claude-opus-4-8` | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 | $2.50 | $12.50 | 1M | 128K¹ |
| Opus 4.7 | `claude-opus-4-7` | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 | $2.50 | $12.50 | 1M | 128K |
| Opus 4.6 | `claude-opus-4-6` | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 | $2.50 | $12.50 | 1M | 128K |
| **Sonnet 5 intro→2026-08-31 (`assess`)** | `claude-sonnet-5` | **$2.00** | **$10.00** | $2.50 | $4.00 | **$0.20** | $1.00 | $5.00 | 1M | 128K |
| **Sonnet 5 from 2026-09-01** | `claude-sonnet-5` | **$3.00** | **$15.00** | $3.75 | $6.00 | **$0.30** | $1.50 | $7.50 | 1M | 128K |
| Sonnet 4.6 (old tokenizer) | `claude-sonnet-4-6` | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 | $1.50 | $7.50 | 1M | 128K |
| **Haiku 4.5 (old tokenizer) (`reply`)** | `claude-haiku-4-5`² | $1.00 | $5.00 | $1.25 | $2.00 | $0.10 | $0.50 | $2.50 | 200K | 64K |
| Fable 5 (above Opus; no ZDR) | `claude-fable-5` | $10.00 | $50.00 | $12.50 | $20.00 | $1.00 | $5.00 | $25.00 | 1M | 128K |

¹ 128K is the synchronous Messages API cap; the **Message Batches API** supports up to **300K** output via the `output-300k-2026-03-24` beta header (Opus 4.8/4.7/4.6, Sonnet 5, Sonnet 4.6 — **not** Fable 5).
² Haiku full dated ID: `claude-haiku-4-5-20251001`. Supports extended thinking (`budget_tokens`) but **not** adaptive thinking or the `effort` param.

**Deprecated / avoid:** Opus 4.1 (`$15/$75`, retires **2026-08-05**). Fast mode is a premium research preview (Opus 4.8 $10/$50, Opus 4.7 $30/$150 — removed 2026-07-24, disabled on Opus 4.6) and is **mutually exclusive with Batch** — do not enable.

**Universal Anthropic multipliers (stack):** cache read `0.1×` base input, 5m cache write `1.25×`, 1h cache write `2×`, Batch `0.5×` on both input & output, `inference_geo:"us"` `1.1×` all categories. **Min cacheable prefix: Opus & Haiku = 4096 tokens; Sonnet & Fable = 2048 tokens** (below the minimum the cache silently no-ops). **New tokenizer (Opus 4.7+, Sonnet 5, Fable 5) emits ~30% MORE tokens** than the old tokenizer (Sonnet 4.6, Haiku 4.5) for the same text.

### Verified OpenAI pricing (per 1M tokens — MTok) — 2026-07-01

| Model | ID (snapshot) | Base in | Cached in | Base out | Batch in | Batch out | Cached discount | Context | Reasoning? |
|---|---|---|---|---|---|---|---|---|---|
| **GPT-5.4 nano (`classify`)** | `gpt-5.4-nano` (`-2026-03-17`) | $0.20 | $0.02 | $1.25 | $0.10 | $0.625 | 90% | 400K | yes (default `none`) |
| GPT-5.4 mini (`classify` escalate) | `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 | $0.375 | $2.25 | 90% | 400K | yes |
| GPT-4.1 nano (legacy fallback) | `gpt-4.1-nano` (`-2025-04-14`) | $0.10 | $0.025 | $0.40 | $0.05 | $0.20 | **75%** | 1.05M | **no** |
| GPT-4.1 mini (legacy) | `gpt-4.1-mini` (`-2025-04-14`) | $0.40 | $0.10 | $1.60 | — | — | **75%** | 1.05M | no |
| GPT-5 nano (legacy/delisting) | `gpt-5-nano` (`-2025-08-07`) | $0.05 | $0.005 | $0.40 | — | — | 90% | 400K | yes (default **not** `none`) |
| GPT-5 mini (legacy) | `gpt-5-mini` (`-2025-08-07`) | $0.25 | $0.025 | $2.00 | — | — | 90% | 400K | yes |

**Flagship / preview (not for Baumy):** `gpt-5.5` $5/$0.50/$30; `gpt-5.6` Sol/Terra/Luna = **limited preview only**, no GA nano variant. **OpenAI caching is automatic** at prompts ≥1024 tokens (no fee, no code; TTL ~5–10min up to 1h). **Batch API = flat 50% off input & output, async ≤24h.**

### Modeled cost (derived; official pricing 2026-07-01)

- **`classify`** (`gpt-5.4-nano`, ~750 in / ~50 out): **~$0.0002/message** uncached, ~$0.0001 cached. Even 9,000 msgs/mo < **$2**. *Cannot breach budget.*
- **`reply`/`assess`/`advisor`** (~5,000 in / ~400 out, uncached): Haiku ~**$0.0070** · Sonnet 5 intro ~$0.0140 · Sonnet std/4.6 ~$0.0210 · Opus 4.8 ~$0.0350. With ~70% cached prefix: Haiku ~$0.0039 · Sonnet std ~$0.0116 · Opus ~$0.0190.
- **Monthly total, base case** (~100 msgs/day, ~50% pre-filter pass ≈ 1,500 classified/mo, ~300 grounded `reply`s/mo, 1 batched daily digest): **Haiku-default ~$2–4 · Sonnet-default ~$6–10 · Opus-default ~$9–16.** Cheap `classify` tier <$1/mo in all cases. The base case sits comfortably under the ~$15/mo cap.
- **Worst realistic case** (chatty 300 msgs/day, weak filter, Opus default ~900 replies/mo, over-retrieval, no effective caching): **~$40–50/mo** — a >10× swing driven entirely by design choices. **The hard ~$0.50/day cap (DR4) is the backstop** that converts this tail risk into a degraded-mode day rather than a runaway bill.
- **Infra** (Vercel Hobby, Neon, Inngest free tiers): **$0** → LLM tokens are 100% of variable cost.

### AI SDK versions (verified 2026-07-01)

- Core `ai`: latest **`7.0.11`** (`latest`); maintained: `ai-v6=6.0.218`, `ai-v5=5.0.209`.
- Providers track the core major: **v7 →** `@ai-sdk/anthropic@4.0.5`, `@ai-sdk/openai@4.0.5`, `@ai-sdk/provider@4.0.1`, `@ai-sdk/provider-utils@5.0.3`. **v6 →** `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`. **v5 →** `@ai-sdk/anthropic@2.0.85`, `@ai-sdk/openai@2.0.110`.
- Runtime: `engines.node >=22`; peer `zod ^3.25.76 || ^4.1.8` (zod latest `4.4.3`).

```jsonc
// package.json (v7 greenfield pin — commit the pnpm lockfile; SDK patches daily)
{
  "engines": { "node": ">=22" },
  "dependencies": {
    "ai": "^7.0.11",                 // conservative: "^6.0.218"
    "@ai-sdk/anthropic": "^4.0.5",   // conservative: "^3.0.92"
    "@ai-sdk/openai": "^4.0.5",      // conservative: "^3.0.80"
    "@ai-sdk/provider-utils": "^5.0.3",
    "zod": "^4.4.3"
  }
}
```

### Model/pricing constants module (compiled defaults; single source of truth)

```ts
// packages/ai/models.ts — never inline model IDs at call sites (D15)
// Prices per 1M tokens (MTok), USD. Verified 2026-07-01. See provider-verify.md.
// These are the COMPILED DEFAULTS; the DB `ai_model_config` table (DR3) overrides them at runtime.

export type Role = 'classify' | 'reply' | 'assess' | 'advisor';

export const MODELS = {
  // Role defaults (env-overridable; DB config table wins at runtime — DR3)
  classify: process.env.BAUMY_CLASSIFY_MODEL ?? 'gpt-5.4-nano',   // reactive triage+extract, every pre-filtered msg
  reply:    process.env.BAUMY_REPLY_MODEL    ?? 'claude-haiku-4-5', // reactive live chat; NEVER Opus (DR2)
  assess:   process.env.BAUMY_ASSESS_MODEL   ?? 'claude-sonnet-5',  // multi-fact reasoning over retrieved info
  advisor:  process.env.BAUMY_ADVISOR_MODEL  ?? 'claude-opus-4-8',  // explicit deliberate intent ONLY (write-gate)
  // classifier cascade (reactive tier)
  classifyEscalate: process.env.BAUMY_CLASSIFY_ESCALATE ?? 'gpt-5.4-mini', // low-confidence nano output only
  classifyFallback: process.env.BAUMY_CLASSIFY_FALLBACK ?? 'gpt-4.1-nano',  // swappable cost-floor
} as const satisfies Record<string, string>;

// {in, cachedIn, out, batchIn, batchOut, minCachePrefix / cacheDiscount}
export const RATES = {
  'claude-haiku-4-5': { in: 1,  cachedIn: 0.10, out: 5,  batchIn: 0.50, batchOut: 2.50, minCachePrefix: 4096 },
  'claude-sonnet-5':  { in: 2,  cachedIn: 0.20, out: 10, batchIn: 1.00, batchOut: 5.00, minCachePrefix: 2048,
                        _note: 'INTRO thru 2026-08-31; from 2026-09-01: in 3, cachedIn 0.30, out 15, batch 1.5/7.5' },
  'claude-opus-4-8':  { in: 5,  cachedIn: 0.50, out: 25, batchIn: 2.50, batchOut: 12.50, minCachePrefix: 4096 },
  'gpt-5.4-nano':     { in: 0.20, cachedIn: 0.02,  out: 1.25, batchIn: 0.10,  batchOut: 0.625, cacheDiscount: 0.90 },
  'gpt-5.4-mini':     { in: 0.75, cachedIn: 0.075, out: 4.50, batchIn: 0.375, batchOut: 2.25,  cacheDiscount: 0.90 },
  'gpt-4.1-nano':     { in: 0.10, cachedIn: 0.025, out: 0.40, batchIn: 0.05,  batchOut: 0.20,  cacheDiscount: 0.75 }, // NOT 0.90
} as const;
```

### Config-driven routing + spend cap (DDL — config surface owned here; hot-path enforcement coordinated with `llm-pipeline`)

```sql
-- ai_model_config: DB-backed role→model routing, tweakable without redeploy (DR3 / decision C).
-- Overrides the compiled MODELS defaults at runtime; the boot health-check validates each resolved id (D15).
-- Owner-only writes (never driven by untrusted group text — reuses the A5 write-gate). Always reversible via dashboard.
CREATE TABLE ai_model_config (
  role         text PRIMARY KEY,        -- 'classify' | 'reply' | 'assess' | 'advisor' | 'classify_escalate'
  model_id     text NOT NULL,           -- e.g. 'claude-haiku-4-5' (dateless alias; no date suffix — Gotcha 1)
  max_output   int  NOT NULL DEFAULT 500,
  enabled      boolean NOT NULL DEFAULT true,
  -- escalation thresholds are config-driven; exact values TBD pending real UX (DR3) — ship conservative defaults
  escalate_confidence numeric,          -- e.g. reply->assess or nano->mini trigger; NULL = role default
  updated_by   bigint,                  -- member telegram_user_id (owner-only)
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- spend_config: single-row, tweakable hard cap (DR4 / decision C).
CREATE TABLE spend_config (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),   -- singleton row
  daily_cap_usd  numeric NOT NULL DEFAULT 0.50,                 -- ~$0.50/day (~$15/mo); tweakable
  degrade_mode   text    NOT NULL DEFAULT 'capture_only',       -- 'capture_only' | 'notice' (one-line reply)
  updated_by     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- spend_day: per-Berlin-day rollup for cap checks + the member-askable spend query (DR6).
-- Fed from per-request token/cost rows (Task 12). Day boundary = Europe/Berlin (B9).
CREATE TABLE spend_day (
  day        date PRIMARY KEY,          -- Europe/Berlin calendar day
  usd        numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
// Spend gate — call BEFORE any discretionary LLM call (reply / assess / advisor). DR4.
// Reminder delivery is NEVER routed through this gate (decision C: reminders never gated).
async function spendGate(role: Role): Promise<'ok' | 'degraded'> {
  const { daily_cap_usd } = await getSpendConfig();
  const spentToday = await getSpendForBerlinDay(berlinToday());   // Europe/Berlin day boundary (B9)
  if (spentToday < daily_cap_usd) return 'ok';
  // Past cap: degrade. Cheap classify+store capture stays ON (sub-cent) so nothing is lost;
  // reply/assess/advisor are suppressed (degrade_mode='capture_only') or reduced to a one-line
  // "daily spend cap reached" notice (degrade_mode='notice'). advisor/assess never resume until under cap.
  return 'degraded';
}
// Reminders (E22) bypass spendGate entirely. In degraded mode, a reminder that would have used an LLM
// for phrasing falls back to a templated (LLM-free) string so it ALWAYS fires and notifies the group.
```

### Provider factory + call shapes (v6/v7-identical)

```ts
// packages/ai/providers.ts — direct key, NO gateway (D14). Re-resolve keys INSIDE each Inngest step.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
export const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export const openai    = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
// NEVER: model: 'anthropic/claude-sonnet-5'  <- routes through paid AI Gateway.
```

```ts
// classify — combined triage+extract, structured output (D7/D13). Do NOT use generateObject.
import { generateText, Output } from 'ai';
import { z } from 'zod';
const { output } = await generateText({
  model: openai(await resolveModel('classify')),   // DB config -> env -> compiled default (DR3)
  output: Output.object({ schema: z.object({
    memory_worthy: z.boolean(),
    is_reminder:   z.boolean(),
    needs_reply:   z.boolean(),
    confidence:    z.number(),        // drives nano->mini escalation (D9) and reply->assess routing
    extracted_facts: z.array(z.string()),
  })}),
  providerOptions: { openai: { reasoningEffort: 'none' } }, // PIN it (D7); verify exact key vs @ai-sdk/openai@4 docs
  // stable system prompt >=1024 tokens FIRST for automatic caching; per-message text LAST
  prompt,
});
// If strict JSON-schema mode errors, set per-output strictJsonSchema:false (default true in v6+).
```

```ts
// reply path (Haiku) with ephemeral caching (D5). Reactive, ZERO tools (DR5). cacheControl on the LAST prefix block.
// spendGate('reply') must return 'ok' before this call (DR4). This path can escalate to 'assess' (Sonnet)
// for grounded multi-fact reasoning, but can NEVER route to 'advisor'/Opus (DR2).
const res = await generateText({
  model: anthropic(await resolveModel('reply')),   // 'claude-haiku-4-5' by default
  messages: [
    { role: 'system', content: PERSONA_PROMPT,   // frozen; keep prefix > model min (4096 Haiku/Opus, 2048 Sonnet)
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }, // add ttl:'1h' only if reused >5min
    // retrieved-memory block (also cacheable if byte-stable) ... then per-message untrusted text AFTER the last breakpoint
  ],
  maxOutputTokens: 500, // cap output (5x input price)
  // NO tools on the reactive reply path — memory-only, exfil-safe (DR5)
});
// Cost telemetry: res.providerMetadata.anthropic.cacheReadInputTokens / cacheCreationInputTokens (verify path live — OQ1)
```

```ts
// advisor path (Opus) — explicit deliberate intent ONLY, gated by the deterministic write-gate (DR2/DR3).
// Reachable from "go research/assess X" + scheduled tasks, NOT the reactive classifier. Web-search allowed (DR5).
// spendGate('advisor') must return 'ok'; output goes only to the fixed house group.
// (Exact web-search tool verified at build — OQ11.)
```

```ts
// Tool shape (v6/v7) + multi-step control. Keep the deterministic write-gate OUTSIDE the LLM tool layer.
// Tools live ONLY on the deliberate advisor/assess path; the reactive reply path stays tool-free (DR5).
import { tool, isStepCount } from 'ai';
const t = tool({ description, inputSchema: z.object({ /* ... */ }), execute: async (a) => out });
// stopWhen: isStepCount(n) — 'stepCountIs' is a deprecated alias; default generateText is a single step.
```

### Verdict trail (verification, 2026-07-01)

Every Anthropic pricing claim below was re-fetched from official sources and returned **`confirmed`** — no corrections applied. **Re-verify at build (decision batch #7)** before locking constants:

- Opus 4.8 `$5/$25`, cache `$6.25/$10/$0.50`, batch `$2.50/$12.50`, 1M/128K → confirmed (+ 300K batch-output beta noted).
- Opus 4.7 / 4.6 identical to 4.8; Opus 4.1 `$15/$75` deprecated, retires 2026-08-05 → confirmed.
- Sonnet 5 intro `$2/$10` (→2026-08-31) then `$3/$15` → confirmed.
- Sonnet 4.6 `$3/$15`, old tokenizer → confirmed.
- Haiku 4.5 `$1/$5`, 200K/64K, extended-thinking-yes/adaptive-no/effort-no → confirmed.
- Fable 5 `$10/$50`, requires 30-day retention / no ZDR → confirmed.

Sources: `platform.claude.com/docs/en/about-claude/pricing` + `/models/overview`; `developers.openai.com/api/docs/pricing` + model/caching pages; npm dist-tags / `ai-sdk.dev` migration guides.

---

## Gotchas

1. **Dateless IDs are pinned snapshots, not evergreen.** Write `claude-sonnet-5`, `claude-opus-4-8`, `claude-sonnet-4-6` exactly — appending a date suffix (e.g. `claude-sonnet-5-2026xxxx`) **404s**. Only Haiku has a dated full ID (`claude-haiku-4-5-20251001`); its alias `claude-haiku-4-5` is fine. This applies to values stored in `ai_model_config.model_id` too — validate on write and at boot.
2. **The reactive path must be structurally incapable of reaching Opus (DR2).** Enforce it in code — the `reply` router should not have `advisor`/Opus in its candidate set at all, so a misclassification or injection can never escalate to the $25/MTok tier. A config knob that *could* point `reply`→Opus is a foot-gun; keep `advisor` reachable only behind the write-gate.
3. **The spend cap is HARD, not an alert (DR4).** Past `daily_cap_usd`, discretionary `reply`/`assess`/`advisor` calls stop (degraded mode) — this is a gate that returns before the API call, not a notification after the fact. **Reminders must bypass the gate**; forgetting to exempt them would silently suppress reminder delivery, violating decision C ("reminder delivery never gated"). Cover the exemption with a test.
4. **Cap day boundary is `Europe/Berlin`, not UTC (B9).** Rolling the daily spend on UTC would reset the cap mid-evening in Berlin. Compute "today" via the IANA `Europe/Berlin` zone (DST-aware) for both the cap check and the ledger rollup.
5. **Sonnet 5's $2/$10 is INTRODUCTORY** and auto-steps to $3/$15 on **2026-09-01** (+50% both axes, cache hit $0.20→$0.30). A budget validated in July silently grows in September. Sonnet 4.6 ($3/$15, old tokenizer) is the stable alternative for the `assess` role.
6. **Minimum cacheable prefix is model-dependent and silent-fails below threshold:** 4096 tokens (Opus, Haiku) / 2048 (Sonnet, Fable). A ~2,500-token persona prompt caches on Sonnet but **not** on Haiku/Opus — you pay full input every call while believing caching works. Assert `usage.cache_read_input_tokens > 0`.
7. **Prompt caching is a strict prefix match** — any byte change (a `datetime.now()`, a per-request UUID, non-deterministic JSON key order, a varying tool set) silently invalidates it. Keep the persona + deterministic (sorted-key) tool list first; put per-message untrusted Telegram text **after** the last `cache_control` breakpoint.
8. **Caching is a burst optimizer, not a guaranteed discount.** The 5-min TTL means one-off queries hours apart are cache misses; worse, a 1h-TTL write costs 2× base input, so enabling 1h caching on low-traffic prefixes can *increase* cost. Model the budget at **both** cached and uncached rates.
9. **The ~30% new-tokenizer inflation** (Opus 4.7+, Sonnet 5, Fable 5) makes cross-generation sticker comparisons misleading. Re-baseline with `count_tokens` against the exact target model before trusting a spreadsheet. Haiku 4.5 / Sonnet 4.6 get a double discount (lower rate + old tokenizer).
10. **Output tokens cost 5× input.** Baumy's conversational persona invites long replies — a 1,000-token Opus reply is ~$0.025 in output alone. Cap `maxOutputTokens` (~400–600, per-role in `ai_model_config`) and prompt for concision.
11. **Batch API is async-only (≤24h) and Fast-mode-incompatible.** Use it for digests/consolidation/back-processing/scheduled tasks, never the interactive `reply` path.
12. **GPT-5-family models are reasoning models** — output tokens include reasoning tokens billed at the output rate. `gpt-5.4-nano` defaults `reasoning_effort` to `none` (safe); `gpt-5-nano` does **not** — leaving it unset silently multiplies output cost. Always pin `reasoning_effort` for the `classify` role.
13. **GPT-4.1 cached discount is 75%, not 90%.** Cost models assuming a flat 90% over-estimate savings on `gpt-4.1-nano/mini` — the estimator must be generation-aware.
14. **`gpt-4.1-*` and `gpt-5-*` are drifting to legacy** (off the main pricing table, snapshot flagged deprecated) but still callable. Do not hardcode — use the `ai_model_config`/env alias layer so a deprecation is a config change, not a redeploy.
15. **Bare-string model ids route through the Vercel AI Gateway** (separate key/billing) — silently breaks the $0 constraint. Grep-guard the `'<provider>/<model>'` pattern.
16. **`generateObject`/`streamObject` are deprecated in v6+** (still compile in v7). Use `generateText({ output: Output.object() })` and read `.output` (not `.object`). Grep-guard `generateObject(`/`streamObject(`.
17. **`convertToModelMessages` became async in v6** — must be `await`ed, or a Promise silently breaks the request. **`stopWhen` only fires on steps with tool results** (a plain text `generateText` is a single step). The v6 `ToolLoopAgent` default jumped to `isStepCount(20)` — can burn Anthropic tokens on the deliberate path; set `stopWhen` explicitly.
18. **OpenAI `strictJsonSchema` defaults `true` in v6+** — a zod schema the model can't satisfy under strict mode will error; loosen the schema or set `strictJsonSchema:false` per output/tool.
19. **Reactive over-triggering is a cost bug, not just a UX one.** If Baumy replies to messages it wasn't addressed in, `reply` volume (the cost driver) balloons. The deterministic write/notify-gate that exists for prompt-injection safety *also* caps reply-tier spend and, combined with the hard cap (DR4), bounds a runaway day — same controls.
20. **Config writes to `ai_model_config`/`spend_config` are privileged (A5).** They go through the deterministic write-gate: owner = full control; trusted housemates = safe-direction changes only; untrusted group text can NEVER reconfigure routing or lift the cap (injection would otherwise mute Baumy or unbound spend). Always reversible via dashboard.
21. **Third-party pricing aggregators are unreliable** (some invented the gpt-5.6 tiers). Trust only `developers.openai.com` and `platform.claude.com`; add source URLs as comments next to rate constants.

---

## Tasks (ordered, with dependencies + estimates)

1. **Pin AI SDK + provider + zod versions; commit lockfile** — `ai@^7.0.11` (or `^6.0.218`), `@ai-sdk/anthropic@^4.0.5`, `@ai-sdk/openai@^4.0.5`, `@ai-sdk/provider-utils@^5.0.3`, `zod@^4.4.3`; `engines.node >=22`. *Depends: none. ~15m.*
2. **Create the typed model/pricing constants module** (`MODELS` role defaults + `RATES`) with env-overridable role IDs, exact dateless strings, and a comment that Sonnet 5 intro pricing ends 2026-08-31. Encode both intro and post-intro Sonnet 5 rates. *Depends: 1. ~0.5h.*
3. **Create the `ai_model_config` routing table + `resolveModel(role)` resolver** (DB config → env → compiled default; DR3) and seed the four role defaults (`classify`/`reply`/`assess`/`advisor`) + escalation entries. Owner-only writes through the write-gate. *Depends: 2. ~2–3h.*
4. **Create the provider-factory module** (`createAnthropic`/`createOpenAI` with explicit `apiKey`); re-resolve keys inside each Inngest step; never the bare-string form. Add a grep guard for `'<provider>/<model>'`. *Depends: 2. ~0.5h.*
5. **Boot health-check** that resolves every configured role → model ID (from `ai_model_config`, fail-fast), so a wrong/date-suffixed ID surfaces at startup not in production. *Depends: 3,4. ~0.5h.*
6. **Implement `classify`** — `generateText` + `Output.object`, `reasoningEffort:'none'`, combined triage+extract, small `maxOutputTokens`. Structure the system prompt as a stable ≥1024-token cacheable prefix (per-message text last). Verify the exact `reasoningEffort` option key against current `@ai-sdk/openai@4` docs. *Depends: 4. ~1–2h.*
7. **Implement `reply` (Haiku) with prompt caching, ZERO tools** — `cacheControl:{type:'ephemeral'}` on the frozen persona+memory prefix (sized above the model min), per-message text after the last breakpoint, `maxOutputTokens ~500`. No tools on this path (DR5). Assert `cache_read_input_tokens > 0` in a smoke test. *Depends: 4. ~1–2h.*
8. **Build the config-driven role router** — `classify` (reactive) → `reply` (Haiku, reactive default) → `assess` (Sonnet, grounded multi-fact reasoning) → `advisor` (Opus, explicit-deliberate-only via write-gate). **Enforce DR2 in code: the reactive `reply` candidate set excludes Opus so a misclassification can never reach `advisor`.** Escalation thresholds read from `ai_model_config` (TBD-tunable, no redeploy). This is the single biggest budget lever. *Depends: 3,7. ~1–1.5 day.*
9. **Implement the spend cap (DR4)** — `spend_config` (`daily_cap_usd` default 0.50, `degrade_mode`) + `spendGate(role)` called before every `reply`/`assess`/`advisor` call, checked against a `Europe/Berlin`-day rollup. Degraded mode keeps cheap capture on, suppresses discretionary tiers; **reminder delivery bypasses the gate entirely** (templated LLM-free fallback in degraded mode). Test the reminder exemption. *Depends: 8, spend ledger (Task 13). ~1 day.*
10. **Wire the deliberate/advisor path web-search tool (DR5)** — tool available only on `advisor`/`assess` scheduled tasks (INPUT-only; output to the fixed house group; write-gate-triggered; cap-governed). Reactive `reply` stays tool-free. Verify the exact web-search tool (maps-capable for "near us") at build. *Depends: 8. ~0.5–1 day.*
11. **Bound per-reply context** — capped top-k pgvector retrieval (~2,000-token memory budget), rolling history window (not full-thread resend), `maxOutputTokens ~400–600`. Coordinate with the storage/retrieval workstream. *Depends: 8. ~1 day.*
12. **Build the nano→mini escalation cascade** — nano emits a confidence flag; re-run only low-confidence inputs through `gpt-5.4-mini` (threshold from `ai_model_config`); log which tier handled each message. *Depends: 6. ~2h.*
13. **Add per-request token/cost logging + `spend_day` rollup + member spend query (DR6)** — log input/output/cache tokens per call (both providers) to Neon; a generation-aware cost estimator (GPT-5 cache=10%, GPT-4.1=25%, batch=50%) feeding the `spend_day` rollup that the cap reads; answer "how much have we spent this month?" from the ledger. Unit test to catch over-retrieval / Opus-overuse regressions. *Depends: 4. ~1–1.5 day.*
14. **Route async Anthropic + OpenAI work through the Batch API on Inngest** (nightly consolidation, digests, re-embed sweeps, scheduled tasks) — 50% off, poll the job row, `retries:0` (batch spends real tokens); keep interactive paths synchronous. Verify the 24h window applies to `gpt-5.4-nano`. *Depends: 2. ~3h.*
15. **Re-baseline token/cost with `count_tokens`** against `claude-sonnet-5`/`claude-haiku-4-5`/`gpt-5.4-nano` on representative prompts (captures the ~30% tokenizer inflation). Do not estimate from a chars-per-token constant. *Depends: 2. ~1h.*
16. **Verify cache-token telemetry access path** — one live `generateText` with Anthropic caching; log `providerMetadata` and `usage` to confirm where `cacheReadInputTokens`/`cacheCreationInputTokens` surface; wire the meter to the confirmed path. *Depends: 7. ~0.5h.*
17. **Build-time verification pass (decision batch #7)** — re-confirm every model ID, price, and AI-SDK field name (`reasoningEffort`, `cacheControl`, `Output.object`, `providerMetadata.*`, the web-search tool) against official Anthropic/OpenAI/ai-sdk docs before locking constants. *Depends: 2. ~1–2h.*

---

## Risks & mitigations

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **Opus (`advisor`) becomes reachable from the reactive path** (router mis-tuned, config points `reply`→Opus, or "just use the best model" instinct) → violates DR2; ~$10.5/mo on replies alone at base volume, >$30/mo chatty. | High | Structurally exclude Opus from the reactive `reply` candidate set (DR2); `advisor` only via the write-gate on explicit deliberate intent; hard daily cap (DR4) backstops; cost alert surfaces overuse. |
| R2 | **Hard spend cap suppresses reminder delivery** — if reminders route through `spendGate`, a capped day would silently drop reminders, breaking decision C ("reminders never gated"). | High | Reminders bypass `spendGate` entirely; templated LLM-free fallback phrasing in degraded mode; dedicated test asserts reminders fire past the cap. |
| R3 | **Unbounded RAG retrieval / full-history resend** — input is a direct multiplier; 2,000→8,000 tokens is 4× input cost, turning a $0.019 cached reply into a $0.055 one. Quietest way to breach budget. | High | Hard token budget on retrieved memory (~2,000, top-k capped) + rolling history window; per-request token logger catches bloat; cap converts the tail into a degraded day. |
| R4 | **Bare-string model ids route through the AI Gateway**, incurring separate cost/billing that violates the $0 constraint. | High | Enforce provider-factory calls only; grep-guard the `'<provider>/<model>'` pattern; keep API keys as sole model auth. |
| R5 | **Untrusted group text reconfigures routing or lifts the cap** (prompt injection into `ai_model_config`/`spend_config`) → mutes Baumy or unbounds spend. | High | Config writes go through the deterministic write-gate (A5): owner full control, trusted housemates safe-direction only, untrusted text never; always reversible via dashboard. |
| R6 | **Sonnet 5 intro pricing expires 2026-08-31** → +50% on the `assess` line in September, compounded by ~30% tokenizer inflation. | Med | Encode both rate sets + cutover date in constants; Inngest/calendar reminder to re-decide (Haiku permanent vs Sonnet 4.6 stable for `assess`) before the window closes. |
| R7 | **Wrong/date-suffixed model ID string** (compiled default or `ai_model_config` row) → runtime 404s only visible in production. | Med | Centralize IDs; validate on write; boot health-check resolving each configured role → ID (fail-fast). |
| R8 | **Cap day boundary computed in UTC** instead of `Europe/Berlin` → cap resets mid-evening Berlin time, letting spend overrun. | Med | Compute the daily rollup + cap check via IANA `Europe/Berlin` (DST-aware, B9); test around a DST transition. |
| R9 | **Unset `reasoning_effort` on the `classify` model** silently bills reasoning tokens at the output rate, blowing the "cheap" budget. | Med | Pin `reasoning_effort` (`none` for 5.4-nano); cap max output; cost test fails if effective output tokens exceed a bench threshold. |
| R10 | **Hardcoding legacy IDs** (`gpt-4.1-nano`/`gpt-5-nano`) that OpenAI deprecates → runtime errors for the whole memory pipeline. | Med | `ai_model_config`/env-overridable IDs + boot health-check; watch `developers.openai.com/api/docs/deprecations`. |
| R11 | **Building on the deprecated `generateObject`** creates day-one tech debt that may break in a future major. | Med | Standardize on `generateText` + `Output.object`; lint/grep guard against `generateObject(`/`streamObject(`. |
| R12 | **Copied reference/tutorial code targets an old AI SDK API** (`parameters`, `maxSteps`, `maxTokens`, `generateObject`, `stepCountIs`). | Med | Apply the v4→v5/v5→v6 rename checklist (`parameters`→`inputSchema`, `maxTokens`→`maxOutputTokens`, `maxSteps`→`stopWhen/isStepCount`, `await convertToModelMessages`). |
| R13 | **v7.0 stable is ~2 weeks old, daily patches** — regression risk for an always-on bot. | Med | Pin exact versions + lockfile; fall back to `ai@^6.0.218` (identical Baumy surface) if stability is paramount. |
| R14 | **Prompt caching silently never fires** — prefix below the 4096-tok Haiku/Opus min, sporadic traffic outside the TTL, or a silent invalidator (timestamp/UUID/unsorted JSON). Budget built on cached rates runs at full rates. | Med | Size prefix above the model min; freeze the prefix (no per-request timestamps, sorted tool keys); assert `cache_read_input_tokens > 0`; model both cached and uncached. |
| R15 | **A tool leaks onto the reactive `reply` path** (exfil surface + cost) despite DR5's memory-only rule. | Med | Keep tools only on the deliberate `advisor`/`assess` path; reactive `reply` constructed with no tools; test asserts the reactive call has an empty tool set. |
| R16 | **Chatty house + weak pre-filter** scales the *expensive* tier, not just `classify`. | Med | Aggressive deterministic pre-filter (~50% drop); reactive-only reply policy; hard cap; sample real volume in week 1. |
| R17 | **Output verbosity** — 5× input price; a runaway 1,000-token Opus reply is ~$0.025 output alone. | Low | Per-role `maxOutputTokens ~400–600`; persona prompted for concision; monitor avg output tokens. |
| R18 | **Underestimating spend** by ignoring the ~30% tokenizer inflation on the sticker rate. | Low | Base budget figures on `count_tokens` output, not sticker arithmetic. (Absolute spend is tiny at ~4 users — modeling-accuracy, not burn.) |
| R19 | **zod major mismatch** (zod v3 <3.25.76 or outside peer range) → type-inference/perf breakage. | Low | Pin `zod@^4.4.3` across all workspace packages. |
| R20 | **Trusting third-party aggregator pricing** (inconsistent/partly fabricated) bakes wrong numbers into forecasts. | Low | Source all constants only from `developers.openai.com` / `platform.claude.com`; URL comments next to each rate; build-time re-verify (Task 17). |

---

## Open questions (for the owner / to resolve at build)

> Note: the earlier "which Anthropic tier is the default?" question is **RESOLVED by decision C** — `reply`=Haiku, `assess`=Sonnet, `advisor`=Opus (explicit-only). The remaining questions are build-time verifications and tuning knobs.

1. **Cache-token telemetry access path** — confirmed the field names `cacheReadInputTokens`/`cacheCreationInputTokens` exist in `@ai-sdk/anthropic@4` types, but verify they surface at `result.providerMetadata.anthropic.*` (and/or a normalized `result.usage.*`) with one live call before wiring the cost meter (Task 16).
2. **Exact `@ai-sdk/openai@4` option key for `reasoning_effort`** (`providerOptions.openai.reasoningEffort`?) and whether it exposes an explicit `promptCacheKey`/service-tier option — grep found `reasoningEffort`/`strictJsonSchema`/`textVerbosity` but not `promptCacheKey`. Verify against current provider docs before merging Task 6 (decision batch #7).
3. **`gpt-4.1-nano` deprecation status** — the model page flagged its snapshot as deprecated but still lists pricing. Confirm on `developers.openai.com/api/docs/deprecations` whether there's a shutoff date before relying on it as the cost-floor fallback.
4. **When does OpenAI ship a GA `gpt-5.5-nano`/`gpt-5.6-nano`?** `gpt-5.6` (Sol/Terra/Luna) is preview-only now; a future 5.6-nano could reset the `classify` pick. Re-verify near launch.
5. **Batch API SLA for `gpt-5.4-nano` specifically** — confirm the ≤24h window and no per-model batch exclusions for the nano tier before building the Inngest consolidation job (Task 14).
6. **Post-2026-08-31 model policy for the `assess` role** — decide before the intro window closes: Sonnet 5 accept the step-up ($3/$15 + ~30% tokenizer inflation) vs Sonnet 4.6 (stable $3/$15, old tokenizer, no inflation). Config-tweakable, so a runtime flip, not a redeploy.
7. **Escalation thresholds are TBD pending real UX (DR3)** — the `reply`→`assess` and nano→mini confidence cut-offs, and the exact `degrade_mode` behavior members see past the cap (`capture_only` silent vs a one-line `notice`). Ship conservative defaults; tune from a one-week real-volume sample.
8. **Real message + grounded-reply volume** for this specific 4-person house — the model assumes ~100 msgs/day and ~10 grounded replies/day. A one-week sample tightens every estimate and the initial cap-headroom check.
9. **Exact web-search tool for the deliberate/advisor path (DR5)** — verify the tool (and whether "near us" needs a maps-capable search using the house location) at build; confirm it's INPUT-only with no output side-effects (decision CAP).
10. **v6→v7 additivity for the core generate/tool/providerOptions surface** — stated by the migration framing but a dedicated `migration-guide-7-0` page wasn't fetched. If choosing v7, skim it for any non-additive change touching `generateText`/`tool`/`providerOptions` before committing.
11. **Is memory extraction folded into the `classify` call or a separate call?** This spec assumes **one** nano structured-output call does triage + fact/entity extraction (a separate Anthropic extraction call per message would add cost and should be avoided). Confirm with the `llm-pipeline` owner.
