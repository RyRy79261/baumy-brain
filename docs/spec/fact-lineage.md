# Fact lineage — origin + a familial timeline of facts

Facts are `{subject, predicate, object}` triples in a bitemporal, trust-gated graph. This adds
two things every fact now carries so Baumy can reason about *where a fact came from* and *what
it followed from* — and narrate that in answers instead of stating flat, source-less claims.

## The two new columns on `baumy_facts` (migration 0009)

- **`source_memory_item_id`** — the evidence note (`memory_items` row) the fact was distilled
  from. Its **ORIGIN**. Paired with the existing `authored_by` (which *person* stated it) and
  `recorded_at` (*when*), a fact now knows who said it, in which message, and when.
- **`derived_from_fact_id`** — a self-FK to the prior fact this one **follows from** (its
  PARENT). Two ways it's set in `reconcileFact`:
  - On a **supersession** (same subject+predicate, trust-permitted new value): the new row's
    parent is the incumbent it replaced. This mirrors the incumbent's existing forward
    `superseded_by` pointer, so a supersession chain is now walkable **both** directions.
  - On an **add** (a new predicate about a subject that already has facts): the parent is the
    **most recent prior fact about the same subject**. This is what chains a *progression across
    different predicates and different people* — "Ryan: Zuzka is coming today" → "Marco: Zuzka
    has arrived". Null for the very first fact about a subject.

`derived_from` is **best-effort context, not a semantic guarantee** — it's "the previous thing
recorded about this subject", which is usually the meaningful antecedent but occasionally just
temporal adjacency. It's surfaced as *context*, never as a hard causal assertion.

Together with `subject_entity_id` (which groups all facts about one entity) these build a
per-entity **timeline, sourced across people**. Indexes: `baumy_facts_subject_idx` (timeline
walks) and `baumy_facts_derived_idx` (lineage-tree walks).

## Surfaced into the reply

`currentFactsForQuery` now returns, per matched current fact: `authoredBy` (who stated it) and
its lineage parent (`priorContent` + `priorAuthoredBy`) via a `LEFT JOIN` on `derived_from`.
The ingest reply path maps the member ids to **names** and folds the parent into the grounding:

> `zuzka status: arrived  (follows from — zuzka arriving: today, per Ryan)` — authored by Marco

So Baumy can answer "has Zuzka arrived?" with the progression and the sources, e.g. *"Yeah —
you said she was coming today, and Marco confirmed she got in."* instead of a bare "arrived".

## Security / invariants preserved

- **A secret lineage parent is never surfaced.** The `priorContent` join is gated on
  `pf.is_secure = false`; a secret antecedent is redacted from the timeline (a secret is still
  only ever decrypted in the direct-answer path, never volunteered as "context").
- **Provenance follows the injection wall.** `authored_by` is null for quarantined content;
  quarantined input still never becomes a fact, so it never enters a lineage.
- **Trust-gating is unchanged.** Lineage is descriptive metadata on top of the existing
  add/noop/update/reject reconcile — it never lets a lower-trust fact overwrite a higher one.
- **Additive + reversible migration.** Both columns are nullable; existing rows (and
  reflect-generated `system` profile facts, which have no source note) simply carry NULL.

## Reserved for later

- No read path yet *walks* the full `derived_from` chain (it surfaces only the immediate
  parent). A deeper "show me the whole timeline of X" view can walk the self-FK when needed.
- Cross-*subject* familial links (e.g. "the party" ← "Zuzka's visit") are not modeled; today
  lineage is within one subject entity's timeline.
