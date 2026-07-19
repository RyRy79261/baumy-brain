# Overview prompt — building a full-permission "second brain" AI over WhatsApp/Telegram

> **What this is:** a self-contained briefing you can paste into an AI assistant (or just read) to
> kick off building a personal second-brain system. It distils the architecture, memory design,
> hard-won security rules, and research findings from **Baumy Brain** — a working Telegram
> house-secretary bot with a trust-gated, bitemporal, graph-structured memory — and maps them onto
> the *single-user, full-permission* variant: a private brain you talk to over WhatsApp or Telegram
> that remembers everything you tell it and answers from that memory.

---

## The prompt

You are helping me design and build a **personal second-brain AI**: a chat bot (WhatsApp or
Telegram) that I message all day — notes, facts, ideas, links, "remind me", questions — and that
captures everything into durable structured memory, answers questions grounded in that memory, and
proactively surfaces reminders. Single user (me), full permission: unlike a multi-user group bot, I
am the trusted principal for my own brain. Use the reference architecture below — it is running in
production in a comparable system (a Telegram house-management secretary) and its memory pipeline
has been empirically ablated — and adapt it where the single-user assumption simplifies things.
Flag anywhere you deviate from it and why.

---

## 1. Reference stack (what the working system runs on)

| Layer | Choice | Why |
| --- | --- | --- |
| App / API | **Next.js (App Router) + TypeScript on Vercel** | One deployable for webhook, background jobs entry, and an admin dashboard. Any serverless HTTP framework works; the shape matters more than the brand. |
| Async / background | **Inngest** | The chat webhook is *fast-ack only* (verify secret → enqueue → 200). ALL real work — classify, capture, extract, reply, reminders, reflection crons — runs in durable background functions with retries. This is load-bearing: chat platforms retry webhooks and LLM pipelines are slow/flaky. |
| Database | **Postgres (Neon) + Drizzle ORM + pgvector + pg_trgm** | One database holds evidence, the fact graph, embeddings (HNSW index), fuzzy text matching, reminders, sessions, audit log. No separate vector DB, no graph DB — recursive CTEs do bounded graph traversal fine. |
| LLM | **Anthropic only, tiered by role** | Cheap fast model (Haiku) for classify/route *only*; mid model (Sonnet) for reply + all memory ops (extract/expand/rerank/reflect/forget); big model (Opus) as escalation when the reply path signals it needs more. One vendor keeps prompt behavior, tool-calling, and safety posture consistent. |
| Embeddings | **Voyage `voyage-3.5-lite`, 512-dim** | Plain `fetch`, no SDK. Store the model name on every embedding row and filter retrieval to the current model — never cosine-compare across embedding spaces. Keep a deterministic lexical-hash embedder for offline tests only. |
| Tests | **Vitest + PGlite** (in-memory Postgres w/ pgvector + pg_trgm) + a real-Postgres e2e via testcontainers | The whole memory pipeline is testable offline and deterministically: LLM + chat calls mocked, deterministic test embedder. The e2e catches migration/SQL bugs the in-memory stand-in can't. |
| Auth (dashboard) | **Chat-native magic link** — DM the bot `/dashboard` → one-time link → signed HMAC session cookie | The chat platform already authenticated you; don't bolt on a second identity system. Re-check authorization against the DB on every request, never trust the cookie's claims cache. |
| Secrets at rest | **AES-256-GCM** for sensitive values (wifi, door codes, bank refs) | Store only a non-secret descriptor + ciphertext; embed the descriptor, never the secret; decrypt only to answer a direct request, never in digests/summaries. |

**Why Postgres and not a markdown/Obsidian vault** (this question always comes up): a vault is a
*document* store — the graph is implied by wikilinks scattered through text, so every "what links to
X", multi-hop path, or hub query means re-scanning files, and there's no native semantic layer. The
answer is a **two-layer split**: an *evidence layer* (the captured notes, original wording,
provenance — the "markdown equivalent") plus a *derived, indexed query engine* (entities + facts +
edges, vector index, trigram index, bounded graph traversal). Markdown can be a rendered *view*;
the indexed graph is the *engine*. Build the engine first.

## 2. The memory system (the crown jewels — copy this shape)

The pipeline, message-in to answer-out:

1. **Classify** (cheapest model): route the message — note to capture? question? reminder?
   list op? forget request? — and pick a reply tier (shallow vs deep). Routing/triage ONLY;
   never let the classifier itself cause a privileged effect.
2. **Capture** — store the raw message as an **evidence item** with its embedding, author,
   timestamp, origin. Near-verbatim restatements (≥0.97 cosine) *consolidate* onto the original
   (salience bump) instead of duplicating.
3. **Extract facts** — distil `{subject, predicate, object}` triples out of the evidence.
   **No fact ceiling**: a dense message paginates (re-ask until a short page drains) rather than
   silently truncating. Every hot-path structured-output call is *best-effort*: a malformed LLM
   response degrades to a safe default (empty extraction, text-fallback reply) — one LLM hiccup
   must never crash-loop ingest.
4. **Entity resolution** — normalize → exact match → alias → *conservative* fuzzy merge
   (`strict_word_similarity`). **Write side is precision-first**: a bad merge corrupts the graph
   ("Marta" ≠ "Marco"); under-merging is recoverable at read time by fuzzing generously. This
   asymmetry is the single most load-bearing design rule in the whole system.
5. **Reconcile** — the fact graph is **bitemporal** (valid-time + transaction-time): a new fact
   *supersedes* the incumbent rather than overwriting it; superseded facts stay queryable as
   history ("you used to say the bins went out Friday"). Every fact carries **lineage**: the
   evidence item it came from (with author) and the prior fact it follows from — so you can chain
   a progression across time and people.
6. **Retrieve** (question path) — **hybrid RRF**: semantic (pgvector cosine) ⊕ lexical
   (full-text tsvector), fused by Reciprocal Rank Fusion, recency-composed, **plus a structured
   facts arm** (`currentFactsForQuery`) and, on the deep tier, **graph context**: a bounded
   recursive-CTE walk (≤2 hops, node/edge caps) from the query's seed entities, and per-entity
   timelines. Deep tier also adds query expansion/HyDE and an LLM re-rank — both best-effort,
   degrading to plain hybrid on any error.
7. **Reflect** (sleep-time cron, every ~6h) — re-read each person's/topic's accumulated facts and
   notes and synthesize a durable *profile* fact that supersedes the prior one. Only processes
   subjects with fresh activity (never churns). This is the "it learns" step.
8. **Forget** (on request) — the LLM only resolves a *description* of what to forget into exact
   row ids; deterministic code presents them for confirmation before anything is hidden (soft,
   reversible) or purged (redact + drop embedding). A "forget X" message is never itself captured
   (storing "delete X" would re-add X).

Retrieval invariants — every retrieval arm, always: **scoped to the owner, active-only,
quarantined-content-excluded, current-embedding-model-only.**

## 3. What the research says (and how much to trust it)

Behind this design sits a multi-pass research program: an 8-domain landscape survey across LLM/agent
memory, knowledge-graph construction, GraphRAG, cognitive psychology, computational memory models,
forgetting/continual learning, mechanistic interpretability, and memory neuroscience — then
adversarial steelman/red-team passes, a citation-verification gate, a framework-bias audit, and
finally an **empirical ablation of the real retrieval pipeline**. Honest disclosure first: the
theory passes were one model family reviewing itself (agreement ≠ field consensus), so treat the
literature claims as a rigorous *hypothesis map*. The ablation, however, is real measured data.

**Durable findings worth building on:**

- **Write-time distillation is universal.** Every mature memory system — MemoryBank, Mem0, A-MEM,
  Zep/Graphiti, HippoRAG, Generative Agents — stores extracted units (facts, notes, reflections),
  never the raw stream. The KG-construction lineage sharpens it to *"extract freely, canonicalize
  precisely"*: entity resolution is the load-bearing hard problem, and write-side precision /
  read-side recall is the consistent operating rule (with provenance kept so merges stay
  reconstructible).
- **Supersession is logically unavoidable.** Any store representing belief change needs a
  read-time rule for what's currently in force. Bitemporal modeling (SQL:2011 lineage) is the
  standard answer; parametric knowledge-editing of model weights (ROME/MEMIT-style) fails to
  propagate and degrades under cumulative edits — keep knowledge in the database, not the weights.
- **There is no principled utility-decay of stale-but-uncontradicted facts** anywhere in the
  field. Recency-weighting and supersession are what actually work; don't over-engineer a
  forgetting curve.
- **Memory importance has no agreed operationalization** (LLM-rated poignancy, access frequency,
  and graph centrality are all in production use); pick something simple (salience bumps on
  restatement) and move on.
- **Writable inference-time memory is a real attack surface** — PoisonedRAG-class attacks drive
  attacker-chosen answers with a handful of injected passages; MINJA poisons persistent memory
  through ordinary queries. The field has no settled write-trust primitive, which is exactly why
  the trust-tier + provenance design below matters *even for a personal brain*.

**Empirical ablation results (20-query labeled set over the production pipeline):**

- The **structured facts arm is a decisive win** for "who/what is X" queries: fact-family hit@8
  went 0.33 → 1.00 the moment `currentFactsForQuery` was added; overall MRR 0.574 → 0.690.
- The **graph walk closes multi-hop**: 0.67 → 1.00 on multi-hop queries ("where is Charl's sister
  staying") only when graph context is added.
- **Lexical-only retrieval is insufficient** (0.00 on paraphrase/fact/supersession/colloquial
  families; only nails verbatim) — this is *why* hybrid exists.
- **Query expansion trades precision for recall** (hit@1 0.55 → 0.35, hit@8 0.70 → 0.80): reserve
  expansion + re-rank for a *deep tier* on hard questions; answer easy questions with the shallow
  hybrid. The ablation independently re-derived this tiering.
- **Supersession works**: stale-vs-current queries score 1.00 wherever the semantic/fact arm
  participates — the pipeline surfaces the current answer, not the old one.

## 4. Security posture — what "full permission" does and doesn't change

The golden rule of the reference system: **the LLM proposes; deterministic code disposes.** No
code path lets message *text* directly cause a privileged effect; effects are gated by
platform-authenticated identity (`chat.id` / `from.id`), never by content. In a single-user brain
you are the trusted principal, so most of the multi-user trust machinery collapses — but **not all
of it**:

**Keep (these protect you from your own inputs and the outside world):**
- **Quarantine forwarded/bot-origin/third-party content.** A forwarded message, a pasted article,
  a link summary — that text is *someone else's words entering your prompt context*. Store it,
  retrieve it, but tag it: never attribute it to you, never let it silently ground an answer as if
  it were your own fact, and never let it write privileged facts. This is your prompt-injection
  wall, and the poisoning research says it's not optional.
- **Fixed send destinations.** The bot replies to *your* authenticated chat id, resolved in code.
  The LLM never picks a recipient. (One compromised retrieval → attacker-chosen exfiltration
  target is the failure mode this kills.)
- **Confirm-tap on destructive ops.** Deletion/purge still deserves a button tap even when the
  only user is you — "forget everything about work" resolved to 400 rows is a thing you want to
  see before it happens. Reversible low-stakes ops (reminders, list add/check-off) auto-commit;
  don't confirm-gate those.
- **Trust-gated supersession.** A fact may supersede an incumbent only if its trust ≥ the
  incumbent's. With tiers collapsed to {you=trusted, quarantined}, this one rule stops a poisoned
  forward from overwriting your real facts.
- **Secrets encrypted at rest**, descriptor-only embeddings, decrypt only on direct request.
- **Fail closed** on env/webhook-secret/identity checks; audit log on privileged actions.

**Drop / simplify:** multi-user rosters, per-member DM-vs-group scoping, pause semantics,
the admin-grant wall (you're the owner), group-scope derivation (scope = you).

## 5. Platform notes — Telegram vs WhatsApp

- **Telegram (the easy path, what the reference runs on):** free Bot API, instant setup
  (@BotFather), webhooks with a secret token, inline keyboards for confirm-taps, no restrictions
  on bot-initiated messages — reminders and proactive digests "just send". DM the bot = your
  authenticated private lane. If you want the fastest route to a working brain, start here.
- **WhatsApp (official = Meta Cloud API):** requires a Meta business app + phone number;
  webhooks similar. Two constraints change the design: (1) the **24-hour customer-service
  window** — the bot can free-form reply only within 24h of *your* last message; outside it,
  bot-initiated sends (your reminders! your morning digest!) must use pre-approved **template
  messages**. Design proactive features around templates, or send a daily "anything for me?"
  nudge-template that reopens the window. (2) Interactive **reply buttons** exist (up to 3) and
  cover the confirm-tap pattern. Per-conversation pricing applies. Avoid unofficial gateways
  (Baileys/web-scraping): account-ban risk makes them a bad substrate for the system that holds
  your brain.
- Either way, the webhook layer is thin and swappable: normalize inbound messages to one internal
  shape `{origin, author, text, attachments, forwarded?}` and keep the whole pipeline
  platform-agnostic behind it.

## 6. Build order (roughly the order that worked)

1. Webhook fast-ack → background ingest skeleton → echo reply (prove the loop).
2. Evidence capture + embeddings + hybrid retrieval → "answer from memory" (the core value).
3. Fact extraction + entity resolution + bitemporal supersession (the fact arm — biggest measured
   quality win).
4. Reminders (parse → schedule → exactly-once fire: claim → send → mark-sent, release on failure).
5. Graph edges + bounded traversal + deep tier (expansion/re-rank) for hard questions.
6. Reflection cron; forget-with-confirmation; secrets encryption; dashboard.
7. Tests throughout: offline in-memory Postgres for the pipeline, mocked LLM/chat, deterministic
   test embedder; a real-Postgres e2e for migrations.

Working cadence that kept quality high: spec first (write down what a subsystem does *before*
implementing — most mistakes came from guessing), one focused change at a time, typecheck + tests +
build green before every commit, and a security test for every trust/authz/exactly-once change.

---

*End of prompt. Reference implementation: Baumy Brain (private repo) — Next.js + Inngest + Neon
Postgres/pgvector/pg_trgm + Anthropic (tiered) + Voyage embeddings; memory pipeline in
`lib/memory/`, retrieval AI in `lib/ai/`, research corpus in `docs/research/`.*
