Both files read successfully. Checked against the eight VERIFIED verdicts. Findings below.

## (1) OVERSTATEMENTS / MISSTATEMENTS vs the verified verdicts

**Synthesis:**

- **Line 32 (T3-B), HippoRAG mechanism.** Synthesis calls the fan-normalization convergence "three unrelated derivations… Same behavior, three causes — and not even the same function," describing HippoRAG's device as "PPR normalization… a stochastic-matrix row-sum constraint." T3 verification (error-found) says this names the **wrong knob**: HippoRAG's actual promiscuity-taming device is node specificity sᵢ=|Pᵢ|⁻¹, a graph-native **IDF**, which is the *same normative quantity* as ACT-R's −ln(fan) log-diagnosticity. The verification's mandate is to **restore the pairwise ACT-R↔IDF convergence as surviving core**. Synthesis's "three unrelated causes / not even the same function" thus overstates the divergence and contradicts the verified residue.

- **Lines 29 & 31 (T3-A), Park provenance.** Synthesis states as fact that "Park et al. inherit recency+relevance from IR/recommender lineage, not ACT-R" and "Convergence, if any, is recency+relevance only." T3 verification (error-found): Park et al. **cite ACT-R (Anderson 1993)**; the IR-lineage counter-assertion is **unevidenced and points against the only documented evidence**. Verdict must be restated as "shared design pattern; provenance/independence unestablished in *both* directions." Synthesis picks the attack side as settled — misstatement.

- **Lines 33, 37, 65, 72 (T3-C), Heathcote averaging "fatal."** Synthesis leans hard on Heathcote et al. 2000 as an averaging artifact and line 72 calls it "**fatal to T3-C's power law**." T3 verification (too-harsh): Heathcote 2000 is **off-domain** (practice curves, not retention), and the on-domain follow-up **Averell & Heathcote 2011 partially answers the open question in C's favor**; "C reads closer to survives than recorded." "Fatal" overstates.

- **Line 36 (T5-3), TEM≈attention via No-Free-Lunch.** Synthesis downgrades TEM≈attention using "grid-cell emergence is hyperparameter-fragile: Schaeffer/Khona/Fiete (NeurIPS 2022), 12cm yields grids, 11/13cm do not." T5 verification (error-found): this is a **verified conflation** — NFL targets a *different* modeling program (path-integration recurrent nets with place-cell readouts), **not** Whittington's TEM/transformer mathematical derivation. Downgrade is legitimate only for the "engineered variant, not vanilla attention" reason. Synthesis uses the wrong basis.

- **Line 51 & Honest-read (T8-B), "plausibly a convergence, not a break."** Synthesis (BROKEN section) says T8-B "has its purpose inverted… B is plausibly a point of *convergence*." T8 verification: B's genuinely-contested/medium verdict is **confirmed, "no change needed"**, and the adjudicator **correctly refused** the flat-convergence collapse; the read≠edit-locus dissociation "is a genuine disanalogy even when structure is shared." Pushing B to "convergence" is the overreach the verification names.

- **Lines 55 & 66 (T4-D), "over-graded / should not survive."** Synthesis lists T4-D under BROKEN ("survives/high is over-graded"). T4 verification: Claim D "**survives (high)… both sides endorse**" — confirmed. The falsifiability worry properly attaches to Claim A (medium) and the unaddressed generic-diffusion objection, **not** to D (whose RAPTOR-counterexample core is solid). Downgrading D contradicts the verified verdict.

- **Lines 65 & Honest-read (T7-D open question).** Synthesis treats "the *sole* human strand… that transfers to machines" (rational-analysis need-odds) as settled. T7 verification (error-found): this is "the biggest unflagged leap" — dense-vector/parametric substrates **do** exhibit interference crowding (catastrophic forgetting = substrate interference), so the **interference rationale partially transfers**; the "exact-key DB, no crowding" move cherry-picks. Synthesis's "sole strand" is overstated.

**Meta (§4 recalibrations) — 3 of 5 are off vs verified:**
- **T4-D → "too generous"**: contradicted (D verified survives/high, both endorse).
- **T8-B → "stronger than contested / convergence"**: contradicted (verified no-change, convergence is overreach).
- **T5-Claim-4 → "under-weights MTT directionality"**: not supported — T5 Claim D verified "correct and well-calibrated, no change."
- T2-B → "leans toward failing": mildly overstated (verified stays genuinely-contested/medium, *confirmed*).
- T7-A parametric-form oversold: **supported** by T7 verification.

## (2) Cross-topic inconsistency the meta MISSED

- **The Heathcote-2000 "identical artifact" symmetry is itself built on a misapplied citation.** Meta §1 line 8 pairs T7-A and T3-C as "both… vulnerable to the identical [averaging] artifact." But per the T3 **and** the implicit T7 verification, Heathcote 2000 is a **practice-curve** result, off-domain for *both* retention applications, and the on-domain Averell & Heathcote 2011 cuts toward the retained claims. So the meta's crux that these two topics share one fatal artifact rests on a citation the verification flags as domain-transferred in both places — the meta caught the *asymmetric verdict* but not that the shared premise is off-domain.
- **AlphaEdit "Outstanding Paper" premise is now reversed.** Not an inconsistency inside synthesis/meta (neither asserts it), but note for the record: the T6 verified verdict **reverses** the standing fabrication flag — AlphaEdit won a genuine ICLR 2025 Outstanding Paper Award (official ICLR PDF + NUS release). The task instruction to "confirm it stays flagged" is outdated. Synthesis line 17 cites AlphaEdit only for its analytic core, so no correction is needed there.

## (3) Load-bearing cruxes list — mostly right, two over-framed, one gap

- **Crux 1 (independent convergence)** is over-broad as worded ("*every* convergence verdict loses force"). T1 verification: the genealogy kills only the **AI leg**; the **lesion-neuroscience base (H.M./K.C.) is independent** of the info-processing lineage, leaving **two** independent bases, not one. The crux should be scoped to the AI branch, not universalized.
- **Crux 3 (need-probability individual-curve)** is framed as wide-open, but T3/T7 verification says **Averell & Heathcote 2011 partially answers it in C's favor**, and the "sole strand transfers" premise it rides on is itself wrong (interference partially transfers). Partly-answered, not fully live.
- **Missing element:** the **generic-diffusion base-rate objection** (T4 review finding 4 — diffusion/energy-descent also describes heat flow, epidemics, Markov chains, original PageRank, near-zero discriminating power). T4 verification: it "**landed and unaddressed — must be folded into Claim A**." It directly undercuts the "deep, not lexical" defense of the associative-traversal thesis and belongs in/under crux 4, but appears nowhere in the meta's list.

Cruxes 2, 5, 6, 7, 8 are well-formed and match the verified tensions.

## (4) Citations synthesis relies on that topic verifications FLAGGED

- **Line 39 — "Yu et al., 'Found in the Middle,' ACL 2024."** Fabricated surname. T8 verification: verified authors are **Hsieh et al.** (Cheng-Yu Hsieh, Yung-Sung Chuang, et al.); no author "Yu." Synthesis inherited the exact misattribution the gate exists to catch. Must correct to Hsieh et al. 2024.
- **Line 40 — Shaw & Porter (2015) "~70%."** T8 verification: the figure is **contested**; Wade, Garry & Pezdek (2018, Psych Science) recoded the same data to **26–30% false memories** (rest are mere false beliefs). Synthesis uses the uncontested 70% and builds its "disanalogy is *quantitative* not categorical" (line 40) conclusion on it — the verification says the correction **strengthens Claim C's categorical core**, so synthesis's "merely quantitative" read is itself weakened by the flagged stat.
- **Line 54 — Murayama et al. 2014 as "RIF reliability-contested."** T6 verification: Murayama 2014 is **mis-deployed (inverted)** — it is primarily inhibition-*confirming*, not a reliability indictment. The contested-RIF point should rest on Frontiers-2014 + Cortex-2018.
- **Line 12 — "Cowan et al. (2019)."** T1 verification: single author, **Cowan (2019)**, not "et al." Minor, non-load-bearing, but a flagged misattribution the synthesis carries.

Not inherited (correctly absent from synthesis/meta): the fabricated "5–10 F1" HippoRAG-2 quote, the misattributed arXiv 2507.03226, the Generative-Agents "retrieval runs over the distilled layer" false claim, and the "~200–300 ms/fan" figure — none appear in either file.
