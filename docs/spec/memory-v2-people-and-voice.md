# Memory v2 — People, Sentiment, Reflection & Voice (the next set of changes)

> Baumy already *recalls* well (semantic ⊕ lexical ⊕ entity-aware retrieval over a trust-gated bitemporal knowledge graph). This spec is the next chapter: making the memory **people-centric** (people are the hub, everything else hangs off them), giving it **honest epistemics** (it knows what it knows, what it half-knows, and what the house has *never* discussed), making its **learning visible** (a 🧠 when it captures), and adding a background **reflection** tier — all while staying **lossless by design** (nothing is ever deleted) and on the existing stack (Neon Postgres + pgvector + pg_trgm, Voyage embeddings, Anthropic Sonnet-primary/Opus-advisor/Haiku-routing, Inngest for async). No new vendor, no rewrite.

## Grounding note (current reality, not the older specs)

This extends `memory-core.md` but supersedes its stale details: production embeddings are **Voyage `voyage-3.5-lite` (512-dim)**, not OpenAI 1536; language models are **Anthropic only** (Sonnet primary, Opus advisor, Haiku routing) — see `AGENTS.md`. Everything below is written against the code as it actually is in `lib/memory/` and `lib/ai/`.

## Overview — the through-line

Five threads, one character: **a house participant with a good memory and honest epistemics who never invents a verdict and keeps the scroll clean.**

1. **People-centric graph.** People (not generic "things") are the primary nodes. Housemates are simply people who *also* have a Telegram identity; guests, friends, and officials (landlord) are people *without* one. A person accretes roles, relationships, attributes, activity, and notes over time — and can be *promoted* from external → housemate without losing a thing.
2. **Sentiment as notes, never a score.** Baumy remembers *what the house said and felt* about a person (attributed, qualitative, time-stamped) — it never computes an internal ranking/judgment of anyone. This is the "never invent" invariant applied to people.
3. **Reflection / consolidation.** A background job distils scattered facts into durable higher-order summaries ("who is Zuzana", "state of the house") — this is what people mean by "it learns."
4. **Salience, not decay.** Nothing is ever deleted (bitemporal facts + evidence are append-only). Salience is a *ranking* signal so signal beats noise; it never removes data.
5. **Voice & epistemics.** A graduated honest-miss (knows / partial / blank), a functional reaction vocabulary (🧠 learned it, 👎 asked-but-blank, 👀 thinking), and world-knowledge scoping (engage house questions freely; answer general-world only when explicitly asked).

## Decisions (locked in discussion)

| # | Decision | Why |
|---|----------|-----|
| 1 | **People are a first-class entity `kind`** (`person`), not the hardcoded `'thing'`. People ⊇ Housemates. | People are the hub of a household-secretary's memory; a person is a person whether or not they're enrolled. |
| 2 | **Compose, don't adopt.** No Managed Agent, no Anthropic memory tool, no mem0/Letta/Zep runtime. Extend the owned Neon/pgvector pipeline. | Baumy is a webhook + Inngest pipeline (not a long-lived agent loop) and already owns 100% of its data. Every managed option trades ownership + the injection wall for model-controlled writes — a downgrade. |
| 3 | **Housemates ↔ person-entities are bridged, not merged.** `members` stays the auth/roster source of truth; a person-entity carries a nullable link to its member row. | Keeps the security model intact while unifying the knowledge graph. Enables external→housemate promotion. |
| 4 | **Relationships become real entity-to-entity edges** (`objectEntityId`), not string values. | Turns the flat triple store into a walkable social graph ("whose room is *Zuzana's sister* in?"). |
| 5 | **Sentiment is stored as attributed NOTES, never a numeric/label ranking.** | A note is house-told (allowed); a score is Baumy inventing a judgment about a person (forbidden by "never invent"). Also keeps it **orthogonal to the security trust tiers**. |
| 6 | **Never volunteer sentiment.** Surface it only on request. | Avoids the bot reading as if it's tattling/judging. |
| 7 | **Never delete. Salience is ranking-only.** Facts (bitemporal) and evidence are append-only; salience/recency only affect *retrieval order*. | Baumy's entire reason to exist is not-forgetting. Lossless-by-design is a feature to preserve. |
| 8 | **Reflection is a background "sleep-time" Inngest cron** that reads *already-trusted, already-stored* rows only. | Security-clean by construction (no attacker input on that path); keeps synthesis off the hot webhook path. |
| 9 | **Graduated honest-miss with three epistemic states** derived from retrieval signal: knows / partial / blank. | Lets Baumy say the *informative* kind of "I don't know" ("we've never mentioned anything like that"). |
| 10 | **Functional reactions are code-emitted; vibe reactions are model-picked.** 🧠 / 👎 / 👀 are deterministic; 👍🔥🎉🤯 are the model's read. | "LLM proposes, code disposes" applied to reactions — memory-truth signals must be deterministic. |
| 11 | **World-knowledge answers only when explicitly asked.** House-knowledge questions engaged freely (tag or not). | Unprompted restaurant recs waste tokens and pollute the chat; Baumy is the house's memory, not a general chatbot. |

---

## 1. People as first-class entities

**Now:** `resolveEntity` (`facts.ts`) hardcodes `kind: 'thing'`, so a person and a sink are the same node type. Housemate names mentioned in text resolve to entities that are **not linked** to their `members` row — the graph-node "charl" and the roster-member Charl are two disconnected representations of the same human.

**Change:**
- `resolveEntity` accepts/infers a `kind` (`person` | `place` | `org` | `event` | `thing`). Extraction classifies it; when unknown, default `thing` (unchanged behaviour) so this is additive.
- Add a nullable bridge so a person-entity can point at its `members` row (e.g. `entities.member_id` FK, or the reverse). Housemate-name resolution resolves to the *bridged* person-entity, unifying facts about a housemate whether they were mentioned in group text or acting via Telegram.
- **Promotion path:** an external person (person-entity, no member link) becomes a housemate by creating the `members` row and linking it — all accreted facts/aliases/edges carry over.

**Invariants:** `members` remains the fail-closed auth/roster source of truth (`roster.ts`); the bridge never lets group text mint or elevate a member (that stays deterministic, from `my_chat_member`/`chat_member` events).

## 2. Person schema facets

A person node is the sum of facts where it is the subject, across these facets — **all expressible on the existing `entities`/`facts` schema** with free-form predicates (never a `pgEnum`):

| Facet | Shape | Example |
|---|---|---|
| identity | `entities` row: canonicalName, `aliases[]`, `kind='person'` | Zuzana · "Zu", "Zuzka" |
| roles (relational, plural) | edges/predicates | `{zuzana, friend_of, →Ryan}`, `{zuzana, guest_of, →house}`; `{landlord, official_of, →house}` |
| attributes | value facts | `{zuzana, occupation, nurse}` |
| relationships | entity edges (`objectEntityId`) | `{zuzana, sibling_of, →Charl}` |
| activity/events | episodic facts w/ `eventAt` | `{zuzana, fixed, →boiler, on: date}` |
| notes/sentiment | attributed notes (§3) | "Ryan wasn't sure who she was at first" (by Ryan, date) |
| provenance | `authoredBy` on facts | Charl is the source of most Zuzana-facts → Charl "knows" her |

Roles are **relational and plural** (a person is `friend_of Ryan` *and* `guest`), never a single global label — and because predicates are free-form, new role types (friend, official, neighbour, coworker) need zero schema change.

## 3. Sentiment as attributed notes (never scored)

**Principle:** *store what was said and felt — attributed, qualitative, time-stamped — never a computed verdict.* A sentiment note is house-told (in-character); a like/dislike/trust score would be Baumy inventing an opinion about a person (violates "only know what the house told you, never invent").

**Shape:** a note is `about-whom` (person entity) · `note text` · `said-by` (authoredBy) · `when`. Reuse the evidence layer: an observation message ("not sure who this Zuzana is tbh") is already captured with its author — the new bit is **tagging it to the person it's about** so it surfaces in that person's file.

**Rules:**
- **Never a number/label ranking of people.** No `trust_score`, no `sentiment: negative` column.
- **Orthogonal to the security trust tiers.** The `trusted`/`untrusted`/`quarantined` tiers are about *who is speaking* (a provenance gate for injection defense). Sentiment is about *who is spoken of* and *how people feel*. These axes **never cross** — a social note must never touch a fact's security trust level.
- **Never volunteered.** Surfaced on request only (e.g. "what do we know about Zuzana?").

**The introduction moment:** the *first* mention of a brand-new person (a node with no prior facts) is a distinct episodic event — worth noting *who brought them up* and *any concern/question raised right then* ("she was Ryan's friend; nobody knew her before"). This is legitimate social memory (vigilance toward a stranger), not judgment.

## 4. Reflection / consolidation tier

**Now:** Baumy stores atomic triples but never synthesises higher-order insight. Everything happens inline per message.

**Change:** a background **"sleep-time" Inngest cron** (idle-scheduled) that:
- clusters recent evidence + facts **per entity**, and
- has Sonnet write durable **summary rows** back into the fact store — for a person, a current "who is X" schema; for the house, a "state of the house".

This is Generative Agents "reflection" + mem0-style UPDATE, and for a people-centric graph it *is* "keep each person's schema current." **Security-clean by construction:** it reads already-stored, already-trust-tagged rows — never attacker input — so it needs no new injection defense.

## 5. Salience — ranking, never deletion

**Non-negotiable:** nothing is ever deleted. Facts are bitemporal (superseded → `is_current=false`, kept); evidence is append-only (dedup bumps salience on the original, never drops it). Baumy has **no context-window constraint** forcing forgetting — it retrieves from Postgres, and at house scale (tens of thousands of rows over years) pgvector/full-text stay sub-second. There is **no capacity reason to delete, ever.**

**The real gap** is *noise dilution in ranking* on the evidence layer: after months, thousands of "lol"/"ok" messages shouldn't compete with the three real answers. Fix = **pure ranking, zero loss**:
- **Salience at capture:** score how much a message *matters* (a durable fact vs. chatter) — a new signal used only to *order* retrieval. `memory_items.salience` already exists (default 0.5); score it meaningfully at `captureMemory` instead of leaving it flat.
- **De-noise retrieval:** let salience + relevance win so chatter is down-ranked, not removed. A "lol" is still returned if you literally ask about it.
- **(Optional, likely unneeded):** a reversible `archived` flag — excluded from *default* retrieval, fully recalled on explicit ask. Reversible, still lossless. Only if precision genuinely degrades in the wild.

**Facts (the knowledge graph) are sacrosanct** — salience/decay never touch them.

## 6. Graduated honest-miss (epistemics)

Three epistemic states, **measurable from the retrieval signal**:

| State | Retrieval signal | Response |
|---|---|---|
| **knows** | good hits | answer, in words |
| **partial** | adjacent hits, no answer | soft miss ("I've got bits around that, not the specific answer") or 👎 |
| **blank** | empty even at the loosest floor → topic is *novel to the house* | worded miss ("no idea — we've genuinely never mentioned anything like that") or 👎 |

The **blank** state is what makes "how much it doesn't know" real: Baumy can tell "never discussed" apart from "no specific fact," because the retrieval literally came back empty. This decision is **post-retrieval** (triage can't know it upfront) — it fits the existing flow: 👀 while checking → resolve to words *or* 👎.

## 7. Reaction vocabulary

| Signal | Means | Emitted by |
|---|---|---|
| 👀 | seen — checking memory (transient) | code |
| 🧠 | **learned that, it's stored** — no reply needed | code (fires when `shouldCapture` captured a durable fact and it isn't otherwise replying) |
| 👎 | asked, but I've got nothing on that | code (fires on the **blank** retrieval state) |
| 👍 🔥 🎉 🤯 | social read — noted / hell yeah / party / wild | the model (vibe of the moment) |
| **words** | only when it *knows*, the *blank is informative*, or it's *directly addressed* | code + model |

**🧠 makes learning visible** — it fixes the "did Baumy actually remember that?" anxiety (the Zuzana incident): the house watches it capture in real time, zero scroll cost. The **functional signals (🧠/👎/👀) are deterministic**, emitted by code from what actually happened (a fact captured, retrieval empty, thinking); the **vibe reactions are the model's** read of the social moment. Reactions are *free* (participate liberally, no scroll); **words are earned** (only when they carry info) — this is the existing "emoji by default" voice, extended.

> Note: `classify` currently emits a `reaction` enum `['👍','🔥','🎉','🤯']` (no 👎). 👎 and 🧠 are **not** added to that model-picked enum — they're emitted deterministically in the ingest VOICE section from the capture/retrieval outcome.

## 8. Group participation & world-knowledge scoping

- Baumy is a **group member** — it engages genuine **house-knowledge questions** whether or not it's @-tagged (already true via the "answer natural-language questions" path). Triage separates real knowledge-questions from banter/rhetorical.
- **World-knowledge** (restaurant recs, trivia, general facts) is answered **only when explicitly asked/directed** — never volunteered. Unprompted world-knowledge wastes tokens and pollutes the chat, and pulls Baumy toward being a general chatbot rather than the house's memory.

---

## Suggested build order (each additive, on the current stack)

1. **Person typing + housemate bridge** (§1) — `kind='person'`, member link; mirror new columns into the PGlite test DDL + an e2e case (per `AGENTS.md`).
2. **Reaction vocabulary** (§7) — 🧠 on capture, 👎 on blank retrieval; deterministic in the VOICE section. Cheap, high-visibility, addresses the "did it remember?" anxiety.
3. **Graduated honest-miss** (§6) — thread the retrieval-emptiness signal into the reply decision.
4. **Salience at capture + de-noise ranking** (§5) — score `salience` meaningfully; never delete.
5. **Relationships as edges** (§4) — resolve person-objects to `objectEntityId`; precision-first (same discipline as entity resolution).
6. **Sentiment notes** (§3) — tag observations to the person; on-request surfacing only.
7. **Reflection cron** (§4-tier) — the "it learns" upgrade; reads trusted rows only.

## Invariants this spec must not break

- **Injection wall / trust tiers** (`security.md`): origin/trust derived from Telegram-authenticated events, never text; quarantined content never grounds a reply or writes a fact. Sentiment is orthogonal to (never touches) security trust.
- **LLM proposes, code disposes:** functional reactions and the capture/miss decisions are deterministic.
- **Never invent:** sentiment is remembered (attributed), never a computed verdict; no internal ranking of people.
- **Lossless:** no deletion; facts bitemporal, evidence append-only; salience is ranking-only.
- **Trust-gated fact supersede** (`facts.ts`): unchanged.
