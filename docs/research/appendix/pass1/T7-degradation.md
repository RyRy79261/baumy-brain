# T7-degradation — Degradation: forgetting lawful, mechanism unknown, partly a feature

**Topic verdict:** robust

## Adjudicated claims

### A) Forgetting is lawful/negatively-accelerated (Ebbinghaus); spacing + testing robustly improve retention — among the most replicated effects in psychology.
- **Verdict:** survives (confidence: high)
- **Strongest support:** Three independent meta-analyses converge: Cepeda et al. 2006 (Psych Bulletin, 317 experiments) establishes not just that spacing helps but a quantitative ISI x retention-interval interaction; Rowland 2014 (g≈0.50) and Adesope et al. 2017 (g≈0.61) independently confirm the testing effect with overlapping CIs across lab and classroom. All verified and correctly attributed.
- **Strongest attack:** The *strong* parametric-form reading is contested: Murre & Dros 2015 is n=1 (a demonstration, not a population replication); Heathcote/Brown/Mewhort 2000 showed the analogous 'power law of practice' is an averaging artifact (individual curves are exponential); Averell & Heathcote 2011 found an above-chance asymptote (decline-to-plateau, not decay-to-zero). Testing also has boundary conditions (Van Gog & Sweller 2015 on complex materials; Pan & Rickard 2018 show transfer is modest/narrow, d≈0.40).
- **Open question:** At the individual (non-aggregated) level, is the forgetting function power/log or exponential-to-an-asymptote — and does a genuine plateau (permanent memories) undercut using 'negatively-accelerated decay' as the constraint that discriminates Claim-B mechanism models?

### B) The mechanism of forgetting is unresolved after a century — time-decay (ACT-R) vs interference/discriminability (SIMPLE) vs context-drift (TCM) vs active erasure (Rac1/neurogenesis), each making different predictions.
- **Verdict:** weakened-but-stands (confidence: high)
- **Strongest support:** That the mechanism is genuinely open is agreed by both sides — decay-vs-interference is a two-century unsettled dispute, and the molecular active-forgetting work is real and causal (Shuai et al. 2010 Cell; Akers et al. 2014 Science). The brain spending ATP via Rac1 to actively forget is a datum pure-decay-as-failure cannot explain. Anchors all verified and correctly attributed.
- **Strongest attack:** The 'four rival mechanisms making divergent testable predictions' framing partly commits a Marr-levels conflation: ACT-R rational analysis is computational-level (implementation-agnostic by Anderson's own account), TCM is algorithmic, Rac1/neurogenesis is implementation — several can be simultaneously true rather than competing. The discriminating predictions are also individually fragile: context reinstatement (TCM) is small, abolished by outshining, and fails for recognition (Smith & Vela 2001); neurogenic forgetting does not cleanly replicate mouse→rat and rests on adult human hippocampal neurogenesis, itself contested (Sorrells 2018 vs Boldrini 2018); decay-vs-interference may be behaviorally ill-posed (McGeoch).
- **Open question:** Is the decay-vs-interference question empirically decidable from behavioral data at all, and does the Marr-levels critique fully dissolve the rivalry — or do at least two camps (same-level decay vs interference; TCM-reversible vs Rac1-erased) still make a genuinely divergent, testable prediction about recoverability?

### C) Some forgetting is adaptive — intermediate decay maximizes inference (Schooler & Hertwig); transience aids generalization (Richards & Frankland); the target is 'degrade well,' not retain-all.
- **Verdict:** weakened-but-stands (confidence: medium)
- **Strongest support:** The narrow existence claim is well-motivated from two directions: Schooler & Hertwig 2005 show an inverted-U (a real optimum, not a metaphor) in ACT-R; and the actively-regulated, ATP-consuming molecular machinery (Rac1, neurogenesis) is hard to explain unless forgetting is sometimes useful — evolution does not spend energy to degrade a system for no benefit. Both anchors verified.
- **Strongest attack:** The 'three-level convergence' is a simulation + a review-article analogy + a contested-in-humans pathway dressed as a law. Schooler & Hertwig is architecture- and heuristic-contingent — the recognition heuristic / less-is-more effect has alternative mechanistic explanations (Dougherty et al. 2008, continuous-familiarity MINERVA) and is partly a mathematical necessity of the setup. Richards & Frankland's 'transience = regularization' is an opinion-piece analogy with no measurement that biology implements an L1/L2-style penalty — exactly the engineer-imposed analogy this exercise flags. The whole claim courts Panglossian adaptationism (Gould–Lewontin): an optimum existing in a model does not show evolution tuned to it, and much forgetting is plainly failure (amnesia, age-related decline).
- **Open question:** Beyond 'some forgetting can be beneficial,' is there any direct measurement (not simulation or analogy) that biological transience implements a regularization-like capacity constraint, or that any real agent's forgetting rate sits near the Schooler–Hertwig optimum?

### D) AI is thinnest here: it handles contradiction (invalidation) but has almost no principled decay of stale-yet-uncontradicted facts; whether time-based decay improves task performance is empirically unsettled (mixed ablations).
- **Verdict:** survives (confidence: high)
- **Strongest support:** The empirical core resists all attack and is endorsed by both sides: AI has mature machinery for replacing contradicted facts (ROME, MEMIT, RAG supersession — all require a contradicting signal) and mature machinery for *not* forgetting (EWC, replay), but there is no meta-analytic backbone — no Cepeda-2006/Rowland-2014 equivalent — showing a principled time-decay term improves downstream performance. Temporal-QA benchmarks (TempLAMA, FreshQA, TimeQA, RealTimeQA) confirm models confidently emit stale facts; the field's response is refresh/edit, not principled salience decay.
- **Strongest attack:** The *framing* 'almost no principled decay' is loose — decay mechanisms are pervasive in ML (LSTM forget gate; ALiBi/recency-weighted attention; controlled continual-learning tradeoffs), so the claim must retreat to its own precise wording (no selective utility/time-based decay of *consolidated facts* firing *without* a contradiction). The deeper point: the implicit premise that biological forgetting is the machine benchmark is a false equivalence — the capacity/metabolic and shared-substrate-interference rationales (SIMPLE, neurogenesis) don't bind cheap, lossless machine storage; only the rational-analysis strand (Anderson–Schooler need-odds) is substrate-independent and legitimately transferable.
- **Open question:** Which human forgetting rationale actually transfers to machines — is it only the environmental-need-odds/rational-analysis strand, with the biological capacity and interference rationales being non-binding for lossless storage, and does that reframe what 'graceful forgetting for AI' should even optimize?

**Strawman attacks flagged:** Red-team D-move-1 (LSTM forget gate / ALiBi refute 'almost no principled decay') partly attacks a broader phrasing than the claim's actual wording: Claim D already specifies decay of 'stale-yet-uncontradicted FACTS,' and forget gates/positional decay operate on hidden state and token distance, not consolidated factual knowledge — so the rebuttal knocks down a looser reading the claim did not commit to. The red team half-concedes this by retreating to the narrow version, which survives.; The Marr-levels 'four theories answer different questions, not a bake-off' point, while incisive, mildly caricatures the steelman: decay (ACT-R base-level) vs interference (SIMPLE) ARE genuine same-level competitors over the same behavioral data, so the critique dissolves some but not all of the rivalry — presenting it as if it dissolves the whole 'divergent predictions' claim slightly overreaches.

**Overstated enrichment flagged:** 'Directly replicated 130 years later' for Murre & Dros 2015 — it is a single-subject (n=1) self-experiment, a demonstration, not a population replication that can establish a functional form as a law.; 'Quantitatively lawful' specific power/log form that 'lets it discriminate between the Claim-B models' — overstated given the Heathcote-2000 averaging-artifact risk (aggregation manufactures power shapes) and Averell/Heathcote-2011's above-chance asymptote; the defensible sense is weak (monotone, decelerating, plateauing).; 'Deep, non-lexical convergence on power-law/log-compressed time... the same math surfacing in different fields' — partly circular: SIMPLE *assumes* a logarithmic timeline and ACT-R *posits* power-law decay as built-in primitives, so convergence among models that each bake in the time-warp is weaker than independent discovery.; 'Three levels — computational, algorithmic, biological — agree good forgetting is a feature' — inflates one architecture-contingent simulation + one review-article ML analogy + a molecular pathway unconfirmed in adult humans into a unified three-level law.; Letting Richards & Frankland's 'transience = regularization' pass as 'load-bearing convergence' while separately flagging de Cheveigné's compression thesis as a mere preprint analogy — inconsistent, since both are the same borrowed-vocabulary analogy without a demonstrated shared mechanism.

**New open questions:** Does the forgetting curve have a genuine above-chance asymptote (a class of effectively permanent memories), and if so does 'negatively-accelerated decay' remain a valid constraint on mechanism models, or must they instead reproduce decline-to-plateau?; Applied to forgetting (not just practice), does the Heathcote averaging artifact hold — i.e., are individual-subject forgetting curves exponential while only the aggregate looks power/log?; Given the unresolved Sorrells-2018-vs-Boldrini-2018 dispute over adult human hippocampal neurogenesis, what (if any) human relevance does the Akers neurogenic-forgetting mechanism retain, and can it be a load-bearing 'prediction signature' while its premise is contested?; Which of the three human forgetting rationales (rational/need-odds, capacity-metabolic, substrate-interference) is actually substrate-independent enough to be a normative target for machine memory — and does recognizing that only the rational-analysis strand transfers change what an AI 'graceful degradation' benchmark should measure?; Is the decay-vs-interference dichotomy even behaviorally decidable in principle (McGeoch's point that pure decay is never observable uncontaminated by intervening events), or does resolving it require neural/molecular rather than behavioral measurement?

---

## Steelman (enrichment)

All anchors verified. Below is the steelman. This is my final return value.

---

# STEELMAN: "Degradation — forgetting is lawful, mechanism unknown, partly a feature"

Verdict up front: this cluster is the **best-supported** in the whole memory-science baseline. Claims A–C rest on some of the most replicated results in experimental psychology plus a converging molecular/computational story; Claim D's "AI is thinnest here" is not a hedge but a defensible, evidence-backed diagnosis. All primary citations below were verified this session (title/author/year/venue) unless explicitly flagged.

---

## Claim A — Forgetting is lawful/negatively-accelerated; spacing + testing robustly improve retention

**This is as close to bedrock as psychology gets. Strongest form of the claim:**

**The forgetting function is lawful and negatively accelerated (verified).**
- Ebbinghaus (1885) *Über das Gedächtnis* established savings-based retention loss. Crucially, it was **directly replicated 130 years later**: **Murre & Dros (2015), *PLOS ONE* 10(7):e0120644** — a single-subject 70-hour replication that recovered the curve and fit it best with a logarithmic/power form (not simple exponential). This is the rare century-old result that survives modern re-run.
- The negatively-accelerated shape generalizes across materials (nonsense syllables, faces/names, autobiographical events) — Murre & Dros discuss this explicitly. The functional form is the substance: forgetting rate decelerates over log-time, which is what every serious model (below) must reproduce.

**Spacing and testing are among the most replicated effects in the field (verified meta-analyses):**
- **Spacing/distributed practice: Cepeda, Pashler, Vul, Wixted & Rohrer (2006), *Psychological Bulletin* 132(3):354–380** — 839 assessments across 317 experiments in 184 articles. Not just "spacing helps": it establishes the **ISI × retention-interval interaction** (optimal gap grows with the retention interval) — a quantitative law, not a folk tip.
- **Testing effect / retrieval practice — two independent large meta-analyses converge:** **Rowland (2014), *Psychological Bulletin*** (g ≈ 0.50, 159 effect sizes, testing vs. restudy) and **Adesope, Trevisan & Sundararajan (2017), *Review of Educational Research*** (g ≈ 0.61). Independent teams, different inclusion rules, overlapping confidence intervals, lab-and-classroom generality — this is what robust looks like.

**The deepest defensible formulation (theoretical anchor):** **Bjork & Bjork's "New Theory of Disuse" (1992)** separates *storage strength* from *retrieval strength* and predicts precisely why the manipulations that *worsen* momentary performance (spacing, testing, interleaving — "desirable difficulties") *improve* durable retention. This unifies A with C: forgetting (retrieval-strength loss) is the very engine that makes retrieval practice potent. (Well-established primary source; not freshly re-verified this session — flag as high-confidence-from-training.)

**Why A is genuinely strong, not just old:** the phenomena replicate across a century, across labs, and across the lab/classroom boundary, and they are *quantitatively lawful* (fit by explicit functional forms), which is what lets them discriminate between the models in Claim B.

---

## Claim B — Mechanism unresolved after a century; competing accounts make *different* predictions

**Strongest form: this is a live, well-posed scientific disagreement with rival formal models that fit the same curves via incompatible mechanisms — not vagueness, but genuine underdetermination.** The four camps, each with a real anchor:

1. **Rational/decay-flavored — ACT-R:** **Anderson & Schooler (1991), "Reflections of the Environment in Memory," *Psychological Science* 2(6):396–408.** Base-level activation decays as a **power function** of time-since-use because the *environment's* need-probability decays that way (measured in NYT headlines, parental speech, email). Forgetting mirrors environmental statistics. Prediction signature: retention governed by recency/frequency of past *need*.

2. **Interference/discriminability — SIMPLE:** **Brown, Neath & Chater (2007), "A Temporal Ratio Model of Memory," *Psychological Review* 114(3):539–576.** Explicit claim (d): **"all memory loss is due to interference and not trace decay."** Items are located by *temporal distinctiveness* on a log-compressed timeline; forgetting is crowding by near neighbors, scale-invariant across timescales. Prediction signature: forgetting depends on the *density of competitors*, not absolute elapsed time.

3. **Context drift — TCM:** **Howard & Kahana (2002), "A Distributed Representation of Temporal Context," *Journal of Mathematical Psychology* 46(3):269–299.** A gradually drifting context vector produces recency and lag-recency; "forgetting" is *mismatch between current and encoding context*, not erasure. Prediction signature: reinstating context recovers the memory (so decay is retrieval-failure, in principle reversible).

4. **Active biological erasure — Rac1 / neurogenesis:** two independent molecular handles, both verified:
   - **Shuai et al. (2010), "Forgetting Is Regulated through Rac Activity in Drosophila," *Cell* 140(4):579–589** — first direct evidence of an *intrinsic active-forgetting* pathway; blocking Rac1 slows normal forgetting, driving it accelerates. Conserved to mammals (later Rac1 object-recognition and Alzheimer-model work).
   - **Akers et al. (2014), "Hippocampal Neurogenesis Regulates Forgetting During Adulthood and Infancy," *Science* 344(6184):598–602** — *increasing* neurogenesis after encoding *induces* forgetting; the cross-species precocial-rodent manipulation (guinea pig/degu) is a genuine causal dissociation, not a correlation. Prediction signature: forgetting is an *actively regulated, expendable* process with a molecular substrate.

**Why "mechanism unknown" is the honest and strong reading:** these are not paraphrases of one idea. Decay vs. interference is a **two-century-old, empirically contested** dichotomy (**Hardt, Nader & Wixted (2013), "Decay happens," *Trends in Cognitive Sciences* 17(3):111–120** argues decay is real and active, explicitly against pure-interference orthodoxy — high-confidence from training). Context-drift reframes decay as reversible retrieval failure; active-erasure says traces are *physically dismantled*. They make **divergent, testable predictions** (context reinstatement recovers a TCM memory but not a Rac1-erased one; interference predicts competitor-density effects that pure time-decay does not). A field with four rival formal/molecular models that each fit the macro-curve is a field where the *mechanism is genuinely open* — which is exactly the claim.

**Cross-field convergence here is deep, not lexical:** the same **power-law / log-compressed-time** signature independently shows up in ACT-R activation (Anderson & Schooler), SIMPLE's log timeline, and TCM's drift dynamics. Three traditions built from different primitives converge on scale-invariant, log-time forgetting. That is substantive convergence.

---

## Claim C — Some forgetting is adaptive; the target is "degrade well," not "retain all"

**Strongest form: adaptivity of forgetting is not a just-so story — it is demonstrated computationally *and* biologically, from two independent directions that meet in the middle.**

**Computational / cognitive side (verified):**
- **Schooler & Hertwig (2005), "How Forgetting Aids Heuristic Inference," *Psychological Review* 112(3):610–628.** The key result is stronger than "forgetting is tolerable": in ACT-R simulations of the recognition heuristic, **intermediate forgetting rates *maximize* inferential accuracy** — an inverted-U. Too little forgetting and too much both hurt; there is an optimal, non-zero decay. This is a *mechanistic demonstration* that loss is functional, not a metaphor.
- Rooted in the rational-analysis backbone (Anderson & Schooler 1991): if memory allocates availability to match environmental need-odds, then *letting stale items fall* is optimal resource allocation, not failure.

**Neurobiology side (verified):**
- **Richards & Frankland (2017), "The Persistence and Transience of Memory," *Neuron* 94(6):1071–1084.** The thesis is exactly "degrade well": **transience (1) enhances behavioral flexibility** by discounting outdated information and **(2) prevents overfitting, promoting generalization.** They explicitly draw the parallel to *regularization* in machine learning — forgetting as a bias-variance mechanism. Intelligence lives in the *interaction* of persistence and transience.
- Mechanistically grounded by the Claim-B active-forgetting substrates (Rac1, neurogenesis; **Davis & Zhong (2017), "The Biology of Forgetting — A Perspective," *Neuron*** — high-confidence from training): the brain spends energy to forget, which only makes evolutionary sense if forgetting is *useful*.

**Cross-field convergence is real and load-bearing here:** the *generalization-via-forgetting* argument in Richards & Frankland is the **same formal intuition as regularization/overfitting** in statistical learning — and Schooler & Hertwig's inverted-U is a **bias-variance tradeoff** stated in memory terms. The most recent framing, **de Cheveigné (2025/2026), "Graceful forgetting: memory as a process," arXiv:2502.11105** (cross-listed q-bio.NC / cs.LG / cs.IR; *preprint, not peer-reviewed — flag*), makes the compression thesis explicit: bounded memory absorbing unbounded input *requires* repeated summarization/compression — forgetting as lossy re-encoding. Note this is a preprint, cite as a framing paper, not settled result.

**The defensible headline:** the normative target is not maximal retention but **optimal degradation** — an inverted-U with a real peak (Schooler & Hertwig) whose functional payoff is flexibility + generalization (Richards & Frankland), implemented by dedicated molecular machinery (Rac1/neurogenesis). Three levels — computational, algorithmic, biological — agree that *good forgetting is a feature*.

---

## Claim D — AI is thinnest here: handles contradiction (invalidation), lacks principled decay of stale-yet-uncontradicted facts; whether time-decay helps is empirically unsettled

**Steelmanning D means showing the diagnosis is *correct*, and it is — this is the sharpest, most defensible gap in the baseline.**

**AI genuinely handles contradiction/invalidation (verified):**
- **Model editing:** **Meng et al. (2022), "Locating and Editing Factual Associations in GPT" (ROME), *NeurIPS 2022*** and its mass-edit successor **MEMIT (Meng et al., *ICLR 2023*)** — these *overwrite a fact with a contradicting one*. That is invalidation-by-replacement.
- **Retrieval/RAG supersession** and continual pretraining likewise resolve *conflicts* by preferring newer evidence.
These mechanisms all require **a contradicting signal** to fire.

**But there is no principled decay of stale-yet-uncontradicted facts — and the benchmarks prove the symptom (verified):**
- **Dhingra et al. (2022), "Time-Aware Language Models as Temporal Knowledge Bases," *TACL* (TempLAMA)**; **Vu et al. (2023/2024), "FreshLLMs / FreshQA," *arXiv:2310.03214, Findings of ACL 2024***; **TemporalWiki (Jang et al., EMNLP 2022)**; **RealTimeQA (Kasai et al., NeurIPS 2023 Datasets)**; **TimeQA (Chen et al., NeurIPS 2021)**. Consistent finding: **models confidently emit outdated facts** for time-sensitive queries. The field's response is overwhelmingly *refresh/retrieve/edit* — inject the new answer — **not** let the old one decay in salience on its own. A fact that has simply gone stale but hasn't been explicitly contradicted has *no principled mechanism* to lose weight.
- Note the *asymmetry vs. cognitive science*: the dominant continual-learning literature studies **catastrophic forgetting as a bug to prevent** (EWC, replay). AI has spent a decade learning *not* to forget. The Claim-C insight — that graceful, selective forgetting is a *feature* to engineer — is essentially absent from mainstream practice. That is the thinness, stated precisely.

**"Whether time-based decay improves task performance is empirically unsettled (mixed ablations)" — this is the honest state, and it is the strongest part of D:**
- Recency-weighting appears in agent-memory and retrieval systems, but there is **no consensus benchmark and no clean, widely-replicated ablation** showing that a principled time-decay term improves downstream task performance. Unlike Cepeda-2006 or Rowland-2014 on the human side, there is **no meta-analytic backbone** for "decay helps" in AI.
- **Caution flag (per your instructions):** several 2026 arXiv preprints in this session's searches — e.g. "The Geometry of Forgetting" (arXiv:2605.xxxxx), "Temporal Validity in Retrieval Memory" (arXiv:2606.xxxxx), "Control-Plane Placement Shapes Forgetting" (arXiv:2606.15903) — carry **future-dated IDs and are unverifiable as to authorship/venue/results.** I did **not** rely on them and recommend treating them, and any self-reported agent-memory decay benchmark, as **unverified** until independently checked. The absence of a trustworthy, peer-reviewed ablation is *itself the evidence* for D.

**Why D is the correct diagnosis, stated at full strength:** AI has mature machinery for *replacing contradicted facts* (ROME/MEMIT/RAG) and mature machinery for *not forgetting* (anti-catastrophic-forgetting). It has **neither a normative theory nor a validated benchmark** for the thing cognitive science has nailed down three ways — *optimal, contradiction-free, time-and-utility-based degradation* (Anderson–Schooler need-odds, Schooler–Hertwig inverted-U, Richards–Frankland transience). The cross-field convergence that is *deep* on the science side (power-law forgetting; forgetting-as-regularization) is exactly where AI has *no principled implementation and no settled evidence*. That gap is real, specific, and unclosed.

---

## Convergence scorecard (where it's deep vs. vocabulary)

- **Deep:** power-law / log-compressed-time forgetting independently reached by ACT-R, SIMPLE, and TCM. **Deep:** forgetting-as-regularization/overfitting-control — Richards–Frankland (neuro) ≅ bias-variance (stats/ML) ≅ Schooler–Hertwig inverted-U (cognitive). These are the same math surfacing in different fields.
- **Shallow / aspirational:** "graceful forgetting" as applied to LLM agents (de Cheveigné 2025 preprint; assorted 2026 preprints) — the *vocabulary* is borrowed from neuroscience, but the **validated mechanism and the ablation evidence are not there yet.** Honest steelman: the analogy is *promising and principled*, but currently unearned empirically.

## Verification ledger
- **Verified this session (title/author/year/venue):** Murre & Dros 2015 (PLOS ONE); Cepeda et al. 2006 (Psych Bulletin); Rowland 2014 (Psych Bulletin); Adesope et al. 2017 (Rev Educ Res); Anderson & Schooler 1991 (Psych Science); Brown, Neath & Chater 2007 (Psych Review); Howard & Kahana 2002 (J Math Psych); Shuai et al. 2010 (Cell); Akers et al. 2014 (Science); Schooler & Hertwig 2005 (Psych Review); Richards & Frankland 2017 (Neuron); Meng et al. ROME 2022 (NeurIPS); Dhingra et al. 2022 (TACL); Vu et al. FreshLLMs 2023/2024 (arXiv 2310.03214 / Findings ACL 2024).
- **High-confidence from training, NOT re-verified this session (verify before load-bearing use):** Bjork & Bjork 1992 (New Theory of Disuse); Hardt, Nader & Wixted 2013 (TiCS 17:111–120); Davis & Zhong 2017 (Neuron); MEMIT (Meng et al., ICLR 2023); TemporalWiki (Jang et al., EMNLP 2022); RealTimeQA (Kasai et al., NeurIPS 2023); TimeQA (Chen et al., NeurIPS 2021).
- **Flagged unverifiable — do NOT cite:** all future-dated 2026 arXiv preprints surfaced in search (2605.09195, 2603.16544, 2606.26511, 2606.15903) and any self-reported AI-memory decay benchmark. de Cheveigné arXiv:2502.11105 is real but a **non-peer-reviewed preprint** — cite as framing only.

**No fabricated papers, venues, or benchmark numbers were introduced.** The one place I refuse to manufacture strength is Claim D's "decay helps" — there is no trustworthy ablation to point to, and that emptiness is the point.

---

## Red-team (dismissal)

All key counter-citations verified. Here is the red-team analysis.

---

# RED TEAM: "Degradation — forgetting lawful, mechanism unknown, partly a feature"

The steelman is right that this is the best-supported cluster. So the honest red-team job is not to pretend A–C are shaky — it's to attack the specific *strong* formulations, the *convergence* claims, and the *false equivalences* the framing smuggles in. Where a claim resists, I say so.

---

## CLAIM A — "Forgetting is lawful/negatively-accelerated; spacing + testing robustly improve retention"

**What genuinely resists attack:** That retention declines monotonically and is negatively accelerated is not in dispute; that spacing and retrieval practice produce net positive effects across hundreds of experiments (Cepeda 2006, Rowland 2014, Adesope 2017 — all verified) is real and survives independent replication. Do not attack the *existence* of these effects. Attack three overreaches:

**1. The "lawful functional form" is where the strength is *overstated* — and the field's own analogue was demolished as a measurement artifact.** The steelman leans on the forgetting curve being *quantitatively lawful* (a specific power/log form) as what "lets it discriminate between the models in Claim B." That precise-form claim is the weakest link:
- **Murre & Dros (2015, PLOS ONE) is n = 1** — Murre relearning lists on himself. A single-subject re-run is a demonstration, not a population replication; it cannot establish a *functional form* as a law. The steelman's phrase "directly replicated 130 years later" oversells a one-participant study.
- The averaging trap is not hypothetical here. **Heathcote, Brown & Mewhort (2000), "The power law repealed," *Psychonomic Bulletin & Review* 7(2):185–207** (verified) fit 7,910 learning series from 475 subjects and showed the celebrated "power law of practice" is an **artifact of averaging** — individual curves are *exponential*, and aggregation manufactures the power shape. Forgetting curves are built the same way (average over subjects/items), so any aggregate "power/log law of forgetting" is under exactly this suspicion until shown at the individual level.
- **Averell & Heathcote (2011), "The form of the forgetting curve and the fate of memories," *J. Math. Psych.* 55(1):25–35** (verified) — the paper that *did* the individual-level work — found the forgetting curve has an **above-chance asymptote** (some memories are effectively permanent). That directly contradicts a clean "negatively-accelerated decay toward zero." The true shape is *decline-to-a-plateau*, which is a different object than the monotone-decay the steelman uses to constrain the Claim-B models.
- Power laws are also easy to over-diagnose in general (Clauset–Shalizi–Newman 2009; Stumpf & Porter, "Critical truths about power laws," *Science* 2012 — high-confidence from training): candidate "power laws" are routinely indistinguishable from lognormal or exponential mixtures over the narrow ranges psychology measures. So "forgetting is a power law" is a modeling *choice/convention* at least as much as a discovered *law*.

**Net:** the *phenomenon* is lawful in the weak sense (monotone, decelerating, plateauing). The *strong* sense the steelman needs — a specific parametric law robust at the individual level that adjudicates mechanisms — is contested and partly artifactual.

**2. "Testing robustly improves retention across materials" has a documented boundary condition the steelman elides.** **Van Gog & Sweller (2015), *Educational Psychology Review* 27(2):247–264** (verified) argue the testing effect *shrinks or vanishes* as element-interactivity/complexity rises. This is contested — **Karpicke & Aue (2015), "The Testing Effect Is Alive and Well with Complex Materials"** (verified) rebut it — but "contested boundary condition" is precisely *not* "robust across materials." The effect is robust for simple verbal materials and weaker/disputed for complex, integrated knowledge.

**3. "Testing" doesn't transfer as cleanly as the retention numbers imply.** **Pan & Rickard (2018), *Psychological Bulletin* 144(7):710–756** (verified): transfer of test-enhanced learning is real but *modest and narrow* (d ≈ 0.40 vs. restudy; largest for near-transfer across test formats, smaller for genuinely new content/inferences). The g ≈ 0.50–0.61 headline is for *retention of tested material*; generalization is a weaker, more moderated effect. The steelman's "lab-and-classroom generality" glosses this.

---

## CLAIM B — "Mechanism unresolved; rival models make *different* predictions"

**What resists attack:** That mechanism is genuinely open is correct — decay-vs-interference is a two-century unresolved dispute, and the molecular active-forgetting work (Shuai 2010 Cell; Akers 2014 Science — both verified) is real. Do not claim the mechanism is *known*. Attack the framing that these are *four rival mechanisms making divergent testable predictions*, and the "deep convergence" claim.

**1. The "four rival mechanisms" is partly a levels-of-analysis category error (Marr).** ACT-R rational analysis (Anderson & Schooler 1991, verified) is an explicitly **computational-level** theory — Anderson is on record that rational analysis is *agnostic about implementation*; it asks what the environment demands, not what neurons do. Rac1/neurogenesis (Shuai, Akers) is **implementation-level**. TCM (Howard & Kahana 2002, verified) is **algorithmic-level**. These are not four competing answers to one question; they largely answer *different* questions. Presenting "environmental need-odds decay" and "Rac1 dismantles the trace" as rivals that "make divergent predictions about the same thing" conflates Marr's levels. A rational-level power law and a molecular erasure pathway can *both* be true simultaneously. So "the mechanism is unresolved" is right, but "four theories in a bake-off" overstates the incompatibility — some of the apparent disagreement is a description of the same system at different grains.

**2. The predictions that supposedly *discriminate* the models are individually fragile:**
- *TCM's signature — "reinstate context and the memory returns (decay is reversible retrieval failure)."* The empirical backbone for context reinstatement is weaker than the steelman implies. **Smith & Vela (2001), *Psychonomic Bulletin & Review* 8(2):203–220** (verified) find environmental-context effects *reliable but small and easily abolished* — "outshining"/overshadowing by any salient non-contextual cue wipes them out, and the classic Godden & Baddeley effect notoriously **fails for recognition** (appears only in free recall). So "reinstating context recovers the memory" is a fragile, condition-dependent effect, not a clean discriminating prediction.
- *Active-erasure's signature — a molecular substrate for forgetting.* **Neurogenesis-induced forgetting does not cleanly replicate across species** — the effect demonstrated in mice (Akers 2014) has been **reported absent in rats** (per the Akers-follow-up literature, verified in search), and the field openly disputes whether forgetting is even "a categorically separate process from plasticity." Worse for human relevance: the mechanism presupposes ongoing adult hippocampal neurogenesis, and **whether that exists in adult humans is itself unresolved** — **Sorrells et al. (2018, *Nature* 25975)** found it drops to undetectable after childhood; **Boldrini et al. (2018)** found it persists lifelong; same tissue questions, opposite conclusions (verified). A forgetting mechanism resting on a contested premise cannot be a load-bearing "prediction signature."
- *SIMPLE's signature — "all memory loss is interference, no decay."* Brown, Neath & Chater (2007, *Psychological Review*, verified) make this claim, but **Hardt, Nader & Wixted (2013), "Decay happens," *TiCS* 17:111–120** (high-confidence from training) argue the opposite from the same data. The decay-vs-interference question may be **partially ill-posed/untestable** in behavioral data alone (McGeoch's 1932 point: you can rarely observe "pure" decay uncontaminated by intervening events). "Different predictions" oversells testability where the constructs may not be behaviorally separable.

**3. The "deep, non-lexical convergence on power-law/log-compressed time" is partly a shared modeling convention plus the averaging artifact — not three independent discoveries.** ACT-R, SIMPLE, and TCM don't independently *discover* log-compressed time; log/power time is a **built-in modeling primitive** in each (SIMPLE literally *assumes* a logarithmic timeline; ACT-R *posits* power-law base-level decay). Convergence among models that each *assume* the same time-warp is weaker evidence than the steelman's "same math surfacing in different fields." Combine that with the Heathcote-2000 averaging artifact (power shape manufactured by aggregation), and "deep convergence on the power law" is at serious risk of being **convergence on a shared assumption fitted to artifactually-shaped aggregate data** — impressive-sounding, but partly circular.

---

## CLAIM C — "Some forgetting is adaptive; the target is 'degrade well'"

This is where the steelman is most seductive and most attackable, because the evidence is a *simulation* plus a *review-article analogy*, dressed as a three-level convergence.

**1. Schooler & Hertwig (2005) is a simulation whose result is architecture- and heuristic-contingent — and the heuristic it rides on is contested.** The inverted-U ("intermediate forgetting *maximizes* inference") is a result *inside ACT-R applied to the recognition heuristic*. Two problems:
- The **recognition heuristic and the less-is-more effect are themselves disputed.** **Dougherty, Franco-Watkins & Thomas (2008)** showed the less-is-more effect can arise from a **continuous-familiarity MINERVA model with no discrete recognition heuristic at all** (verified) — i.e., the phenomenon has alternative mechanistic explanations that dissolve the specific "forgetting tunes the recognition heuristic" story. And the less-is-more effect is partly a **mathematical necessity given the model's assumptions** (verified, per the Beaman et al. and review literature) — which makes "forgetting *produces* better inference" somewhat *baked into the setup* rather than discovered.
- "Maximizes" is a claim about an *optimum in a model*, not evidence that any real agent's forgetting rate sits at that optimum. It shows forgetting *can* help *in a specific model of a specific task*. That is much weaker than "forgetting is adaptive."

**2. Richards & Frankland (2017, *Neuron*, verified) is a review/opinion piece, and its "transience = regularization" is exactly the engineer-imposed analogy this exercise is meant to flag — not a result the neuroscience demonstrates.** It offers *no* measurement that biological transience implements anything like a regularization penalty. Regularization in ML is a specific, quantified penalty on parameter magnitude (L1/L2) or an explicit capacity constraint; "the brain forgets and this might reduce overfitting" is a *suggestive parallel*, not a shared mechanism. Treated as evidence, it is **an analogy standing in for a demonstration**. The steelman itself half-concedes this for de Cheveigné (2025 preprint) but lets Richards & Frankland's regularization claim pass as "load-bearing convergence" — it is the same borrowed vocabulary, one tier more respectable.

**3. The whole claim courts Panglossian adaptationism (the Gould–Lewontin "spandrels" critique).** Demonstrating an *optimum exists* in a model does not show evolution *tuned* forgetting to it, nor that any given instance of forgetting is an *adaptation* rather than a *constraint* (metabolic cost, synaptic capacity, interference as an unavoidable byproduct). Much forgetting is plainly *failure* — retrograde amnesia, PTSD intrusions that *won't* forget, age-related decline. "Forgetting is a feature" is true for *some* forgetting under *some* framing; generalized to "the target is degrade-well," it risks relabeling every loss as functional post hoc. The adaptive story is *plausible and partially demonstrated*, not established as the general character of forgetting.

**What resists:** the *existence* of at least some functionally beneficial forgetting is well-motivated (the brain spending ATP via Rac1 to actively forget is a real datum that pure-decay-as-failure doesn't explain). The defensible claim is narrow: *some* forgetting is actively regulated and *can* be beneficial. The steelman's "three levels — computational, algorithmic, biological — agree good forgetting is a feature" overstates a simulation + a review analogy + a contested-in-humans molecular pathway into a unified law.

---

## CLAIM D — "AI is thinnest here; no principled decay of stale-yet-uncontradicted facts; time-decay benefit empirically unsettled"

The steelman defends D as *correct*. Two red-team moves: (a) parts of D are *overstated* in the other direction, and (b) the deepest problem is that **the entire cluster's application of human forgetting laws to machines is a false equivalence** — which, ironically, *undercuts D's own normative premise*.

**1. "AI has almost no principled decay" is overstated.** Decay mechanisms are pervasive in ML — they're just not fact-level utility decay:
- The **LSTM forget gate** (Gers, Schmidhuber & Cummins 2000) is *literally* a learned decay of stored state.
- **Recency-weighted attention / positional decay** (ALiBi, Press et al. 2022; rotary embeddings) impose principled distance-based down-weighting.
- **Continual-learning replay and EWC** implement *controlled* retention/forgetting tradeoffs.
So "no principled decay" is wrong as stated. The accurate, narrower claim is: **AI lacks *time-and-utility-based decay of consolidated factual knowledge* that fires *without* a contradicting signal.** That narrower claim survives; the broad one doesn't. The steelman should retreat to the narrow version or it's refuted by the forget gate.

**2. The "AI can't forget" framing sits in unacknowledged tension with "AI forgets catastrophically."** The dominant continual-learning finding is that neural nets forget *too much, uncontrollably* (catastrophic forgetting). So the real gap is not "machines can't forget" — it's "machines can't forget *selectively and on purpose*." D's steelman does note the catastrophic-forgetting asymmetry, but the headline "AI is thinnest at forgetting" is imprecise: AI is thin at *controlled* forgetting while being *pathologically prone* to *uncontrolled* forgetting. Those are different failures and the claim should name the right one.

**3. "Whether time-decay helps is empirically unsettled" resists attack — and is the strongest sentence in the cluster.** There is genuinely no meta-analytic backbone (no Cepeda-2006 equivalent) for "principled time-decay improves downstream task performance" in AI. Absence of evidence is correctly diagnosed. The steelman's refusal to cite a benchmark here — and its explicit flagging of the future-dated 2026 arXiv IDs (2605.09195, 2606.15903, etc.) as **unverifiable** — is the correct call; I confirm those IDs cannot be verified and should not be cited. This part should not be "attacked"; it should be *endorsed* as the honest state.

**4. The deepest attack — the cluster's core false equivalence, which cuts against D's normative premise.** D implicitly frames the human forgetting laws (A–C) as a *baseline AI should aspire to*. But two of the three human rationales for forgetting **do not transfer to machines**, and treating them as a target is the engineer-imposed analogy this exercise exists to catch:
- *Capacity/metabolic necessity.* Humans forget partly because storage and maintenance are physically expensive (synaptic cost, ATP-spending Rac1). **Machine storage is cheap and non-degrading.** The Richards–Frankland "transience prevents overfitting" and the neurogenesis-erasure arguments are grounded in a *biological resource constraint that simply doesn't bind* a system that can keep every fact losslessly. So "AI should degrade like a brain" imports a *necessity* that isn't there.
- *Interference from a fixed substrate.* Human interference/discriminability effects (SIMPLE) arise because memories crowd a shared representational space. A database with exact keys has *no analogous crowding*. Retrieval failure in AI is an engineering property, not a law of the substrate.
- **What *does* transfer** is only the *rational-analysis* strand: Anderson & Schooler's "match availability to environmental need-odds" is substrate-independent and *is* a legitimate normative target for machine memory (down-weight what the world is unlikely to ask for). That single strand — not the biological ones — is the real, transferable core. So the correct steelman of D is narrower than stated: AI lacks an implementation of the *rational/environmental-statistics* form of graceful degradation; the *biological* forms it "lacks" are ones it may not *need*, and holding them up as a target is a false equivalence.

**Net on D:** the *empirical* claim (no validated time-decay ablation) fully resists attack. The *framing* claim ("AI is thin at forgetting, and human forgetting is the standard") is half-right and half-false-equivalence: correct that selective utility-based decay is missing; wrong to imply the brain's *capacity-driven* forgetting is the benchmark, since that rationale doesn't bind machines.

---

## Where the steelman survives (stated precisely, not manufactured)

- **A (existence):** monotone, negatively-accelerated forgetting with a plateau, and net-positive spacing/testing effects, are real and replicated. Only the *precise-parametric-law* and *robust-across-all-materials/transfer* overreaches fall.
- **B (openness):** the mechanism *is* genuinely unresolved. What falls is the "four *co-level* rivals making clean divergent predictions" framing and the "deep independent convergence on the power law" claim.
- **D (empirical core):** "no validated benchmark that principled time-decay improves task performance" is correct and refreshingly honest.

## What most needs downgrading

1. **A:** "directly replicated" (it's n = 1); "quantitatively lawful" form (contested; asymptote, not decay-to-zero; averaging-artifact risk).
2. **B:** "four rival mechanisms with divergent testable predictions" (partly a Marr-levels conflation; the discriminating predictions — context reinstatement, neurogenic erasure — are individually fragile/contested-in-humans); "deep convergence on power law" (shared assumption + averaging artifact).
3. **C:** "three levels agree forgetting is a feature" (one simulation on a contested heuristic + one review-article ML analogy + a molecular pathway unconfirmed in adult humans); "regularization" equivalence is the flagged engineer-imposed analogy.
4. **D:** "almost no principled decay" (refuted by forget gates / recency-weighting — retreat to "no selective utility-based factual decay"); and the unstated premise that biological forgetting is the machine benchmark (false equivalence — only the rational-analysis strand transfers).

**Verification note:** Heathcote/Brown/Mewhort 2000, Averell/Heathcote 2011, Smith/Vela 2001, Pan/Rickard 2018, Van Gog/Sweller 2015 (+ Karpicke/Aue rebuttal), Dougherty et al. 2008, Sorrells 2018 vs Boldrini 2018, and the mouse-vs-rat neurogenesis-forgetting discrepancy were all confirmed via search this session. Hardt/Nader/Wixted 2013, Clauset–Shalizi–Newman 2009 / Stumpf–Porter 2012, LSTM forget gate (Gers et al. 2000), ALiBi (Press et al. 2022), and Marr's levels are high-confidence from training, not re-verified this session. I introduced no fabricated papers or numbers, and I confirm the future-dated 2026 arXiv IDs remain unverifiable and were not relied on.

