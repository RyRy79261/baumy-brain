# ADR 0002 — Why Baumy's knowledge graph lives in Postgres, not an Obsidian/markdown vault

**Status:** Accepted · **Date:** 2026-07-06 · **Applies to:** the memory substrate
(`lib/memory/`, `db/schema.ts`).

## Context

There's a popular pattern of using **Obsidian / a folder of markdown files** as the backend "brain" for
AI agents: a vault of `.md` notes, `[[wikilinks]]` as a hand-curated knowledge graph, local-first and
LLM-native. It's a genuinely good idea for *personal* knowledge, and the question recurs: why doesn't
Baumy store its memory that way instead of in Postgres?

There's a counter-claim from graph tooling (e.g. our `/graphify` skill, and Microsoft GraphRAG): **raw
markdown files are non-performant as a query substrate.** Both are right, at different layers — and the
reconciliation is exactly why Baumy is built the way it is.

## The two positions, reconciled

**Markdown/Obsidian as a brain** is attractive because a vault is plain files an LLM reads natively (no
API/parser/lock-in), the wikilinks are a traversable graph, you own the data, and it's git-friendly. Real
strengths — but all of them are properties of markdown as a **source and view** format.

**The performance critique is also correct:** a markdown file is a *document*, not a queryable structure.
To answer "what links to X", "trace a 3-hop path A→B", "what's in community Y", or "which node is a hub",
you must **scan and re-parse the files each time** — the graph is implied by links scattered across text,
not stored as data. Flat markdown therefore has: no index / precomputed adjacency (traversal is O(files)
scans), no native semantic layer (you build a vector index anyway), and no way to run the algorithms that
make a graph *useful* (community detection, shortest-path, hub/"god-node" ranking need an extracted graph
in a DB, not a folder). It's fine for a few thousand personal notes; it degrades on large/dense graphs,
real-time multi-hop, concurrency, and atomic single-edge updates.

**The reconciliation (and what graph tools actually do):** it isn't markdown-*vs*-graph — it's **two
layers**. `/graphify` itself is the proof: it *builds* a real indexed graph as the engine (`graph.json`,
push-to-Neo4j, community detection, god nodes, `query`/`path`/`explain`) and then *emits* Obsidian / a
wiki / HTML as human-facing **views** — it never queries the raw markdown. GraphRAG is the same shape
(extract an entity/relation graph from text → query the graph, not the prose). The rule:

> **Extract a performant, indexed graph once → query *that* → render markdown/Obsidian for humans if you
> want a browsable view.** Markdown is the source & the view; the graph is the engine.

## Decision

Baumy stores its memory as an **indexed graph in Postgres**, not a markdown vault — and it independently
lands on the same two-layer split the graph tools prescribe:

- **Source / evidence layer** — `memory_items` (the captured notes/messages + Voyage embedding). The
  "markdown equivalent": durable, keeps original wording + provenance/lineage, human/LLM-readable.
- **Derived query engine** — `entities` + `facts` + relationship edges, with **pgvector (HNSW)** for
  semantic recall, **pg_trgm** for fuzzy entity resolution, and the bounded **recursive-CTE traversal**
  in `graph.ts` for multi-hop walks. This is the performant, indexed graph the critique argues for — in
  Postgres rather than Neo4j.

## Rationale — two independent reasons that converge

1. **Performance (the graph-tooling point).** Baumy's whole value is fast recall: hybrid semantic+lexical
   retrieval, multi-hop graph traversal ("Charl's sister → the cave"), per-entity timelines. Those are
   indexed graph/vector queries; a flat vault would force scan-and-parse for every one and wouldn't
   support the traversal at all.
2. **Security (the load-bearing reason for *this* product).** Baumy is **multi-user and adversarial** —
   *every group message is untrusted, attacker-controlled input*. The memory substrate must enforce
   trust-gated writes (a fact only supersedes if trust ≥ incumbent), AES-256-GCM encryption of secrets
   (descriptor-only at rest), quarantine of forwarded/bot content, group-scoping on every read, and
   exactly-once semantics — the injection wall. **A shared plaintext vault enforces none of that**: a
   file anyone can write is precisely the wrong substrate when the threat model is "any message could be
   an attack." Postgres + application-layer invariants is what makes "the LLM proposes, deterministic
   code disposes" enforceable.

The two reasons point the same way from different directions: performance says *don't query flat files*,
security says *don't let untrusted input write flat files*.

## Consequences

- We forgo the free, human-browsable, portable vault Obsidian gives. Acceptable: the value is *recall for
  a bot*, not a note-taking UI for a person.
- If a human-browsable or exportable view is ever wanted, generate it as a **render** (Graphify-style:
  export the graph to markdown/HTML), never as the source of truth. The query substrate stays Postgres.

## Revisit when

- Baumy (or a descendant system) becomes **single-user and trusted** with light query needs — then a
  markdown/vault substrate's simplicity + portability could win, since the security reason evaporates and
  the performance one softens at small scale.
- We want an **inspectable memory dashboard** — a read-only Graphify/Obsidian-style export of the graph
  is a reasonable feature, kept strictly downstream of Postgres.

## Sources

The Obsidian-as-AI-memory pattern: <https://agentmemory.site/>,
<https://github.com/jrcruciani/obsidian-memory-for-ai>,
<https://medium.com/@vreshch/your-obsidian-vault-is-already-a-knowledge-graph-i-turned-on-the-lights-56c07233db89>.
The extract-a-graph pattern: the internal `/graphify` skill (`~/.claude/skills/graphify/`), and Microsoft
GraphRAG. Baumy's substrate: `AGENTS.md` (Memory & retrieval), `db/schema.ts`, `lib/memory/graph.ts`.
