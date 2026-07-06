# Pass 6 — Empirical ablation (the first data contact)

**This is the first thing in the whole program that touched anything outside model opinion.** Every
prior pass was theory-vs-theory (Pass 5 anti-pattern #3). This one runs the *real* retrieval pipeline —
production write path (`captureMemory` / `reconcileFact` / `resolveEntity`) and read path (`retrieve` /
`retrieveExpanded` / `currentFactsForQuery` / `gatherGraphContext`) on PGlite — over a hand-built house
corpus (20 notes + 8 facts) and a labeled query set (20 queries across 6 families), and measures
hit-rates per pipeline variant. Harness: `scripts/ablation/retrieval.ablation.test.ts` (env-gated,
`RUN_ABLATION=1`; skipped in CI). Raw numbers: `docs/research/data/ablation-*.json`.

## Results (lexical-hash embedder run)

hit@1 = the target was rank 1; hit@8 = target in top 8; MRR = mean reciprocal rank. 20 queries.

| variant | hit@1 | hit@8 | MRR |
|---|---|---|---|
| semantic-only (arm) | 0.50 | 0.80 | 0.621 |
| lexical-only (arm) | 0.25 | 0.25 | 0.250 |
| hybrid (prod shallow reply) | 0.55 | 0.70 | 0.574 |
| hybrid + expansion (deep) | 0.35 | 0.80 | 0.479 |
| hybrid + facts (prod reply) | 0.65 | 0.80 | 0.690 |
| **hybrid + facts + graph (prod deep reply)** | **0.55** | **0.90** | **0.665** |

Per-query-family hit@8 (the diagnostic that matters):

| variant | F1 exact | F2 paraphrase | F3 multihop | F4 fact | F5 supersession | F6 colloquial |
|---|---|---|---|---|---|---|
| lexical-only | 1.00 | 0.00 | 0.33 | 0.00 | 0.00 | 0.00 |
| semantic-only | 1.00 | 0.60 | 1.00 | 0.33 | 1.00 | 1.00 |
| hybrid+facts | 1.00 | 0.40 | 0.67 | **1.00** | 1.00 | 1.00 |
| hybrid+facts+graph | 1.00 | 0.60 | **1.00** | **1.00** | 1.00 | 1.00 |

## What the data CONFIRMS (claims that were only asserted before)

- **The structured-facts arm is a real, decisive win for "who/what is X".** F4-fact hit@8 jumps
  **0.33 → 1.00** the moment `currentFactsForQuery` is added, and it lifts overall hit@1 0.55 → 0.65
  and MRR 0.574 → 0.690. "Who is Zuzka / what is Marta's job / what is Miso" are answered by the fact
  graph, not by note retrieval. This is the corpus's fact-arm claim, now measured.
- **The graph walk closes multi-hop.** F3-multihop goes **0.67 → 1.00** only when `gatherGraphContext`
  is added ("who looks after Miso", "where is Charl's sister staying" need the edge walk). The
  fact-graph-traversal work earns its place empirically, not just in tests.
- **Lexical alone is insufficient** — 0.25 overall, and **0.00** on paraphrase, fact, supersession, and
  colloquial families. It only nails verbatim (F1). This is exactly why hybrid exists.
- **The full deep-reply stack maximizes recall** (hit@8 = 0.90, best of any variant); the only residual
  misses are two pure-paraphrase queries the lexical embedder structurally cannot bridge (see caveat).
- **Recency + fact supersession prefer the current value** — F5 (stale "bins go out friday" vs current
  "monday night") scores 1.00 wherever the semantic/fact arm participates: the pipeline surfaces the
  *current* answer, not the stale one.

## What the data CHALLENGES (a nuance theory-vs-theory missed)

- **Query expansion is NOT a pure win — it trades precision for recall.** The corpus framed expansion as
  "widens recall *without* drowning precision." The data disagrees at the top rank: adding expansion
  moved **hit@1 0.55 → 0.35** (the exact answer gets pushed down as paraphrase-probes surface neighbours)
  while **hit@8 0.70 → 0.80**. So expansion helps *find* the answer but *hurts putting it first* — a real
  recall/precision tradeoff. This is why the deep tier is (correctly) reserved for hard questions and the
  shallow tier answers simple ones: the ablation independently re-derives that design choice, and mildly
  contradicts the "pure win" gloss. **First genuinely new, data-driven finding in the program.**
- **Shallow hybrid's MRR (0.574) sat *below* semantic-only (0.621)** in this run — the lexical arm's
  RRF contribution added some noise at the top. Not alarming (the fact arm more than recovers it), but a
  reminder that fusion is not free.

## Validity caveats (do not over-read)

- **This run used the lexical-hash test embedder (`embedSync`), not production Voyage.** So the "semantic"
  arm here is really a lexical-overlap proxy, and the **F2-paraphrase numbers are pessimistic** — true
  semantic embeddings would recover "laundry machine → dryer", "who supplies our power → Vattenfall",
  etc. **The structural findings (facts arm, graph arm, expansion tradeoff, lexical-insufficiency) are
  embedder-independent and hold regardless**; only the paraphrase-recall ceiling is understated.
  Reproduce honestly with: `RUN_ABLATION=1 ABLATION_EMBEDDER=voyage VOYAGE_API_KEY=… pnpm vitest run scripts/ablation`.
- **The corpus and the query labels were authored by the same model family** that wrote the research (the
  Pass-5 monoculture, disclosed). This is a *measurement*, not a benchmark — n=20, single rater, no
  inter-annotator check. It converts one claim from *theory-vs-theory* to *theory-vs-a-small-world*; it
  does not make the corpus "validated."
- **Arm-isolation variants copy the production SQL CTEs** (`retrieve.ts` `runHybrid`) — drift risk; keep
  in sync by hand. The *headline* variants call the real public API unchanged.

## The human channel (breaking the monoculture, a little)

`scripts/ablation/queries.human.json` is an out-of-distribution input: a human adds their *own* phrasings
of house questions (and their own relevance judgments) and re-runs — perturbing the empirical loop with
input the model didn't author. Any queries there are folded in and counted separately in the artifact.

## Bottom line

The pipeline's core structure is **empirically supported**: the fact arm and the graph walk each close a
family of questions that flat retrieval misses, and the composed deep stack has the best recall. One
theory-claim (expansion as pure win) is **empirically nuanced** into a precision/recall tradeoff. And the
whole thing is now grounded in *something*, however small — which is the point.
