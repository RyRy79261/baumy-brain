# Baumy Brain — Master Build Spec

> A private Telegram **house-management secretary** for a ~4-person **creative space / friends'
> event headquarters** — a household of guests staying over, friends running events out of the house
> as venue/HQ, shopping runs for builds and supplies, and open-ended, **deliberately unstructured**
> coordination ("no distinct structure yet"). Baumy behaves like a **well-trained house secretary for
> the group**: conversational, remembers what the house was told (attributing who said it), answers the
> house questions it can ground, runs the errands it's scheduled to — and **never** treats the group
> chat as a source of commands. It is the **group's custodial tool, not anyone's personal PA.** This is
> the authoritative top-level spec; the 15 section docs (`architecture`, `telegram`, `memory-core`,
> `llm-pipeline`, `provider-verify`, `inngest`, `security`, `auth-identity`, `proactive`, `prompt-mgmt`,
> `data`, `dev-test-obs`, `product`, `scheduled-tasks`, `web-search`) hold the build-ready detail, and
> the sibling masters (`00-task-graph`, `00-risk-register`, `00-open-questions`, `00-rename-map`) hold
> the execution plan. **The owner decision log `00-decisions.md` is authoritative and OVERRIDES any
> older text wherever they differ.** Reconciled to the decision log; platform limits verified against
> current official sources as of **2026-07-02**.

## TL;DR

- **Build, don't fork.** Nothing on the market combines a provider-agnostic LLM + persistent house
  memory + proactive Telegram digests + user-defined scheduled tasks on a $0 stack. We build fresh,
  **lifting the skeleton from camp-404** (Next.js app, Better Auth, dual-driver Drizzle/Neon, Telegram
  webhook shell, Inngest patterns from ops-board) and **clean-room renaming everything** (`00-rename-map.md`).
- **House-management tool, not a personal PA.** Memory is **one shared house pool, author-attributed**
  — no per-user private lane, no `visibility`/`owner_user_id`, **no memory RLS**. Baumy can answer
  "what did Tom say about the landlord?" and cite who/when. Intentional and cost-driven: the owner funds
  a house helper, not four personal secretaries. Reminders are **house-scoped and delivered to the group.**
- **Memory-first, not schema-first.** The database is invisible plumbing. There are no
  `guests`/`events`/`shopping` tables — just a domain-neutral substrate (entities / facts / edges + an
  embedded evidence layer) where "domain" is emergent from free-text labels + vector search. A new domain
  (3D printing, a sink rebuild, a self-run beer shop) is a new *string*, **zero schema migration**.
- **Dual retention.** Baumy keeps **both** every message **verbatim** (evidence/quote layer + a
  **bot-queryable transcript** that works around Telegram's no-scrollback limit — it searches its *own*
  copy) **and** a **derived knowledge graph** (bitemporal + provenance). Both are embedded so semantic
  search finds a relevant message even when extraction missed structuring it.
- **Reactive vs deliberative firewall — the core cost/security invariant.** The **reactive** reply path
  is cheap, spend-capped, **memory-only, zero-tools, and can NEVER invoke Opus**. Power lives on the
  **deliberative** path (on-demand audits + scheduled tasks), which alone may reach the advisor model and
  the **web-search tool** — and only from **explicit deliberate intent**, never a misclassified message.
- **Dashboard in v1, Telegram-native login.** A `(private)/admin` console behind **self-hosted Better
  Auth (session layer only)**; identity is the Telegram user. A member DMs `/dashboard` → Baumy issues a
  one-time, short-TTL, single-use signed **magic link**. No Google OAuth, no email, no login widget.
- **$0 infrastructure.** Vercel Hobby + Neon Free + Inngest Free; spend is LLM tokens only (~$2–4/mo at
  4-user scale), under a **hard ~$0.50/day (~$15/mo) cap** with a degraded mode — **reminder delivery is
  never gated.** **All scheduled/async work runs on Inngest — no Vercel cron.**
- **The whole architecture is one idea:** *Telegram privacy mode is OFF, so every group message is
  untrusted, attacker-controlled input.* Therefore the LLM only ever **proposes**; deterministic code
  **disposes**; every effect is templated, tier-clamped, and destination-fixed.

## Target experience

- **You never see the database.** You talk to Baumy in the house group; it remembers, recalls (citing
  who said it and when), reminds the group, and runs the recurring lookups you ask for — like a competent
  house secretary. There are no forms and no categories.
- **It answers the house's questions.** Say "when's Marta getting here?" or "what's the door code?" and
  Baumy auto-answers when it can ground a confident reply — especially scheduling + info lookups. "If it
  can answer, it should." A `response_policy` (categories, confidence threshold, muted topics, global
  on/off) keeps it from becoming noisy, and the house can **tune it conversationally** (owner: any change;
  a housemate: reduce-noise only) — safe from injection.
- **Author-attributed recall, honest misses.** "What did Theo say about the shoot budget?" filters/boosts
  by the named person and quotes provenance. If Baumy has nothing, it says *"nothing on file"* and offers
  to remember — it never invents. It can even quote its own **verbatim transcript** for text it never
  structured.
- **Reminders that actually fire, to the group.** "Let us know a week before Marta lands" → a
  house-scoped reminder delivered to the group, fired within ±1 minute exactly once, even weeks out or
  anchored to a dated event (re-anchored if the date is later corrected).
- **Deliberate errands you schedule.** "@Baumy every week until we're done, find hardware shops + deals
  near us for the sink rebuild" → a scheduled task that runs on the heavier model **with web search** and
  reports to the group. Digests are just a built-in instance (cadence settable on the fly).
- **A dashboard when you need one.** DM `/dashboard` for a one-time magic link into the memory browser,
  member/reminder/scheduled-task management, response-policy + prompt editing, and cost/usage.

## Locked stack

| Layer | Choice | Notes |
|-------|--------|-------|
| App | **Next.js 16 on Vercel Hobby ($0)** | App Router; single app (no monorepo); `{"fluid":true}`, `maxDuration` 300s (webhook 15s); **no Vercel cron** |
| DB | **Neon Postgres + Drizzle + pgvector** | dual-driver (neon-http reads / neon-serverless txns + row-locking); migrations via `DATABASE_URL_UNPOOLED`; HNSW `vector(1536)` |
| Async/scheduled | **Inngest Free** | 50k exec/mo, 7-day sleep cap, 5 concurrency; cron + `sleepUntil`; reminders, scheduled tasks, digests, sweeps |
| LLM | **Vercel AI SDK (`ai@^7`)** | four config-driven roles: `classify`=OpenAI **nano**, `reply`=**Haiku**, `assess`=**Sonnet**, `advisor`=**Opus** (explicit-only); embeddings `text-embedding-3-small` (1536) |
| Web search | **Deliberative path only** | Anthropic `web_search` server tool (default; no extra egress); INPUT-only; verify tool/version + SDK export at build |
| Auth / dashboard | **Dashboard IN v1** | self-hosted **Better Auth = session layer only**; **Telegram bot-DM magic link** identity; `(private)/admin`; `proxy.ts` matcher `['/admin/:path*','/api/auth/:path*']` (machine endpoints excluded). No Google OAuth / email / widget |
| Crypto | **App-side AES-GCM** | `secure_value`-flagged facts encrypted with `BAUMY_ENCRYPTION_KEY` before write; a DB dump alone is useless |

## System architecture

```
                              ┌────────────────────────── Vercel Hobby (Next.js 16) ──────────────────────────┐
   Telegram  ── webhook ──▶   │  POST /api/telegram/webhook   (nodejs, maxDuration 15, fast path, NO AI)       │
   (privacy OFF,             │    1 verify X-Telegram secret (timingSafeEqual, pre-parse)                     │
    reads ALL msgs)          │    2 Zod-parse · structural gate (in-scope: house group OR known-member DM)    │
                              │    3 persist verbatim · inngest.send(id=tg:update:<update_id>) → 200 fast      │
                              │                                                                                │
   Housemate DM /dashboard    │  /api/auth/[...all]  (Better Auth, session layer)   /admin/**  (dashboard)     │
        (magic link) ─────────┼─▶ /admin/login?token=…  (one-time, single-use, gated on can_access_dashboard) │
                              └───────────────┬────────────────────────────────────────────────────────────┘
                                              │ events
                    ┌─────────────────────────▼──────────────────────────────── Inngest (durable steps) ──────┐
   ┌ REACTIVE (cheap, capped, tool-less, NEVER Opus) ───────────────────────────────────────────────────────┐ │
   │  ingest-message: pre-filter → nano classify+extract → write-gate → memory write                        │ │
   │                  → auto-answer (Haiku, memory-only, response_policy-gated) / reminder mgmt              │ │
   └───────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
   ┌ DELIBERATIVE (explicit intent only; Sonnet/Opus + WEB SEARCH; input-only; out → house group) ──────────┐ │
   │  run-deliberation (on-demand audit) · run-scheduled-tasks (cron scanner; digests are a built-in row)   │ │
   └───────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
   │  arm-reminders (daily) → fire-due-reminders (sleepUntil → atomic claim → send to GROUP) + sweeper       │ │
   │  event-surfacing scan (dated facts) · consolidate/decay · cost-digest · kill-switch                     │ │
                    └─────────────────────────┬──────────────────────────────────────────────────────────────┘
                                              │  reads/writes (provenance + trust + bitemporal + author + group_id)
                    ┌─────────────────────────▼─────────── Neon Postgres + pgvector ─────────────────────────┐
                    │  source_messages(verbatim) · memory_items+embeddings · entities · facts(bitemporal,     │
                    │  author, event_at, is_secure→encrypted) · reminder · scheduled_tasks · response_policy ·│
                    │  members · house · dashboard_login_tokens · ai_model_config · prompts · spend_ledger ·   │
                    │  audit_log · telegram_updates(dedupe)                                                    │
                    └────────────────────────────────────────────────────────────────────────────────────────┘
```

## Data flow

**Ingest (message → memory).**
```
group message → webhook (verify, structural gate, persist verbatim, 200) → inngest event (id=update_id)
  → pre-filter (regex/keyword, drops most chatter)
  → nano classify+extract  (ONE step; output is a bounded schema = the injection firewall)
  → deterministic WRITE-GATE (origin × requester-tier × directedness; trust from the envelope, never text)
  → memory write: derived facts/entities/edges (author, event_at, secure→encrypted) + evidence embedding
                  (group text → trust='untrusted'/quarantined; can never supersede a trusted fact)
```
**Reactive reply / auto-answer (mention, DM-command, or a groundable house question).**
```
addressed OR house-relevant question → embed query → pgvector top-k over facts AND verbatim messages
  → recency/entity re-rank + author filter/boost + similarity floor + response_policy gate
  → grounded prompt (retrieved rows as DATA) → Haiku (memory-only, ZERO tools, NEVER Opus)
  → sendToHouse (fixed dest, no link preview)   |   honest-miss if nothing retrieved (never fabricate)
```
**Deliberative (on-demand audit / scheduled task — explicit intent only).**
```
directed "go check/research X" OR scheduled_tasks cron → trust check → Inngest job
  → assess (Sonnet) / advisor (Opus) + WEB SEARCH (input-only, source-allow-listed citations)
  → spend-cap gate (degraded past cap) → sendToHouse (fixed dest ONLY)
```
**Reminder (house-scoped, delivered to the GROUP).**
```
directed create (absolute | relative | event-anchored) → reminder row → daily-arm cron (≤7-day window)
  → sleepUntil(due_at) → atomic scheduled→sent claim → send to BAUMY_HOUSE_CHAT_ID
  (catch-up sweeper "heartbeat" re-anchors event reminders on date correction; onFailure reaper; NEVER cap-gated)
```
**Proactive (digest / event surfacing).**
```
scheduled task (digest is a built-in instance) + dated-event scan (~1wk ahead)
  → compose grounded ONLY on retrieved rows (empty slots stated as empty) → house group; conservative nudges
```

## The security spine (the through-line)

Every top-tier risk is the same idea from a different angle, so it's mitigated **structurally, once**:
1. **Untrusted input never authorizes a privileged effect.** The LLM emits data or a reply — never a
   command. All authz/destination values come from the authenticated Telegram envelope.
2. **Deterministic write-gate** (`@baumy/core`, pure, 100% branch-covered, default-deny) intersects the
   classifier's proposals with an allowed-action set keyed on **origin × requester-tier × directedness**.
   Membership grants *usage* (query, ask for a reminder/task); the dangerous surface — **config writes,
   response-policy reconfiguration, tool use, model escalation, exfiltration** — is unreachable from
   untrusted or un-directed group text. Config changes are owner-tier or **reduce-noise-only** and always
   reversible in the dashboard.
3. **Reactive/deliberative firewall.** The reactive reply path resolves only `classify`+`reply`, has
   **zero tools**, and is **structurally clamped so it can NEVER invoke Opus** (`resolveModel` clamps a
   reactive task back to its safe default). Web search + advisor are reachable only from explicit
   deliberate intent, never from a misclassified message (cost + exfil control).
4. **Fixed send destination.** Outbound targets a **closed set of server-known chat_ids** — the fixed
   `BAUMY_HOUSE_CHAT_ID`, or a dashboard-eligible member's own DM for the magic link — **never** a
   chat_id parsed from message content. Web search is **INPUT-only**; output goes only to the house group;
   link previews disabled; citation URLs source-allow-listed, model-fabricated URLs defanged.
5. **Trust is code-derived, never LLM-judged.** Group-sourced memory is retrieval-only and can never
   supersede a trusted fact (contradiction resolution is recency-wins **only if** `new.trust ≥ existing`).
   Secure values (door/wifi/bank) are **encrypted app-side**, answered on request to a member, **never
   volunteered, never in digests/broadcasts.**
6. **Fail closed everywhere** — empty scope denies; webhook spoofing rejected pre-parse (wrong secret →
   401/403, zero processing); idempotent on `update_id` (Inngest event id + `ON CONFLICT DO NOTHING`);
   the dashboard magic link is one-time, short-TTL, single-use, signed, bound to `telegram_user_id`,
   consumed atomically.

## Memory-first design (dual retention, shared + author-attributed)

- **Domain-neutral substrate**: `entities` (any noun) · `facts`/edges (any atomic statement, bitemporal
  + provenance + **author** + optional `event_at`/`recurrence`) · `memory_items`+`memory_embeddings` (the
  always-embedded evidence layer). Free-text `entity_type`/`predicate`/`memory_type` — **never pgEnum**.
- **Dual retention (D17).** Keep **both** the full **verbatim transcript** (`source_messages`, retained
  forever — the evidence/quote layer and a bot-queryable scrollback of Baumy's own copy) **and** the
  **derived knowledge graph**. **Embed both** so semantic search hits a relevant message even when
  extraction missed structuring it. This dual pgvector + relational-graph layer (both in Postgres) is the
  **ceiling of fancy** — no dedicated graph DB (Neo4j) / heavy GraphRAG at 4-person scale.
- **One shared house pool, author-attributed (A3/A3b).** No per-user private memory, no `visibility`, no
  RLS. Every row carries `author_tg_id → member → name`; retrieval can filter/boost by a named person.
  Privacy is a **discretion behavior** (soft-redaction via the sensitivity scanner on public replies), not
  a storage partition. **Members are auto-discovered** from group activity (membership IS the roster).
- **mem0's two-phase algorithm, self-implemented**: extract candidate facts → embed → pgvector similarity
  → LLM decides ADD/UPDATE/DELETE/NOOP with **soft-supersede** (never destructive), **trust-gated** so a
  planted note can't overwrite a true owner fact.
- **`group_id` origin-scope column on every memory-bearing row** — constant in v1 (single house), so a
  second group / multi-house is an additive flip, not a rewrite. Multi-tenant SaaS is a **non-goal**.
- **Graduation rule** (the explicit boundary): a domain stays soft until it needs a scheduled action, a
  uniqueness invariant, numeric balances, or transactional consistency — then it earns a real table.
  **Reminders and scheduled tasks are the only two graduated features in v1** (each with a real `status`
  pgEnum); `response_policy` is the config exception.

## Staged rollout & acceptance benchmarks

Stages 0–5 are **all v1**; the v1.1+ deferrals sit behind a formal v1 Definition of Done.

| Stage | Scope | Acceptance benchmark |
|-------|-------|----------------------|
| **0 — Prove the pipe** | Webhook verify+dedupe+persist-verbatim+echo; privacy OFF | Bot sees ordinary chatter; wrong secret → 401 zero-processing; ACK p95 ≤3s; 100% sends to house chat |
| **1 — Ingest + classify + gate** | Pre-filter → nano classify → deterministic write-gate; log only | ≥20-case injection corpus (incl. config-injection + "mute yourself" + Opus/tool-escalation) 100% blocked in CI; un-directed text triggers no privileged action; Inngest runs < 50k/mo |
| **2 — Dual memory + grounded reply + auto-answer** | Verbatim + derived graph (both embedded, author-attributed, secure-value encrypted); retrieval; auto-answer gated by `response_policy` | Store-then-recall ≥90% w/ provenance + attribution; correct with raw Telegram history withheld (verbatim fallback); never fabricates a miss; stays silent when policy-muted/below threshold; secret never in a digest |
| **3 — Reminders + event surfacing** | House-scoped reminders (absolute/relative/event); daily-arm+sleepUntil+sweeper; dated-event scan | Fires ±1 min exactly-once incl. 30-day-out + event-anchored; corrected event date re-anchors before fire; cancelled reminder does not fire |
| **4 — Deliberative path + response policy** | On-demand audits + `scheduled_tasks` (Sonnet/Opus + web search, input-only, out→group, cancellable/expiry); digest as a built-in scheduled task; `response_policy` self-config | Deliberate task uses web search + heavier model; reactive path proven tool-less + never-Opus; scheduled task reports to group + cancels; self-config injection blocked, owner change reversible; spend cap degrades but never gates reminders |
| **5 — Dashboard + admin + hardening** | Telegram-native magic-link dashboard; owner-inviter capture; kill-switch; spend cap + cost/usage; evals | Only `can_access_dashboard` members get a single-use link; owner-only enforced; audit per privileged action; within all free ceilings; red-team suite green |
| **v1.1+ (deferred)** | Anonymous relay/announce; condition-based watches; multi-owner; message-reactions; multi-group/tenant | Behind the v1 DoD |

**v1 non-goals:** per-user private memory / private DM lane; personal-PA reminders/tasks; "my personal
assistant" framing; multi-tenant SaaS / hosting other houses' data; dedicated graph DB / heavy GraphRAG;
Google OAuth / email magic-links; anonymous relay; condition-based watches; multi-owner; message-reactions.

## Cost posture

- Infra **$0** (Hobby / Neon-free / Inngest-free); the only spend is LLM tokens. Expected **~$2–4/mo** at
  4-user scale — token-bound, not infra-bound.
- **The reactive-vs-deliberative firewall is the budget.** Per-message classification (privacy OFF ⇒
  every message hits the pipeline) runs on **OpenAI nano** (~$0.0002/msg — mathematically incapable of
  breaching budget). Live replies/auto-answers run **Haiku** (~$0.007/reply) and **can never drift to
  Opus** (DR2). `assess` (Sonnet) is reachable only for grounded multi-fact reasoning; `advisor` (Opus) +
  web search only via explicit deliberate intent.
- **Hard daily spend cap ~$0.50/day (~$15/mo), config-tweakable**, checked before every discretionary
  `reply`/`assess`/`advisor` call against a `Europe/Berlin`-day rollup in a durable Postgres spend ledger.
  Past the cap → **degraded mode** (cheap classify+store continues; discretionary replies/research
  suppressed or one-lined). **Reminder delivery is NEVER gated** — it bypasses the cap and falls back to
  templated phrasing if needed.
- Guardrails: deterministic pre-filter (~50% drop) · bounded RAG context (~2k tokens) · prompt caching
  (burst optimizer) · Batch API (flat 50%) for all async/scheduled work · scheduled tasks bounded
  (per-task run cap + expiry + `max_uses` web-search cap). A **member-askable spend query** ("how much
  this month?") reads the ledger. Denial-of-wallet (register #7) is the thing to watch.

## Owner, tenancy & identity

- **Owner = whoever invites the bot to the group** (captured from the `my_chat_member` "added" event;
  `BAUMY_OWNER_ID` env override) — no bootstrap-secret dance, no leakable root credential.
- **Membership is the roster.** Trust boundary = `chat.id === BAUMY_HOUSE_CHAT_ID`; members are
  auto-discovered from first group message (no `/bind`); leaving deactivates the member (`is_active`)
  while their contributed memory remains. **All members have equal usage rights** (contribute, query, ask
  for reminders/tasks); the **owner additionally** holds admin/config/model-routing/spend/kill-switch/keys.
- **Single-tenant.** Baumy hosts only this house's data; others self-host by forking. `group_id`
  origin-scope is kept as cheap hygiene (e.g. the owner running a second group) — multi-tenant SaaS is a
  non-goal.
- **Dashboard login is Telegram-native.** DM `/dashboard` (gated on `can_access_dashboard`) → one-time,
  short-TTL, single-use signed token bound to `telegram_user_id` → `/admin/login` mints a **Better Auth
  session (session layer only)**. Only dashboard-eligible members `/start` a DM (to capture `dm_chat_id`;
  a bot cannot initiate a DM). No OAuth/email/widget.

## What needs *you* before build starts

The interview decision set is **complete for v1 scope** (`00-decisions.md`); the residuals are
**build-time tuning / verify-at-build**, not open product questions:
- **Model tier thresholds** (`classify → reply → assess → advisor`) — ship conservative defaults, tune
  from real UX.
- **Exact model IDs / prices + AI-SDK field names** — verified at build by the provider-selection
  workstream; this spec pins only the four-tier routing shape (`classify`=nano, `reply`=Haiku,
  `assess`=Sonnet, `advisor`=Opus).
- **Web-search tool selection** — Anthropic `web_search` server tool is the default; confirm the exact
  tool version + `@ai-sdk/anthropic@4` export at build, and whether "near us" (Berlin) ever needs a
  maps-capable provider (deferred).
- **Auto-answer defaults** — initial `enabled_categories`, `confidence_threshold`, `muted_topics`, and
  the reduce-noise boundary a non-owner may self-configure.
- **Digest cadence** — confirm midweek + end-of-week defaults (settable on the fly).
- **House operational params to pin:** `BAUMY_HOUSE_CHAT_ID`, `BAUMY_TZ = Europe/Berlin` (confirmed), and
  whether the `BAUMY_OWNER_ID` override is needed or inviter-capture suffices.
- **Env inventory:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `BAUMY_HOUSE_CHAT_ID`, `BAUMY_TZ`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DATABASE_URL`(+`_UNPOOLED`), `BAUMY_ENCRYPTION_KEY`,
  `BETTER_AUTH_URL`/`BETTER_AUTH_SECRET`/`BAUMY_SESSION_SECRET`, `BAUMY_PUBLIC_URL`; optional
  `BAUMY_OWNER_ID` and a `WEB_SEARCH_API_KEY` only if an external search provider is chosen. **Removed vs
  the old plan:** `BAUMY_BOOTSTRAP_SECRET`, `BAUMY_HOUSEMATE_IDS`, `GOOGLE_*`. Model IDs and the spend cap
  are **config-driven, not env**.
