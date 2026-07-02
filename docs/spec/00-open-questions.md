# Baumy Brain — Open Questions for the Owner

> **Most of this doc is now ANSWERED.** The 🔴 BLOCKING scope/schema/product decisions the 13 section specs surfaced (dashboard, per-user binding, memory scope, proactive scope, house chat id, timezone, roster/authorization, model routing + spend cap, retention, edited-message handling, reminder execution model, web-search path, owner/tenancy, domain, scheduled tasks) have all been decided by the owner and reconciled into the section specs.
>
> **→ For every resolved question, read `00-decisions.md` (the authoritative decision log).** It supersedes the old recommendations that used to live here, and each section spec now carries a "Reconciled to `00-decisions.md`" note.
>
> What remains below is only the two categories that *can't* be answered by a decision — they need a live check or real traffic:
> - 🔵 **VERIFY** — a build-time fact-check (exact model ids/prices, SDK field names, the web-search tool, local/maps search). Not a judgment call; confirm against current official docs before locking constants (project rule / decision batch #7).
> - 🟡 **TUNABLE** — ship the seeded default, then calibrate from ~a week of real usage (decision batch #6). All are config-driven and tweakable **without a redeploy**.

---

## 🔵 VERIFY at build (facts to re-confirm before locking constants)

1. **Exact model IDs + per-MTok prices for the four decided roles** *(provider-verify.md §Verdict trail, Task 17)* — re-confirm on `platform.claude.com` / `developers.openai.com`. Dateless aliases are pinned snapshots; **appending a date suffix 404s**.
   - `classify` = `gpt-5.4-nano` ($0.20 in / $0.02 cached / $1.25 out; `reasoning_effort` default `none` — pin it)
   - `reply` = `claude-haiku-4-5` ($1/$5; old tokenizer) — HARD RULE: never routes to Opus
   - `assess` = `claude-sonnet-5` (**intro $2/$10 through 2026-08-31, then $3/$15**)
   - `advisor` = `claude-opus-4-8` ($5/$25; rejects `temperature`/`top_p`/`top_k`)
   - cascade: `classify`→`gpt-5.4-mini`; cost-floor fallback `gpt-4.1-nano` (**cached discount 75%, not 90%**); avoid `gpt-5-nano` (no `none` default) and the preview `gpt-5.6` family.
2. **Embedding model + dimension** *(memory-core.md D6, Task 4)* — `text-embedding-3-small` @ **1536** (a one-way door once rows are HNSW-indexed; 3-large @3072 exceeds pgvector's 2000 cap). Confirm the exact AI-SDK method name vs the installed `@ai-sdk/openai` before the schema freeze.
3. **The web-search tool** *(web-search.md A1/A4, OQ4)* — default = the **Anthropic `web_search` server tool** (server-executed, built-in citations, no new egress/key). Confirm: tool **version string** per model (`web_search_20260209` on Opus 4.8/Sonnet 5, else `web_search_20250305`), the **`@ai-sdk/anthropic@4` export name** (`anthropic.tools.webSearch_20260209`), the **price** (~$10 / 1,000 searches) and whether result tokens bill as standard input. `web_fetch` stays **OFF** in v1 (conversation-URL zero-click exfil).
4. **Local / "near us" search** *(web-search.md A2/A3, OQ2)* — v1 = city-level `user_location` bias (`Berlin`/`DE`), **not** a places/maps API (no distances/hours). Verify whether the house's real "near us" queries need maps-grade data; if so it's an additive INPUT-only provider (Brave/Tavily) later, never a v1 rewrite.
5. **AI-SDK version pin + field names** *(provider-verify.md D12–D16, OQ1/OQ2/OQ10)* — pin `ai@^7.0.11` (conservative `^6.0.218`), `@ai-sdk/anthropic@^4`, `@ai-sdk/openai@^4`, `zod@^4.4.x`, node ≥22; commit the lockfile. Against the installed types confirm: `providerOptions.openai.reasoningEffort`; `providerOptions.anthropic.cacheControl`; `generateText({ output: Output.object() })` (read `.output` — `generateObject` is deprecated); the cache-telemetry path `result.providerMetadata.anthropic.cacheReadInputTokens` / `cacheCreationInputTokens`; `isStepCount` vs the deprecated `stepCountIs`.
6. **SKU / infra freshness** *(provider-verify.md OQ3–5)* — `gpt-4.1-nano` deprecation shutoff date; whether a GA `gpt-5.5-nano`/`gpt-5.6-nano` has shipped (would reset the `classify` pick); the Batch API ≤24h SLA applies to `gpt-5.4-nano`. Confirm the live free-tier limits still hold (Inngest 50k exec/mo + 300s `maxDuration`, Neon pgvector ≥0.8, Vercel region = Neon region).

## 🟡 TUNABLE (ship the seeded default, calibrate from ~a week of real traffic)

1. **Classifier confidence gates** *(llm-pipeline.md D14)* — seed `gate 0.5 / storeActive 0.6 / storePending 0.4 / escalate 0.7 / reminderDm 0.8`, and auto-answer `response_policy.confidence_threshold 0.72`. Config constants; ship keep/drop/lane counters and tune precision/recall from `ingest_audit`.
2. **Nudge caps + proactive floors** *(proactive.md OQ3/OQ1, `notify_prefs` defaults)* — group `daily_cap 5`/day, `min_gap_sec ~90 min`, `min_confidence 0.75`; quiet-hours **22:00–08:00** is a placeholder — confirm the real window. Log scores for a week, then tighten/relax.
3. **Digest defaults** *(proactive.md OQ4 + scheduled-tasks.md — cadence is settable on the fly)* — seeded mid-week (`Wed 18:00 Europe/Berlin`) + end-of-week (`Sun 17:00`); decide whether the daily `08:00` fatigue-sink ships default-on or opt-in, and the max items before overflow rolls into the next digest.
4. **Spend-cap degrade behavior + escalation thresholds** *(provider-verify.md DR3/DR4, OQ7)* — `daily_cap_usd 0.50` is decided; still to tune: `degrade_mode` = `capture_only` (silent) vs `notice` (one-line), and the `reply`→`assess` / nano→mini confidence cut-offs. (Reminder delivery is never gated — decided, not tunable.)
5. **Deliberative / web-search budget** *(web-search.md OQ3/OQ5, scheduled-tasks.md OQ3/OQ4)* — per-run `max_uses 5`, `maxOutputTokens ~900`, a per-member research rate-limit, and a deliberative slice of the daily cap; plus scheduled-task backstops `DEFAULT_UNTIL_DAYS 90` / `MAX_ACTIVE ~20` / dispatch tick `*/15` vs hourly. Degraded-mode UX for a deferred research request (silent vs "capped today, will check tomorrow" vs auto-retry).
6. **Real house message volume** *(provider-verify.md OQ8, dev-test-obs.md)* — every cost/quota/cap-headroom estimate assumes ~100 msgs/day (~10 grounded replies/day). A one-week sample from the live group tightens all of them.

---

### The short list — the only things that block or need calibration
- **Before locking constants:** VERIFY 1 (model ids/prices) · 2 (embedding model+dim) · 3 (web-search tool) · 5 (AI-SDK field names).
- **After a week of traffic:** TUNABLE 1 (confidence gates) · 2 (nudge caps) · 3 (digest defaults).
- **Everything else is decided — see `00-decisions.md`.**
