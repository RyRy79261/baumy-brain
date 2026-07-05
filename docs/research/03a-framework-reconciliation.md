# REBALANCED ASSESSMENT — Framework-Bias Integration

Scope note: this is a weighting audit across competing philosophies of memory. It does not crown a winner, propose a design, or defend prior verdicts. Where a claim's truth depends on which school you adopt, that is stated as a property of the claim, not resolved. I have actively hunted our own thumb, including the mirror-image thumb toward the process/single-system side.

---

## 1. FRAMEWORK-NEUTRAL BEDROCK vs FRAMEWORK-RELATIVE

### 1A. Genuinely framework-neutral bedrock (survives under ALL 14 champions)

These survive because they are stated at the level of *phenomenon or formal fact*, stripped of the contested ontology. Every champion — structuralist and process/distributed alike — concedes them.

- **N1. Memory shows robust functional/behavioral dissociations.** Spared skill-learning/priming with impaired recall; recency vs primacy; impaired STM-span with intact LTM-learning and its mirror. Every school accepts the dissociations *exist*. (What they *imply* is relative — see R1.)
- **N2. Retrieval is cue-dependent, not a readout of absolute trace strength.** accessibility ≠ availability (Tulving & Pearlstone 1966); encoding specificity (Tulving & Thomson 1973). Endorsed alike by TAP, engram (silent-engram = intact-availability/failed-accessibility), PDP (completion is cue-driven), and signal-detection. T4-B survives/high correctly.
- **N3. Forgetting is lawful in the WEAK form** (monotone, negatively-accelerated, plateauing above chance) and **spacing + testing/retrieval-practice robustly improve retention.** T7-A. The *parametric* form (power vs exponential) and the *mechanism* are not bedrock.
- **N4. Agent/LLM stores do not possess human-episodic memory in any strong sense.** The possession-denial is conceded even by the LLM-episodic preprint authors. T1-B. (The *reason* is relative — see R2.)
- **N5. Naive shared-weight sequential learning suffers catastrophic interference, and interference-resistance benefits from separating fast-specific from slow-integrated learning.** This is the biology-agnostic, information-theoretic core of T5 that even the Scale-as-substitute champion grants (scale "re-implements the same separation/integration tradeoff within one substrate").
- **N6. LLM parametric knowledge-editing fails to propagate to logical neighbors and degrades under cumulative edits** (RippleEdits; spectral/rank collapse; AlphaEdit only delays). T6-C survives/high. An empirical fact; PDP *claims* it, no one disputes it.
- **N7. In LLMs, read-locus ≠ edit-locus and edit-success is uncorrelated with causal-tracing localization** (Hase 2023; knowledge-neuron thesis undercut, Dai 2022). The *fact* is neutral. **N7b. Strict single-neuron localism ("one fact = one unit") is false for LLMs** — even the engram champion claims only *sparse ensembles*, and PDP claims full distribution, so *"not single-neuron-localized"* is common ground.
- **N8. Formal identities are real as mathematics:** (auto-associative, K=V) attention = one modern-Hopfield update (Ramsauer 2021); spreading-activation / personalized PageRank / Hopfield completion share an inverse-frequency/diffusion form. The math is neutral; the memory-architecture *reading* is relative (R6).
- **N9. Contradiction between stored records cannot simply be ignored** — it must be resolved *somewhere* on the write↔read axis. (Only this weak kernel is neutral; that there is a *distinguished supersession operator* is relative — see R7.)

### 1B. Framework-relative (verdict depends on school) — competing positions at fair weight

**R1. Is memory architecturally PLURAL (discrete stores/systems) or ONE substrate that produces plural behavior?** (T1-A/C)
- *Structuralist (modal-store, multicomponent WM, Squire-binary, SPI):* the dissociations force separable systems; the KF↔amnesia double dissociation and lesion-defined declarative/nondeclarative boundary are the strongest single-inference tools for separable systems.
- *Single-substrate (Cowan embedded-processes, Wixted/Dunn single-signal, PDP connectionist, LoP, TAP):* a single distributed/graded mechanism reproduces double dissociations (Dunn & Kirsner 1988); "plural" is behavioral, not architectural.
- *Fair weight:* coarse behavioral **dissociability** is agreed by all; the inference to **discrete containers** is genuinely non-unique. Neither "n stores" nor "one substrate" is the default. The corpus's recurring "every camp is plural" gloss silently conflates dissociability with architectural plurality — our thumb (see §5).

**R2. WHY do agent stores fail to be episodic?** (T1-B)
- *SPI:* they fail because episodic encoding must be laid down *on top of* a prior semantic encoding; agent logs are captured verbatim, semantic-first-inverted — free-standing episodic storage, which SPI forbids.
- *Squire/Tulving:* they fail the autonoetic (or operational what-where-when) criterion.
- *Signal-detection:* the question is ill-posed — "episodic" is a criterion setting on one strength+context signal, not a kind an agent could "have."
- *Constructive (Schacter & Addis):* they fail because episodic memory is a generative/reconstructive simulation engine, not a queryable log.
- *Fair weight:* the possession-denial (N4) is bedrock; the *reason* is school-relative and the corpus adjudicated it on only a two-item menu (autonoetic vs behavioral WWW).

**R3. Is encoding "distillation into a stored derivative, never raw"?** (T2-A)
- *Abstractionist/reconstructive:* yes — what is stored is a transformed trace.
- *Instance/multiple-trace (MINERVA-2, Hintzman; REM):* no — each experience lays down a separate near-raw multi-attribute trace; abstraction is computed **at retrieval**. Under this school "encoding is distillation" is simply false.
- *CLS:* pattern separation ORTHOGONALIZES to *preserve* distinctness — it is anti-distillation; distillation belongs to neocortex, not the hippocampal encoder. Folding both into "transformed derivatives" erases half of CLS.
- *MTT/TTT:* detailed context-bound traces persist indefinitely; not gist-only.
- *Connectionist:* there are no "items" to distill into — encoding is superposed weight change.
- *Fair weight:* whether abstraction is an encode-time or retrieve-time operation is *open*. Neutral statement: "systems behave as if operating over transformed representations" — and even that is contested by instance models. "Encoding IS distillation, NEVER raw" is a school's answer dressed as bedrock.

**R4. Is adaptive recall graded weighting over per-item scalars (recency × importance × relevance ≈ ACT-R activation)?** (T3-A/B/D)
- *Rational-analysis/ACT-R:* yes — retrievability is a scalar computed from an item's properties/use-history, near-optimally tracking need-probability.
- *Instance/global-matching (MINERVA-2, SAM, REM, TODAM):* there is no per-item weight — retrieval is an emergent echo/global familiarity; the factorization is a category mistake.
- *TAP:* retrievability is a *relation* between encoding and retrieval operations, not a scalar; the "no theory of what an edge weight MEANS" (T3-D) is the predicted symptom, not an engineering gap.
- *Fair weight:* the algebraic convergence (−ln(fan) ≈ IDF/log-diagnosticity) is "same functional form"; "shared normative quantity" is "same reason" and is contested. Importance's "uniquely un-anchored" status (T3-D) is partly an artifact of restricting sources to LLM systems + ACT-R (affective-neuroscience/McGaugh, value-based, and prediction-error accounts all supply candidate anchors).

**R5. What is retrieval — associative completion/traversal, or address lookup?** (T4, whole framing)
- *Associative-completion (Hopfield/PPR/spreading-activation):* content-addressable completion, not lookup.
- *Address-lookup:* the strawman null nobody holds.
- *Third pole the binary omits (global-matching/signal-detection: SAM, REM, TODAM, MINERVA-2; dual-process recollection/familiarity; temporal-context TCM; reconstructive):* retrieval is parallel similarity-weighted evidence accumulation / criterion on a familiarity signal / context-cued drift / reconstruction — **neither** traversal **nor** lookup.
- *Fair weight:* by collapsing the field to a two-horse race and defeating the weak pole, every T4 claim inherited an inflated sense of inevitability. The live scientific question is *which similarity geometry with what dynamics*, not traversal-vs-lookup. This is the largest single thumb in T4.

**R6. Does the attention↔Hopfield identity establish that memory is content-addressable associative storage?** (T4-A)
- *Associative-memory school (via Millidge "Universal Hopfield Networks"):* yes — attention is CAM by that taxonomy.
- *Others:* the resolving instrument is drawn from *inside* the school under test; the identity constrains the function class but the CAM-vs-RAM axis presupposes the two-horse partition.
- *Fair weight:* N8 (the math) is neutral; "attention IS associative memory" is the framework-relative reading. The corpus marked Open-Question-A "answered" using a within-school instrument — a thumb.

**R7. Does updating require a distinguished supersession policy (supersede-at-read vs supersede-at-write), with naive append as the error?** (T6-A)
- *Reconcile/supersede school:* yes — you cannot avoid a supersession policy, only choose where it lives.
- *Coexistence / retrieval-ranking:* keep everything, return both contradictory records, resolve in the reader by relevance/recency — there is *no* supersession operator. Backed by McCloskey & Zaragoza (both traces retained) and multiple/competitive-trace theory (Nadel & Moscovitch).
- *CRDT / merge-semilattice:* multi-writer merge, no single supersession authority.
- *Graded/Bayesian:* every fact held at continuous confidence, updated by evidence — "reweight," not "supersede."
- *Reconstructive (Bartlett):* there are no stored facts to supersede.
- *Fair weight:* only N9 (contradiction can't be ignored) is neutral. "A distinguished supersession policy is unavoidable" presupposes the mutable-reconcile school's own premise. The RippleEdits in-context baseline *beating* parametric editing is affirmative evidence for the retrieval/coexistence rival that was quarantined to "open questions" instead of weighed (see §2).

**R8. Is consolidation TRANSFER between stores, or transformation-with-coexistence, or schema-gated single-substrate learning?** (T5-B/D)
- *Standard-consolidation/CLS:* fast store trains slow store; content migrates; hippocampus becomes dispensable.
- *MTT/TTT:* nothing migrates *out* — a coexisting cortical gist trace is *grown* while the detailed hippocampal trace persists permanently (flat retrograde gradient for episodic detail, conceded even by Sutherland 2020).
- *Standard + fast schema learning (Tse 2007; McClelland 2013):* schema-consistent material consolidates in one/few shots without a slow timescale — "schema-match gates learning rate," a single-system-capable property.
- *Contextual-binding (Yonelinas et al. 2019):* retrograde gradient = interference, hippocampus permanently required, sleep benefit = reduced interference, not gist-abstraction.
- *Fair weight:* the directional question is unsettled. "Migrates to slow store" and "the cracks resolve in the cluster's favor" are transfer-school framings adopted as description.

**R9. Is two-timescale separation NECESSARY ("close to a theorem") or merely SUFFICIENT?** (T5-A)
- *CLS:* near-necessary — a single network that resists interference is just relocating pattern-separation + slow-integration into one substrate.
- *Scale-as-substitute:* sufficient only; scale/orthogonalization (Ramasesh 2022; Mirzadeh 2022) is a co-equal route, bounded by the lazy/rich-feature regime (arXiv 2506.16884).
- *Standard+schema:* necessity is schema-relative — for schema-consistent input one substrate suffices (McClelland's own 2013 amendment).
- *Fair weight:* the *sufficiency* core is near-neutral (N5). "THE structural answer, close to a theorem" is the necessity claim and is framework-relative — this is the second-largest thumb (see §5).

**R10. Is the LLM frozen-weights/volatile-context split a DISANALOGY or a CONVERGENCE with human memory?** (T8-A)
- *Decay-school framing (as-recorded):* disanalogy — humans have a native time/consolidation axis, LLM loss is write-count-driven; substrates differ.
- *Interference theory (McGeoch 1932; Underwood 1957):* human forgetting is *also* substantially write/interference-driven, so "writes not time" is a **convergence**, not a break.
- *Modal-store:* the bifurcation *is* STS/LTS realized in silicon — convergence on two-store architecture.
- *Cowan:* the context window is the focus-of-attention (a state over one store), not a second store.
- *Fair weight:* the corpus silently picked the decay school to manufacture the asymmetry. The disanalogy-vs-convergence verdict flips with the school.

**R11. Is retrieval-emergent abstraction ("prototypes emerge at retrieval; abstraction need not be stored," MINERVA-2, T5-C) bedrock?**
- *Instance/LoP/TAP/connectionist/single-signal:* yes — their central claim; correctly survives/high in its literal form (exemplars *are* stored; the prototype is not).
- *CLS/engram:* reading it UP into "storage is unnecessary/emergent generally" endorses a single-store rival against CLS's stored neocortical schemas and against physically-stored engram ensembles.
- *Fair weight:* literal MINERVA-2 form = neutral-ish and hard to dislodge; the *generalized* "storage is unnecessary" gloss is framework-relative and should not be read up.

---

## 2. CONFIRMED WRONGFUL DISMISSALS TO REVIVE

Only items where the neutral re-audit found "wrongly-dismissed," or where a champion and the re-audit independently converge.

1. **T3-B3 — degree/node-specificity normalization suppresses a genuinely central true entity as hard as an uninformative promiscuous one.** Wrongly flagged as a strawman; it got *stronger* after the mechanism correction (IDF term). It is a direct, unanswered limiter on the "principled Bayes-diagnosticity" reading of the fan effect. Revive against B's "principled defense" framing.
2. **T3-D3 — the "importance has no shared semantics" demand presupposes weights must MEAN one quantity.** Over-dismissed as a "so-what." It names the exact framework bias (a rational-analysis assumption that instance-theory and pure-engineering views reject). Revive as the diagnosis, not a deflection.
3. **T6 — McCloskey & Zaragoza coexistence/no-impairment finding used only defensively.** Revive it as *affirmative* human evidence FOR a non-destructive both-traces-retained architecture — it belongs on the coexistence side of the ledger (R7), not merely subtracted from the overwrite side.
4. **T6 — RippleEdits in-context/non-parametric baseline BEATING parametric editing (Cohen et al., TACL 2024).** Quarantined to "open questions" twice. Revive and put on the scale as affirmative evidence for retrieval-based, non-reconciling memory; the asymmetric burden (home thesis "weakened-but-stands," rival result "not yet demonstrated") is our thumb.
5. **T5 — the transformation-not-transfer objection (MTT), decoupled from multi-trace *count*.** The Tier-F guardrail used Sutherland 2020 to down-weight the *whole* MTT attack, but Sutherland contests only multi-trace *storage* and actually *confirms* comparable retrograde amnesia for recent/remote episodic — which supports the coexistence directionality. Revive the directional objection against T5-B "migrates" and T2-A.
6. **T5 — Tse 2007 / McClelland 2013 as a boundary-condition on NECESSITY, un-bundled.** Dismissal-by-aggregation folded it with generative-replay and MTT into a generic "cracks refine" bucket. The theory's own originator restricted slow-cortex to schema-inconsistent input; revive it as a standalone narrowing of R9's necessity claim.
7. **T7 — the executive-control/inhibitory forgetting camp** (Anderson & Green 2001 think/no-think; retrieval-induced forgetting) was never seated as a mechanism. Its omission also under-cuts T4's pure spreading-activation pillar (retrieval *suppresses* rivals; completion predicts facilitation). Revive as a fifth mechanism and a direct T4 challenge.

Not revived (would re-plant a thumb): "the double dissociation forces discrete stores" (modal/multicomponent) and "delocalization IS convergence" (PDP) are **framework-relative** (R1, N7/R5), not clean revivals — reviving either as settled would just swing the thumb the other way.

---

## 3. CONFIRMED WRONGFUL ACCEPTANCES TO DOWNGRADE

1. **T1-A "Squire co-signs the four-box partition" (high).** Downgrade. Squire's taxonomy is a lesion-grounded declarative/nondeclarative **binary**; he argued *against* episodic/semantic as separate systems (Vargha-Khadem rebuttal). The lesion warrant licenses only coarse plurality; the four-box borrows biological gravitas it did not earn.
2. **T1-A/C "arrived at independently / genealogy is settled" and the refusal to split Claim A.** Downgrade the confidence that AI's declarative/procedural cut is "largely borrowing." Anderson implemented procedural knowledge as Newell's production rules — a *computational* formalism, not Tulving/Squire. And the record **endorsed a strawman** flattening Newell & Simon's *Human Problem Solving* into "a cognitive-psychology monograph" to route the AI branch downstream of psychology — the clearest single instance of our thumb; correct it.
3. **T2-A "encoding IS distillation, never raw" (high→already medium).** Downgrade further in *framing*, not just confidence: "store a transformed trace" does load-bearing ontological work the evidence does not compel (R3).
4. **T2 A/C "deep/genuine convergence" rhetoric.** Downgrade to *functional* convergence. When the A↔D tension was dissolved by retreating to "functional convergence under capacity pressure" (near-analytic: any bounded channel compresses), the price was charged only to D; A and C kept "genuine convergence" prose. Apply the same discount to A and C.
5. **T3 "restore −ln(fan) ↔ IDF as a shared normative quantity" (T3-B).** Downgrade to "shared functional form, contested interpretation." Same-shape ≠ same-reason — the exact inference the record correctly attacked elsewhere, reinstated because it flatters the convergence narrative.
6. **T3-C "Averell & Heathcote 2011 answers in C's favor."** Rebalance: the *raw-data* fit was exponential-best (anti-power-law); power won only under complexity-penalized Bayesian selection. Only the favorable half was credited.
7. **T5 "two-timescale is THE structural answer, close to a theorem" (high).** Downgrade the *necessity* form to *sufficiency* (R9). This top-line "high" survived un-audited while peripheral T5 citations were corrected — the same confidence-laundering the gate flagged elsewhere.
8. **T7 topic-level "robust."** Split it: A/B (human-science) robust; **D (the AI-gap claim) contingent** on a narrow "AI = LLM-factual-QA" scope. "No principled capacity-driven decay in AI" is false once caching theory, machine unlearning, and recommender temporal dynamics are in view (see §4).
9. **T8-C "no ungated single-exposure durable write has any biological analogue" (absolutism).** Downgrade the absolutism (the comparison set was under-searched — reconsolidation, one-trial conditioned taste aversion, flashbulb). The **security core** (attacker-arbitrary, untrusted, non-salience-gated content) may still survive, because the biological analogues are salience-gated — but "no analogue exists" is over-credited.
10. **T4 Open-Question-A "answered."** Downgrade to "answered within one framework" — resolved by a within-school (associative-memory) instrument (R6).
11. **Mischaracterization to correct (not accept): SPI cast as an anti-store / pro-continuum authority in T1-C.** SPI is a *systems* model that affirms distinct episodic/semantic/perceptual systems and only adds encoding-time coupling. Enlisting it against discrete stores inverts what it claims.

---

## 4. GENUINE STONES UNTURNED TO ADD

Curated for cross-topic leverage; noting where each cuts *against* our thumb and where it cuts against the process camp too.

1. **Complementary Learning Systems as a cross-topic witness** (McClelland, McNaughton & O'Reilly 1995; Kumaran et al. 2016). It is a T5 champion but was **never brought into T1/T3/T4/T6**, where it is directly on point: it is the genuine *computational-native* derivation of a fast/slow (~episodic/semantic) split from the math of catastrophic interference — the missing AI-leg that made the T1 independence count slide (three→one→two). Cuts *for* limited structuralist independence.
2. **Instance / global-matching models as a THIRD pole** (MINERVA-2, SAM, REM, TODAM, Logan). Neither discrete-stores nor pure-continuum: retrieval as emergent global familiarity. Dissolves the T3 per-item-scalar and T4 completion-vs-lookup binaries. Tellingly, Hintzman appears in the record only as a Tulving-Wiseman critic; his MINERVA-2 was never seated.
3. **Rate-distortion / resource-rational memory** (Bhui, Lai & Gershman 2021; Bates & Jacobs 2020, *Psych Review*). The falsifiable operationalization of "distillation" (T2) *and* a normative derivation of graceful forgetting (T5/T7) — and it cuts **both ways**: it gives the vacuity charge formal teeth (any capacity-bounded channel compresses optimally, so cross-field "convergence" may be near-analytic). The record engaged only the softest exponents of this bridge.
4. **Interference theory of HUMAN forgetting** (McGeoch 1932; Jenkins & Dallenbach 1924; Underwood 1957). The single biggest unexamined thumb behind T8-A: it recasts "writes not time" as convergence (R10), and reframes T7's mechanism map.
5. **Reconsolidation** (Nader, Schafe & LeDoux 2000). A real biological *rewrite-on-retrieval* channel — undercuts the "frozen store" (T8-A), "no biological rewrite" (T8-C), and write-once directional-transfer (T5) assumptions.
6. **Contextual-binding theory** (Yonelinas, Ranganath, Ekstrom & Wiltgen 2019). Attacks the T5 *core* (not its edges): retrograde gradient = interference, hippocampus permanently required, sleep benefit = reduced interference, not gist-abstraction.
7. **Signal-detection single-process recognition** (Wixted 2007). The single-signal champion's strongest missing instrument: unequal-variance single-signal reproduces the ROC curvature dual-process cites as proof of two processes. Bears on T1-B and the T4 dual-process gap. (Note: seating it makes single-vs-dual *contested*, not single-process-default — do not over-read.)
8. **Executive-control / inhibitory forgetting** (Anderson & Green 2001; retrieval-induced forgetting) — fifth mechanism camp (T7) and a direct challenge to T4's spreading-activation-as-facilitation.
9. **Caching / competitive-analysis theory** (Belady 1966 optimal MIN; LRU/LFU/ARC) + **machine unlearning** (Bourtoule et al. 2021, SISA) + **recommender temporal dynamics** (Koren 2009). Together they refute the T7-D / T8-A "AI has no principled capacity-driven or targeted decay" gap — a 60-year theory of optimal forgetting-under-capacity plus principled uncontradicted removal. Cuts against *our* thumb.
10. **Bjork & Bjork New Theory of Disuse** (storage strength vs retrieval strength). A THIRD option beyond LoP and TAP that cuts *both* ways: it supplies the intrinsic-strength dimension TAP's "purely relational" reading denies, *and* the two-orthogonal-strengths structure the single-scalar reading denies. On-point for T2-C and T3.
11. **Constructive / generative episodic memory** (Schacter & Addis 2007; Bartlett 1932). Defends the T1-B possession-denial on an axis orthogonal to the contested autonoetic criterion, and challenges the store-and-retrieve ontology (T2, T4, T6) at the root.
12. **Fuzzy-trace theory as genuinely DUAL-storage** (Reyna & Brainerd). It was cited one-directionally as *pro*-distillation, but it holds verbatim AND gist are stored in parallel *at encoding* — a partly-anti-thesis source used as pro-thesis evidence (T2-A, T5-B).
13. **The functionalism / Marr's-levels objection.** T8's substrate-level disanalogy verdicts (A, B) are only interesting if one *rejects* functionalism; a silent framework dependence never flagged.
14. **The capacity premise itself** (T2). "Bounded capacity ⇒ distill at encoding" is unexamined; human storage estimates are enormous (Landauer 1986) and the binding constraint may be interference/retrieval, not storage. If so the cluster's foundational "why" is weaker than stated.

---

## 5. WHERE WE HAD BEEN OVER-WEIGHTING — BLUNT

**The over-weighted philosophy is the discrete-store structuralist ontology: the Atkinson-Shiffrin modal-store → Tulving multiple-systems → symbolic-boxes-and-arrows lineage.** The corpus treated as neutral bedrock a chain of commitments that are each a *school's choice*:
- "memory is plural discrete stores/systems" (T1),
- "encoding writes a transformed item INTO a store" (T2),
- "recall is graded weighting over stored per-item scalars" (T3),
- "retrieval is completion/traversal over a stored associative structure" (T4),
- "consolidation TRANSFERS content between a fast and a slow store" (T5),
- "updating SUPERSEDES stored records" (T6).

**The tell is structural, not local.** The topic *titles and cruxes* are written in store/systems vocabulary ("encoding is distillation," "completion vs lookup," "supersede vs append," "close to a theorem"). That framing forces the live rivals — Cowan's embedded-processes, Wixted/Dunn single-signal, PDP connectionism, Craik's levels-of-processing, Morris's transfer-appropriate processing, and the instance/global-matching family — to appear only as *attacks on a structuralist default*, never as co-equal framings. That is why the single-signal and connectionist champions are rightly rated the most under-weighted: not because specific verdicts went against them, but because they were **never seated at the table as first-class hypotheses.** The recurring "coarse plurality is unanimous across all camps" gloss is the load-bearing thumb — it manufactures agreement by defining "plural" as descriptive dissociability, which a single-substrate model happily grants.

**Secondary, narrower thumb — within T5: CLS-necessity.** "Two-timescale is THE structural answer, close to a theorem" was over-weighted against its live rivals (scale-as-substitute, standard+schema-gating, MTT-coexistence, contextual-binding). Here the over-weighted school is CLS specifically, not structuralism broadly.

**Even-handedness checks (so this does not become a new coronation):**
- The bias is a *default-setting* bias (what gets to be bedrock vs an attack), **not uniform hostility** to the process camp. The audit *did* correct against plurality in places: it credited Cabeza & Moscovitch though it favors components-over-systems, walked back an "over-charged" independence-collapse, protected CLS from a weak EWC witness, and accepted MINERVA-2 retrieval-emergent abstraction at high (an anti-structuralist result).
- There is a **local counter-thumb toward the process side in T1-C**: the crux is worded from Cowan's side (activated-LTM as the neutral baseline against which discrete stores must justify themselves), and SPI — a *systems* model — was miscast as an anti-store authority. So the thumb is not monolithic; the architecture layer (T2–T8) leans structuralist while the T1-C crux itself leans embedded-processes.
- The under-weighted champions are entitled to a **seat**, not to become the new default. Single-signal "defeats dual-process by default," PDP "delocalization IS convergence," and TAP "retrievability is *never* intrinsic" are themselves framework-relative overreaches (R2, N7/R5, and Bjork & Bjork cut against the last). The fair correction is to move the contested claims from "bedrock" to "framework-relative with competing positions stated," per §1B — not to swing the default from stores to states.

The corrected posture: keep §1A as bedrock; reclassify §1B as explicitly school-dependent with the competing positions weighted evenly; revive §2; downgrade §3; and treat §4 (especially CLS-cross-topic, instance/global-matching, rate-distortion, interference-theory, and the caching/unlearning literature) as the evidence whose absence let the structuralist default look more inevitable than the philosophies of memory actually make it.
