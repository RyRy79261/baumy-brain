# Fact-graph traversal — human-like multi-hop knowledge

Baumy's facts already form a **property graph**, but until now nothing walked it — every lookup
was one-hop (facts about the entity a query names). This adds the traversal layer
(`lib/memory/graph.ts`) so a query that needs to *connect* knowledge ("where's Charl's sister
staying?") can reach facts no single lookup returns. It builds on [[fact-lineage]].

## The graph that already existed

- **Nodes** — `baumy_entities` (people, places, orgs, events, things).
- **Relationship edges** — a `baumy_facts` row with `object_entity_id` set is an edge:
  `subject —predicate→ object` (e.g. "Zuzka —sibling_of→ Charl", "Charl —owns→ the cave").
  These were *written* by `reconcileFact` but never *read* — inert until now.
- **Attribute facts** — a fact with `object_value` (a property of one node).
- **Temporal edges** — `derived_from_fact_id` / `superseded_by` give each subject a timeline.

## Two traversals

- **`connectedEdges(seeds, {maxHops:2, maxNodes:10, maxEdges:12})`** — a **recursive CTE** that
  walks relationship edges OUTWARD from the query's seed entities, *both directions* along each
  edge, bounded by hops + node/edge caps. It returns the edges inside that reachable
  neighborhood, closest-to-seed first. This is the cross-subject hop: seed on {Zuzka}, reach
  Charl (1 hop) and the cave (2 hops, *through* Charl).
- **`entityTimeline(entityId, limit)`** — the full progression of ONE subject, oldest→newest,
  **including superseded rows** (that's the story: "coming today" → "arrived" → "left"; past
  rows are tagged `(past)`).

`gatherGraphContext(query)` ties them together: resolve the query to seed entities (same
name/alias/trigram match the fact lookup uses), walk the neighborhood, take the top seed's
timeline (only when it's a real >1-entry progression), and return grounding items the reply can
reason over. Wired into the **deep tier only** of the reply path (`ingest.ts`) — best-effort, so
any error degrades to `[]` and the reply still has hybrid recall + direct facts.

## Bounds & safety (a graph walk must never run away or leak)

- **Bounded**: ≤2 hops, ≤10 nodes, ≤12 edges, ≤8 timeline rows — a walk can never dump the graph.
  The recursive CTE's `UNION` + `depth < maxHops` terminate on cycles.
- **Group-scoped**: every query filters `group_id` — a walk never crosses houses.
- **Secret-excluded**: relationship edges are `is_secure = false` by construction (a secret
  fact never gets an `object_entity_id`), and the timeline shows a secret as its **descriptor
  only**, never the plaintext. Secrets stay decrypt-on-direct-answer, never ambient "context".
- **Current/active**: edges walk `is_current` facts + `is_active` entities; the timeline is the
  one place superseded rows are surfaced (deliberately — it *is* the history), still non-deleted.
- **Deep-tier only**: the walk costs a couple of extra queries, so it runs for questions the
  classifier already flagged as needing depth, not every message.

## Reserved / next

- **Weighted / typed edge preference** — today all relationship predicates traverse equally; a
  future pass could prefer "stays_at"/"sibling_of" over weak links, or rank by recency.
- **Path surfacing** — we surface the edges, not the literal path string ("Zuzka → Charl →
  cave"); the reply model reconstructs it. An explicit path could be handed over for very
  deep chains.
- **Semantic edge inference** — edges are only as good as extraction's `objectKind`; richer
  relationship extraction feeds directly into deeper, more useful walks.
