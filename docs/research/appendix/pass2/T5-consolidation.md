# T5-consolidation — Pass-2 Fable verification

**Gate status:** pass-with-fixes

## Verified claim checks
- **[confirmed]** Claim A verdict: two-timescale is 'weakened-but-stands (high)' — sufficiency survives, necessity fails (Ramasesh scale/orthogonality), EWC 'independent convergence' is borrowed not independent.
    - adjudicated: Ruling sound and well-calibrated; keep 'high' for the biology-agnostic sufficiency core, keep the necessity downgrade and the EWC borrowed-vocabulary flag.
    - note: Kirkpatrick EWC (PNAS 114:3521-3526) verified; it explicitly motivates from mammalian synaptic consolidation, so 'two communities converge' is correctly demoted.
- **[too-generous]** Claim A open question promoted by adjudicator: 'is EWC's class-incremental underperformance evidence the SYNAPTIC branch of the analogy specifically fails?'
    - adjudicated: Trim/reframe — a weak ML approximation (Fisher-penalty EWC) underperforming says nothing about whether biological synaptic consolidation exists; the adjudicator laundered a red-team non-sequitur into a research question.
    - note: Review point 4 lands: this inflates the damage to Claim A; reframe as 'EWC is a weak ML witness' without the synaptic-branch leap.
- **[too-generous]** Claim B verdict: 'weakened-but-stands (medium)' — neuro transformation robust, AI bridge (RAPTOR/sleep-time/chunking) fails.
    - adjudicated: Ruling defensible but the label under-foregrounds that the entire AI half collapsed; for a cluster whose interest is the AI analogy, state plainly 'neuroscience holds, the bridge fails.' Keep 'medium'.
    - note: RAPTOR write-time-vs-read-time inconsistency and sleep-time-compute-as-caching both confirmed; the surviving neuro sub-claim rests on retrograde-amnesia, not the behavioral gist study.
- **[error-found]** Claim B behavioral pillar: steelman's Lutz et al. 2017 (Sci Rep 42950) 'gist strengthening over multiple nights while verbatim does not.'
    - adjudicated: Mischaracterized — verified single night with probes at 20min/10h/1yr; at 10h sleep enhanced episodic detail and did NOT affect gist (null), gist effect appeared only at 1yr. Pillar is weaker than presented; a same-author non-replication (J Sleep Research 2025/26, jsr.70106) further undercuts sleep-dependence.
    - note: Both review (c) and defense confirm; adjudicator credited B1's behavioral anchor without noticing it half-refutes at the timescale that matters. Must fix.
- **[error-found]** Claim C verdict: 'weakened-but-stands (high)' bundling MINERVA-2 (Part 1) with TEM-equals-attention (Part 2) under one confidence.
    - adjudicated: Split the bundle: Part 1 (MINERVA-2) high — the single hardest-to-dislodge item; Part 2 (TEM-equals-attention) medium/contested. One 'high' launders Part 2's contested status under Part 1's solidity.
    - note: Both adversaries independently demand the split; the bundled confidence is a genuine calibration defect.
- **[error-found]** Adjudicator's basis for downgrading TEM-equals-attention: grid-cell emergence is 'hyperparameter-manufactured per No-Free-Lunch 2022' (12/11/13cm, Difference-of-Softmaxes).
    - adjudicated: Over-reached via conflation — verified: No-Free-Lunch targets path-integration recurrent nets with place-cell readouts (Sorscher/Banino/Cueva-style), a DIFFERENT modeling program from Whittington's TEM/transformer correspondence, which is a mathematical derivation not contingent on that fragile readout. Downgrade Part 2 for the RIGHT reason (Attack 3: purpose-built recurrent-position-encoding variant, not vanilla self-attention), not via NFL.
    - note: Defense's core correction verified live; NFL is adjacent to TEM's grid-emergence claims but does not touch the transformer-TEM derivation. Restore partial credit to the correspondence.
- **[confirmed]** Claim D verdict: 'genuinely-contested (medium)' — cracks refine not refute, but survival buys low falsifiability (Tse-absorption, MTT trace-multiplication).
    - adjudicated: Correct and well-calibrated; both adversaries affirm. No change.
    - note: Tse a-priori-schema-consistency unfalsifiability and MTT directionality both land as open problems, exactly as scored.
- **[too-harsh]** Review's error (a): steelman's sleep-time-compute magnitudes '~18% accuracy gain, ~2.5x cost reduction' are 'both wrong; actual is 13%/5x.'
    - adjudicated: The review is itself mistaken — the paper (arXiv 2504.13171) reports ALL of: ~5x test-time compute reduction, up to 13% (GSM-Symbolic) AND 18% (AIME) accuracy gains, and 2.5x multi-query cost-per-query reduction. The steelman's 18% and 2.5x are real numbers (just paired across two experiments); nothing to 'fix' to 13%/5x.
    - note: Verified against the paper. Steelman already flagged them as self-reported ('claim direction not magnitude'); no must-fix here beyond that existing flag.
- **[error-found]** EWC source hyperlink (steelman line 118) uses DOI 10.1073/pnas.1717042115.
    - adjudicated: Wrong DOI — the real EWC DOI is 10.1073/pnas.1611835114 (PNAS 114:3521-3526, verified). The page cite is correct, so this is hyperlink hygiene, not fabrication. Fix the link.
    - note: Both adversaries flag; low substantive impact but a verification gate should not pass a mis-linked load-bearing citation.
- **[error-found]** Red-team (line 163) attributes TMR effect sizes 'g approx 0.27-0.32' to 'Cordi & Rasch and others.'
    - adjudicated: Misattributed — those precise values (overall g=0.29; SWS 0.27; NREM2 0.32) are from Hu et al. 2020, Psychological Bulletin (verified), which IS in the red-team source list. Body-text attribution slip, not fabrication. Correct the attribution.
    - note: Numbers are real and correct; only the named source is wrong.
- **[confirmed]** 'EWC Done Right' (arXiv 2603.18596) cited for EWC Fisher-vanishing / suboptimal performance; review labels it 'CVPR 2026.'
    - adjudicated: Paper is REAL — Xuan Liu & Xiaobin Chang, submitted March 2026, verified to discuss FIM gradient vanishing. It is an arXiv preprint; the 'CVPR 2026' venue label (review's, not the record's) is unverified. The record's own citation (line 221, '2026 arXiv') is accurate. Treat as a fresh preprint, redundant with van de Ven & Tolias.
    - note: This is the exact shape prior passes caught as fabricated (2026 venue for a convenient point) but it checks out genuine; only the review's added 'CVPR' venue label is unsupported.
- **[confirmed]** Prior-pass fabrications (KGGen/Titans NeurIPS-2025, AlphaEdit 'Outstanding Paper,' Mem0/Zep self-reported DMR benchmarks) recur in this record.
    - adjudicated: They do NOT appear here — confirmed absent by both adversaries and by my check. Nothing to re-flag; they stay flagged in the corpus but were not smuggled into T5.
    - note: Every named work in this record is real and correctly attributed (modulo the DOI-link and TMR-attribution slips above).

## Citation issues
- Kirkpatrick et al. 2017, EWC (steelman source line 118): Hyperlink uses DOI 10.1073/pnas.1717042115 (a different Kirkpatrick item); correct EWC DOI is 10.1073/pnas.1611835114. Page cite 114:3521-3526 is right, so misattributed link, not fabrication.
- TMR effect sizes g approx 0.27-0.32 (red-team line 163): Attributed in body text to 'Cordi & Rasch and others'; the exact values are from Hu et al. 2020, Psychological Bulletin (verified, and already in the red-team source list). Misattribution slip.
- 'EWC Done Right,' arXiv 2603.18596 (review's 'CVPR 2026' label): Paper is genuine (Liu & Chang, March 2026, verified) but it is an arXiv preprint; the 'CVPR 2026' venue is unverified. The record itself only claims '2026 arXiv,' which is accurate — the venue inflation is the review's, not Pass-1's.

## Under-credited strengths
- MINERVA-2 (Claim C Part 1) is the single hardest-to-dislodge item in the whole cluster — a self-contained formal proof about a model's behavior needing no contested physiology. Bundling it under one 'high' with the contested TEM half actually under-serves it.
- TEM-equals-transformer (ICLR 2022, arXiv 2112.04035) is a genuine mathematical DERIVATION, not an emergence claim; the No-Free-Lunch-based downgrade misfires on it (NFL targets a distinct path-integration modeling program, verified), so the correspondence deserves partial credit downgraded only for 'engineered variant, not vanilla attention.'
- The two-timescale SUFFICIENCY core is the best-characterized interference remedy, not merely one of an equally-proven menu — Ramasesh shows forgetting decreases with scale but does NOT show a single network achieves rapid single-shot encoding without interleaving, the exact property CLS's fast store buys. So 'scale as a distinct third route' remains open, not established parity.

## Must fix before Pass 3
- Fix the EWC source hyperlink DOI: 10.1073/pnas.1717042115 -> 10.1073/pnas.1611835114.
- Correct the Lutz et al. 2017 characterization: single night (probes at 20min/10h/1yr), NULL gist effect at 10h, gist only at 1yr; note the same-author non-replication (J Sleep Research 2025/26). Keep B1 surviving on retrograde-amnesia/semanticization grounds, not sleep-dependent gist.
- Split Claim C confidence: Part 1 (MINERVA-2) high; Part 2 (TEM-equals-attention) medium, and downgrade it for the correct reason — Attack 3 (purpose-built recurrent-position-encoding variant, not vanilla self-attention) — NOT via No-Free-Lunch, which targets a different modeling program (verified conflation).
- Trim/reframe the Claim A open question that promotes the red-team's 'synaptic branch of the analogy fails' non-sequitur into a research question; a weak Fisher-penalty EWC underperforming does not bear on whether biological synaptic consolidation exists.
- Fix the TMR effect-size attribution (Cordi & Rasch -> Hu et al. 2020, Psychological Bulletin).
- Do NOT 'correct' the sleep-time-compute magnitudes to 13%/5x — the steelman's 18% and 2.5x are real numbers from arXiv 2504.13171; the review's error-claim there is itself mistaken. Retain only the existing self-reported-preprint flag.

---

## Adversarial review (attack)

I have completed verification of every named work. Below is my adversarial attack on the adjudication.

---

## GATE VERDICT ON T5-CONSOLIDATION ADJUDICATION: PASS, with corrections

I could read the full Pass-1 record. I checked all named works against reality via live web tools. **No fabricated citation survives in this record — every named work is real, including the one that most looked like the prior-pass failure mode.** But the adjudication carries four missed factual errors and two miscalibrated confidences. Details:

### 1. Citation verification (all confirmed REAL — no fabrications)

| Work | Status |
|---|---|
| McClelland/McNaughton/O'Reilly 1995, Psych Rev 102:419–457 | REAL, pages correct |
| Kumaran/Hassabis/McClelland 2016, TiCS 20:512–534 | REAL |
| Kirkpatrick EWC 2017, PNAS 114:3521–3526 | REAL (see DOI error below) |
| Hintzman 1986, Psych Rev 93:411–428 (MINERVA-2) | REAL |
| Whittington et al. 2020, Cell 183 (TEM) | REAL |
| Whittington/Warren/Behrens, arXiv 2112.04035, ICLR 2022 | REAL, title verbatim confirmed |
| Tse 2007 Science 316:76–82; Tse 2011 | REAL |
| van de Ven/Siegelmann/Tolias 2020, Nat Commun 11:4069 | REAL |
| Schaeffer/Khona/Fiete, No-Free-Lunch, NeurIPS 2022 | REAL — 12cm/11cm/13cm claim confirmed **verbatim** |
| Ramasesh/Lewkowycz/Dyer, ICLR 2022 (scale/forgetting) | REAL, orthogonality finding confirmed |
| Sarthi et al., RAPTOR, arXiv 2401.18059, ICLR 2024 | REAL |
| Sleep-time compute, arXiv 2504.13171 | REAL (see number error below) |
| Lutz et al. 2017, Sci Rep 7:42950 (gist abstraction) | REAL (see mischaracterization below) |
| Hu et al. 2020, Psych Bulletin (TMR meta) | REAL — g values confirmed |
| **"EWC Done Right," arXiv 2603.18596, CVPR 2026** | **REAL** — Liu & Chang, submitted March 2026; Fisher-vanishing claim confirmed |

**Note on the CVPR 2026 item:** this is exactly the shape prior passes caught as fabricated (a 2026 venue supporting a convenient point). I fetched the arXiv page directly: it is genuine (Xuan Liu, Xiaobin Chang; "Elastic Weight Consolidation Done Right for Continual Learning"; discusses FIM gradient vanishing). It stays — but the red-team leaned a *fresh, barely-circulated* 2026 paper as corroboration for "EWC underperforms," which is redundant with the canonical van de Ven & Tolias three-scenarios result and adds fragility, not strength.

### 2. Four factual errors the adjudication MISSED

**(a) Steelman misreports the sleep-time-compute magnitudes.** Steelman (line 67): "up to ~18% accuracy gain, ~2.5× cost reduction." The actual paper reports **~13% accuracy gain and ~5× test-time-compute reduction.** Both numbers are wrong. Impact is low because both sides correctly flagged the numbers as unreliable self-report — but *neither side actually checked them against the paper*, and the adjudicator repeated the framing without catching the misquote. A verification gate should not let mis-transcribed magnitudes pass, even flagged ones.

**(b) Steelman links the wrong DOI for EWC.** The source URL uses DOI `10.1073/pnas.1717042115` — that is Kirkpatrick et al.'s **"Reply to Huszár,"** not the EWC paper. The real EWC DOI is `10.1073/pnas.1611835114`. The page cite (114:3521–3526) is correct, so this is a hyperlink-hygiene error, not a fabrication — but it went uncaught.

**(c) Steelman mischaracterizes Lutz et al. 2017 — and the study is weaker than presented.** Steelman (line 63): the gist representation "strengthening over multiple nights while verbatim detail does not." The study tested a **single** night's sleep with retention probes at 20min/10h/**1yr** — not "multiple nights." More damaging: at the 10h probe, sleep enhanced episodic detail and **did NOT significantly affect gist abstraction**; the gist effect appeared only at 1 year. So the steelman's lead behavioral pillar for B1 actually shows a *null gist result at the timescale a memory system cares about*. The red-team's "small/heterogeneous effects" attack is if anything *understated* here, and the adjudicator credited B1's behavioral pillar without noticing its own cited anchor half-refutes it. (B1 still survives — but on retrograde-amnesia/semanticization grounds, exactly as the red-team conceded, not on this study.)

**(d) Red-team misattributes the TMR effect sizes.** Red-team (line 163): "Cordi & Rasch and others document that TMR... effects are small-to-moderate (Hedges' g ≈ 0.27–0.32)." Those precise values are from **Hu et al. 2020, Psychological Bulletin** (overall g=0.29; SWS g=0.27; NREM2 g=0.32) — verified. Cordi & Rasch is a separate review. The numbers are correct and Hu is in the source list, so this is a body-text attribution slip, not fabrication — but the adjudicator, which scrutinized attributions elsewhere, let it stand.

### 3. Two miscalibrated verdicts

**Claim C — "weakened-but-stands (high)" is too generous as bundled.** This verdict fuses two parts of very different strength: MINERVA-2 (Part 1) is a genuinely hard-to-dislodge formal result — the red-team itself names it the single most resistant item — and deserves high confidence. But TEM≈attention (Part 2), which the steelman escalated to "the deepest cross-field result," rests on grid-cell emergence that No-Free-Lunch shows is hyperparameter-manufactured (12cm works, 11/13cm don't — I confirmed this verbatim). A single "high" verdict over the bundle launders Part 2's contested status under Part 1's solidity. The adjudicator's *overstatement flag* correctly downgrades the TEM claim — but the verdict line and confidence don't reflect that split. Correct calibration: **Part 1 high, Part 2 genuinely-contested.**

**Claim B — "weakened-but-stands (medium)" under-weights that the entire AI half collapsed.** By the adjudicator's own red-team summary, the AI bridge "does not resist": RAPTOR writes summaries at index time (contradicting the cluster's read-time-emergence thesis), sleep-time compute is caching, chunking is conceded. What survives is *only* the neuro sub-claim — and per error (c) above, even that survives on different grounds than the steelman argued. For a topic whose relevance is the *AI analogy*, "weakened-but-stands" reads as generous framing for "the neuroscience holds, the bridge fails." Not wrong, but the label flatters a claim whose interesting half is gone.

### 4. One strawman leap the adjudicator amplified rather than flagged

Red-team Attack 2 on Claim A ends: EWC's class-incremental underperformance "arguably shows the *synaptic* branch of the analogy failing." That is a non-sequitur — a weak ML *approximation* (Fisher-penalty EWC) underperforming says nothing about whether biological synaptic consolidation exists. The adjudicator did not flag this as overreach; it *promoted it into an open question* ("is EWC's underperformance evidence the SYNAPTIC branch specifically fails?"). That launders a rhetorical leap into a research question and mildly inflates the damage to Claim A.

---

**Bottom line:** The adjudication's core rulings are sound and its three strawman flags are fair. No citation is fabricated — the prior-pass fabrications (KGGen/Titans NeurIPS-2025, AlphaEdit, Mem0/Zep self-benchmarks) do not recur here, and the one high-risk 2026 venue checks out. But the gate should not pass clean: fix the sleep-time-compute magnitudes (13%/5×, not 18%/2.5×), the EWC DOI link, the Lutz-2017 mischaracterization (single night; null gist at 10h), and the Cordi-&-Rasch→Hu-et-al. attribution; and split Claim C's confidence so the contested TEM≈attention half is not sheltered under MINERVA-2's high confidence.

---

## Adversarial respect (defend)

Read the Pass-1 record in full. Verified the load-bearing and contested citations live. Findings below.

---

## VERDICT: Pass-1 adjudication is mostly well-calibrated, but it over-reached on ONE high-value item (TEM≈attention) by adopting a conflated attack. Citations are overwhelmingly real; one link is mis-DOI'd; the behavioral-pillar flag is, if anything, now stronger.

---

### CITATION VERIFICATION (all named works checked against reality)

Every named work in this record is **real and correctly attributed**:
- CLS (McClelland et al. 1995, Psych Review), CLS-updated (Kumaran/Hassabis/McClelland 2016, TiCS), TEM (Whittington et al. 2020, Cell 183), Whittington/Warren/Behrens 2022 ICLR (arXiv 2112.04035), RAPTOR (Sarthi et al. 2024 ICLR, arXiv 2401.18059), Hintzman 1986, van de Ven et al. 2020 Nat Comms, Tse et al. 2007 Science — all confirmed.
- Red-team's counter-cites also confirmed: **No Free Lunch** (Schaeffer/Khona/Fiete, NeurIPS 2022), **Ramasesh/Lewkowycz/Dyer** (ICLR 2022, scale-reduces-forgetting), the **Sci Rep 2017 gist** paper (Lutz et al., srep42950), and even the red team's suspicious-looking **"EWC Done Right" arXiv 2603.18596** — it is a **genuine March-2026 paper**, not a fabrication.
- **No fabricated 2025 venues appear in this record.** The prior-pass fabrications (KGGen/Titans NeurIPS-2025, AlphaEdit "Outstanding Paper," Mem0/Zep self-reported benchmarks) are simply absent here — nothing to re-flag, and I confirm they were not smuggled back in.
- **Sleep-time compute (arXiv 2504.13171)** — flag correctly stands: preprint, self-reported magnitudes. Uphold as flagged.

**ONE citation-hygiene defect (new):** The steelman's EWC source link (line 118) points to DOI `10.1073/pnas.1717042115`. The correct EWC DOI is **`10.1073/pnas.1611835114`** (PNAS 114:3521–3526). The paper is real and correctly *described*; only the hyperlink DOI is wrong. Fix the link; no substantive impact.

---

### WHERE THE ADJUDICATION WAS TOO HARSH (defender core)

**1. The TEM≈attention downgrade adopts a conflation — this is the real over-reach.**
The adjudicator downgraded "formal mathematical correspondence… deepest cross-field result" largely by endorsing red-team Attack 2: that the empirical anchor (grid-cell emergence) is "hyperparameter-manufactured per No-Free-Lunch 2022." **I verified No-Free-Lunch's actual target, and it is NOT TEM or the transformer-TEM correspondence.** It is a case study of **path-integration recurrent networks with place-cell readouts** (Sorscher/Banino/Cueva-style), trained on path-integration tasks; the 12cm-vs-11/13cm and Difference-of-Softmaxes fragility is a property of *that readout construction*. The paper trained ">11,000 networks" of that family — a different modeling program from Whittington's TEM/transformer.

Consequences the adjudicator under-credited:
- The **TEM≈transformer result is a derivation** (a transformer with recurrent position encodings is mathematically related to TEM), not an emergence claim contingent on the fragile grid-cell readout No-Free-Lunch dissects. A robustness critique of program B does not undercut a derivation in program A.
- The red team **itself conceded** the TEM *neuro* prediction (remapping preserves structure across environments) "did confirm."
- So the item is not "constructed relation whose empirical payoff is contested" via No-Free-Lunch — that attack misfires. The **legitimate** critique is red-team Attack 3 (the correspondence needs a *purpose-built* recurrent-position-encoding variant, hand-designed coordinates, not vanilla self-attention). That lands and should stay. Net: credit a genuine mathematical correspondence for a TEM-shaped transformer, downgraded only for "engineered variant, not vanilla attention" — **not** dismissed as tuning-manufactured.

**2. Claim A necessity/sufficiency: calibration is fair, but the attack's alternative is itself under-established.**
"Sufficiency survives, necessity fails" is the right ruling. But note Ramasesh shows forgetting *decreases* with scale — it does **not** show a single large network achieves *rapid single-shot encoding without interleaving*, which is the property CLS's fast store buys. So "scale is a genuinely distinct third route" remains an open question (the adjudicator flags this correctly), and the two-timescale *sufficiency* core is still the best-characterized remedy, not merely one of an equally-proven menu. Mild under-credit, not a reversal.

**3. MINERVA-2 (Claim C Part 1):** both passes already agree this is the hardest-to-dislodge item and it survives at high confidence. Affirmed — no correction needed; the only trimmed overreach ("you don't need a semantic layer at all") is a fair trim.

---

### WHERE THE ATTACK LANDS (concede — not defending the indefensible)

- **EWC "independent convergence" is genuinely dead.** EWC (verified real) explicitly motivates itself from mammalian synaptic consolidation; DeepMind/McClelland lineage. "Two communities converge" is borrowed vocabulary, not independent confirmation. Concede fully; keep the enrichment flag.
- **RAPTOR write-time vs. read-time inconsistency** stands — RAPTOR summarizes at index time, contradicting the cluster's own read-time-emergence thesis. Concede.
- **The behavioral gist pillar is now WEAKER, not stronger.** Hunting further: the same lead author (Lutz) has a **follow-up non-replication — "Long-Term Visual Gist Abstraction Independent of Post-Encoding Sleep"** (J. Sleep Research, 2025/26) — directly undercutting the Sci Rep 2017 sleep-dependence result. This *confirms* the adjudicator's "small/heterogeneous/replication-trouble" flag. The transformation claim should keep surviving on retrograde-amnesia/semanticization grounds, **not** on sleep-dependent gist. Concede and uphold the flag.
- **Tse-absorption unfalsifiability** and **MTT trace-multiplication directionality** attacks land as open problems; "genuinely-contested" for Claim D is correct.

---

### NET
Pass-1 clears the gate with one required correction and one strengthened flag. **Required fix:** restore partial credit to the TEM≈transformer correspondence — the No-Free-Lunch-based downgrade rests on conflating two distinct entorhinal-hippocampal modeling programs (verified); the surviving critique is "engineered variant, not vanilla attention," which is narrower than "hyperparameter-manufactured." **Strengthened flag:** the sleep-dependent-gist behavioral pillar has a same-author non-replication and should stay downgraded. **Citation hygiene:** EWC source DOI is wrong (`1717042115` → `1611835114`). No fabricated citations found in this record; all named works, including the red team's counter-cites, verify as real.

