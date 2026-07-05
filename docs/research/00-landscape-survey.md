# Cognitive memory & knowledge-graph replication — a landscape survey

> **Purpose:** a *sentiment of the existing research landscape* for cognitive-replication / memory
> management in AI — **not** a solution or a design. Establishes a baseline to interpret what
> "replicating human high-speed memory" would even mean.
>
> **How it was produced:** a multi-agent research workflow — 8 domains surveyed on **Claude Fable 5**
> (high effort, web-grounded, schema-constrained), each **independently fact-checked on Claude Opus 4.8**,
> then Fable-5 synthesis → Opus-4.8 completeness/accuracy critic → Fable-5 baseline. 19 agents, 0 errors,
> ~871k tokens. Every citation was adversarially checked; three fabricated 2025 venues and several
> missing canonical works were caught and folded back in (see the Validation appendix).
>
> **Domain verdicts:** 6/8 solid, 2/8 needs-caveats (agent-memory, forgetting-decay); none weak.

---

# Part I — The landscape survey (by theme)


## A cross-field sentiment-of-the-landscape survey

This report synthesizes eight independently fact-checked domain surveys — LLM/agent memory architectures, LLM-driven knowledge-graph construction, graph-augmented retrieval (GraphRAG), cognitive psychology of human memory, computational/rational models of memory, forgetting and continual learning, the mechanistic view of knowledge inside transformer weights, and memory neuroscience. It is organized by **theme** rather than by field, because the most striking fact about this literature is how the same handful of primitives recurs across domains that rarely cite one another. Where the fields genuinely converge, this is noted; where the convergence is superficial or the human-vs-machine analogy breaks down, that is flagged just as plainly. A candid maturity assessment closes the report.

A note on scope: this surveys what the fields have *done and believe*. The "what the literature offers" passages describe transferable findings, not recommendations to build anything.

---

## Theme 1 — Memory is plural, and the field agrees on roughly the same partition

Across cognitive science and AI, the single most durable finding is that memory is **not one store**. Tulving's (1972) episodic/semantic distinction — events located in subjective time versus context-free knowledge — remains foundational, later joined by procedural memory and by Baddeley & Hitch's (1974) working memory (with the episodic buffer added in Baddeley 2000). The neuropsychological dissociations grounding this (dense amnesia sparing procedural skill; Scoville & Milner 1957 on patient H.M.) are textbook-settled.

Strikingly, the AI agent literature re-derived nearly the same partition. Sumers, Yao, Narasimhan & Griffiths' **CoALA** framework (TMLR 2024) maps language agents onto working memory plus episodic/semantic/procedural long-term stores, explicitly borrowing from the symbolic cognitive architectures **Soar** (Laird 2012) and **ACT-R** (Anderson et al. 2004), both of which already separated working, procedural, episodic, and semantic memory decades earlier. Reflexion (Shinn et al. 2023) is the canonical episodic instance and Voyager (Wang et al. 2023) the procedural one.

This is a **real convergence of vocabulary**, and it is productive rather than decorative: the same decomposition organizes both the study of human memory and the design space of agents. But it is worth being honest that the mapping is an *analogy chosen by the AI field*, not an empirical discovery that agents "have" episodic memory in the way humans do. Whether human episodic and semantic memory are even truly separate systems — versus endpoints of a continuum (SPI / embedded-processes views) — remains contested within psychology itself, as does whether a distinct short-term store exists at all versus "activated long-term memory" (Cowan; temporal-context models).

---

## Theme 2 — Generation and encoding: nobody stores the raw stream

Every mature system, biological or artificial, transforms experience before storing it.

In the AI systems, the recurring principle is **write-time distillation**: store extracted units — facts, triples, notes, summaries, reflections — not raw logs. This holds across MemoryBank (Zhong et al., AAAI 2024), Mem0 (Chhikara et al. 2025), A-MEM (Xu et al. 2025), Zep/Graphiti (Rasmussen et al. 2025), HippoRAG (Gutiérrez et al., NeurIPS 2024), and Generative Agents (Park et al., UIST 2023). The knowledge-graph-construction lineage sharpens this into a two-stage discipline: **"extract freely, canonicalize precisely."** Open information extraction (the schema-free triple paradigm from TextRunner, Banko et al. 2007, through ReVerb and Stanford OpenIE) is now done by LLM prompting; the load-bearing hard problem, agreed across CESI (Vashishth et al. 2018), EDC (Zhang & Soh, EMNLP 2024), and KGGen (Mo et al., NeurIPS 2025), is **entity resolution / canonicalization**, because raw LLM extraction yields fragmented, redundant, sparse graphs. The consistent operating rule — write-side precision, read-side recall — reflects an asymmetry the literature treats as near-universal: over-merging corrupts the graph irreversibly, whereas under-merging only fragments and is recoverable per-query. (KGGen reports MINE information-retention scores of 66.07% versus GraphRAG's 47.80% and classical OpenIE's 29.84% — absolute percentage-point gaps, not relative lifts.)

Note the closed/schema side has its own lineage: REBEL (Huguet Cabot & Navigli, Findings of EMNLP 2021) established BART-based end-to-end autoregressive relation extraction; GenIE (Josifoski et al., NAACL 2022) added the specific novelty of *constrained decoding against Wikidata* to guarantee valid schema elements (its synthetic-data follow-up SynthIE is by Josifoski, Sakota, Peyrard & West).

Human encoding shows analogous principles. Craik & Lockhart's (1972) levels-of-processing framework makes durability a function of encoding depth/elaboration; Tulving & Thomson's (1973) encoding specificity establishes that *what* is encoded determines which cues can later reach it. Biologically, the dentate gyrus performs **pattern separation** — expansion-recoding similar inputs into sparse, low-overlap codes to minimize interference — which is precisely a "precision-first write side." (The explicit DG-separation / CA3-completion division is properly credited to McNaughton & Morris 1987, O'Reilly & McClelland 1994, and Treves & Rolls 1994; David Marr's 1971 archicortex theory is the autoassociative ancestor, not the source of the modern subfield mapping.)

**Convergence:** distillation-and-deduplication on write is universal. **Tension:** the human systems extract *gist and schema* continuously and non-optionally (Bartlett 1932), whereas AI extraction is a discrete pipeline stage whose errors (hallucinated or omitted triples) compound downstream — a failure mode with no biological analogue and, in most published systems, no trust model at all on writes.

---

## Theme 3 — Weighting: the near-universal "recency × importance × relevance" and its cousins

If one formula recurs across this entire landscape, it is **multi-signal weighting**, and the fields converge on remarkably similar ingredients.

The clearest AI statement is Generative Agents' (Park et al. 2023) retrieval score: normalized **recency** (exponential decay on time-since-last-access), **importance** (LLM-rated 1–10 at write time), and **relevance** (embedding cosine) — with retrieval refreshing last-access, so use earns durability. This template was widely copied.

Its intellectual ancestor is **ACT-R's declarative activation** (Anderson et al. 2004), the most empirically validated formal model in the set: Aᵢ = Bᵢ + Σⱼ Wⱼ Sⱼᵢ, where base-level Bᵢ = ln(Σ tₖ^(−d)) with d≈0.5 folds frequency and recency into one power-law-decaying quantity, and spreading activation adds context-driven associative boost. Crucially, ACT-R's associative strength is **fan-normalized** (Sⱼᵢ ≈ S − ln(fanⱼ)): a cue connected to many items lends each less weight — a principled defense against hub domination in traversal that quantitatively predicts human fan-effect slowdowns.

The **rational analysis** tradition (Anderson & Milson 1989; Anderson & Schooler 1991) grounds this normatively: retrievability tracks the environment's **need-probability**, and real demand streams (news headlines, parental speech, email) show the same frequency/recency/spacing regularities as human retention. (The framing that this makes forgetting "near-optimal" is the rational-analysis school's editorializing, not a settled result; bounded/resource-rational reframings, e.g. Lieder & Griffiths 2020, temper the optimality claim.)

Several other weighting signals recur:
- **Topology/centrality as weight.** HippoRAG's Personalized PageRank stationary mass and GraphRAG's (Edge et al. 2024) node-degree/community structure derive a memory's importance from how connected it is — a third source alongside declared salience and access counts. HippoRAG additionally weights the PPR reset vector by node specificity (inverse frequency), the graph analogue of IDF.
- **Calibrated confidence.** Knowledge Vault (Dong et al. 2014) and NELL (Carlson et al. 2010) established that automatically extracted facts must carry fused, recalibrated confidence with promotion thresholds — and NELL documents the failure mode (semantic drift) when this is absent.
- **Parameter-space importance.** In continual learning, Elastic Weight Consolidation (Kirkpatrick et al. 2017) weights each *weight's* importance by Fisher information; Synaptic Intelligence (Zenke et al. 2017) computes it online. In RL memory, Prioritized Experience Replay (Schaul et al., ICLR 2016; arXiv 2015) weights replay by TD-error (surprise).
- **Biological salience-gating.** Synaptic Tagging and Capture (Frey & Morris 1997) makes a weak trace persist only if a temporally-nearby salient event supplies plasticity-related proteins — importance and temporal proximity, not mere recurrence, decide retention. CREB/excitability-gated **neuronal allocation** (Josselyn, Han et al. 2007) determines which neurons capture a memory and co-allocates temporally proximate memories.
- **Capacity allocation under interference.** Anthropic's superposition work (Elhage et al. 2022) shows LLMs allocate representational capacity by feature importance and sparsity, dropping low-importance features first.

**Convergence (strong):** graded, use-dependent, multi-signal weighting — with access strengthening and disuse decaying — is the shared backbone. Anderson's activation equation and Park's three-factor score are recognizably the same idea at different levels of formality. **Open tension:** *where importance should come from* is unresolved. LLM-rated poignancy (Generative Agents), access statistics (ACT-R, MemoryBank), graph centrality (HippoRAG), and calibrated extractor confidence (Knowledge Vault) are all in active use, **none dominant**, and there is no shared theory of what a knowledge-graph edge weight even *means* — trust, confidence, salience, recency, and centrality are conflated across systems.

---

## Theme 4 — Traversal: retrieval as associative completion and graph walk

The second great convergence is that **retrieval is traversal / associative completion**, not lookup by address.

The canonical cognitive account is Collins & Loftus's (1975) **spreading activation** over a weighted associative network (building on Collins & Quillian 1969): activating a node propagates to neighbors, attenuating with distance and link strength — the empirical basis of semantic priming. SAM (Raaijmakers & Shiffrin 1981) formalizes recall as cue-driven probabilistic sampling over associative strengths with a sample-recover-restrengthen loop; global-matching models (MINERVA 2, Hintzman 1986; REM, Shiffrin & Steyvers 1997) compute a probe's similarity to *all* traces in parallel.

The AI field independently arrived at the same shape:
- **Personalized PageRank over an open KG.** HippoRAG (NeurIPS 2024) seeds PPR from query entities and lets probability mass diffuse — single-step multi-hop "pattern completion," reported at up to ~20% better multi-hop QA and 10–20× cheaper than iterative retrieval (IRCoT). These are the paper's best-case, dataset-specific figures; the general characterization is more modest.
- **Content-addressable completion.** Ramsauer et al.'s (ICLR 2021) proof that transformer attention is one-step retrieval in a modern continuous Hopfield network recasts attention itself as associative memory, with regimes from crisp single-pattern recall to metastable blending of similar items.
- **The three-step recall circuit inside LLMs.** Geva et al. (EMNLP 2023) show factual recall as: early-mid MLPs enrich the subject representation with attributes; the relation propagates to the final position; upper-layer attention heads query the enriched subject and extract the attribute — i.e., **MLPs store, attention traverses**. Anthropic's attribution-graph work (Lindsey et al. 2025) shows genuine multi-hop internal traversal ("Dallas → Texas → Austin" with an explicit intermediate "Texas" step), though it yields satisfying insight on only ~25% of prompts (a figure the paper hedges).

Retrieval is also **cue-dependent, not strength-absolute**: Tulving & Thomson's encoding specificity means a weak-but-matched cue beats a strong-but-mismatched one — accessibility ≠ availability, a distinction that originates with **Tulving & Pearlstone (1966)** and was later refined (not originated) by Bjork & Bjork's (1992) storage-strength/retrieval-strength formalization.

At the systems level the practical convergence is **hybrid fusion**: virtually every deployed retriever runs semantic (cosine) ⊕ lexical (BM25) ⊕ graph traversal in parallel and fuses them, commonly by Reciprocal Rank Fusion (Cormack et al. 2009) — see Zep, LightRAG (Guo et al. 2024), HippoRAG 2 (ICML 2025). The head-to-head evaluations (Han et al. 2025, "RAG vs. GraphRAG"; GraphRAG-Bench, Xiang et al. 2025) converge on **complementarity by query type**: flat vector+lexical wins detail/single-fact lookups; graph traversal wins associative/multi-hop; hierarchical summaries win global/thematic — and unions/routing beat any single mode.

**Tension worth stating carefully:** GraphRAG's own framing that vector RAG "structurally cannot" answer global/sensemaking questions is *overstated* — RAPTOR (Sarthi et al., ICLR 2024) recovers much of the benefit with a cluster tree and no entity graph, and long-context stuffing recovers more, so the barrier is practical/quality, not structural. A live, unresolved question is whether the *active ingredient* is relational graph topology or merely multi-resolution hierarchical summarization. Also unsettled: agentic per-hop traversal (Think-on-Graph, Sun et al., ICLR 2024; RoG, Luo et al., ICLR 2024) versus one-shot diffusion (HippoRAG) — depth and interpretability versus cost.

---

## Theme 5 — Consolidation, reflection, and the fast/slow architecture

A third convergence: **periodic offline synthesis of episodes into durable higher-level structure** is how these systems "learn."

The biological template is **Complementary Learning Systems** (McClelland, McNaughton & O'Reilly 1995; updated Kumaran, Hassabis & McClelland 2016): a fast, sparse, pattern-separating hippocampal encoder plus a slow, overlapping, generalizing neocortex, with **replay** during sharp-wave ripples (Wilson & McNaughton 1994; Buzsáki 2015) interleaving experience to extract structure without catastrophic interference. Disrupting ripples impairs consolidation; the claim that *prolonging* them improves memory rests essentially on a single study (Fernández-Ruiz et al. 2019) and should be read as suggestive rather than settled. Consolidation is increasingly understood as **transformation (gist extraction), not faithful copying**, and its rate is schema-dependent — congruent information integrates within ~48h (Tse et al. 2007).

The AI analogues:
- **Reflection** (Generative Agents): threshold-triggered synthesis of memory clusters into higher-level insights stored with evidence pointers.
- **Hierarchical summarization**: MemoryBank's daily→global summaries and user portraits; GraphRAG's Leiden-community summaries (Traag et al. 2019); RAPTOR's recursive summary tree.
- **Proceduralization**: Soar's "chunking" compiles deliberate problem-solving into fast production rules.
- **"Sleep-time compute"** in the Letta/MemGPT line — offline reprocessing framed explicitly by analogy to sleep.

A subtler convergence: **abstraction need not be stored to exist**. MINERVA 2 and instance-based models (Gonzalez et al. 2003; GCM) show prototypes/schemas emerge at *retrieval time* from similarity-weighted blends of raw exemplars — consolidation into summaries is optional for abstraction. The neuroscience counterpart is **structure–content factorization**: the Tolman-Eichenbaum Machine (Whittington et al. 2020) separates reusable relational structure (grid-like codes) from bound sensory particulars, enabling zero-shot transfer — and was later shown formally related to transformer attention.

**Convergence:** two-timescale (fast episodic + slow consolidated) architecture is endorsed by both neuroscience and continual-learning theory as the structural answer to interference. **Tension:** how literal biological replay is (veridical trace replay vs. *generative* replay of pseudo-experience) is unsettled, as is whether the standard "systems consolidation as transfer" model or Multiple Trace Theory (Nadel & Moscovitch 1997) — under which vivid episodic memory stays permanently hippocampus-dependent — is correct. Note MTT is distinct from the later Trace Transformation Theory (Winocur, Moscovitch & Bontempi 2010).

---

## Theme 6 — Updating and coherence: reconciliation, supersession, and the ripple problem

Append-only stores accumulate contradictions that poison retrieval; every serious system therefore needs an **update policy**, and the field has converged on a small menu.

- **Explicit reconciliation.** Mem0 (2025) compares each extracted fact against retrieved incumbents and issues ADD / UPDATE / DELETE / NOOP, reporting ~91% lower p95 latency and >90% token savings versus full-context. (An ECAI 2025 acceptance is claimed but not independently confirmed; treat as arXiv:2504.19413.)
- **Bi-temporal soft invalidation.** Zep/Graphiti (2025) carries event-time and ingestion-time on every edge; a contradicting fact *closes the incumbent's validity window* (valid_at/invalid_at) rather than deleting it, so current-state queries filter to live edges while history stays traversable. This descends directly from classical temporal-database theory (Snodgrass, TSQL2). Mem0's graph variant independently converges on edge invalidation over overwrite. (Zep's headline numbers — 94.8% vs. MemGPT's 93.4% on the DMR benchmark — are vendor-reported, a razor-thin 1.4-point margin on a benchmark Zep itself later criticizes as near-saturated; its LongMemEval temporal-reasoning gains are the stronger result.)

The human analogue is arresting: **memory reconsolidation** (Nader, Schafe & LeDoux 2000) shows that reactivating a consolidated memory returns it to a labile, re-writable state — a biological "update-on-read" window — and the misinformation effect (Loftus & Palmer 1974) shows post-event information blends into or overwrites the original. Retrieval is a *write* operation: the testing effect (Roediger & Karpicke 2006) and retrieval-induced forgetting (Anderson, Bjork & Bjork 1994) both show accessing a memory changes its future state and its neighbors'.

The **mechanistic-editing** literature is the hardest-edged version of updating and delivers a sobering lesson. Locate-then-edit methods treat the MLP down-projection as a linear associative memory: ROME (Meng et al. 2022) rewrites one (subject, relation)→object fact with a rank-one update; MEMIT (Meng et al. 2023) scales to ~10,000 edits. But:
- **Local edits don't propagate.** RippleEdits (Cohen et al., TACL 2024) shows edited facts fail to update their logical neighbors (aliases, compositions, entailments) — a direct formalization of why a graph mutation has a required "ripple set," and why local writes create global incoherence.
- **Cumulative writes corrupt the store.** Sequential ROME-style edits grow weight norms and destroy dominant singular directions carrying general ability, collapsing the model (Gupta et al., EMNLP 2024; Yang et al., ACL 2024). AlphaEdit (Fang et al., ICLR 2025 Outstanding Paper) projects each edit onto the null space of preserved keys, boosting prior methods ~36.7% and delaying collapse — though the guarantee holds only under the *linear associative-memory approximation*, not over the full nonlinear model, and spectral degradation under long edit sequences persists.

**Convergence:** everyone agrees new information must be reconciled against incumbents, and that unconstrained overwriting is catastrophic — the parameter-space version (protect important weights) and the graph version (invalidate, don't delete) and the biological version (trust/reliability-gated reconsolidation) are the same defensive principle. **Open:** hard deletion vs. soft invalidation has no consensus (auditability and temporal reasoning vs. store growth and retrieval noise), and whether editing can ever be a safe *maintenance* mechanism at scale is genuinely unresolved.

---

## Theme 7 — Degradation: forgetting is lawful, contested in mechanism, and increasingly seen as a feature

This is the richest cross-field theme and also the one where AI systems are thinnest.

**What is agreed.** Forgetting is lawful and negatively accelerated — fast then slow — from Ebbinghaus (1885) onward. Spacing and retrieval practice robustly improve long-term retention (Cepeda et al. 2006; Roediger & Karpicke 2006), among the most replicated findings in psychology, with optimal spacing scaling with the target retention interval — the basis of computational schedulers (Pavlik & Anderson 2005; the Multiscale Context Model, Mozer et al. 2009; Half-Life Regression, Settles & Meeder 2016). Catastrophic forgetting is a real, fundamental consequence of naive sequential training in distributed networks (McCloskey & Cohen 1989; French 1999), and the stability–plasticity tradeoff is intrinsic. And there is broad agreement that **some forgetting is adaptive**: Schooler & Hertwig's "How Forgetting Aids Heuristic Inference" (2005) shows intermediate decay *maximizes* inference accuracy; Richards & Frankland's (2017) "persistence and transience" argues transience aids generalization; Bjork's "desirable difficulties" tradition treats accessibility loss as functional.

**What is contested — and it is a century-old dispute still unresolved.**
- **Decay vs. interference vs. retrieval failure.** ACT-R posits genuine time-based power-law decay of trace *strength*; SIMPLE (Brown, Neath & Chater 2007) and temporal-context models (Howard & Kahana 2002) reproduce identical curves from discriminability loss and context drift with *no decay parameter*. The data underdetermine the mechanism — and the consequences differ sharply (adding items degrades old ones under interference; time alone does not). Note that the tidy claim "forgetting is retrieval failure, not erasure" is *not* fully common ground: it fits New Theory of Disuse and SIMPLE, but ACT-R itself models real strength decay. Biology adds a further live option: **active forgetting** via neurogenesis-driven remodeling and Rac1/AMPA-receptor removal (Hardt, Nader & Nadel 2013), with "silent engrams" (Tonegawa et al.) showing some amnesia is reversible retrieval failure, not erasure.
- **The functional form.** Whether the aggregate power law (Wixted & Ebbesen 1991) is *real* or an averaging artifact of exponential individuals (Anderson & Tweney; Murre & Chessa; Averell & Heathcote 2011) is disputed — consequential because power laws imply scale-free ever-slowing loss while exponentials imply a characteristic lifetime.

**The continual-learning menu** (three families, no free lunch): regularization (EWC — among the most-cited, not provably "the" most; SI; LwF, Li & Hoiem 2016), rehearsal/replay (iCaRL, Rebuffi et al. 2017; GEM, Lopez-Paz & Ranzato 2017), and parameter isolation/architecture (Progressive Networks, Rusu et al. 2016). Replay is generally the strongest baseline when storing data is permissible. Even here foundations are contested: Huszár's "Note on the quadratic penalties in elastic weight consolidation" (PNAS 2018) questioned EWC's derivation, and a distinct failure mode — **loss of plasticity** (the degrading *ability to learn new things*, Dohare et al., Nature 2024) — reframes what the problem even is.

**Where AI memory is genuinely thin.** The agent/KG systems handle *contradiction* (invalidation) well but have almost no principled mechanism for **decay of stale-yet-uncontradicted facts**, age-driven consolidation of episodic detail, or salience-based pruning. MemoryBank operationalized an Ebbinghaus curve (R = e^(−t/S), rehearsal resets t and increments S) — an early and influential move, not the literal "first" such mechanism — and MemGPT (Packer, Wooders, Lin, Fang, Patil, Stoica & Gonzalez 2023) casts eviction as OS-style paging with recursive summarization (demotion, not deletion). But whether explicit time-based decay actually *improves task performance* over simple relevance+recency ranking is empirically unsettled, with mixed ablations. This is the clearest place the landscape is thin: the weighted-decay half of a degrading memory is under-built and under-evaluated in AI, precisely where cognitive science is richest.

---

## Theme 8 — Where the LLM-memory / human-memory analogy breaks down

The analogy is generative but leaks. Honest points of divergence:

1. **Parametric vs. non-parametric knowledge are different substrates with different degradation.** In-weights knowledge (Physics of LM: Allen-Zhu & Li 2024 — ~2 bits/parameter capacity; and critically, *storage ≠ extractability* — a fact can be memorized yet unqueryable without diverse/paraphrased exposure) degrades by **catastrophic interference and edit-induced spectral collapse**, i.e. as a function of *accumulated writes and their geometry*, not time. External stores degrade by rank starvation, invalidation, or eviction. HippoRAG 2 explicitly frames non-parametric growing stores *against* fine-tuning into weights (which forgets catastrophically). Human memory has no clean parametric/non-parametric split. Titans (Behrouz, Zhong et al., Google, NeurIPS 2025), with a gradient-"surprise"-gated write and adaptive weight-decay forgetting, and EM-LLM (Fountas et al., ICLR 2025), which segments context into episodic events by Bayesian surprise, are the current test-time/neural-memory counterpoints that partly bridge this gap.

2. **"Where is a fact stored" may not be a well-posed question in LLMs.** Causal tracing (ROME) localizes recall to mid-layer MLPs at the last subject token, but Hase et al. (NeurIPS 2023) showed **edit success is statistically uncorrelated with tracing localization** — you can rewrite a fact at a layer other than where tracing says it lives. The "knowledge neuron" thesis was directly attacked (Niu et al., ICLR 2024: neurons largely track token-expression patterns, not knowledge). Given additive multi-layer composition, "stored at layer L" is itself contested. No such indeterminacy afflicts an external record.

3. **Retrieval-time reinforcement is real in humans, optional in machines.** Access-driven strengthening (Generative Agents' last-access refresh, MemoryBank's strength increment, ACT-R's decaying trace per use) is a *design choice* in AI, whereas in humans retrieval is intrinsically a memory-modifying, sometimes memory-distorting event (testing effect, reconsolidation, misinformation).

4. **Writable memory is an attack surface with no biological analogue.** LLM-managed writable stores are injectable/poisonable, and — as the surveys note — most published architectures have *no trust model at all on writes*. There is an active memory-poisoning attack literature but no standard defense. This is orthogonal to anything in human memory.

5. **Long-context as solvent.** Whether million-token contexts erode the case for retrieval structure is genuinely open; current evidence favors retrieval on cost and distraction-resistance, but the boundary keeps moving and the benchmarks (LoCoMo, with documented label noise; LongMemEval; DMR, near-saturated) are themselves disputed, making cross-paper accuracy claims hard to compare.

6. **The Hopfield-attention equivalence is exact but may be re-description.** That attention *is* one-step Hopfield retrieval is mathematically true; whether trained heads actually *operate* as pattern-completing associative memories in that sense (versus the equivalence being a formal reframing) is debated. Likewise, whether sparse-autoencoder features are the model's "true" ontology or an imposed one is unresolved (feature splitting/absorption, unexplained "dark matter" variance).

A general caution the validators repeatedly flag: the graph/DB-engineering tie-ins to cognitive science ("traversal reweights the graph," "update-on-read") are *analogies drawn by survey authors*, not claims the cited neuroscience/psychology papers make.

---

## State of maturity — an honest ledger

**Well-established (textbook-settled, replicated, mechanistically or formally grounded):**
- The plurality of memory systems and the episodic/semantic/procedural/working partition (Tulving; Baddeley; H.M.).
- Synaptic plasticity (LTP/LTD) as the cellular substrate of associative memory (Bliss & Lømo 1973); place cells and grid cells and the cognitive-map framework (2014 Nobel).
- Spreading activation / semantic priming; ACT-R declarative activation as a quantitatively validated model of weighted, decaying, use-strengthened retrieval.
- The lawful, negatively-accelerated forgetting curve; the spacing and testing effects.
- Catastrophic forgetting as a real, fundamental phenomenon; the stability–plasticity tradeoff.
- Hippocampal necessity for rapid episodic encoding; some form of CLS fast/slow separation; replay's causal role in consolidation.
- Transformer FFN layers as key-value associative memories, and the MLP-store / attention-route division of factual recall (replicated across model families).
- Superposition and the linear/directional representation of features; SAEs recovering causally-steerable features.
- Locate-then-edit methods reliably rewriting individual facts at modest scale.

**Solid but with live, substantive debate:**
- Decay vs. interference vs. retrieval failure as the cause of forgetting (unresolved after a century); the exact functional form (power vs. exponential-mixture).
- Standard systems consolidation vs. Multiple Trace / Trace Transformation Theory.
- Graph-structured retrieval genuinely beats flat RAG on multi-hop and global queries — but the *magnitude*, the *active ingredient* (topology vs. hierarchy), and the *cost-benefit* are contested; complementarity/routing is the emerging consensus.
- Bi-temporal invalidation as the accepted pattern for dynamic knowledge (borrowed from mature DB theory).
- Whether weight editing constitutes real knowledge update (ripple failures suggest not, without retraining/consolidation).
- Whether rational analysis is explanatory or post-hoc; whether ACT-R's equations describe a mechanism or a convenient aggregate.

**Emerging / speculative (promising, thinly evaluated, or vendor-reported):**
- LLM-as-memory-manager (write/link/delete by model judgment) — non-determinism, cost, reproducibility, and poisoning concerns unaddressed at the policy level.
- Whether explicit time-based decay improves agent task performance over relevance+recency (mixed ablations).
- Constrained editing (AlphaEdit-style) scaling to thousands-to-millions of lifetime in-weights edits.
- Test-time/neural long-term memory modules (Titans, EM-LLM) as a parametric counterpoint to external stores.
- Attribution-graph circuit tracing as a general method (satisfying on ~25% of prompts).
- Active/adaptive forgetting mechanisms (neurogenesis, Rac1) and their engineering transfer.
- Whether SAE features are the model's true ontology.
- Machine unlearning and principled decay/pruning of stale-yet-uncontradicted memory — the thinnest spot in AI memory, and the widest gap versus cognitive science.

**Bottom line.** The fields have independently converged on a shared toolkit — weighted multi-signal retrieval (recency × importance × relevance and its formal ancestor, ACT-R activation), graph/associative traversal (spreading activation, Personalized PageRank, Hopfield completion), fast/slow consolidation with reflection, reconciliation-and-supersession over append, and graded degradation. That convergence is real and repeatedly yields working mechanisms. But the deepest questions are open in *both* the science and the engineering: the mechanism of forgetting, the meaning of a memory's weight, where knowledge is "stored" in a distributed system, whether structure or hierarchy does the retrieval work, and how to make a memory *degrade well* rather than merely grow. The AI systems are strongest exactly where they borrowed mature ideas (temporal databases, key-value memory, hybrid IR) and weakest where cognitive science is richest but hardest to formalize — principled, adaptive, trustworthy forgetting.

---

# Part II — The cognitive baseline

# COGNITIVE BASELINE

*A sentiment-level statement of what the existing research collectively implies must be in place — as commitments, not components — before the question "how might one replicate human high-speed memory?" is even coherent to ask. This is a reading of the field's tacit baseline, not a solution, an architecture, or a design. Where the field converges, it is marked; where it is guessing or divided, that is marked just as plainly. Citations are hedged per the critic's corrections: several 2025 venue claims are downgraded to preprints, and self-reported benchmark numbers are flagged as such.*

The framing word is *interpreting*. What follows is not what you would build but what you would have to already believe — the vocabulary, the laws, and the acknowledged ignorance — to interpret any claim of replication as meaningful rather than as a category error. "High-speed" is read here as the property that distinguishes human memory most sharply: rapid, often one-shot encoding into an enormous store, followed by near-immediate cue-driven retrieval that no addressing scheme explains. The baseline is the set of commitments that makes that phenomenon discussable.

---

## PRIMITIVES — the irreducible entities you must grant before the question is coherent

**1. Memory is plural.** The single most durable finding across both cognitive science and AI is that memory is not one store. The working / episodic / semantic / procedural partition is the shared vocabulary — Tulving's episodic/semantic split, Baddeley & Hitch's working memory, and the older Atkinson-Shiffrin modal (multi-store) model that the survey omitted and that belongs here as the ancestor of the whole discussion. Squire's declarative/nondeclarative taxonomy is the other canonical cut and should sit beside Tulving's, not be replaced by it. The neuropsychological dissociations (H.M.; amnesia sparing skill) make this textbook-settled *as a partition*. Two honesty flags carry all the way down: (a) whether these are truly separate *systems* or endpoints of a continuum (SPI / embedded-processes / temporal-context views) is contested inside psychology, as is whether a distinct short-term store exists at all versus "activated long-term memory"; and (b) when the AI field re-derived nearly the same partition (CoALA, borrowing Soar and ACT-R), that is a *productive analogy chosen by engineers*, not evidence that an artifact "has" episodic memory the way a person does. The baseline grants the plurality as a framing device, not as a settled ontology.

**2. The stored unit is a transformed trace, never the raw stream.** No mature system — biological or artificial — stores experience verbatim. Encoding is distillation: the hippocampal dentate gyrus performs pattern separation (expansion-recoding into sparse, low-overlap codes), and AI systems store extracted units (facts, triples, notes, summaries) rather than logs. To even talk about replication you must accept that the atom of memory is an abstraction produced at write time, and that *what* is encoded fixes which cues can later reach it (encoding specificity). One correction the survey needed: levels-of-processing ("deeper encoding = more durable") is not a clean law — it is famously circular (depth is operationally defined by what is later remembered), and the standard corrective is transfer-appropriate processing (Morris, Bransford & Franks 1977): durability depends on the *match* between encoding and retrieval, not on depth per se.

**3. Traces carry graded, multi-signal weight — not binary presence.** A memory is not "there or not"; it has an activation/strength that is some composition of recency, frequency, importance/salience, relevance to the current cue, and (in networked stores) topological centrality. ACT-R's declarative activation is the most formal statement of this, and its fan-normalization (a cue linked to many items lends each less) is a genuinely principled idea. But the critic is right that calling ACT-R "the most empirically validated model in the set" is an unearned ranking: global-matching models (MINERVA-2 — properly Hintzman 1984/1988, not 1986 — and REM) and temporal-context models are competing, well-supported traditions. Treat weighted, graded, use-dependent traces as the primitive; treat any *particular* equation as one school, not the winner.

**4. Access is associative and content-addressable, not by location.** You reach a memory through cues and links, not through an address. This is the deepest cross-field convergence: spreading activation over a weighted associative net (Collins & Loftus), cue-dependent recall where a weak-but-matched cue beats a strong-but-mismatched one (accessibility ≠ availability, originating with Tulving & Pearlstone 1966), and, on the machine side, content-addressable completion — original Hopfield (1982) and Kanerva's sparse distributed memory (1988) as the ancestors, the modern continuous-Hopfield/attention equivalence as the current form. The associative-completion character of retrieval is what makes human recall *fast*: it is one-step pattern completion, not search. Any replication conversation that models retrieval as keyed lookup has already left the baseline.

**5. There is a fast/slow, two-timescale division of labor.** A fast, sparse, one-shot encoder (hippocampus) feeding a slow, overlapping, generalizing store (neocortex) is the Complementary Learning Systems primitive, and continual-learning theory endorses the same split as the structural answer to interference. This is arguably *the* primitive for "high-speed": rapid one-shot capture is possible only because it is quarantined from the slow store that would otherwise be overwritten. Honesty flag the survey under-stated: the "slow neocortex" premise is itself challenged by evidence of *fast* cortical schema learning (Tse et al. 2007) — the same paper the survey cites approvingly — so the clean fast/slow dichotomy is a working assumption with a known crack.

**6. Capacity is bounded, so prioritization is forced.** Working memory is sharply capacity-limited (Miller's ~7, Cowan's ~4, chunking) and any store must allocate finite representational room — the superposition view shows even LLM weights allocate capacity by feature importance and drop low-importance features first. Bounded capacity is *why* weighting and forgetting exist at all. This is a primitive, not a nuisance: an unbounded store would not need most of the dynamics below, and human memory is emphatically bounded.

---

## DYNAMICS — the laws that must operate over those primitives

**1. Use strengthens; disuse decays.** Retrieval refreshes recency and earns durability; unaccessed traces lose accessibility. The recurring "recency × importance × relevance" weighting (Generative Agents) and its formal ancestor (ACT-R base-level activation) are the same dynamic at different levels of formality. This is convergent and load-bearing.

**2. Forgetting is lawful and negatively accelerated — but its mechanism is genuinely unknown.** The Ebbinghaus curve (fast then slow) is textbook. What is *not* settled, and has not been for a century, is the mechanism: time-based decay of trace strength (ACT-R) vs. interference/discriminability loss (SIMPLE) vs. context drift (temporal-context models) vs. active, neurogenesis-driven erasure (Rac1/AMPA removal) — with "silent engrams" showing some amnesia is reversible retrieval failure rather than erasure. The consequences diverge sharply (adding items degrades old ones under interference; time alone does not), so this is not a cosmetic dispute. Correction to fold in: the tidy slogan "forgetting is retrieval failure, not erasure" is *not* common ground — it fits New Theory of Disuse and SIMPLE but contradicts ACT-R's real strength decay and the active-forgetting biology. The functional form (a true power law vs. an averaging artifact of exponential individuals) is likewise disputed.

**3. Retrieval is itself a write.** In humans, accessing a memory modifies it and its neighbors — the testing effect (which predates Roediger & Karpicke 2006; cf. Abbott 1909 / Gates 1917), retrieval-induced forgetting, reconsolidation (a consolidated memory reactivated becomes labile and re-writable), and the misinformation effect. This collapses the read/write separation that engineered stores take for granted, and it is why the human/machine analogy is asymmetric: retrieval-time reinforcement is *intrinsic* in humans, *optional* in machines. Correction: reconsolidation (Nader et al. 2000) should not be stated as a clean "update-on-read" law — its boundary conditions and human replicability are actively contested.

**4. Episodes are consolidated into gist by offline replay — as transformation, not copying.** Replay during sharp-wave ripples interleaves experience to extract structure without catastrophic interference; sleep-dependent consolidation (Diekelmann & Born 2010 — a systems-level literature the survey skipped) is part of this. Consolidation *transforms* (extracts gist/schema) rather than faithfully copying, and its rate is schema-dependent. The AI analogues (reflection, hierarchical summarization, "sleep-time compute," Soar chunking) are recognizably the same move. Two honesty flags: whether replay is veridical or *generative* (pseudo-experience — the origin being Robins 1995 / Shin et al. 2017, uncited in the survey) is unsettled; and abstraction may not require storage at all — instance-based models (MINERVA-2) show prototypes emerging at *retrieval* time from raw exemplars.

**5. New information must reconcile against incumbents — append-only is fatal.** Every serious account requires an update policy: supersession, trust/reliability-gating, and (in the temporal-database lineage) bitemporal soft invalidation rather than deletion. The parameter-space version (protect important weights — EWC/SI), the graph version (invalidate, don't overwrite), and the biological version (reconsolidation) are the same defensive principle. And the mechanistic-editing literature delivers the sobering law: local edits don't propagate to logical neighbors (the ripple problem, RippleEdits), and cumulative edits corrupt the store (spectral collapse). Note the vendor/self-report hedges the critic flagged — Mem0's latency/token figures and Zep's razor-thin DMR margin are self-reported.

**6. Some forgetting is adaptive — degradation is partly a feature.** Intermediate decay can *maximize* inference accuracy (Schooler & Hertwig 2005); transience aids generalization (Richards & Frankland 2017); "desirable difficulties" treat accessibility loss as functional. A memory that only grows is not a good memory. This reframes the whole degradation question: the target of replication is a store that *degrades well*, not one that retains everything.

**7. Spacing and retrieval practice improve retention** — among the most replicated findings in psychology, and the basis of computational schedulers. Correction: "optimal spacing scales with the retention interval" is oversimplified; Cepeda et al. (2008) found the optimal gap-to-interval *ratio* is non-monotonic and shrinks at longer intervals.

---

## OPEN QUESTIONS — where the field simply does not know, and where replication talk outruns evidence

**1. What does a memory's weight *mean*?** There is no shared theory. Trust, confidence, salience, recency, frequency, and centrality are conflated across systems, and *where importance should come from* — LLM-rated poignancy, access statistics, graph centrality, calibrated extractor confidence — has no dominant answer. You cannot claim to replicate a weighting you cannot define.

**2. What is the mechanism of forgetting?** (See Dynamic 2.) Unresolved after a century, and the candidate mechanisms make different predictions. This is the single largest gap sitting under any replication claim.

**3. Where is a fact "stored" in a distributed system — is the question even well-posed?** Causal tracing localizes recall to mid-layer MLPs, but edit success is statistically *uncorrelated* with tracing localization (Hase et al. 2023), and the knowledge-neuron thesis (Dai et al. 2022) was directly attacked (neurons may track token expression, not knowledge). "Stored at layer L" is contested. Human memory has no clean parametric/non-parametric split at all, so the substrate question does not even transfer cleanly.

**4. Does relational structure or multi-resolution hierarchy do the retrieval work?** GraphRAG's claim that flat retrieval "structurally cannot" answer global questions is overstated — RAPTOR recovers much with a summary tree and no entity graph. Whether the active ingredient is graph topology or just hierarchical summarization is live and unresolved; the emerging consensus is only that complementarity/routing beats any single mode.

**5. Are the human memory systems truly distinct, and is consolidation transfer or permanent dependence?** Standard systems consolidation vs. Multiple Trace Theory (vivid episodic memory stays permanently hippocampus-dependent) is unsettled — which also destabilizes the "hippocampal necessity" claim the maturity ledger treated as settled.

**6. Can editing/updating ever be safe maintenance at scale?** Ripple failures and spectral collapse suggest local weight editing is not real knowledge update without retraining/consolidation. Constrained methods (AlphaEdit — a preprint; the "ICLR Outstanding Paper" label is unverified and its ~36.7% figure is paper-reported) delay collapse only under a linear approximation, not the full model. Hard-delete vs. soft-invalidate has no consensus.

**7. Is the weighted-decay half of memory buildable at all?** This is the widest gap between the science and the engineering. Principled decay of *stale-yet-uncontradicted* facts, age-driven consolidation of episodic detail, and salience-based pruning are the thinnest spot in AI memory — and machine *unlearning* is named as the widest gap yet has no anchor in the survey (e.g., Bourtoule et al. 2021 SISA). Whether explicit time-based decay even *improves* task performance over plain relevance+recency is empirically unsettled (mixed ablations). This is precisely where cognitive science is richest and engineering is emptiest.

**8. Is retrieval-time reinforcement necessary, and can a writable store be trusted?** In humans, retrieval-as-write is intrinsic; in machines it is optional and usually omitted. And a machine-writable store is an *attack surface with no biological analogue* — most published architectures have no trust model on writes, and there is an active memory-poisoning literature with no standard defense. Any replication that ignores this is not modeling human memory; it is modeling something with a novel failure mode humans don't have.

**9. Do the elegant equivalences describe mechanism or merely re-describe it?** That attention *is* one-step Hopfield retrieval is mathematically exact; whether trained heads *operate* as pattern-completers is debated. Whether SAE dictionary features (Bricken et al. 2023; Templeton et al. 2024 — the papers that produced the features the survey discusses) are the model's "true" ontology or an imposed one is unresolved (feature splitting/absorption, unexplained variance). Formal equivalence is not mechanistic identity.

**10. Does long context dissolve the need for retrieval structure?** Genuinely open; current evidence favors retrieval on cost and distraction-resistance, but the benchmarks (LoCoMo, LongMemEval, near-saturated DMR) are themselves disputed, so cross-paper claims barely compare.

---

## The honest bottom line

The fields have independently converged on a shared toolkit — plural stores, transformed traces, graded multi-signal weighting, associative/content-addressable access, fast/slow consolidation, reconcile-don't-append updating, and lawful-but-adaptive degradation. That convergence is real and repeatedly yields working mechanisms, and it is strongest exactly where AI borrowed mature ideas (temporal databases, key-value/associative memory, hybrid IR, dense retrieval — whose founding lineage, Lewis et al. 2020 / REALM / DPR / RETRO, and the differentiable-memory ancestry, NTM/DNC and Memory Networks, the survey should have named). But two cautions define the baseline as *sentiment* rather than *fact*. First, much of the cross-field mapping is an analogy drawn by AI and by survey authors — the neuroscience and psychology papers rarely make the graph/DB claims attributed to them, and the human/machine correspondence leaks at every substrate boundary. Second, the deepest questions are open in *both* the science and the engineering simultaneously: the mechanism of forgetting, the meaning of a weight, the locus of stored knowledge, whether structure or hierarchy does the work, and how to make a memory degrade well rather than merely grow. The field's implied baseline for "replicating human high-speed memory" is therefore not a blueprint but a posture: grant the primitives, respect the dynamics, and treat anyone who claims the open questions are closed as having left the evidence behind.

---

# Part III — Validation appendix (Opus 4.8)

## Per-domain verdicts

- **agent-memory** — verdict: **needs-caveats**, self-confidence: high. 4 gaps, 5 corrections flagged.
- **kg-construction** — verdict: **solid**, self-confidence: high. 4 gaps, 2 corrections flagged.
- **graph-rag** — verdict: **solid**, self-confidence: high. 6 gaps, 3 corrections flagged.
- **human-memory** — verdict: **solid**, self-confidence: high. 5 gaps, 4 corrections flagged.
- **computational-cognition** — verdict: **solid**, self-confidence: high. 3 gaps, 4 corrections flagged.
- **forgetting-decay** — verdict: **needs-caveats**, self-confidence: high. 5 gaps, 3 corrections flagged.
- **llm-mechanistic** — verdict: **solid**, self-confidence: high. 6 gaps, 3 corrections flagged.
- **neuroscience** — verdict: **solid**, self-confidence: high. 6 gaps, 7 corrections flagged.

## Completeness & accuracy critic (verbatim)

Returning a gap/error list only. I audited the report against my own knowledge of these literatures (no repo work required).

---

## 1. Shaky / unverified / likely-misattributed citations

- **KGGen "Mo et al., NeurIPS 2025"** — arXiv:2502.09956 (Stanford). NeurIPS 2025 acceptance is unverified; likely a fabricated venue. Treat as arXiv/preprint. The MINE 66.07/47.80/29.84 numbers are the paper's own self-report on its own benchmark — flag as self-evaluation, not independent.
- **Titans "Behrouz, Zhong et al., Google, NeurIPS 2025"** — arXiv:2501.00663; no confirmed NeurIPS 2025 acceptance at time of writing. Venue likely fabricated; downgrade to preprint.
- **AlphaEdit "ICLR 2025 Outstanding Paper"** — the "Outstanding Paper" award claim is unverified and should be checked before asserting; the ~36.7% figure is paper-reported.
- **"HippoRAG 2 (ICML 2025)"** and **"HippoRAG 2 headline multi-hop / 10–20× cheaper than IRCoT"** — the cost/accuracy figures belong to HippoRAG *1*; the report mixes them under a HippoRAG line. Confirm which paper each number comes from.
- **Niu et al. "ICLR 2024"** (knowledge-neuron critique) — venue uncertain (this line of work appeared at ACL/EMNLP-adjacent venues); verify.
- **EDC "Zhang & Soh, EMNLP 2024"** — verify venue (EDC/Extract-Define-Canonicalize); it may be a preprint/workshop rather than main EMNLP.
- **"Craik & Lockhart (1972)" levels-of-processing** stated uncritically as a durability law — LoP is famously criticized for circularity (depth is operationally defined by what is later remembered). Presenting it as a settled mechanism overstates it; Morris, Bransford & Franks (1977) transfer-appropriate processing is the standard corrective and is missing.
- **"MINERVA 2, Hintzman 1986"** — the canonical MINERVA-2 references are Hintzman 1984 (Psych Rev) and 1988; 1986 is a narrower paper. Minor mis-anchor.
- **Mem0 "~91% lower p95 latency / >90% token savings"** — vendor/author self-report on their own harness; already hedged on venue but the performance numbers deserve the same "self-reported" flag.

## 2. Missing subfields / seminal works / systems (named)

Human memory:
- **Atkinson & Shiffrin (1968) modal/multi-store model** — glaring omission in Theme 1's "memory is plural" discussion.
- **Miller (1956) "magical number seven"** and the working-memory *capacity* literature (Cowan's 4; Chase & Simon 1973 chunking) — absent from any capacity discussion.
- **Squire's declarative/nondeclarative taxonomy** (Squire 1992/2004) — the canonical partition; report leans on Tulving but omits Squire.
- **Sleep-dependent consolidation** (Diekelmann & Born 2010) — Theme 5 cites only ripples; the systems-level sleep literature is missing.
- **Engram / optogenetic tagging** (Liu et al. 2012; Ramirez et al. 2013; Josselyn & Tonegawa 2020) — "silent engrams" is name-dropped without the engram framework.
- **Hippocampal indexing theory** (Teyler & DiScenna 1986; Teyler & Rudy 2007) and **Schacter's constructive memory / seven sins** (relevant to Theme 7's "forgetting as feature") — both absent.

AI/ML — the entire RAG and neural-memory ancestry is missing:
- **RAG origin: Lewis et al. (2020), REALM (Guu et al. 2020), DPR (Karpukhin et al. 2020), FiD, RETRO (Borgeaud et al. 2022)** — the report discusses RAG throughout but never cites its founding papers or the dense-retrieval lineage. Also **cross-encoder rerankers / ColBERT** — the report's "hybrid fusion is RRF everywhere" ignores learned reranking, which is at least as common in production.
- **Neural Turing Machine / DNC (Graves et al. 2014/2016)** and **Memory Networks / End-to-End MemNN (Weston 2015; Sukhbaatar 2015)** — the seminal differentiable external-memory line, entirely absent.
- **Original Hopfield (1982)** and **Kanerva Sparse Distributed Memory (1988)** — cited only via the modern continuous Hopfield; the associative-memory ancestors are missing.
- **Knowledge-graph embeddings / completion (TransE, Bordes et al. 2013)** and the KB substrate (Freebase/DBpedia/YAGO/Wikidata, ConceptNet) — the KG-construction theme omits the embedding-based completion tradition entirely.
- **Knowledge-neuron original thesis (Dai et al. 2022)** — Niu's critique is cited but not the target paper.
- **SAE dictionary-learning papers (Bricken et al. 2023 "Towards Monosemanticity"; Templeton et al. 2024 "Scaling Monosemanticity"; Cunningham et al. 2023)** — Theme 8 discusses SAE features without citing the work that produced them; only Elhage 2022 superposition is cited.
- **Induction heads (Olsson et al. 2022)** and **Transformer-XL / Compressive Transformer (Rae et al. 2019)** — in-context "retrieval" and parametric context-memory, missing.
- **Machine unlearning** is named as "thin" but no unlearning literature is cited (e.g., Bourtoule et al. 2021 SISA) despite being flagged as the widest gap — a named subfield with no anchor.
- **Generative/pseudo-rehearsal origin** (Robins 1995; Shin et al. 2017 Deep Generative Replay) — "generative replay" is invoked in Theme 5 without attribution.

## 3. Overstated consensus / understated disagreement

- **"ACT-R... the most empirically validated formal model in the set"** — an unearned ranking; global-matching (REM/MINERVA-2) and TCM proponents would dispute. State it as one strong tradition, not the winner.
- **Hybrid RRF fusion "virtually every deployed retriever"** — overstated. Many production stacks are single dense retriever + cross-encoder rerank, not tripartite RRF. Understates the reranker-vs-fusion disagreement.
- **Reconsolidation (Nader et al. 2000)** is presented as a clean "update-on-read" law; the report omits that its **boundary conditions and human replicability are actively contested** — a real disagreement understated.
- **Allen-Zhu & Li "~2 bits/parameter"** — stated as fact; it is a specific result under specific synthetic training regimes, with contested generality. Flag as regime-dependent.
- **Spacing: "optimal spacing scales with retention interval"** — oversimplified; Cepeda et al. (2008) found the optimal-gap-to-RI *ratio* is nonmonotonic and shrinks with longer RIs. The clean scaling claim overstates consensus.
- **Testing effect "Roediger & Karpicke 2006"** as origin — the effect dates to Abbott (1909)/Gates (1917); minor over-crediting.
- **CLS presented as jointly "endorsed by neuroscience and continual-learning theory"** — the report flags generative-vs-veridical replay but understates that CLS's *neocortical slow-learning* premise is itself challenged by fast cortical schema learning (Tse et al. 2007, which the report cites approvingly without noting the tension it creates for standard CLS).
- **"Hippocampal necessity for rapid episodic encoding"** listed as textbook-settled — largely true, but the strong version is contested by multiple-trace/reinstatement findings the report itself cites elsewhere; the maturity ledger doesn't cross-reference that tension.

Net: citation-accuracy is high for the human-memory and mechanistic-interpretability cores; the weak points are (a) three probable fabricated/overstated 2025 venues (KGGen, Titans, AlphaEdit award), (b) a near-total absence of the RAG/neural-external-memory founding literature despite RAG being a central theme, and (c) missing human-memory canon (Atkinson-Shiffrin, Miller, Squire, sleep, engram).
