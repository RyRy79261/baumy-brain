# T3-weighting — Weighting = recency x importance x relevance (+ cousins)

**Topic verdict:** mixed

## Adjudicated claims

### A) Graded, use-dependent, multi-signal weighting is the shared backbone of adaptive recall; Generative Agents' 3-factor score (recency × relevance × importance) is functionally ≈ ACT-R activation (base-level + spreading activation).
- **Verdict:** weakened-but-stands (confidence: high)
- **Strongest support:** Two independent traditions — a cognitive-optimality model (ACT-R) and an engineering system built with no cognitive intent (Park et al. 2023) — both instantiate a use-history term (recency/frequency ↔ base-level decay) and a context-match term (relevance ↔ spreading activation Sₖᵢ) as first-class, separately-weighted factors. The two terms any adaptive recall system must carry reappear in both, which is real (if modest) design-pattern convergence.
- **Strongest attack:** The convergence claim survives only in a form so weak it is near-tautological (every forgetting model is monotone-decreasing in time), and collapses the moment you demand the actual functional forms match: ACT-R's power-law decay is itself disputed (Heathcote et al. 2000 show it is an averaging artifact vs. exponential), while Park uses exponential — so the human anchor and the AI form disagree. Worse, the steelman's mapping importance ↔ ACT-R base-level frequency is internally contradicted by Claim D: Generative-Agents importance is a use-INDEPENDENT, one-time content-poignancy rating, not a use-frequency count. The seam is exactly at importance, and Park inherits recency+relevance from IR/recommender lineage, not ACT-R, so 'independent rediscovery' in a 2–3-signal design space is the null hypothesis, not a signal.
- **Open question:** Does any memory system's 'importance' term actually behave like ACT-R's use-history base-level (frequency of access), or is importance categorically a content-salience prior distinct in kind — such that the A-convergence holds ONLY at recency+relevance and fails at the third factor?

### B) ACT-R fan-normalization (down-weighting associative strength by log node degree) is a principled defense against hub domination in retrieval AND predicts the empirically robust human fan effect — the same normalization for the same information-theoretic reason.
- **Verdict:** weakened-but-stands (confidence: high)
- **Strongest support:** As a description the parallel is real and recurs: ACT-R's −ln(fan), the down-weighting of promiscuous cues, and inverse-degree normalization in graph/embedding retrieval all make a high-degree cue contribute less per associate, and in each case a cue linked to everything is genuinely less diagnostic. ACT-R does formally predict the ~200–300 ms/fan RT cost (Anderson 1974), so the mechanism-plus-phenomenon pairing is not invented.
- **Strongest attack:** The escalation to 'provably shared cause / same generative reason' collapses three unrelated derivations into one: ACT-R −ln(fan) is Bayesian log-diagnosticity (optimal only inside a stipulated equiprobable-partition model), embedding hubness (Radovanović et al. 2010) is a concentration-of-measure geometry artifact with no diagnosticity content, and Personalized PageRank normalization (HippoRAG) is a stochastic-matrix requirement (rows sum to 1) — same behavior, three causes, and not even the same function (inverse-degree ≠ inverse-log-degree ≠ PPR). Additionally 'the fan effect is the signature of correct normalization' relabels a measured RT deficit as a feature (the classic rational-analysis unfalsifiability move), and the human anchor is contested (Bunting et al. 2004 tie it to interference-resistance not activation-division; inhibition and SAM/global-matching accounts compete).
- **Open question:** Is there a genuinely shared normative quantity behind inverse-degree down-weighting across cognition and retrieval, or is 'promiscuous nodes carry less weight' merely a convergent behavior reachable from a Bayesian, a geometric, and a linear-algebra derivation independently — i.e., is the parallel structural coincidence rather than shared cause?

### C) Human retrievability tracks environmental need-probability (Anderson & Schooler 1991); the unqualified 'near-optimal' framing is contested and should be read as bounded/resource-rational (Lieder & Griffiths 2020).
- **Verdict:** weakened-but-stands (confidence: high)
- **Strongest support:** The empirical bedrock is the hardest-to-dismiss result in the cluster: across three unrelated corpora (NYT headlines, CHILDES parental speech, email) the probability an item recurs co-varies with recency, frequency, and spacing in the same direction as human retention/practice curves, and the spacing/desirable-difficulty effect falls out — a broad qualitative correspondence, not a single post-hoc fit. The claim is also honestly hedged: it explicitly names 'near-optimal' as contested and points to the field's own mature self-correction (resource-rational analysis), which makes the baseline harder, not easier, to refute.
- **Strongest attack:** The 'same shape' evidence is a match between two AGGREGATED power laws, and Heathcote et al. (2000) show power-law shape is precisely what averaging over heterogeneous individual curves manufactures — so the celebrated correspondence may be a shared aggregation artifact. The three corpora are all heavy-tailed, Zipfian, human-generated text (one statistical family, not three independent confirmations), feeding the standard 'just-so story' unfalsifiability charge against rational analysis (analyst picks environment, corpus, cost, objective). And resource-rationality is not cleanly more falsifiable — BBS commentaries flag that a free cost-function + approximation-algorithm + utility can render almost any bias 'optimal given costs.'
- **Open question:** Does the need-probability correspondence survive at the level of individual (unaveraged) memory and environmental recurrence curves, and would it hold for non-Zipfian / non-human-text environments — i.e., can it be separated from the averaging artifact and the same-statistical-family selection?

### D) Where 'importance' comes from is unresolved and no dominant standard has emerged (LLM-rated poignancy vs. access-count vs. graph centrality vs. calibrated confidence); there is no shared theory of what an edge weight MEANS, unlike recency and relevance which have normative anchors.
- **Verdict:** survives (confidence: high)
- **Strongest support:** This is a claim of absence verified by exhibiting disagreement, and the disagreement is real and demonstrable by inspection of what three leading real systems compute: Park (LLM-rated salience), Zhong/MemoryBank (access/decay frequency), Gutiérrez/HippoRAG (graph centrality). No single operationalization dominates the 2023–24 systems, and unlike recency (need-probability decay) and relevance (associative diagnosticity), importance has no comparable normative derivation. Both the steelman and the red team agree the narrow factual core is unbroken.
- **Strongest attack:** The strong metaphysical wording ('different quantities in different units, no shared semantics, incommensurable') overstates it: LLM-rated salience, access frequency, centrality, and confidence can each be read as a noisy estimator of one latent target — expected future utility / need-probability of the item — so the real situation is UNDER-UNIFICATION, not incommensurability. And the sharp 'recency/relevance anchored vs. importance free-floating' dichotomy is overdrawn by the steelman's own concessions (recency's form is contested per Heathcote; relevance-as-diagnosticity is model-dependent per contested fan-effect theory) — making it a difference of degree, not kind.
- **Open question:** Do the four importance proxies empirically correlate on shared items — i.e., are they measuring one latent utility/need-probability quantity (under-unification) or genuinely distinct constructs (incommensurability)? This is testable and would settle whether D is a deep semantic void or merely an un-unified engineering knob.

**Strawman attacks flagged:** Red-team D3 ('possible triviality / category error'): reframes D as claiming importance is 'a special, deep open problem' and then dismisses it because every ML hyperparameter lacks agreed semantics. The original D only claims importance is unresolved with no dominant standard — a 'so what' deflection about significance, not a refutation of the factual claim, and it smuggles in the unsupported premise that the systems 'never claimed' any normative standard.; Red-team B3 ('degree-normalization suppresses the correct central entity just as much as an uninformative one'): valid as an independent point, but it slightly reframes the steelman — which spoke of hubs that co-occur with everything being LESS informative — into a claim that hubs are always wrong, then rebuts that stronger version. The steelman never asserted hubs are always the wrong answer.; Red-team A1's 'monotone-decreasing is unfalsifiable in the bad way': this actually lands on the steelman's own explicitly-flagged honest concession rather than on Claim A's substance, so it is more a re-labeling of a conceded weakness than a fresh attack; presenting it as a defeater slightly inflates its force.

**Overstated enrichment flagged:** A: 'independently rediscovered the exact factorization cognitive science derived from optimality' — Park et al. inherit recency+relevance from the IR/recommender lineage, not from ACT-R, and the 2–3-signal design space makes convergence the expected null; 'exact factorization' + 'independent rediscovery' is the overreach.; A: mapping Generative-Agents importance ↔ ACT-R base-level FREQUENCY — a use-independent one-time poignancy rating is being equated with a running use-count; this both overstates the term-by-term tightness and directly contradicts the steelman's own Claim D.; B: 'provably shared cause and shared fix / same generative reason' across ACT-R −ln(fan), embedding hubness, and PPR — three distinct derivations (Bayesian diagnosticity, high-dimensional geometry, stochastic-matrix constraint) collapsed into one; 'provably' holds only inside ACT-R's stipulated equiprobable model.; B: 'Bayes-optimal, not a hack' — optimal only within a chosen mutually-exclusive, exhaustive, equiprobable (1/n) partition of a cue's associates, which is a modeling assumption, not an environmental fact.; C: 'justify any decay/frequency/priority weighting scheme — biological OR artificial' — launders a human empirical correspondence into normative authority for hand-set engineering constants (e.g., 0.995/hour decay) that were fit to no environment's recurrence statistics.; C: resource-rational analysis is 'more defensible precisely because it is falsifiable' — contested on the record; adding a free cost-function + approximation algorithm can reduce, not increase, falsifiability.; D: 'different quantities in different units, no shared semantics / incommensurable' — overstates a real gap; the four proxies plausibly estimate one latent need-probability/utility target, so the defensible version is under-unification, not metaphysical incommensurability.

**New open questions:** Do the four importance operationalizations (LLM-rated poignancy, access frequency, graph centrality, calibrated confidence) empirically correlate on the same items — settling whether importance is one latent quantity noisily estimated (under-unification) or genuinely distinct constructs (incommensurability)?; Can the Anderson & Schooler need-probability correspondence be demonstrated at the individual-curve level rather than only in aggregate, thereby surviving Heathcote et al.'s averaging-artifact critique — and does it hold in non-Zipfian / non-human-text environments to answer the same-statistical-family selection charge?; Is inverse-degree/-log-degree down-weighting a genuine shared-cause convergence or three independent routes (Bayesian log-diagnosticity, concentration-of-measure geometry, stochastic-matrix normalization) that happen to produce similar behavior — i.e., can 'same reason' be distinguished from 'same behavior' empirically?; Is resource-rational analysis falsifiable in practice given free choice of cost function and approximation algorithm, or does that flexibility make it accommodate arbitrary biases — the unresolved dispute the steelman's 'more falsifiable' claim depends on?; Given that a use-independent content-salience prior (Generative-Agents importance) does NOT map onto ACT-R's use-history base-level term, does any convergence between LLM-memory systems and ACT-R exist at the importance factor at all, or is the shared backbone strictly a recency+relevance phenomenon?

---

## Steelman (enrichment)

STEELMAN — "Weighting = recency × importance × relevance (+ cousins)"

All primary citations below were verified live (title/author/year/venue). Self-reported benchmark numbers are flagged as such and NOT relied on.

---

## CLAIM A — Graded, use-dependent, multi-signal weighting is the shared backbone (Generative Agents 3-factor ≈ ACT-R activation)

**Verdict: Strong, and the convergence is deeper than vocabulary — it is functional-form convergence.**

The strongest case is not "both use several signals" but that **both decompose retrievability into the same three functionally-distinct terms, and the LLM system independently rediscovered the exact factorization cognitive science derived from optimality.**

- **Generative Agents** (Park, O'Brien, Cai, Morris, Liang, Bernstein, *UIST '23*, arXiv:2304.03442): retrieval score = α_recency·recency + α_relevance·relevance + α_importance·importance, with recency an **exponential decay** (factor 0.995) over hours since last access, importance an LLM-assigned poignancy score, relevance query–memory embedding cosine. Verified.
- **ACT-R activation** (Anderson et al., "An integrated theory of the mind," *Psychological Review* 111(4):1036, 2004; base-level learning traceable to Anderson 1991): Aᵢ = Bᵢ (base-level: frequency + **power-law recency**, Bᵢ = ln Σⱼ tⱼ^(−d), d≈0.5) + Σ Wₖ Sₖᵢ (spreading activation from cues = **relevance/associative match**). Verified.

The mapping is tight and term-by-term:
- **recency** ↔ ACT-R base-level decay (both monotone-decreasing in elapsed time; Park's exponential is a computational stand-in for ACT-R's power law — same sign, same role);
- **relevance** ↔ ACT-R spreading activation Sₖᵢ (cue-conditioned, context-driven);
- **importance** ↔ base-level **frequency/prior** component (a use-independent salience prior that raises baseline retrievability).

Why this is genuine convergence, not analogy: the two terms that *must* be present for any adaptive memory — a **use-history term** (recency/frequency) and a **context-match term** (relevance) — are the two ACT-R has carried since the 1970s, and they reappear as first-class, separately-weighted factors in a system built by people optimizing an engineering objective with no cognitive-modeling intent. The independent rediscovery is the evidence. Additional convergent instances that strengthen the "shared backbone" claim rather than being one-offs:
- **MemoryBank** (Zhong, Guo, Gao, Ye, Wang, *AAAI 2024*, arXiv:2305.10250): strength updates via the **Ebbinghaus forgetting curve** (S = exp(−t/τ)) reinforced by access — i.e. a recency×frequency base-level term reimplemented from a different psychological source. Verified.

**Most defensible formulation:** "Adaptive memory retrieval — biological or artificial — composes at minimum a *use-history* signal (recency/frequency), a *context-fit* signal (relevance/spreading activation), and often a *value/salience prior* (importance), combined as a graded, monotone-in-each-factor score." Stated that way the claim is near-unfalsifiable-in-a-good-way: it is the design pattern any recall system converges on, and two independent traditions instantiate it.

**Honest scope limit (keeps the steelman rigorous):** the combination *rule* differs — ACT-R **sums log-terms** (a product in probability space, principled from Bayes), whereas Generative Agents **sum min-max-normalized** heuristic scores with hand-set weights. The deep identity is the **factorization**; the arithmetic ("×" vs "+") is the shallow part. The title's "×" is literally truer of ACT-R (log-additive = multiplicative in odds) than of the agent systems that inspired the slogan.

---

## CLAIM B — ACT-R fan-normalization (hub down-weighting) is a principled defense against hub domination AND predicts the human fan effect

**Verdict: Strongest of the four. This is a rare case where a cognitive constraint and an engineering pathology have a *provably shared cause and shared fix.***

- **The fan effect** (Anderson, "Retrieval of propositional information from long-term memory," *Cognitive Psychology* 6:451–474, **1974**): recognition RT for a fact rises ~200–300 ms per additional association ("fan") on its concepts. Verified. Formalized in ACT-R as spreading activation from cue k being **divided across its fan**: Sₖᵢ = S − ln(fanₖ), i.e. a high-degree (hub) cue spreads *less* activation per associate. The associative strength **decreases with the log of the node's degree** (Anderson & Reder 1999; formula verified via secondary ACT-R sources).
- **The engineering pathology:** in any graph/embedding retrieval, high-degree "hub" nodes co-occur with everything, so an un-normalized spreading/similarity score lets hubs dominate every query (the "hubness" problem in high-dimensional retrieval; the popular-node sink in PageRank-style propagation).

The steelman: **fan-normalization is exactly hub down-weighting, and it is Bayes-optimal, not a hack.** Anderson & Milson's rational analysis (below) shows the −ln(fan) term is what you get when you treat a cue's diagnosticity as **P(needed | cue)**: a cue associated with n things provides ~1/n bits of evidence for any one of them, so log-diagnosticity falls as ln(fan). The human RT cost and the engineering fix therefore have the **same generative reason** — a promiscuous cue is genuinely less informative. This is the deepest cross-field point in the whole topic: the fan effect is not a bug the brain suffers, it is the *signature of correct normalization*, and graph-retrieval systems that down-weight hubs are independently paying the same optimal cost.

- **Convergent modern instance:** **HippoRAG** (Gutiérrez, Shu, Gu, Yasunaga, Su, *NeurIPS 2024*, arXiv:2405.14831) uses **Personalized PageRank** over a KG for multi-hop retrieval — PPR's inverse-degree normalization is structurally the same hub-taming move, dressed as a neurobiological (hippocampal-index) analogy. Verified as a real NeurIPS 2024 paper. *Caveat: its "up to 20% over SOTA" figure is author-reported; cite the mechanism, not the number.*

**Most defensible formulation:** "Down-weighting associative strength by (log) node degree is simultaneously (i) the ACT-R account of the empirically robust human fan effect and (ii) a principled, Bayes-justified defense against hub domination in associative retrieval — the same normalization for the same information-theoretic reason." Both halves are independently verifiable; the conjunction is the contribution.

**Honest caveat:** the fan effect has live theoretical competitors (e.g. global-matching / SAM-family memory-strength accounts; Anderson & Reder 1999 is itself a defense against these). So B should be stated as "ACT-R *offers* a principled account that both fits the fan data and maps onto hub-normalization" — not "ACT-R is the settled explanation of the fan effect." The mapping to hub down-weighting survives regardless of which memory model wins, because inverse-degree normalization is model-independent.

---

## CLAIM C — Retrievability tracks environmental need-probability (Anderson & Schooler); "near-optimal" framing is contested (bounded/resource-rational)

**Verdict: The empirical core is exceptionally strong; the epistemically honest position *is* the contested one, and that strengthens rather than weakens the claim.**

**The strong, defensible half — the environmental statistics result:**
- **Anderson & Schooler, "Reflections of the environment in memory," *Psychological Science* 2:396–408, 1991** (verified). They measured, in three real corpora — *New York Times* headlines, parental speech (CHILDES), and email — the probability that an item is "needed" (recurs) as a function of how frequently, recently, and in what temporal pattern it appeared. The environmental **need-probability curves have the same shape as the human retention and practice curves** (power-law recency, log-frequency, spacing effects). The desirable-difficulty/spacing effect falls out too.
- Foundation: **Anderson & Milson, "Human memory: An adaptive perspective," *Psychological Review* 96(4):703–719, 1989** (verified) — memory as a rational **P(need)** estimator; the recency and frequency curves are *derived* from optimality against environmental statistics, not fit post hoc.

This is the load-bearing evidence for the whole "recency × importance × relevance" enterprise: it shows those factors are not arbitrary engineering knobs but **estimators of a real environmental quantity (need-probability)**. That is the honest justification for any decay/frequency/priority weighting scheme — biological or artificial. It is a *very* hard result to explain away: the correspondence holds across three unrelated corpora.

**The contested half — steelmanning the "near-optimal" hedge as itself the correct position:**
The strongest scholarship does **not** claim humans are globally optimal. **Lieder & Griffiths, "Resource-rational analysis," *Behavioral and Brain Sciences* 43:e1, 2020** (verified) reframes the whole program: cognition optimizes performance **subject to computational-resource constraints**, so behavior is "optimal *given costs*," which explains systematic deviations from unbounded optimality (and generated a full BBS peer-commentary round — the contestation is on the record). This is the mature descendant of Anderson's rational analysis, and it is *more* defensible precisely because it is falsifiable and predicts biases.

**Most defensible formulation:** "Human retrievability demonstrably tracks environmental need-probability (Anderson & Schooler 1991) — that correspondence is robust and cross-corpus. The *unqualified* 'near-optimal' gloss is contested and should be replaced by **resource-rational**: memory approximates the need-probability computation under bounded resources." Stating C this way is not a retreat — it is citing the field's own self-correction, and it makes the baseline *harder* to attack, because it no longer depends on a strong-optimality claim that any single bias would refute.

**Honest caveat for the baseline:** the near-optimality of *ACT-R's specific parameterization* (d≈0.5, particular decay forms) is a separate, weaker claim than the qualitative need-probability correspondence. Keep them apart: the qualitative environmental result is bedrock; the exact functional form is a modeling choice.

---

## CLAIM D — WHERE importance comes from is unresolved; no shared theory of what an edge weight MEANS

**Verdict: Correct, and this is the most important claim to preserve — the honest steelman here is *for the negative claim*.**

The strongest case that this gap is real and structural, not a literature-coverage artifact:

1. **The candidate sources are mutually incompatible in units and semantics**, and none has a normative derivation the way recency/relevance do:
   - **LLM-rated importance** (Generative Agents' poignancy prompt, verified) — a subjective 1–10 elicited from a model; no ground truth, prompt-sensitive, uncalibrated.
   - **Access-count / reinforcement** (MemoryBank's Ebbinghaus strengthening, verified) — importance = use-frequency, a *behavioral* proxy.
   - **Graph centrality** (HippoRAG's PageRank/PPR, verified) — importance = structural position, a *topological* proxy.
   - **Calibrated confidence** — a *probabilistic* proxy, different units again.

   These are not four estimators of one agreed quantity; they measure **frequency, subjective salience, connectivity, and certainty** respectively. That is precisely the "no shared theory of what an edge weight MEANS" claim, and it is demonstrable by inspection of what each system computes.

2. **The contrast with recency/relevance is the clincher.** Recency has a normative anchor (need-probability decay; Anderson & Schooler). Relevance has one (spreading activation / semantic match, and an information-theoretic diagnosticity reading via fan). **Importance has no comparable normative derivation** — nothing in the cognitive literature says the third Generative-Agents term *equals* a specific environmental quantity. In ACT-R the nearest analogue (the base-level **prior/frequency** term) is well-defined; but the LLM systems' "importance" is a *free-floating salience score* that does not map cleanly onto that prior. So even the A-convergence has a **seam exactly at importance** — which independently corroborates D.

3. **No dominant standard has emerged**, and the surveyed 2023–2024 systems each pick a *different* one (Park: LLM-rated; Zhong: access/decay; Gutiérrez: centrality) — verified across three real papers. Divergence across the leading systems *is* the evidence for "none dominant."

**Most defensible formulation:** "Recency and relevance have normative anchors (need-probability; associative diagnosticity). *Importance* and *edge weight* do not: across the leading systems they are variously operationalized as LLM-rated salience, access frequency, graph centrality, or confidence — different quantities in different units, with no shared semantics or optimality derivation. This is a genuine open problem, not a survey gap."

This is the claim a domain expert would defend most confidently, because it is a **claim of absence** that you verify by showing the candidates disagree — and they demonstrably do.

---

## Cross-field convergence: where it is genuinely deep vs. merely lexical

**Deep (mechanism + shared generative reason):**
- **Recency/decay ↔ base-level learning ↔ Ebbinghaus** — same monotone use-history term; recency justified by *need-probability* (Anderson & Schooler 1991). Deep.
- **Fan-normalization ↔ hub down-weighting** (Claim B) — same inverse-(log-)degree operation for the same information-theoretic reason (cue diagnosticity). **Deepest convergence in the topic.**
- **The three-factor factorization itself** (Claim A) — independently rediscovered; convergence in *functional form*, not just word choice.

**Shallow / lexical (flag honestly):**
- The **combination arithmetic**: heuristic weighted-sum of normalized scores (agent systems) vs. log-additive Bayesian activation (ACT-R). Same slogan ("×"), different math.
- **"Importance"** as a shared term (Claim D) — same word, four incompatible referents. Purely lexical.
- **Neurobiological branding** (HippoRAG's hippocampal-index framing) — the *mechanism* (PPR) is a real convergence on hub-normalization; the neuro-analogy itself is motivational dressing, not evidence.

---

## Verification ledger (all primary items confirmed real; venue + year checked)

- Anderson (1974), *Cognitive Psychology* 6:451–474 — fan effect. ✓
- Anderson & Milson (1989), *Psychological Review* 96(4):703–719 — rational analysis. ✓
- Anderson & Schooler (1991), *Psychological Science* 2:396–408 — environmental need-probability. ✓
- Anderson & Reder (1999) — ACT-R fan model, S−ln(fan). ✓ (formula via ACT-R secondary sources)
- Anderson et al. (2004), *Psychological Review* 111(4):1036 — integrated theory / base-level. ✓
- Lieder & Griffiths (2020), *Behavioral and Brain Sciences* 43:e1 — resource-rational analysis. ✓
- Park et al. (2023), *UIST '23*, arXiv:2304.03442 — Generative Agents, 3-factor, decay 0.995. ✓
- Zhong et al. (2024), *AAAI 2024*, arXiv:2305.10250 — MemoryBank, Ebbinghaus. ✓
- Gutiérrez et al. (2024), *NeurIPS 2024*, arXiv:2405.14831 — HippoRAG, Personalized PageRank. ✓ (real NeurIPS-2024 paper)

**Flagged — cite mechanism, not metric:** HippoRAG's "up to 20% over SOTA" is author-reported; MemoryBank's gains are self-reported. Neither number is independently verified here — the steelman rests on their *mechanisms* (PPR hub-normalization; forgetting-curve base-level), which are real, not on their benchmark deltas. No 2025 venue or self-reported metric is relied upon anywhere above.

---

## Red-team (dismissal)

# RED TEAM — "Weighting = recency × importance × relevance (+ cousins)"

Primary citations in the steelman are real (I re-verified the contestable ones live). The attack below is aimed at the steelman's *strong* moves — "functional-form convergence," "independent rediscovery," "provably shared cause," "Bayes-optimal," "normative anchor" — not at the papers' existence.

---

## CLAIM A — "3-factor ≈ ACT-R activation is functional-form convergence, independently rediscovered"

This is the steelman's most rhetorically load-bearing claim and it is the weakest under load.

**1. The "functional form" that supposedly converges is itself a contested averaging artifact.** ACT-R base-level learning is a *power-law* decay (Bᵢ = ln Σ tⱼ^−d). Heathcote, Brown & Mewhort, "The power law repealed: the case for an exponential law of practice," *Psychonomic Bulletin & Review* 7:185–207 (2000), fit 7,910 learning series from 475 subjects and found the exponential beat the power law in **every unaveraged dataset** — the power law is a **bias produced by averaging across individual curves**. So the specific decay form ACT-R carries is the disputed one. The steelman then concedes Generative Agents uses *exponential* decay (0.995) and rescues the match by saying both are "monotone-decreasing in elapsed time — same sign, same role." But *monotone-decreasing in time* is satisfied by literally every forgetting model ever proposed. Collapsing the convergence claim onto that invariant is unfalsifiable in the bad way: it can never fail, so it carries no evidential weight. The moment you demand the *actual functional form* match, the two systems disagree, and the human side's form is itself under attack.

**2. "Independent rediscovery" is false, and convergence in a tiny design space is the null, not a signal.** Park et al.'s retrieval score is standard information-retrieval / recommender-system furniture: a recency term, a cosine-relevance term, and a salience prior have been the backbone of IR ranking since TF-IDF and recency-ranked feeds — a tradition Park et al. were embedded in, *not* ACT-R (which they do not build on). "Convergence" is being asserted between a cognitive optimality derivation and an engineering lineage that already contained recency+relevance for unrelated reasons. And the design space is nearly exhausted by three signals: a use-history term, a query-match term, and a prior is close to *all* the orthogonal information a retrieval score can carry. When the space of possible answers is that small, two systems landing in the same place is the expected outcome, not evidence of a shared deep truth. Convergence is evidence only when divergence was live and the space was large; here neither holds.

**3. A and D contradict each other exactly at "importance."** Claim A maps Generative-Agents *importance* ↔ ACT-R *base-level frequency*. But Generative-Agents importance is an LLM **poignancy rating assigned once at ingestion from content** — it is explicitly **use-independent**, not a frequency-of-access term. ACT-R base-level frequency is the running count of *uses over time*. These are different in kind (content-salience vs. use-history). The steelman's own Claim D then says importance is a "free-floating salience score that does not map cleanly onto that prior." So the steelman claims deep convergence at importance (A) and no shared semantics at importance (D). Both cannot be true. The honest reading is D's: the mapping in A is the analogy being imposed by the reader, and the "seam at importance" is where the whole convergence story tears.

**4. The title's "×" survives only by switching algebras per system.** Park sums min-max-normalized heuristics; ACT-R sums log-terms. The steelman salvages "×" via "log-additive = multiplicative in odds." That identity holds only inside ACT-R's specific independence assumptions and only for the activation equation — it is not what Park's importance/recency terms do, and it is a re-description, not a shared operation. The slogan is kept alive by picking whichever arithmetic is convenient for each system.

**What resists:** "any adaptive recall system composes a use-history term and a context-match term" is genuinely robust — because it is nearly tautological. Tautological-robust ≠ deep cross-tradition convergence. Downgrade "independent rediscovery of the exact factorization cognitive science derived from optimality" to "two systems in a small design space both use the obvious signals."

---

## CLAIM B — "fan-normalization = hub down-weighting, Bayes-optimal, same generative reason"

The steelman calls this the strongest; the *description* is strong, the *"provably shared cause"* is a false equivalence.

**1. Three different mechanisms are being collapsed into one.** The steelman claims −ln(fan), embedding "hubness," and PageRank normalization are "the same inverse-degree operation for the same information-theoretic reason." They are not:
- ACT-R **−ln(fan)** is a *log-diagnosticity* term (Anderson & Milson).
- Embedding **hubness** (Radovanović, Nanopoulos & Ivanović, *JMLR* 2010) is a *concentration-of-measure artifact of high-dimensional Euclidean/cosine geometry* — points near the data mean become nearest-neighbors of everything. That is a distance-metric pathology, with no diagnosticity content.
- **Personalized PageRank** degree-normalization (HippoRAG) is a *stochastic-matrix requirement* — rows must sum to 1 for a well-defined random walk. It is a linear-algebra necessity, not a Bayesian computation.

These produce superficially similar "high-degree nodes contribute less" behavior via **unrelated derivations**, and they are not even the same function (inverse-degree ≠ inverse-*log*-degree; PPR ≠ −ln(fan)). "Same operation, same reason" is precisely the engineer's-analogy-imposed-on-the-science move the task asks me to flag.

**2. "Bayes-optimal" is optimal-within-a-chosen-model.** The −ln(fan) diagnosticity result requires treating a cue's n associates as a mutually-exclusive, exhaustive, *equiprobable* (1/n each) hypothesis set. Real associations are not equiprobable, and that partition is a modeling choice, not an environmental fact. "Provably" is provable inside Anderson & Milson's stipulated probability model only.

**3. "The fan effect is not a bug, it's the signature of correct normalization" relabels a deficit as a feature — the classic rational-analysis unfalsifiability move.** The fan effect is a measured RT *cost*; calling that cost "optimal" is exactly the maneuver critics of rational analysis object to. And on the engineering side, degree-normalization suppresses a *correct central entity* just as much as a promiscuous-and-uninformative one — PPR down-weights by degree regardless of whether the hub is the right answer. So the "same optimal cost" framing hides that the engineering "fix" can suppress the truth; the parallel to an RT deficit is not that the two are both optimal, it's that both *pay a price*, for different reasons.

**4. The human anchor is genuinely contested.** Bunting, Conway & Heitz, "Individual differences in the fan effect and working memory capacity," *Journal of Memory & Language* 51 (2004): individual differences track **interference-resistance, not amount of activation**, contradicting the activation-division account. Anderson & Reder themselves migrated toward **inhibition/suppression** rather than link-weakening; SAM/global-matching offer competing accounts. The steelman concedes this. Good — but it means the "predicts the human fan effect" half rests on one theory among live competitors.

**What resists:** as a *description* — "inverse-(log-)degree down-weighting recurs in associative retrieval, and in each case a promiscuous cue carries less weight" — the parallel is real and useful. Only "same generative reason / provably shared cause" is the overreach.

---

## CLAIM C — "retrievability tracks need-probability; near-optimal → resource-rational"

The empirical core (Anderson & Schooler 1991) is the strongest thing in the cluster and largely survives. Two real attacks remain.

**1. The correspondence is a match between two *averaged* power laws — and averaging manufactures power laws.** Anderson & Schooler match aggregate corpus need-probability curves to aggregate memory retention curves and note "the same shape" (power-law). But Heathcote et al. (2000, above) show power-law shape is precisely what averaging over heterogeneous individual curves *fabricates*. If both the environmental and the memory curve are power-law only in aggregate, the celebrated "same shape" may be a **shared artifact of aggregation**, not evidence of adaptation. Matching two averaged power laws is weaker evidence than it looks.

**2. Rational analysis is a "just-so story": the analyst chooses the environment, the corpus, the cost, and the objective.** The three corpora (NYT headlines, CHILDES, email) are post-hoc selected and are *all heavy-tailed, Zipfian, human-generated text* — and any heavy-tailed source yields power-law recurrence. So "cross-corpus robustness" is robustness across three draws from the *same statistical family*, not three independent confirmations. There is no external principle fixing which environment memory is "adapted to," which is the standard unfalsifiability charge against rational analysis.

**3. Resource-rationality is *not* obviously more falsifiable — the steelman's escape partly backfires.** Lieder & Griffiths (2020) is a genuine BBS target article, but the peer commentaries include exactly the objection that resource-rational analysis has **too many free knobs** (choice of cost function + approximation algorithm + utility) to be readily falsified: adjust the assumed computational cost and almost any observed bias becomes "optimal given costs." Adding a free resource-cost function generally *reduces* falsifiability. Citing the field's self-correction is honest, but it trades a strong-but-testable optimality claim for a flexible framework whose own falsifiability is contested — not a clean strengthening.

**4. False equivalence for the AI baseline (the smuggled "or artificial").** Even granting human retrievability tracks need-probability, nothing shown establishes that an LLM-agent's recency×importance×relevance score *estimates* need-probability. The agent's 0.995/hour decay is **hand-set**, fit to no environment's recurrence statistics. Invoking Anderson & Schooler to "justify any decay/frequency/priority weighting scheme — biological *or artificial*" borrows a human empirical result's normative authority for an engineered knob that made no corresponding measurement. That "or artificial" is the imposed equivalence.

**What resists:** the qualitative, cross-corpus environmental correspondence is a real and hard-to-dismiss result, and the resource-rational reframing of "near-optimal" is the honest position. The bedrock claim — human retrievability correlates with environmental recurrence statistics — survives; only the "therefore the engineering knobs are principled estimators" extension is unearned.

---

## CLAIM D — "where importance comes from is unresolved; no shared theory of an edge weight"

This is the claim that most resists, because it is a claim of *absence* verified by exhibiting disagreement, and the disagreement (LLM-rating vs. access-count vs. centrality vs. confidence) is real and demonstrable by inspection. I will not manufacture a refutation. But the *strong* steelman version overstates it in two ways:

**1. "Incompatible referents / different quantities" may be false — they may be noisy estimators of one target.** LLM-rated salience, access frequency, graph centrality, and calibrated confidence can each be read as a proxy for **expected future utility / need-probability of the item** — the *same* quantity recency estimates from the time axis. If so, importance is not semantically incommensurable; it is multiple un-unified estimators of one latent quantity. That reading *supports* the original claim's careful wording ("none dominant, unresolved") while *refuting* the steelman's stronger metaphysical wording ("different quantities in different units, no shared semantics"). The correct red-team verdict: the gap is real, but it is **under-unification, not incommensurability** — a difference of degree from recency/relevance, not a categorical void.

**2. The contrast "recency/relevance are anchored, importance is not" is overdrawn by the steelman's own concessions.** Per Claim C, recency's specific parameterization is contested and its functional form is disputed (Heathcote); per Claim B, relevance-as-diagnosticity is model-dependent and rests on a contested theory of the fan effect. So all three factors are *less* firmly anchored than the clean dichotomy implies. Importance is the most ungrounded, but the "normatively anchored vs. free-floating" split is a difference of degree the steelman inflates into a kind.

**3. Possible triviality.** "Different systems operationalize a soft construct differently, with no agreed semantics" is true of nearly every ML hyperparameter (what does an attention weight *mean*? an embedding dimension?). Framing importance's underdetermination as a special, deep open problem may overstate it: importance could simply be a pragmatic tuning knob that never needed a normative theory, in which case the "gap" is a category error — measuring an engineering hyperparameter against a scientific-optimality standard the systems never claimed.

**What resists (state precisely):** the *narrow* factual core — no single operationalization of importance dominates the 2023–24 systems, and the leading systems each pick a different one — is correct and well-supported by the three real papers (Park: LLM-rated; Zhong: access/decay; Gutiérrez: centrality). That divergence is the evidence, and it holds. Only the escalation to "metaphysically distinct quantities with no possible shared referent" is unearned.

---

## Cross-field "convergence" — where it is a false equivalence

- **"Independent rediscovery is the evidence" is broken epistemics.** Convergence is evidence of a deep shared truth only when divergence was possible and the option space was large. Across all four claims the space is tiny (2–3 retrieval signals; one obvious "down-weight promiscuous nodes" move) and the AI systems inherit recency/relevance from IR, not from cognition. In a small space, convergence is the *null hypothesis*, not the signal — so it cannot bear the weight the steelman places on it.
- **"Same operation, same reason" (fan/hubness/PPR)** collapses log-diagnosticity, a high-dimensional geometry artifact, and a stochastic-matrix constraint into one story. Same *behavior*, three *causes*.
- **"Biological or artificial" (Claim C)** launders a human empirical result into justification for hand-set engineering constants that measured nothing.
- **The extra convergent instances lean on disputed foundations.** MemoryBank's Ebbinghaus curve rests on Murre & Dros, "Replication and Analysis of Ebbinghaus' Forgetting Curve," *PLOS ONE* 10:e0120644 (2015) — a genuine replication but **n = 1 subject on nonsense syllables**, and it found a **non-smooth curve with a ~24h upward jump** (sleep consolidation) that the smooth exponential does *not* capture. So "reimplemented from a different psychological source" is reimplementing a model whose own replication shows systematic misfit.
- **HippoRAG's hippocampal branding**: the steelman already concedes it is dressing. Agreed — and note its "up to 20% over SOTA" is author-reported; rely on nothing but the PPR mechanism.

## Net

- **A**: overclaimed. "Convergence" reduces either to a tautology (both terms decrease with time) or to a contested/false mapping (importance↔frequency, contradicted by D). Downgrade to "obvious signals in a small design space."
- **B**: description strong, causal-identity claim false. Keep "inverse-log-degree down-weighting recurs"; drop "same generative reason / provably shared cause."
- **C**: empirical bedrock (cross-corpus need-probability correspondence) resists; the averaging-artifact and just-so-story attacks nick it; the "biological or artificial" transfer to engineering knobs is unearned; resource-rationality is honest but not clearly more falsifiable.
- **D**: the narrow factual claim (no dominant importance metric; leading systems diverge) is the most defensible thing in the whole cluster and I could not break it. The *strong* steelman ("incommensurable quantities, no shared referent") overstates it — the four proxies plausibly estimate one latent need-probability/utility target, so the real situation is **under-unification, not incommensurability**.

**Sources:** [Heathcote, Brown & Mewhort 2000 — power law repealed](https://pubmed.ncbi.nlm.nih.gov/10909131/) · [Anderson & Schooler 1991 — reflections of the environment in memory](https://users.cs.northwestern.edu/~paritosh/papers/KIP/AndersonSchooler1991ReflectionsOfEnvironmentOnMemory.pdf) · [Bunting et al. 2004 — individual differences in the fan effect / WM capacity](https://www.sciencedirect.com/science/article/abs/pii/S0749596X04000877) · [Anderson & Reder — "The fan effect: new results and new theories"](https://www.researchgate.net/profile/Lynne-Reder/publication/228716798_The_fan_effect_New_results_and_new_theories/links/0912f5075c4ef08523000000/The-fan-effect-New-results-and-new-theories.pdf) · [Murre & Dros 2015 — replication of Ebbinghaus forgetting curve](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0120644)

