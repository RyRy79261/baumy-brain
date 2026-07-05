# FABLE-5 GATE RULING — Pass-1 Corpus (T1–T8 + Synthesis/Meta)

## (1) OVERALL STATUS: **PASS-WITH-FIXES**

All eight topics clear the gate at `pass-with-fixes`; **none fails**. The verification overturned **zero topic theses** — memory-is-plural, encoding-is-distillation, weighting, associative-retrieval, consolidation, updating, degradation, and analogy-breaks all survive in the weakened/contested-but-standing form Pass 1 assigned. The citation base is unusually clean: no fabricated load-bearing citation, and the prior-pass poison (KGGen/Titans "NeurIPS 2025," Mem0/Zep self-reports) stayed quarantined across every topic.

It is **not a clean pass** for three structural reasons:
- **~11 real factual errors sit inside adjudicated grounding text** — a fabricated author (Yu→Hsieh), a fabricated quoted statistic ("5–10 F1"), a 3× magnitude inflation (Anderson 1974 fan), a wrong-mechanism attribution (HippoRAG), a false flagship AI example (Generative Agents), a mischaracterized behavioral anchor (Lutz 2017), and a domain-transferred citation (Heathcote 2000). These were graded as-is.
- **One standing flag is inverted:** AlphaEdit *did* win a genuine ICLR 2025 Outstanding Paper Award. The corpus currently asserts the opposite of truth, and the task instruction to "keep it flagged" is outdated.
- **Systematic confidence-laundering:** "high" is attached to surviving *weak* forms while the headline reads *strong* (T2-A/C, T5-C bundle, T7-A). The verdicts are directionally sound but the labels are not gate-clean.

The **weakest link is the Synthesis/Meta layer itself** — it over-reached on ~6 verified residues by adopting attack-side framings the verification rejects (T4-D, T8-B, T3-A/B/C, T7-D) and inherited four flagged citations. The corpus's own top-line summary currently misstates the bottom line in several places. Pass 3 may proceed **only after the Tier-A and Tier-B fixes below are cleared.**

---

## (2) CONSOLIDATED MUST-FIX LIST (deduplicated, ranked)

### Tier A — Factual/citation errors currently asserting falsehood (fix first)
1. **Reverse the AlphaEdit "Outstanding Paper" flag (T6).** It won a genuine ICLR 2025 Outstanding Paper Award (official ICLR PDF + NUS release). Un-flag lines 21/41/120/134; strike the false self-credit. *Analytic verdict on Claim C is unaffected — provenance only.*
2. **"Yu et al." → "Hsieh et al." (T8, arXiv 2406.16008), all 3 occurrences + Synthesis L39.** Fabricated surname — the exact error the gate exists to catch.
3. **Strike the Generative Agents "retrieval runs over the distilled layer, not the raw stream" claim (T2-A, lines 9/62).** Web-verified false; raw observations are co-retrieved and drive behavior. Do not present it as A's flagship AI rediscovery.
4. **Correct the HippoRAG mechanism to node specificity sᵢ=|Pᵢ|⁻¹ (graph-native IDF), not PPR row-normalization (T3-B, both support+attack; fixes Synthesis L32).** Then **restore the pairwise ACT-R −ln(fan) ↔ IDF/log-diagnosticity convergence as surviving core** — this is a genuine shared normative quantity, not "three unrelated causes."
5. **Replace the fabricated "5–10 F1" quotation (T4-C)** with HippoRAG-2's actual qualitative wording ("drops considerably below standard RAG"), noting heterogeneous per-system magnitudes.
6. **Swap arXiv 2507.03226 → arXiv 2502.11371 everywhere the LLM-judge attack on Claim C is grounded (T4-C); drop the "knowledge-leaking" rider** (2502.11371 covers position bias + ground-truth underperformance, not leaking).
7. **Fix the Anderson 1974 fan magnitude: ~200–300 ms/fan → ~50–90 ms/step (~110 ms fan-1→3); soften "formally predict" → "post-hoc models"** (ACT-R postdates the result ~20 yrs) (T3-B).
8. **Fix the Murayama 2014 inversion (T6-B, L16; Synthesis L54).** It is primarily inhibition-*confirming*; re-anchor the RIF-contested point on Frontiers-2014 + Cortex-2018.
9. **Flag Shaw & Porter "~70%" as contested; add Wade, Garry & Pezdek 2018 recode to 26–30% (false memory vs mere false belief) (T8-C; Synthesis L40).** The correction *strengthens* Claim C's categorical core — so Synthesis's "merely quantitative disanalogy" read must flip.
10. **Correct Lutz et al. 2017 (T5-B):** single night; **null gist effect at 10h**, gist only at 1yr; note the same-author non-replication (J Sleep Research 2025/26). Keep B1 surviving on retrograde-amnesia/semanticization grounds, not sleep-dependent gist.
11. **Re-scope Heathcote 2000 to PRACTICE curves (off-domain for retention) in BOTH the T3-C-attack and T7-A pairing; add Averell & Heathcote 2011 as the on-domain forgetting result** (exponential fits raw individual data best; Bayesian model selection favors power-with-asymptote). Downgrade the averaging-artifact attack from "strongest" to "contested, wrong-domain"; strike Synthesis L72's "fatal." *This is a cross-topic fix — one citation, two topics, one synthesis line.*

### Tier B — Confidence calibration (de-launder)
12. **T2-A and T2-C: high → medium** (or explicitly re-anchor "high" to the surviving weak form). As written, "high" launders confidence onto the "never raw" / "retrieval = f(match)" strong forms the record concedes fall to Nairne 2002.
13. **Split T5-Claim-C confidence:** MINERVA-2 (Part 1) **high**; TEM≈attention (Part 2) **medium/contested** — and downgrade Part 2 for the **correct** reason (purpose-built recurrent-position variant, not vanilla self-attention), **NOT** via No-Free-Lunch (verified conflation — NFL targets a different path-integration modeling program; fixes Synthesis L36).
14. **Scope T7-Claim-A "high" to the WEAK reading** (monotone, decelerating, plateauing + robust spacing/testing); do not let it re-import the contested parametric-law form.
15. **Recalibrate T1-Claim-A "enrichment":** only the **AI leg's** independence falls; the lesion-neuroscience base (H.M./K.C.) is independent of the info-processing genealogy → **TWO independent evidentiary bases, not one lineage.**

### Tier C — Provenance/framing over-reach (incl. Synthesis/Meta layer)
16. **T3-A Park provenance — delete BOTH assertions** ("no cognitive intent / two independent traditions" — Park cites ACT-R via Anderson 1993; AND "inherits from IR lineage, not ACT-R"). Restate: "shared design pattern; provenance/independence unestablished in **both** directions" (fixes Synthesis L29/L31).
17. **T7 open-question D — do not promote "only rational-analysis transfers to machines" as settled.** Dense-vector retrieval and parametric knowledge in shared weights **do** exhibit crowding (catastrophic forgetting = substrate interference), so the interference rationale **partially transfers**; the "exact-key DB, no crowding" move cherry-picks (fixes Synthesis L65 / honest-read "sole strand").
18. **Synthesis/Meta corrections:** remove **T4-D** from the BROKEN list (it *survives/high*, both sides endorse); reject the **T8-B → "convergence, not break"** reframing (genuinely-contested/medium is confirmed; the read≠edit-locus dissociation is a real disanalogy); correct Meta §4's three off recalibrations (T4-D, T8-B, T5-Claim-4).
19. **T6 temporal-DB lineage** — Snodgrass valid/transaction-time grew from the DB-systems community, largely independent; only **two of three** CS traditions (AGM, TMS/ATMS) share the AI-logic lineage.
20. **T5-Claim-A open question** — reframe as "EWC is a **weak ML witness**," not "the synaptic branch of the analogy fails" (a Fisher-penalty EWC underperforming says nothing about biological synaptic consolidation).
21. **T1** — keep the AI-internal declarative/procedural lineage (Winograd/Newell) as **open residue** (Open Question #3), not a verdict flip; note it concerns KR-formalism, not the ACT-R memory-systems cut.

### Tier D — Additions the verification requires
22. **Fold the generic-diffusion base-rate objection into T4-Claim-A** (landed and unaddressed): diffusion/energy-descent also describes heat flow, epidemics, Markov chains, original PageRank — near-zero discriminating power. *(Also a missing crux — see §3.)*
23. **T4-C — repartition** hard-metric multi-hop (recall/F1/EM on MuSiQue/2Wiki/HotpotQA; **stronger than credited**) vs. LLM-judge global sensemaking (**weaker**); add the "fix = passage-arm hybridization ⇒ complementarity survives at component level" qualifier.
24. **T4-A — restate the reduced form** ("attention is one step of content-addressable associative retrieval; exactness rider confined to K=V; independence limited to the Hopfield↔attention identity"), cite **Millidge et al. ICML 2022** on Open Question A, de-dup the one-step & pattern-separation attacks.
25. **T4 — re-source or downweight** the blog/content-farm-grounded attacks (quicktakes.io, hugocisneros.com) to primary literature; verify or re-cite the spurious-metastable-states attribution pinned to arXiv 2309.12673.

### Tier E — Minor/hygiene (batch, non-blocking)
26. T5 EWC DOI hyperlink 10.1073/pnas.1717042115 → **10.1073/pnas.1611835114**.
27. T5 TMR effect-size attribution: Cordi & Rasch → **Hu et al. 2020, Psychological Bulletin**.
28. T1 "Cowan et al. (2019)" → **Cowan (2019)** (single author).
29. T7 de Cheveigné date "2025/2026" → **2025**.
30. T3-D "calibrated confidence" proxy — **attribute to a named system/paper or drop** (three verified exhibits suffice).
31. T3-C "three unrelated corpora" → "three corpora (one statistical family — heavy-tailed human text)."

### Tier F — GUARDRAILS (do NOT "fix")
- **Do NOT** correct the sleep-time-compute magnitudes to 13%/5x — the steelman's 18% and 2.5x are **real** numbers from arXiv 2504.13171 (paired across two experiments); retain only the existing self-reported-preprint flag.
- **Keep** the 2025-26 preprints directional-only; **do not** re-flag as fabrication (all resolve to real arXiv items).
- **Keep** the Chen et al. 2402.13731 "AAAI-2024 venue unconfirmed" hedge; **reject** the defense's push to clear it (the AAAI 2024 entry is a different-titled sibling paper).
- **Re-weight the MTT-based attack on T2-A downward** — its own cited "Has MTT been refuted?" (Hippocampus 2020) undercuts MTT's multi-trace storage claim.

---

## (3) THE 8 LOAD-BEARING CRUXES

**CONFIRMED as the right Pass-3 targets (no change): cruxes 2, 5, 6, 7, 8** — well-formed, match the verified tensions.

**AMEND (2 cruxes):**
- **Crux 1 (independent convergence)** — over-broad as worded ("*every* convergence verdict loses force"). Re-scope: the genealogy kills only the **AI leg**; the lesion-neuroscience base (H.M./K.C.) is independent → **two** independent bases survive, not one lineage. Keep the crux, narrow it to the AI branch.
- **Crux 3 (need-probability individual-curve)** — reframe from "wide-open" to **"partly-answered."** Averell & Heathcote 2011 answers it in Claim C's favor at the individual level, and the "sole strand transfers to machines" premise it rides on is itself wrong (interference partially transfers).

**AUGMENT (1 crux):**
- **Crux 4 (associative-traversal / "deep, not lexical")** — sound, but **must absorb the generic-diffusion base-rate objection** (T4 review finding 4), which directly undercuts the "deep, not lexical" defense and is currently absent from the meta's list.

**ADD:** the **generic-diffusion base-rate objection** as an explicit Pass-3 target (fold into crux 4 or stand it alone) — it "landed and unaddressed" and is distinct from the "three-regimes-is-numerology" flag.

**DROP: none.** All eight cruxes remain live Pass-3 targets.

---

## (4) HONEST READ — how much this Fable verification changed confidence

The verification **did not move confidence in the conclusions** — it overturned no topic thesis, and the citation base held up unusually well (zero fabricated load-bearing citations, prior-pass poison fully quarantined). If anything, confidence in the surviving *cores* ticked **up**, because several corrections strengthen them: Wade et al. sharpens T8-C's categorical break, the IDF convergence restores real substance to T3-B, and the independent lesion base fortifies T1. What dropped materially is confidence that the **Pass-1 text is citable as-is**: the layer caught ~11 concrete factual errors in adjudicated grounding, exposed a systematic confidence-laundering habit (high labels riding surviving weak forms across T2/T5/T7), and reversed one standing flag outright (AlphaEdit won the award). The Synthesis/Meta layer specifically is the least trustworthy artifact in the corpus — it repeatedly picked the attack-side framing the verification rejects, so the top-line summary currently misstates ~6 verified residues. Net: **trust the direction, not yet the text** — the corpus is sound in its verdicts and clean in its sourcing discipline, but its precision and calibration must clear the Tier-A/B fixes before Pass 3 can build on it.
