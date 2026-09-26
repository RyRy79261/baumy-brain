# Fact lineage — origin + a familial timeline of facts

Facts are `{subject, predicate, object}` triples in a bitemporal, trust-gated graph. This adds
two things every fact now carries so Baumy can reason about *where a fact came from* and *what
it followed from* — and narrate that in answers instead of stating flat, source-less claims.

## The two new columns on `baumy_facts` (migration 0009)

- **`source_memory_item_id`** — the evidence note (`memory_items` row) the fact was distilled
  from. Its **ORIGIN**. Paired with the existing `authored_by` (which *person* stated it) and
  `recorded_at` (*when*), a fact now knows who said it, in which message, and when.
- **`derived_from_fact_id`** — a self-FK to the prior fact this one **follows from** (its
  PARENT). Set in `reconcileFact` only where there is a real relation (revised by
  `chat-understanding-v2.md` §7, F8):
  - On a **supersession** (same subject+predicate — after predicate normalisation, so
    `arrival_date` supersedes `arrives_on` — trust-permitted new value): the new row's parent is
    the incumbent it replaced. This mirrors the incumbent's forward `superseded_by` pointer, so a
    supersession chain is walkable **both** directions.
  - On a **new occurrence** (the same key again after the previous one is over — a new visit): the
    parent is the previous occurrence of that key (same value too, for a multi-valued predicate).
  - Otherwise **null**. It used to fall back to "the most recent prior fact about the same subject",
    which presented an unrelated fact as a cause ("wifi provider: virgin (follows from — bin day:
    friday)") and — joining without a `deleted_at` filter — brought a soft-forgotten fact back
    verbatim as the parent of the next one. A forgotten (`deleted_at`) or refused-conflict row is
    never a parent, neither when it is assigned nor when it is joined.

Together with `subject_entity_id` (which groups all facts about one entity) these build a
per-entity **timeline, sourced across people**. Indexes: `baumy_facts_subject_idx` (timeline
walks) and `baumy_facts_derived_idx` (lineage-tree walks).

## Surfaced into the reply

`currentFactsForQuery` now returns, per matched current fact: `authoredBy` (who stated it) and
its lineage parent (`priorContent` + `priorAuthoredBy`) via a `LEFT JOIN` on `derived_from`.
The ingest reply path maps the member ids to **names** and folds the parent into the grounding:

> `zuzka arrives on: Sat 26 Sep  (earlier: zuzka arrives on: Fri 25 Sep, per Ryan)` — authored by Marco

So Baumy can answer "when does Zuzka arrive?" with the change and its sources, e.g. *"Saturday —
Ryan said Friday, but Marco moved it."* instead of hedging between two values.

## Security / invariants preserved

- **A secret lineage parent is never surfaced.** The `priorContent` join is gated on
  `pf.is_secure = false`; a secret antecedent is redacted from the timeline (a secret is still
  only ever decrypted in the direct-answer path, never volunteered as "context").
- **Provenance follows the injection wall.** `authored_by` is null for quarantined content;
  quarantined input still never becomes a fact, so it never enters a lineage.
- **Trust-gating is unchanged.** Lineage is descriptive metadata on top of the existing
  add/noop/update/removed/conflict/reject reconcile — it never lets a lower-trust fact overwrite a higher one.
- **Additive + reversible migration.** Both columns are nullable; existing rows (and
  reflect-generated `system` profile facts, which have no source note) simply carry NULL.

## Reserved for later

- No read path yet *walks* the full `derived_from` chain (it surfaces only the immediate
  parent). A deeper "show me the whole timeline of X" view can walk the self-FK when needed.
- Cross-*subject* and cross-*predicate* familial links (e.g. "the party" ← "Zuzka's visit", "coming
  today" → "has arrived") are not modeled as lineage — the entity timeline (newest first,
  `lib/memory/graph.ts`) tells a subject's story across predicates instead.
