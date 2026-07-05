# THE STRUCTURE OF MEMORY — Refined Cross-Field Reference

*A framework-explicit map across LLM/agent memory, cognitive psychology, memory neuroscience, and KG/retrieval. Pre-implementation reference only — descriptive, not prescriptive. No design is proposed here.*

---

## PREAMBLE — method, scope, and the central finding

This document maps eight recurring questions about the *structure* of memory (labeled T1–T8 from the prior passes) as they appear across four literatures, and separates what is true *regardless of which theory of memory you hold* from what is true *only relative to a school*. It is the output of a bias audit, corrected by a verification gate (citation/mechanism fixes) and a framework-bias reconciliation.

The eight topics: **T1** plurality of memory (stores/systems; declarative vs procedural; whether agent stores are "episodic"); **T2** encoding as distillation into a stored trace; **T3** adaptive recall as graded weighting over per-item scalars; **T4** retrieval as associative completion/traversal; **T5** consolidation and two-timescale separation; **T6** updating (supersede vs append; knowledge editing); **T7** forgetting (lawfulness, mechanism, the alleged AI gap); **T8** substrate (frozen weights + volatile context vs human memory).

The competing schools ("champions") seated at the table: the **Atkinson–Shiffrin modal store**; **Baddeley multicomponent working memory**; **Squire declarative/nondeclarative** (a lesion-grounded binary); **Tulving SPI / multiple systems**; **Cowan embedded-processes** (activated LTM, single store); **Wixted single-signal / Dunn state-trace** (signal-detection); **PDP connectionism** (McClelland, Rumelhart); **Craik & Lockhart levels-of-processing (LoP)**; **Morris transfer-appropriate processing (TAP)**; the **instance / global-matching family** (Hintzman MINERVA-2; Raaijmakers & Shiffrin SAM; Shiffrin & Steyvers REM; Murdock TODAM; Logan); **Complementary Learning Systems / CLS** (McClelland, McNaughton & O'Reilly); **ACT-R rational analysis** (Anderson); **engram** (Josselyn & Tonegawa); and **constructive/generative** memory (Bartlett; Schacter & Addis).

**The central finding of the audit.** The prior corpus quietly treated one lineage — Atkinson–Shiffrin modal store → Tulving multiple systems → symbolic boxes-and-arrows — as *neutral bedrock*, when each of its commitments is a *school's choice*. The tell is structural: the topic titles themselves are written in store/systems vocabulary ("encoding is distillation," "completion vs lookup," "supersede vs append," "close to a theorem"), which forces the live rivals (Cowan, single-signal, PDP, LoP, TAP, instance/global-matching) to appear only as *attacks on a default* rather than as co-equal framings. This document reclassifies those commitments as framework-relative and states the rivals at fair weight. It does **not** swing the default the other way: "single-signal defeats dual-process," "delocalization *is* convergence," and "retrievability is *never* intrinsic" are themselves framework-relative overreaches. The goal is a table with every chair filled, not a new coronation.

---

## I. FRAMEWORK-NEUTRAL BEDROCK

*Claims that survive under every champion because they are stated at the level of phenomenon or formal fact, stripped of contested ontology. Each carries a pointer to the relative question it is often confused with.*

**N1 — Memory shows robust functional/behavioral dissociations.** Spared skill-learning and priming alongside impaired recall; recency vs primacy; impaired short-term span with intact long-term learning and its mirror. Every school concedes the dissociations *exist*. *(What they imply — separable containers vs one graded mechanism — is relative: see R1.)*

**N2 — Retrieval is cue-dependent, not a readout of absolute trace strength.** Accessibility ≠ availability (Tulving & Pearlstone 1966); encoding specificity (Tulving & Thomson 1973). Endorsed alike by TAP, engram theory (the silent-engram case = intact availability, failed accessibility; Ryan et al. 2015), PDP (completion is cue-driven), and signal-detection. Survives at high confidence.

**N3 — Forgetting is lawful in the weak form** — monotone, negatively accelerated, plateauing above chance — **and spacing + retrieval practice robustly improve retention** (Ebbinghaus 1885; Roediger & Karpicke 2006; Cepeda et al. 2006). *The parametric form (power vs exponential) and the mechanism are not bedrock (see R10, and III/downgrade 6).*

**N4 — Agent/LLM stores do not possess human-episodic memory in any strong sense.** The possession-denial is conceded even by authors arguing LLMs have episodic-*like* structure. *(The reason for the denial is relative: see R2.)*

**N5 — Naive shared-weight sequential learning suffers catastrophic interference (McCloskey & Cohen 1989; Ratcliff 1990), and interference-resistance benefits from separating fast-specific from slow-integrated learning.** This is the biology-agnostic, information-theoretic core of T5 that even the scale-as-substitute camp grants — scale "re-implements the same separation/integration tradeoff within one substrate." *(Whether the separation is necessary or merely sufficient is relative: see R9.)*

**N6 — LLM parametric knowledge-editing fails to propagate to logical neighbors and degrades under cumulative edits.** RippleEdits (Cohen et al., TACL 2024) shows failure of entailed consequences; sequential editing induces rank/representation collapse (the model-editing-at-scale literature); AlphaEdit's null-space constraint (Fang et al., ICLR 2025) delays but does not remove the decay. An empirical fact no camp disputes.

**N7 — In LLMs, read-locus ≠ edit-locus, and edit-success is uncorrelated with causal-tracing localization** (Hase et al. 2023, undercutting the knowledge-neuron thesis of Dai et al. 2022). **N7b —** strict single-neuron localism ("one fact = one unit") is false for LLMs: the engram camp claims only *sparse ensembles*, PDP claims full distribution, so *"not single-neuron-localized"* is common ground. *(Whether delocalization is "convergence with the brain" is relative — see R5/R6.)*

**N8 — Formal identities are real as mathematics.** Auto-associative attention with keys=values equals one update of a modern (continuous) Hopfield network (Ramsauer et al. 2021); spreading-activation, personalized PageRank, and Hopfield completion share an inverse-frequency/diffusion form (Millidge et al.'s Universal Hopfield Networks framing, 2022). The math is neutral; the memory-architecture *reading* is relative (see R6).

**N9 — Contradiction between stored records cannot simply be ignored; it must be resolved somewhere on the write↔read axis.** Only this weak kernel is neutral. That there exists a *distinguished supersession operator* (as opposed to retrieval-time reconciliation, graded reweighting, or multi-writer merge) is relative — see R7.

---

## II. FRAMEWORK-RELATIVE QUESTIONS

*Each: the question, the competing positions at fair weight, what evidence would decide it, and the honest current status (with our thumb named). The point of Section II is that the answer is a property of the school, not of nature-as-settled.*

### R1 — Is memory architecturally PLURAL (discrete stores/systems), or ONE substrate that *produces* plural behavior? (T1)

**Positions.**
- *Structuralist* (modal store; Baddeley multicomponent WM; Squire declarative/nondeclarative binary; Tulving SPI): the dissociations force separable systems. The double dissociation — patient KF's impaired span with intact LTM learning vs the amnesic mirror — plus the lesion-defined declarative/nondeclarative boundary, is the strongest single inference tool for separable systems.
- *Single-substrate* (Cowan embedded-processes; Wixted/Dunn single-signal; PDP connectionism; LoP; TAP): a single graded/distributed mechanism reproduces double dissociations; "plural" is a description of behavior, not architecture.

**What would decide it.** The actual adjudicating instrument is **state-trace analysis** (Bamber 1979; Dunn & Kirsner 1988; Newell & Dunn 2008): plot one condition's performance against another's across a manipulation; if all data fall on a single monotone curve, *one latent variable suffices* and the dissociation does **not** license two systems. A genuinely two-dimensional state-trace (points that no monotone single-parameter mapping can align) would be decisive *for* plurality. The empirical record here is mixed and under-cited: many celebrated double dissociations collapse to one dimension under this test, which is precisely why the inference from dissociation to "container" is non-unique. A complementary decider is neural-population geometry — genuinely orthogonal subspaces for putative systems vs a shared manifold with different read-outs.

**Honest status / our thumb.** Coarse behavioral *dissociability* is unanimous. The inference to *discrete containers* is genuinely open. The corpus's recurring "every camp is plural" gloss silently equates dissociability with architectural plurality — **this is the single largest thumb in the whole map** (see §V-crux-1). Neither "n stores" nor "one substrate" is the default.

### R2 — WHY do agent stores fail to be episodic? (T1)

**Positions.**
- *SPI* (Tulving 1995): they fail because episodic encoding must be laid down *on top of* a prior semantic encoding; verbatim agent logs invert that order (semantic-first is required), so free-standing episodic storage is forbidden.
- *Squire / Tulving criterial*: they fail the autonoetic (or operational what-where-when) test.
- *Signal-detection* (Wixted): the question is ill-posed — "episodic" is a criterion setting on one strength+context signal, not a kind a system "has."
- *Constructive* (Schacter & Addis 2007): they fail because episodic memory is a generative simulation engine (shared with imagining the future), not a queryable log.

**What would decide it.** Largely conceptual, so "evidence" is bounded. A partial decider: build an agent whose store respects SPI ordering and test whether human-episodic *signatures* emerge (recollection/familiarity dissociation, remember/know judgments). The autonoetic criterion is not operationalizable in a machine, which gives the signal-detection "ill-posed" charge real force. This question is closer to *definition* than to empirics — flag it as such.

**Honest status / our thumb.** The possession-denial (N4) is bedrock; the *reason* is school-relative. The corpus adjudicated it on a two-item menu (autonoetic vs behavioral what-where-when) and never seated the signal-detection or constructive answers.

### R3 — Is encoding "distillation into a stored derivative, never raw"? (T2)

**Positions.**
- *Abstractionist / reconstructive*: yes — what is stored is a transformed trace.
- *Instance / multiple-trace* (MINERVA-2, Hintzman 1986; REM): no — each experience lays down a separate near-raw multi-attribute trace; abstraction is computed *at retrieval*.
- *CLS*: pattern separation *orthogonalizes to preserve distinctness* — it is anti-distillation; distillation belongs to neocortex, not the hippocampal encoder. Folding both into "transformed derivatives" erases half of CLS.
- *Connectionist*: there are no "items" to distill into — encoding is superposed weight change.

**What would decide it.** *When* does abstraction happen — encode-time, retrieve-time, or offline-consolidation-time? Discriminating experiments exist: (a) manipulate *retrieval* context to change the abstraction extracted from a **fixed** study set — success favors retrieval-time (MINERVA-2's core prediction); (b) neural evidence of gist-trace formation at encoding *independent of any retrieval* favors encode-time; (c) sleep-dependent schema extraction (Durrant et al.; Tse et al. 2007) implies some abstraction is *offline*, a third timing. Classic prototype/exemplar results (Posner & Keele 1968; Medin & Schaffer 1978) are consistent with retrieval-time abstraction from stored exemplars.

**Honest status / our thumb.** Whether abstraction is encode-time or retrieve-time is open. The neutral statement is "systems behave *as if* operating over transformed representations," and even that is contested by instance models. **"Encoding IS distillation, never raw" is a school's answer dressed as bedrock.**

### R4 — Is adaptive recall graded weighting over per-item scalars (recency × importance × relevance ≈ ACT-R activation)? (T3)

**Positions.**
- *Rational-analysis / ACT-R* (Anderson & Schooler 1991): yes — retrievability is a scalar computed from an item's properties and use-history, near-optimally tracking need-probability.
- *Instance / global-matching* (MINERVA-2, SAM, REM, TODAM): there is no per-item weight — retrieval is an emergent echo / global familiarity; the factorization into per-item scalars is a category mistake.
- *TAP*: retrievability is a *relation* between encoding and retrieval operations, not a scalar. The complaint that edge-weights have "no theory of what they mean" is the *predicted symptom*, not an engineering gap.

**What would decide it.** The **list-strength effect** (Ratcliff, Clark & Shiffrin 1990) is the classic discriminator: strengthening some list items should hurt memory for others under a pure per-item/global-matching account in specified ways — and recognition shows a *null* list-strength effect that a naive per-item strength model does not predict but REM does. More generally: a per-item scalar predicts that an item's manipulated history changes *only its own* retrievability; global-matching predicts *neighborhood* effects (retrievability of X depends on the whole studied set's similarity structure). Fan-effect data (Anderson 1974) fit both a diagnosticity scalar and a global-match interference reading — so fan alone does not decide it.

**Honest status / our thumb.** The algebraic convergence (−ln(fan) ≈ IDF / log-diagnosticity) is "same functional form"; "shared normative quantity" is "same reason," and is contested. Importance's "uniquely un-anchored" status is partly an artifact of restricting the source list to LLM systems + ACT-R — affective-tagging (McGaugh 2000, amygdala modulation), value/reward, and prediction-error accounts all supply candidate anchors for importance.

### R5 — What is retrieval: associative completion/traversal, or address lookup? (T4, the whole framing)

**Positions.**
- *Associative completion* (Hopfield / personalized PageRank / spreading activation): content-addressable completion, not lookup.
- *Address lookup*: the strawman null nobody holds.
- *The omitted third pole* (global-matching / signal-detection: SAM, REM, TODAM, MINERVA-2; dual-process recollection+familiarity; temporal-context TCM, Howard & Kahana 2002; reconstructive): retrieval is parallel similarity-weighted evidence accumulation / a criterion on a familiarity signal / context-cued drift / reconstruction — **neither** traversal **nor** lookup.

**What would decide it.** Chronometrics. Traversal predicts latency scaling with *graph distance* (multi-hop slower, serial signatures); parallel global-matching predicts *set-size* effects with parallel signatures; drift-diffusion fits (Ratcliff 1978) separate evidence-accumulation dynamics from serial search. The decisive question is *does RT scale with path length or with summed global similarity?* ROC shape (curvilinear vs the z-ROC's slope) further tests single-signal vs dual-process, bearing on whether "completion" is even the right verb.

**Honest status / our thumb.** By collapsing the field to a two-horse race (traversal vs lookup) and defeating the weak pole, every T4 sub-claim inherited an inflated air of inevitability. The live scientific question is *which similarity geometry, with what dynamics* — **this is the largest single thumb inside T4.**

### R6 — Does the attention↔Hopfield identity establish that memory *is* content-addressable associative storage? (T4)

**Positions.**
- *Associative-memory school* (via the Universal Hopfield Networks taxonomy, Millidge et al. 2022): yes — attention is CAM by that classification.
- *Others*: the resolving instrument is drawn from *inside* the school under test; the identity constrains the function class, but the CAM-vs-RAM axis presupposes the two-horse partition of R5.

**What would decide it.** This is partly non-empirical — a choice of taxonomy. The empirical residue: does the system exhibit *attractor* signatures — energy descent, basin structure, spurious/blend states under superposed cues — that alternatives (pure feed-forward similarity readout) do not? Modern Hopfield networks with large capacity collapse toward one-step retrieval, which weakens the "dynamical completion" reading even where the identity holds.

**Honest status / our thumb.** N8 (the math) is neutral. "Attention IS associative memory" is the framework-relative reading. The corpus marked this open question "answered" using a within-school instrument — a thumb (see III/downgrade 10).

### R7 — Does updating require a distinguished supersession policy (supersede-at-read vs supersede-at-write), with naive append as the error? (T6)

**Positions.**
- *Reconcile/supersede*: yes — you cannot avoid a supersession policy, only choose where it lives.
- *Coexistence / retrieval-ranking*: keep everything, return both contradictory records, resolve in the reader by relevance/recency — no supersession operator. Backed by McCloskey & Zaragoza (1985), whose no-impairment result shows the original trace *survives* misinformation, and by multiple/competitive-trace theory (Nadel & Moscovitch 1997).
- *CRDT / merge-semilattice*: multi-writer merge with no single supersession authority.
- *Graded / Bayesian*: every fact held at continuous confidence, updated by evidence — "reweight," not "supersede."
- *Reconstructive* (Bartlett): there are no stored facts to supersede in the first place.

**What would decide it.** In humans: whether "overwritten" information is *recoverable* — recovery implies coexistence (McCloskey & Zaragoza's design was built precisely to test this and found the original survives). In LLMs: RippleEdits shows an **in-context (non-parametric, coexistence-style) baseline beating parametric editing** (Cohen et al. 2024) — affirmative evidence for retrieval-time reconciliation over a write-time supersede operator. The decisive future test is whether *any* architecture *needs* a distinguished supersede op to avoid contradiction pathology, or whether retrieval-time ranking suffices at scale.

**Honest status / our thumb.** Only N9 (contradiction can't be ignored) is neutral. "A distinguished supersession policy is unavoidable" presupposes the mutable-reconcile school's premise. The RippleEdits asymmetry and McCloskey & Zaragoza were both quarantined to "open questions" or used only defensively rather than *weighed on the coexistence side* — a thumb (see III/revivals 3–4).

### R8 — Is consolidation TRANSFER between stores, transformation-with-coexistence, or schema-gated single-substrate learning? (T5)

**Positions.**
- *Standard consolidation / CLS*: fast store trains slow store; content migrates; hippocampus becomes dispensable for old memories.
- *Multiple-trace / trace-transformation* (Nadel & Moscovitch 1997; Winocur & Moscovitch): nothing migrates *out* — a coexisting cortical gist trace is *grown* while the detailed hippocampal trace persists indefinitely (flat retrograde gradient for episodic detail).
- *Standard + fast schema learning* (Tse et al. 2007; McClelland 2013): schema-consistent material consolidates in one/few shots without a slow timescale — "schema-match gates learning rate," a single-system-capable property.
- *Contextual-binding* (Yonelinas et al. 2019): the retrograde gradient reflects *interference*, the hippocampus is permanently required, and sleep's benefit is *reduced interference*, not gist abstraction.

**What would decide it.** The **shape of the retrograde amnesia gradient for matched-difficulty episodic detail** is the battleground: temporally graded (remote spared) favors transfer/standard; flat (remote as impaired as recent) favors coexistence/contextual-binding. The persistent confound is task difficulty and detail-richness across ages of memory. Optogenetic engram-tagging (Kitamura et al. 2017) complicates *pure* transfer: cortical engrams are generated *rapidly* but are initially "silent" and mature over time while the hippocampal engram persists — evidence for *coexistence + maturation* rather than clean migration-out.

**Honest status / our thumb.** The directional question is unsettled. "Migrates to slow store" and "the cracks resolve in the cluster's favor" are transfer-school framings adopted as neutral description.

### R9 — Is two-timescale separation NECESSARY ("close to a theorem") or merely SUFFICIENT? (T5)

**Positions.**
- *CLS*: near-necessary — a single network that resists interference is just relocating pattern-separation + slow-integration into one substrate.
- *Scale-as-substitute*: sufficient only; scale / representational orthogonalization is a co-equal route (Ramasesh et al. 2022, scale reduces forgetting; Mirzadeh et al. 2022, wide networks forget less), bounded by the lazy vs rich feature-learning regime (arXiv:2506.16884).
- *Standard + schema*: necessity is schema-relative — for schema-consistent input, one substrate suffices (McClelland's own 2013 amendment).

**What would decide it.** A **constructive counterexample** — a single-timescale, single-parameter learner provably interference-free on arbitrary streams *without* importing effective fast/slow separation — would refute necessity. An **impossibility result** — a proof that interference-freedom entails some separation of fast-specific from slow-integrated learning — would establish it. Neither exists. Empirically: is scale-driven robustness achievable with *no* effective fast/slow structure, or does scale merely *re-implement* the separation within one substrate (the N5 concession)?

**Honest status / our thumb.** The *sufficiency* core is near-neutral (N5). "THE structural answer, close to a theorem" is the *necessity* claim, which is framework-relative — **the second-largest thumb in the map** (see III/downgrade 7 and §V-crux-4).

### R10 — Is the LLM frozen-weights / volatile-context split a DISANALOGY or a CONVERGENCE with human memory? (T8)

**Positions.**
- *Decay-school framing*: disanalogy — humans have a native time/consolidation axis; LLM context loss is write-count-driven; the substrates differ.
- *Interference theory* (McGeoch 1932; Underwood 1957; Jenkins & Dallenbach 1924): human forgetting is *also* substantially write/interference-driven, so "writes not time" is a **convergence**, not a break.
- *Modal store*: the frozen/volatile bifurcation just *is* LTS/STS realized in silicon — convergence on a two-store architecture.
- *Cowan*: the context window is the focus of attention (a state over one store), not a second store.

**What would decide it.** The **decay-vs-interference debate itself**. If human forgetting is dominantly interference/retrieval-driven (Jenkins & Dallenbach's classic sleep result: less forgetting when fewer intervening memories are encoded), "writes not time" is convergence. If there is an irreducible time-based decay component (Hardt, Nader & Lee 2013, "Decay happens"), the disanalogy retains some purchase. The verdict *flips with which forgetting theory you hold* — which is exactly the point.

**Honest status / our thumb.** The corpus silently adopted the decay school to manufacture the asymmetry. Disanalogy-vs-convergence is not settled; it is school-relative.

### R11 — Is retrieval-emergent abstraction ("prototypes emerge at retrieval; abstraction need not be stored") bedrock? (T5)

**Positions.**
- *Instance / LoP / TAP / connectionist / single-signal*: yes, in its literal form — exemplars are stored; the prototype is not. This survives at high confidence (Posner & Keele 1968; Hintzman 1986).
- *CLS / engram*: reading it *up* into "storage is unnecessary/emergent in general" endorses a single-store rival against CLS's *stored* neocortical schemas and against physically stored engram ensembles.

**What would decide it.** Whether abstracted representations are ever found *physically stored* (favors storage — Tse et al.'s schema cells; engram ensembles) vs *always reconstructible from exemplars* (favors emergence). Almost certainly both occur, which means the *generalized* claim overreaches while the literal one stands.

**Honest status / our thumb.** Literal MINERVA-2 form ≈ neutral and hard to dislodge; the *generalized* "storage is unnecessary" gloss is framework-relative and must not be read up.

---

## III. REVIVED AND DOWNGRADED ARGUMENTS

### IIIa. REVIVED — wrongly dismissed before

1. **Degree/node-specificity normalization suppresses a genuinely central true entity as hard as an uninformative promiscuous one (T3).** Wrongly flagged a strawman; it got *stronger* after the mechanism (IDF) correction. It is a direct, unanswered limiter on the "principled Bayes-diagnosticity" reading of the fan effect. Revive against the "principled defense" framing.
2. **The "importance has no shared semantics" demand presupposes weights must MEAN one quantity (T3).** Over-dismissed as a "so-what." It *names the framework bias* — a rational-analysis assumption that instance-theory and pure-engineering views reject. Revive as the diagnosis, not a deflection.
3. **McCloskey & Zaragoza (1985) coexistence / no-impairment finding, used only defensively (T6).** Revive as *affirmative* human evidence for a non-destructive, both-traces-retained architecture. It belongs on the coexistence side of the R7 ledger, not merely subtracted from the overwrite side.
4. **RippleEdits' in-context / non-parametric baseline BEATING parametric editing (Cohen et al. 2024) (T6).** Quarantined to "open questions" twice. Revive and put on the scale as affirmative evidence for retrieval-based, non-reconciling memory. The asymmetric burden (home thesis "weakened but stands," rival result "not yet demonstrated") was our thumb.
5. **The transformation-not-transfer objection (multiple-trace/trace-transformation), decoupled from multi-trace count (T5/T2).** The prior guardrail used a single skeptical citation (Sutherland and colleagues, 2020) to down-weight the *whole* trace-transformation attack — but that work contests multi-trace *storage* while *confirming* comparable retrograde amnesia for recent and remote episodic memory, which actually supports the coexistence directionality. Revive the *directional* objection against "consolidation migrates content out" and against "encoding is distillation."
6. **Tse (2007) / McClelland (2013) as a boundary condition on NECESSITY, un-bundled (T5).** Dismissal-by-aggregation folded this with generative-replay and trace-transformation into a generic "cracks refine the cluster" bucket. The theory's own originator restricted the slow cortical timescale to *schema-inconsistent* input. Revive as a standalone narrowing of R9's necessity claim.
7. **The executive-control / inhibitory-forgetting camp (T7 and T4).** Anderson & Green's think/no-think (2001) and retrieval-induced forgetting (Anderson, Bjork & Bjork 1994) were never seated as a forgetting *mechanism*. Their omission also undercuts T4's pure spreading-activation pillar: retrieval *suppresses* rivals, whereas pure completion predicts facilitation. Revive as a fifth mechanism *and* a direct challenge to R5's activation model.

*Deliberately NOT revived (would re-plant a thumb):* "the double dissociation *forces* discrete stores" and "delocalization *is* convergence." Both are framework-relative (R1; N7/R5), not clean revivals — reviving either as settled would swing the thumb the other way.

### IIIb. DOWNGRADED — wrongly accepted before

1. **"Squire co-signs the four-box partition" (was high).** Downgrade. Squire's taxonomy is a lesion-grounded declarative/nondeclarative *binary*; he argued *against* episodic/semantic as separate systems (the Vargha-Khadem et al. 1997 developmental-amnesia exchange). The lesion warrant licenses only coarse plurality; the four-box borrows biological gravitas it did not earn.
2. **"AI's declarative/procedural cut is largely borrowed from psychology," plus the refusal to split the genealogy claim (T1).** Downgrade. Anderson implemented procedural knowledge as Newell's *production rules* — a computational formalism, not Tulving/Squire. The record also **endorsed a strawman** flattening Newell & Simon's *Human Problem Solving* (1972) into "a cognitive-psychology monograph" to route the AI branch downstream of psychology — the clearest single instance of our thumb; correct it. CLS (item IV-1) is the genuine *computational-native* derivation of a fast/slow split, which the borrowing narrative erased.
3. **"Encoding IS distillation, never raw" (was high → already medium).** Downgrade the *framing*, not just the confidence: "store a transformed trace" does ontological work the evidence does not compel (R3).
4. **"Deep / genuine convergence" rhetoric across T2.** Downgrade to *functional* convergence. When the encode/retrieve tension was dissolved by retreating to "functional convergence under capacity pressure" (near-analytic: any bounded channel compresses), the discount was charged only to one sub-claim. Apply the same discount uniformly.
5. **"−ln(fan) ↔ IDF as a shared normative quantity" (T3).** Downgrade to "shared functional form, contested interpretation." Same-shape ≠ same-reason — the exact inference the record correctly attacked elsewhere, reinstated because it flatters the convergence narrative.
6. **"Averell & Heathcote (2011) answers the forgetting-curve form in the power-law's favor" (T7).** Rebalance: the *raw-data* fit was exponential-best (anti-power-law); the power form won only under complexity-penalized Bayesian model selection. Only the favorable half was credited.
7. **"Two-timescale is THE structural answer, close to a theorem" (was high) (T5).** Downgrade the *necessity* form to *sufficiency* (R9). This top-line "high" survived un-audited while peripheral T5 citations were being corrected — the same confidence-laundering flagged elsewhere.
8. **T7 rated "robust" at the topic level.** Split it: the human-science core (lawful forgetting, spacing, testing) is robust; the *AI-gap* sub-claim ("AI has no principled capacity-driven or targeted decay") is *contingent* on a narrow "AI = LLM factual QA" scope, and is false once caching theory, machine unlearning, and recommender temporal dynamics are in view (IV-9).
9. **"No ungated single-exposure durable write has any biological analogue" (absolutism) (T8).** Downgrade the absolutism — the comparison set was under-searched (reconsolidation; one-trial conditioned taste aversion; flashbulb memories). The narrower point that biological single-shot writes are *salience-gated* may survive; "no analogue exists" is over-credited.
10. **T4 open question marked "answered."** Downgrade to "answered within one framework" — resolved by a within-school (associative-memory) instrument (R6).
11. **SPI enlisted as an anti-store / pro-continuum authority (T1).** Correct the mischaracterization: SPI is a *systems* model affirming distinct episodic/semantic/perceptual systems that merely adds encoding-time coupling. Using it against discrete stores inverts what it claims.

---

## IV. STONES UNTURNED / GENUINE BLIND SPOTS

*Each: what it is (real work), which topic it bears on, and which way it cuts — including where it cuts against our own thumb and against the process camp.*

1. **Complementary Learning Systems as a cross-topic witness** (McClelland, McNaughton & O'Reilly 1995; Kumaran, Hassabis & McClelland 2016). Seated only in T5; never brought into T1/T3/T4/T6, where it is directly on point as the *computational-native* derivation of a fast/slow (≈episodic/semantic) split from the math of catastrophic interference — the missing "AI leg" that let the T1 independence count wobble. *Cuts for limited structuralist independence.*
2. **Instance / global-matching models as a genuine THIRD pole** (MINERVA-2, SAM, REM, TODAM, Logan 1988). Neither discrete-stores nor pure-continuum: retrieval as emergent global familiarity. Dissolves the T3 per-item-scalar and T4 completion-vs-lookup binaries. Tellingly, Hintzman appears in the record only as a Tulving–Wiseman critic; MINERVA-2 was never seated. *Cuts against both defaults.*
3. **Rate-distortion / resource-rational memory** (Bhui, Lai & Gershman 2021; Bates & Jacobs 2020, *Psychological Review*). The falsifiable operationalization of "distillation" (T2) and a normative account of graceful forgetting (T5/T7). Cuts **both ways**: it gives the vacuity charge formal teeth — any capacity-bounded channel compresses optimally, so cross-field "convergence" may be near-analytic. Only the softest exponents of this bridge were engaged.
4. **Interference theory of HUMAN forgetting** (McGeoch 1932; Jenkins & Dallenbach 1924; Underwood 1957). The single biggest unexamined thumb behind T8: it recasts "writes not time" as a convergence (R10) and reframes T7's mechanism map. *Cuts against our disanalogy thumb.*
5. **Reconsolidation** (Nader, Schafe & LeDoux 2000). A real biological *rewrite-on-retrieval* channel — undercuts "frozen store" (T8), "no biological rewrite" (T8), and write-once directional transfer (T5). *Cuts against multiple structuralist assumptions.*
6. **Contextual-binding theory** (Yonelinas, Ranganath, Ekstrom & Wiltgen 2019). Attacks the T5 *core*, not its edges: retrograde gradient = interference, hippocampus permanently required, sleep benefit = reduced interference, not gist abstraction. *Cuts against the transfer/CLS reading.*
7. **Signal-detection single-process recognition** (Wixted 2007). The single-signal camp's strongest missing instrument: an unequal-variance single signal reproduces the ROC curvature that dual-process cites as proof of two processes. Bears on R2 and the T4 dual-process gap. *Note the even-handed caveat:* seating it makes single-vs-dual *contested*, not single-process-default — do not over-read.
8. **Executive-control / inhibitory forgetting** (Anderson & Green 2001; retrieval-induced forgetting). A fifth mechanism camp (T7) and a direct challenge to T4's spreading-activation-as-facilitation. *Cuts against the pure-completion reading.*
9. **Caching / competitive analysis** (Belady 1966 optimal MIN; LRU/LFU/ARC) + **machine unlearning** (Bourtoule et al. 2021, SISA) + **recommender temporal dynamics** (Koren 2009, timeSVD++). Together a 60-year theory of optimal forgetting-under-capacity plus principled, targeted removal — refuting the T7/T8 "AI has no principled capacity-driven or targeted decay" gap. *Cuts against our thumb.*
10. **Bjork & Bjork New Theory of Disuse** (storage strength vs retrieval strength; 1992). A THIRD option beyond LoP and TAP, cutting *both* ways: it supplies the intrinsic-strength dimension TAP's "purely relational" reading denies, *and* the two-orthogonal-strengths structure the single-scalar reading denies. On point for T2 and T3.
11. **Constructive / generative episodic memory** (Schacter & Addis 2007; Bartlett 1932). Defends the T1 possession-denial on an axis orthogonal to the contested autonoetic criterion, and challenges the store-and-retrieve ontology (T2, T4, T6) at the root.
12. **Fuzzy-trace theory as genuinely DUAL-storage** (Reyna & Brainerd). Cited one-directionally as *pro-distillation*, but it holds that verbatim AND gist traces are stored *in parallel at encoding* — a partly *anti*-thesis source used as pro-thesis evidence (T2, T5).
13. **The functionalism / Marr's-levels objection.** T8's substrate-level disanalogy verdicts are only interesting if one *rejects* functionalism (a computation realized in different substrates is the same computation). A silent framework dependence never flagged.
14. **The capacity premise itself** (T2). "Bounded capacity ⇒ distill at encoding" is unexamined. Human storage estimates are enormous (Landauer 1986, ~10⁹ bits over a lifetime), and the binding constraint may be *interference/retrieval*, not storage. If so, the cluster's foundational "why" is weaker than stated.

---

## V. HONEST OPEN CRUXES FOR LATER

*The deepest unresolved questions, distilled. Each is genuinely open — stated so that adopting a school does not smuggle in an answer.*

**Crux 1 — Dissociability vs architecture (R1).** Does behavioral dissociation license *architectural* plurality? This is the master crux: it is the load-bearing move under T1, and its "everyone is plural" gloss quietly propped up the store-vocabulary of T2–T6. The adjudicating tool (state-trace dimensionality) exists and has *not* been run to conclusion across the key dissociations. Until it is, "n discrete stores" and "one graded substrate producing n behaviors" are co-equal.

**Crux 2 — WHEN does abstraction happen (R3 + R8 + R11)?** Encode-time (distillation), retrieve-time (instance/global-matching), or offline-consolidation-time (schema/CLS)? This one question cuts across T2, T5, and T11 and is currently answered differently by each school as if settled. The discriminating experiments (fixed-study-set retrieval manipulations; encode-time gist-trace imaging; sleep-dependent schema extraction) are known but not jointly decisive yet.

**Crux 3 — Supersession vs coexistence (R7).** Is a distinguished write-time supersede operator *unavoidable*, or does retrieval-time reconciliation over retained records suffice? The human evidence (McCloskey & Zaragoza: originals survive) and the LLM evidence (RippleEdits: in-context beats parametric editing) both currently lean *coexistence* — and both were quarantined rather than weighed. This is a crux with a visible thumb still on it; naming it is part of the correction.

**Crux 4 — Necessity vs sufficiency of two-timescale separation (R9).** No constructive counterexample (a single-timescale interference-free learner) and no impossibility proof exist. "Close to a theorem" was the necessity claim; only sufficiency is established (N5). This is the cleanest place where a *formal* result — not more argument — would settle the matter.

**Crux 5 — The third pole was never seated (R4 + R5).** Instance / global-matching / signal-detection dissolves *both* the "per-item scalar" framing of T3 and the "completion vs lookup" framing of T4. That the entire field was run as a two-horse race, with the third family present only as scattered critics (Hintzman as a Tulving–Wiseman footnote), is the largest structural blind spot. The chronometric discriminators (RT-vs-path-length vs RT-vs-global-similarity; ROC shape) are the concrete way forward.

**Crux 6 — Is the substrate disanalogy even meaningful (R10 + IV-13)?** Whether frozen-weights/volatile-context differs *importantly* from human memory depends on (a) whether human forgetting is time- or interference-driven (unsettled), and (b) whether one accepts functionalism at all (never flagged). Both dependencies must be made explicit before any T8 verdict is load-bearing.

**Crux 7 — The capacity premise (IV-14).** The entire "distill because capacity is bounded" motivation rests on a storage-limit assumption that human data (Landauer) does not obviously support; the real limit may be retrieval/interference. If so, the "why" beneath T2 and much of T5 is a different constraint than the one assumed.

---

## CLOSING — the even-handedness ledger

**Our primary thumb** was a *default-setting* bias, not uniform hostility to the process camp: the discrete-store structuralist lineage got to be *bedrock* while Cowan, single-signal, PDP, LoP, TAP, and the instance/global-matching family had to appear as *attacks on a default*. The load-bearing device was the "coarse plurality is unanimous" gloss, which manufactures agreement by defining "plural" as descriptive dissociability — which a single-substrate model happily grants (Crux 1). The single-signal and connectionist champions are rated most under-weighted not because verdicts went against them but because they were **never seated as first-class hypotheses**.

**Our secondary, narrower thumb** was inside T5: CLS-*necessity* ("close to a theorem") over its live rivals (scale-as-substitute, schema-gating, trace-transformation, contextual-binding). Here the over-weighted school is CLS specifically, not structuralism broadly (Crux 4).

**Counter-thumbs we also found, so this does not become a new coronation.** The audit corrected *against* plurality in places (it credited Cabeza & Moscovitch's components-over-systems view, walked back an over-charged independence-collapse, protected CLS from a weak continual-learning witness, and accepted MINERVA-2 retrieval-emergent abstraction at high — an anti-structuralist result). There is a *local* counter-thumb toward the process side in the T1 crux itself, which was worded from Cowan's side (activated-LTM as the baseline discrete stores must justify themselves against) and which miscast SPI — a *systems* model — as anti-store. So the thumb is not monolithic: the architecture layer (T2–T8) leans structuralist while the T1 crux leans embedded-processes.

**The corrected posture.** Keep Section I as bedrock. Treat Section II as explicitly school-dependent, with competing positions weighted evenly and a decider named for each. Revive Section III-a; downgrade III-b. Treat Section IV — especially CLS-as-cross-topic-witness, the instance/global-matching third pole, rate-distortion, interference theory, and the caching/unlearning literature — as the evidence whose *absence* let the structuralist default look more inevitable than the philosophies of memory actually make it. The under-weighted champions are entitled to a seat, not to become the new default: "single-signal defeats dual-process," "delocalization *is* convergence," and "retrievability is *never* intrinsic" (which Bjork & Bjork's storage/retrieval-strength distinction directly cuts against) are themselves framework-relative overreaches. The fair resting state is a filled table, not a flipped default.
