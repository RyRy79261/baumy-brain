# 🐈‍⬛ Baumy Brain

> A private Telegram **house-management secretary** for one shared house — a memory-first
> group-chat gremlin that quietly remembers everything the house says, answers questions
> grounded in that memory, schedules reminders, learns the people who live there, and can
> forget things on request. It runs in the house group, reacts more than it talks, and
> never invents facts.

Baumy is **not** a personal assistant and **not** multi-tenant. It's one bot, one house,
one shared memory — built so the group chat has to remember *less*, not scroll more.

---

## What it does

| | |
|---|---|
| 🧠 **Remembers the house** | Every message is captured, embedded, and distilled into a trust-gated knowledge graph. Ask "who's in the cave this week?" months later and it knows. |
| 💬 **Answers, grounded** | Replies only from what the house actually said — with an *honest miss* when it doesn't know, never a hallucinated fact. Reacts (👀🧠👍) more than it speaks. |
| ⏰ **Reminders** | "remind us to pay rent friday" → DST-correct, exactly-once delivery to the house group. |
| 👥 **Learns people** | People are first-class entities — housemates, guests, the landlord — with relationships, notes, and attributed sentiment (never a score, never volunteered). |
| 🌙 **Reflects** | A sleep-time job consolidates what it knows into durable per-person profiles — the "it learns over time" step. |
| 🧽 **Forgets on request** | "forget my full name" → Baumy proposes exactly what it'll remove and only deletes on a confirm tap. Soft-hide (reversible) or hard-purge (right-to-be-forgotten). |
| 🔐 **Admin dashboard** | Telegram magic-link login → browse memory, manage reminders/tasks, grant access, tune the response policy. |

---

## The one idea that matters

Telegram privacy mode is **off**, so Baumy sees *every* group message — which means every
message is **untrusted, attacker-controlled input**. The entire design follows one rule:

> **The LLM proposes; deterministic code disposes.**

No path lets group text directly cause a privileged effect. A language model can *suggest*
an action, but the thing that *commits* is always a human authorization — a confirm tap
(deletes, reminders) or a live-authenticated dashboard session (grants, config) — or a
code-resolved constant (the fixed send destination).

```mermaid
flowchart LR
    subgraph untrusted["🚫 untrusted zone — group text"]
        MSG["group message<br/>(anyone, anything)"]
        LLM["language model<br/>proposes"]
    end
    subgraph wall["🧱 the walls"]
        ORIGIN["origin/trust from<br/>Telegram-authed chat.id /<br/>from.id — never text"]
        TAP["confirm-tap wall<br/>callback_query"]
        DASH["dashboard authz<br/>live session, re-checked"]
        CODE["code-resolved<br/>constants only"]
    end
    subgraph privileged["✅ privileged effects"]
        SEND["send to house<br/>(fixed chat id)"]
        GRANT["grants / config"]
        DELETE["delete memory"]
    end

    MSG --> ORIGIN --> LLM
    LLM -->|propose delete| TAP
    TAP -->|tap by authed member| DELETE
    LLM -.->|never picks recipient| CODE
    CODE --> SEND
    DASH -->|owner / admin session| GRANT

    classDef danger fill:#3a1414,stroke:#b04040,color:#fff
    classDef safe fill:#12341a,stroke:#3f8f52,color:#fff
    class MSG,LLM danger
    class SEND,GRANT,DELETE safe
```

**Trust tiers** are derived only from Telegram-authenticated fields, never message content:

```mermaid
flowchart TD
    IN["incoming content"] --> Q{"forwarded /<br/>bot origin?"}
    Q -->|yes| QUAR["🔴 quarantined<br/>never grounds a reply,<br/>never writes a fact"]
    Q -->|no| L{"which lane?<br/>chat.type + chat.id"}
    L -->|house group| UNTR["🟠 untrusted<br/>grounds replies,<br/>never privileged"]
    L -->|member DM| TRUST["🟢 trusted"]
    REFLECT["🔵 system<br/>Baumy's own reflections"] -.->|highest trust| GRAPH[("knowledge graph")]
    QUAR --> GRAPH
    UNTR --> GRAPH
    TRUST --> GRAPH
    GRAPH -.->|"supersede only if trust ≥ incumbent<br/>(memory-poisoning defense)"| GRAPH
```

---

## System architecture

```mermaid
flowchart TB
    TG["📱 Telegram<br/>house group + member DMs"]

    subgraph vercel["Vercel — Next.js 15"]
        WH["/api/telegram/webhook<br/>fast-ack: verify secret →<br/>enqueue → 200"]
        DASH["🔐 Admin dashboard<br/>magic-link + HMAC session"]
        INNGEST["/api/inngest<br/>function host"]
    end

    subgraph async["Inngest — all async / background work"]
        INGEST["ingest pipeline<br/>classify → decide → act"]
        REMIND["reminders<br/>arm · deliver · sweep"]
        REFLECT["reflection cron<br/>every 6h → profiles"]
        TASKS["scheduled tasks<br/>+ proactive digests"]
        REEMBED["re-embed sweep"]
    end

    subgraph data["Neon Postgres + pgvector + pg_trgm"]
        MEM[("evidence + embeddings")]
        KG[("entities + facts")]
        OPS[("reminders · tasks · roster · config · audit")]
    end

    subgraph ai["models"]
        ANTH["Anthropic<br/>Haiku · Sonnet · Opus"]
        VOY["Voyage<br/>voyage-3.5-lite (512d)"]
    end

    TG -->|webhook| WH -->|event| INNGEST
    INNGEST --> INGEST & REMIND & REFLECT & TASKS & REEMBED
    INGEST --> MEM & KG
    INGEST -->|classify, reply, extract| ANTH
    INGEST -->|embed| VOY
    REFLECT --> KG
    REMIND --> OPS
    INGEST -->|send, fixed chat id| TG
    DASH --> MEM & KG & OPS
```

**Why this shape:** the webhook is *fast-ack only* (verify → enqueue → 200); every real
decision happens downstream in Inngest, where retries, exactly-once claims, and idempotency
live. Scope (house vs DM vs ignore) is resolved from stored config, never guessed.

---

## The ingest pipeline

Every group message walks the same gauntlet. The **write-gate** (`decide`) is where the
classifier's *proposal* becomes a code-*disposed* action, clamped by an origin↔action policy.

```mermaid
flowchart TD
    START["message event"] --> PRE["prefilter<br/>drop obvious noise (no LLM)"]
    PRE --> ORIGIN["resolve origin + trust<br/>(authenticated fields only)"]
    ORIGIN --> CMD{"member-DM<br/>command?"}
    CMD -->|"/start /dashboard /pause"| DETERM["deterministic handler"]
    CMD -->|no| CLASSIFY["classify (Haiku)<br/>intent · confidence · respond · tier"]
    CLASSIFY --> DECIDE{"decide()<br/>write-gate + policy"}

    DECIDE -->|worth remembering| CAP["📥 capture<br/>(orthogonal to the action)"]
    DECIDE -->|reminder| REM["⏰ auto-commit reminder"]
    DECIDE -->|forget| FGT["🧽 propose deletion<br/>→ confirm tap"]
    DECIDE -->|question / directed| RPLY["💬 grounded reply"]
    DECIDE -->|else| REACT["😼 react or stay silent"]

    CAP --> EXTRACT["extract facts<br/>(paginated, no cap) →<br/>reconcile into graph"]
    RPLY --> RETRIEVE["hybrid retrieval →<br/>Sonnet, self-escalates to Opus"]

    classDef act fill:#14243a,stroke:#4070b0,color:#fff
    class CAP,REM,FGT,RPLY,REACT act
```

Capture is **orthogonal** to the action: a message can set a reminder *and* state a durable
fact ("Zuzana arrives 10pm, staying in my room") — both are kept. Every structured-output
call on this path is **best-effort** — a malformed model response degrades to a safe default
instead of crash-looping the pipeline.

---

## The memory pipeline — the crown jewel

```mermaid
flowchart LR
    MSG["message"]
    Q["question"]

    subgraph capture["1 · capture"]
        EV["evidence item<br/>+ Voyage embedding"]
        DEDUP["consolidate<br/>≥0.97 cosine → bump"]
    end
    subgraph facts["2 · facts"]
        EX["extract triples<br/>(Sonnet, paginated)"]
        RES["resolve entity<br/>normalize → alias →<br/>trigram merge"]
        RECON["reconcile<br/>trust-gated · bitemporal"]
    end
    subgraph retrieve["3 · retrieve"]
        SEM["semantic<br/>(pgvector cosine)"]
        LEX["lexical<br/>(tsvector FTS)"]
        RRF["RRF fusion<br/>+ recency + salience"]
        DEEP["deep tier:<br/>expansion/HyDE + rerank"]
    end
    subgraph reflect["4 · reflect (sleep-time)"]
        PROF["per-person profiles<br/>→ system-trust facts"]
    end

    MSG --> EV --> DEDUP --> STORE[("evidence + vectors")]
    MSG --> EX --> RES --> RECON --> GRAPH[("entities + facts")]
    Q --> SEM & LEX
    STORE --> SEM
    SEM & LEX --> RRF --> DEEP --> ANSWER["grounded answer"]
    GRAPH --> ANSWER
    GRAPH --> PROF --> GRAPH
```

- **Capture** stores the raw message + embedding; a near-verbatim restatement *consolidates*
  onto the original (salience bump) instead of duplicating.
- **Facts** distils `{subject, predicate, object}` triples into a **trust-gated, bitemporal**
  graph. People are first-class; entity resolution de-fragments surface forms ("the sink" /
  "kitchen sink" → one node) while keeping distinct people distinct.
- **Retrieve** fuses semantic ⊕ lexical recall via **Reciprocal Rank Fusion**, composes
  recency + salience, and on the deep tier adds query expansion/HyDE and a re-rank.
- **Reflect** runs on a slow cron: it re-reads a person's own facts + notes and writes a
  durable profile back as a `system`-trust fact — from **non-secret, non-quarantined**
  material (already-captured evidence + facts, not live group text; secrets and
  forwarded/bot content are excluded).
- **Nothing is ever deleted automatically.** Salience is a *ranking* signal (de-noise), never
  a delete policy — the bitemporal graph is append-only.

---

## Deletion on request — proposes, then a tap disposes

The one place memory *does* get removed is an **explicit human request**, and it still goes
through the confirm wall:

```mermaid
sequenceDiagram
    participant M as Member
    participant B as Baumy ingest
    participant DB as Postgres
    participant C as Callback handler

    M->>B: forget my full name
    B->>B: classify, intent = forget
    B->>B: extract target (Sonnet, speaker-aware)
    B->>DB: findMemoryToForget, group-scoped
    DB-->>B: exact matching rows
    B->>M: I'll forget these 2 things… [Forget] [Keep]
    M->>C: taps Forget (authenticated from.id)
    C->>DB: soft-hide OR purge (redact + drop vector)
    C->>DB: write audit log
    C-->>M: 🧽 Forgotten — 2 things gone.
```

**Soft** hides rows from all recall (reversible, audited); **purge** redacts the stored value
and drops the embedding (right-to-be-forgotten). The mode is chosen from the request's wording
and shown in the proposal *before* anything commits. Reminders are the one exception to the
wall — they auto-commit, because a reminder only posts text to the fixed house group.

---

## Model routing

Anthropic only for language models (Voyage is the one deliberate exception, for embeddings —
Anthropic ships none). Each role is pinned and env-overridable; ids are never inlined.

```mermaid
flowchart LR
    C["🟢 Haiku<br/>routing / triage ONLY"] --> D{"needs an answer?"}
    D -->|reply, memory ops| S["🟡 Sonnet<br/>primary reasoning"]
    S -->|"reply path<br/>self-escalates"| O["🔴 Opus<br/>advisor / deliberative"]
```

Cheap high-volume triage is Haiku; everything that *reasons* — replies, fact extraction, query
expansion, re-rank, reflection, forget — runs on Sonnet. The **reply path** additionally
self-escalates to Opus when it signals it needs more; the other Sonnet ops are fixed-tier (Opus
is also the deliberative tier for scheduled tasks).

---

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**, flat root layout (`@/*` → `./`)
- **Drizzle ORM** + **Neon Postgres** + **pgvector** + **pg_trgm**
- **Inngest** for all async / background / scheduled work
- **Anthropic** (`@ai-sdk/*` + `ai` SDK) for language models · **Voyage** `voyage-3.5-lite` (512-dim) for embeddings
- **Auth:** Telegram magic-link → signed HMAC session cookie
- **Secrets at rest:** AES-256-GCM (wifi/door/bank values); only a non-secret descriptor is stored + embedded
- **Tests:** Vitest + PGlite (offline, in-memory Postgres with pgvector + pg_trgm) **plus** a real pgvector Postgres e2e via testcontainers

## Commands

```bash
pnpm dev            # next dev
pnpm inngest:dev    # local Inngest dev server
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (offline; PGlite)
pnpm build          # next build
pnpm db:generate    # drizzle-kit generate (migrations)
pnpm db:migrate     # apply migrations (needs DATABASE_URL_UNPOOLED)
node --experimental-strip-types scripts/set-webhook.ts   # register the Telegram webhook
```

See **[SETUP.md](SETUP.md)** for a full local + deploy walkthrough, and
**[AGENTS.md](AGENTS.md)** for the working guide + security invariants. Detailed design specs
live in **[docs/spec/](docs/spec/)**.

---

*Built memory-first: the whole point is recall you can trust. Baumy remembers so the house
doesn't have to — and only forgets when you ask it to. 😼*
