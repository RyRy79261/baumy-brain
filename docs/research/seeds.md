# Adversarial targets — 8 topics as claim-clusters

Distilled from the Pass-0 landscape survey. Each claim is a unit to be steelmanned AND red-teamed.

## T1 — Memory is plural (the systems partition)
- **A.** Memory decomposes into working / episodic / semantic / procedural — a partition shared by
  cognitive science (Tulving; Baddeley; Squire's declarative/nondeclarative; Atkinson-Shiffrin ancestor)
  and by AI agents (CoALA ← Soar, ACT-R).
- **B.** The AI re-derivation is a *productive analogy*, not evidence agents "have" episodic memory.
- **C.** Whether these are separate systems vs. a continuum (SPI / embedded-processes), and whether a
  distinct short-term store exists vs. "activated LTM", is itself contested in psychology.

## T2 — Encoding is distillation, never raw storage
- **A.** All mature systems store transformed traces (facts/triples/summaries; hippocampal pattern
  separation), never the raw stream.
- **B.** Write-side rule: "extract freely, canonicalize precisely" — over-merge is fatal/irreversible,
  under-merge is recoverable (precision-first write, fuzzy read).
- **C.** What is encoded fixes which cues can retrieve it (encoding specificity / transfer-appropriate
  processing; levels-of-processing is circular).
- **D.** AI extraction is a discrete, errorful pipeline stage (compounding hallucinated/omitted triples)
  with no biological analogue and usually no write-time trust model.

## T3 — Weighting = recency × importance × relevance (+ cousins)
- **A.** Graded, use-dependent, multi-signal weighting is the shared backbone (Generative Agents'
  3-factor score ≈ ACT-R declarative activation).
- **B.** ACT-R fan-normalization (a cue linked to many items lends each less) is a principled defense
  against hub domination and quantitatively predicts the human fan effect.
- **C.** Rational analysis: retrievability tracks environmental need-probability (Anderson & Schooler);
  the "near-optimal" framing is contested (bounded / resource-rational).
- **D.** WHERE importance comes from is unresolved (LLM-rated, access-counts, graph-centrality,
  calibrated confidence — none dominant); no shared theory of what an edge weight *means*.

## T4 — Retrieval is associative traversal/completion, not address lookup
- **A.** Deepest cross-field convergence: spreading activation (Collins & Loftus), Personalized
  PageRank (HippoRAG), Hopfield-completion (attention IS one-step Hopfield retrieval — exact).
- **B.** Retrieval is cue-dependent, not strength-absolute (encoding specificity; accessibility ≠
  availability, Tulving & Pearlstone).
- **C.** Practical convergence = hybrid fusion (semantic ⊕ lexical ⊕ graph, RRF) with
  complementarity-by-query-type: graph wins multi-hop/global, flat wins single-fact.
- **D.** GraphRAG's "flat RAG structurally cannot do global queries" is overstated (RAPTOR); the active
  ingredient may be hierarchical summarization, not graph topology (unresolved).

## T5 — Consolidation/reflection + the fast/slow architecture
- **A.** Two-timescale design (fast sparse hippocampal encoder + slow generalizing neocortex — CLS) is
  the structural answer to interference; endorsed by continual-learning theory.
- **B.** Offline replay/reflection *transforms* episodes into gist (not faithful copy); AI analogues =
  reflection, hierarchical summarization, "sleep-time compute", Soar chunking.
- **C.** Abstraction need not be stored — prototypes emerge at retrieval from exemplars (MINERVA-2;
  instance models); structure/content factorization (Tolman-Eichenbaum Machine ≈ attention).
- **D.** Cracks: veridical vs. generative replay unsettled; fast cortical schema learning (Tse 2007)
  challenges the clean slow-neocortex premise; systems-consolidation vs. Multiple-Trace-Theory.

## T6 — Updating: reconcile/supersede not append; the ripple problem
- **A.** Append-only is fatal; everyone converges on an update policy (reconciliation ADD/UPDATE/
  DELETE/NOOP; bi-temporal soft invalidation from temporal-DB theory).
- **B.** Human analogue = reconsolidation (update-on-read) + misinformation effect; retrieval is a write
  (testing effect, retrieval-induced forgetting) — intrinsic in humans, optional in machines.
  (Reconsolidation boundary conditions / human replicability contested.)
- **C.** Mechanistic-editing lesson: local edits don't propagate to logical neighbors (ripple problem,
  RippleEdits); cumulative edits cause spectral collapse; constrained editing (AlphaEdit) delays it
  only under the linear associative-memory approximation.
- **D.** Hard-delete vs. soft-invalidate has no consensus; whether editing is ever safe maintenance at
  scale is unresolved.

## T7 — Degradation: forgetting lawful, mechanism unknown, partly a feature
- **A.** Forgetting is lawful / negatively-accelerated (Ebbinghaus); spacing + testing robustly improve
  retention (among the most replicated findings in psychology).
- **B.** Mechanism unresolved after a century — time-decay (ACT-R) vs. interference/discriminability
  (SIMPLE) vs. context-drift (TCM) vs. active erasure (Rac1 / neurogenesis); they make different predictions.
- **C.** Some forgetting is adaptive — intermediate decay maximizes inference (Schooler & Hertwig);
  transience aids generalization (Richards & Frankland). The target is "degrade well", not retain-all.
- **D.** AI is thinnest here: it handles *contradiction* (invalidation) but has almost no principled
  decay of stale-yet-uncontradicted facts; whether time-based decay even improves task performance is
  empirically unsettled (mixed ablations).

## T8 — Where the LLM ↔ human analogy breaks down
- **A.** Parametric vs. non-parametric are different substrates that degrade differently (interference /
  spectral-collapse vs. eviction / rank-starvation — as a function of writes, not time); humans have no
  clean parametric/non-parametric split.
- **B.** "Where is a fact stored" may be ill-posed in LLMs (edit success uncorrelated with causal-tracing
  localization, Hase 2023; the knowledge-neuron thesis was attacked).
- **C.** A writable memory is an attack surface with no biological analogue (poisoning; no standard
  write-trust defense in published systems).
- **D.** Elegant equivalences (attention = Hopfield; SAE dictionary features) may be re-description, not
  mechanism; whether long context dissolves the need for retrieval structure is genuinely open.
