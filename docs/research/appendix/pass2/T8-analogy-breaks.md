# T8-analogy-breaks — Pass-2 Fable verification

**Gate status:** pass-with-fixes

## Verified claim checks
- **[error-found]** REVIEW: 'Yu et al., Found in the Middle, ACL 2024 Findings, 2406.16008' is a misattribution; the paper has no author surnamed 'Yu' (correct: Hsieh et al.).
    - adjudicated: Review is right; Pass-1 record contains a real author-name error propagated 3x (Claim-A attack, overstatement flag, red-team). Defense's hedge 'Yu/Hsieh et al.' is evasive.
    - note: arXiv:2406.16008 verified authored by Cheng-Yu Hsieh, Yung-Sung Chuang, et al.; no author 'Yu' — fabricated surname, must correct to Hsieh et al. 2024.
- **[confirmed]** REVIEW + DEFENSE: The load-bearing Shaw & Porter (2015) '~70%' false-memory figure is contested; Wade, Garry & Pezdek (2018) recoded the data to 26-30%, and no pass cites this rebuttal.
    - adjudicated: Both are right and converge; the record uses an uncontested 70% that is disputed downward. Correcting it strengthens Claim C rather than loosening it.
    - note: Wade/Garry/Pezdek 2018 (Psych Science) verified: recode yields 26-30% false memories vs the rest being mere false beliefs — the authority/recollection axis C depends on.
- **[too-harsh]** DEFENSE: The Claim C 'absolutism doing rhetorical work' flag over-reached; C's core (single-exposure, verbatim, ungated, full-trust write) is a genuine categorical break under-credited by taking 70% at face value.
    - adjudicated: Upheld. Both review and defense agree the flag rests on the inflated 70%; once corrected, C's irreducible core is stronger, not weaker. Verdict (weakened-but-stands/high) still stands.
    - note: Wade's memory/belief split removes exactly the 'retrieved-as-genuine authority' property the softening attack needed — C is under-credited, not the reverse.
- **[too-generous]** DEFENSE: Clear the 'AAAI-2024 venue unconfirmed' hedge on Chen et al. 2402.13731 — it is confirmed AAAI 2024.
    - adjudicated: Reject — defense is too generous. The AAAI 2024 proceedings entry is a DIFFERENT-titled sibling ('Journey to the Center of the Knowledge Neurons'); 2402.13731 ('Cracking Factual Knowledge') is a distinct arXiv work. Keep flagged.
    - note: ojs.aaai.org/.../29735 is the AAAI 2024 paper under a different title; the venue attribution to 2402.13731 is a likely conflation — record's existing hedge is correct and must remain.
- **[confirmed]** REVIEW: The Heap paper (2501.17727) was retitled; the steelman ledger's 'v1 title verified this session' stamp is stale and the canonical title is now the metrics claim.
    - adjudicated: Substantively right. Current canonical title is 'Automated Interpretability Metrics Do Not Distinguish Trained and Random Transformers'; the steelman's cited SAE-title is superseded and should be updated.
    - note: arXiv fetch confirms current title is the metrics claim; the abstract supports the red-team's rescoping (SAE-feature-artifact reading is NOT licensed).
- **[too-harsh]** REVIEW: The red team slightly overstated its Heap correction — 'authors explicitly state they do not claim SAEs fail to capture information... confirmed via abstract' is a reasonable inference, not a verbatim abstract statement.
    - adjudicated: Minor overreach confirmed but immaterial. Abstract says metrics are 'useful but insufficient proxies' and scores don't 'guarantee features have been recovered' — the substance is right; the 'confirmed via abstract' provenance is slightly inflated.
    - note: Substance of the D/Heap correction holds; only the verbatim-disclaimer provenance is overstated — worth a note, not a gate blocker.
- **[too-harsh]** DEFENSE: Soften the Claim A 'Lost-in-the-Middle = measurement artifact' flag — the rebuttal paper itself locates the cause in an intrinsic U-shaped attention bias, so a real (if calibratable) substrate read-property survives.
    - adjudicated: Partially upheld. 'Calibratable ≠ pure artifact' is fair, and an intrinsic per-head positional bias over a verbatim buffer is a genuine disanalogy beyond the bare frozen/volatile gate. But calibration (~10-15pt recovery) does substantially weaken the 'occupancy-starvation law' framing, so the flag is largely correct — reword to 'intrinsic-but-calibratable,' don't drop.
    - note: Both the flag and the defense are partly right; the steelman's 'starvation orthogonal to correction' is legitimately weakened, but 'measurement artifact' over-reads what Found-in-the-Middle actually shows.
- **[confirmed]** DEFENSE: The red team's B verdict of flat 'convergence, not break' over-reaches; the quantified read≠edit dissociation is a real methodological disanalogy even with shared distribution.
    - adjudicated: Fair but already handled. The adjudicator did NOT adopt flat 'convergence' — it preserved the epistemic-affordance open question. B's 'genuinely-contested/medium' verdict correctly refuses both the metaphysical escalation and the flat convergence dismissal.
    - note: No change to B's verdict needed; the open question is the honest resolution — defense's concern is satisfied by the existing framing.
- **[confirmed]** REVIEW: Confirming prior-pass flags hold — rank-collapse (Dong et al. ICML 2021 Oral, deployed-substrate inversion), Ramasesh ICLR 2022 (scale increases resistance), Niu et al. ICLR 2024 Spotlight, PoisonedRAG USENIX Security 2025, MINJA — all correctly attributed and flagged.
    - adjudicated: Confirmed clean. Both docs agree; independent checks corroborate venues/authors and the steelman's Dong-inversion + catastrophic-forgetting-at-scale flags are correctly retained.
    - note: No fabricated papers in T8's set; the steelman's crispest 'provable mechanism' (spectral collapse) genuinely inverts its source and stays flagged.
- **[too-harsh]** REVIEW: Attaching 'high' confidence to Claim A over-reads as generous once the vivid degradation laws are stripped to a one-line architectural gate.
    - adjudicated: Borderline; verdict text already concedes it. The frozen-weights/volatile-buffer gate is genuinely un-attacked by either side, so 'weakened-but-stands/high' is defensible — but a calibration note ('core survives high; degradation-law framing defeated') would read cleaner.
    - note: Not an error — the surviving architectural gate legitimately carries 'high'; only the presentation risks misleading a skimming reader.

## Citation issues
- 'Yu et al., Found in the Middle, ACL 2024 Findings' (arXiv:2406.16008): Misattributed author. Verified authors are Cheng-Yu Hsieh, Yung-Sung Chuang, et al.; there is no author surnamed 'Yu' (hallucinated from hyphenated given names Cheng-Yu / Chen-Yu). Must correct to Hsieh et al. 2024 in all three occurrences. ID, venue (ACL 2024 Findings), and finding are correct.
- Shaw & Porter (2015), Psychological Science, '~70%' figure: Load-bearing statistic is contested and used uncontested. Wade, Garry & Pezdek (2018, Psychological Science) recoded the same data to 26-30% false memories (vs mere false beliefs). Not fabricated, but must add the rebuttal and flag the 70% as disputed before load-bearing use.
- Chen et al., 'Degenerate Knowledge Neurons' (arXiv:2402.13731), 'AAAI 2024': Venue attribution unconfirmed and likely conflated. The AAAI 2024 proceedings entry by the same group is a different-titled paper ('Journey to the Center of the Knowledge Neurons'); 2402.13731 ('Cracking Factual Knowledge') is a distinct arXiv work. Keep the existing 'venue unconfirmed' hedge; do NOT clear it (defense's push to clear is wrong).
- Heap et al. (arXiv:2501.17727): Stale title in the steelman's verification ledger. Canonical title is now 'Automated Interpretability Metrics Do Not Distinguish Trained and Random Transformers'; the cited SAE-interpret-random title is superseded. Update the ledger and drop the stale 'verified this session' stamp.

## Under-credited strengths
- Claim C's irreducible core — a single-exposure, verbatim, ungated, full-trust write with retrieved-as-genuine authority — is a genuine categorical break, and it is STRENGTHENED once the contested 70% is corrected to ~26-30% (Wade et al. distinguish false memory from mere false belief on exactly the authority axis C depends on).
- Claim A's surviving intrinsic positional attention bias: per Found-in-the-Middle itself the cause is an intrinsic per-head U-shaped bias, only partially calibratable (~10-15pt), which is a real substrate read-property disanalogy beyond the bare frozen-weights/volatile-buffer gate — the red team's 'everything reduces to the gate' under-credits it.
- Claim B's quantified, reproducible, operationally-exploitable read≠edit-locus dissociation (Hase 2023) is a genuine methodological/epistemic disanalogy even when the underlying distributed structure is shared — correctly preserved by the adjudicator as an open question rather than collapsed into flat 'convergence.'

## Must fix before Pass 3
- Correct the author misattribution: 'Yu et al.' → 'Hsieh et al.' for arXiv:2406.16008 in all three places (Claim-A strongest attack, overstatement flag, open question). This is the exact wrong-author error the gate exists to catch and it slipped through.
- Flag the Shaw & Porter '~70%' figure as contested and cite Wade, Garry & Pezdek (2018, Psychological Science) recoding to 26-30% (false memory vs false belief). Note that the correction strengthens Claim C's core rather than loosening it.
- Keep the Chen et al. 2402.13731 'AAAI-2024 venue unconfirmed' hedge; reject the defense's push to clear it (AAAI 2024 entry is a different-titled sibling paper). Do not attribute 2402.13731 to AAAI 2024.
- Update the Heap et al. (2501.17727) title in the verification ledger to the current 'Automated Interpretability Metrics Do Not Distinguish Trained and Random Transformers' and drop the stale 'v1 verified' stamp; keep the D/Heap over-read flag.

---

## Adversarial review (attack)

Verification complete. I read the full Pass-1 record and independently checked every load-bearing citation against arXiv / official venues. Findings below.

---

# ADVERSARIAL REVIEW OF THE T8 ADJUDICATION

## Bottom line
The adjudication is largely well-calibrated and its four flagged overstatements are real. But it **propagated one misattributed author name it never caught**, **rested a key comparison on a contested statistic none of the three passes checked**, and **stamped a now-stale title as "verified."** No fabricated papers — every named work exists — but two citations are wrong in a way that matters.

---

## 1. Misattribution the adjudicator MISSED (highest-value finding)

**"Yu et al., 'Found in the Middle,' ACL 2024 Findings, 2406.16008" is a wrong-author citation.** The paper (arXiv:2406.16008, Findings of ACL 2024, aclanthology 2024.findings-acl.890) is authored by **Cheng-Yu Hsieh, Yung-Sung Chuang, Chun-Liang Li, Zifeng Wang, Long Le, Abhishek Kumar, James Glass, Alexander Ratner, Chen-Yu Lee, Ranjay Krishna, Tomas Pfister**. There is **no author named "Yu."** The surname was almost certainly hallucinated from the hyphenated given names (Cheng-**Yu**, Chen-**Yu**). This wrong name originated in the red team (point A-3), and the adjudicator **carried it verbatim** into the Claim-A "Strongest attack," into the overstatement flag ("Yu et al., ACL 2024 Findings"), and into an open question. Correct cite: **Hsieh et al. 2024**. The arXiv ID, venue, and finding (U-shaped positional bias is calibratable, ~10-15 pt recovery) are all correct — only the author attribution is fabricated. This is exactly the class of error the gate exists to catch, and it slipped through.

## 2. Contested statistic treated as fact (missed by all three passes)

Shaw & Porter (2015), *Psychological Science*, "Constructing Rich False Memories of Committing Crime" — **the paper is real and correctly attributed** (both prior passes flagged it "not re-verified"; now confirmed). BUT the load-bearing "**~70% of subjects**" figure that the red team's Claim-C attack and the adjudicator's flag/open-questions all repeat is **disputed in the literature**. Wade, Garry & Pezdek (2018, *Psychological Science*, "Deconstructing Rich False Memories of Committing Crime") recoded the same data under two independent schemes and concluded the defensible rate is **26-30%, not 70%**. None of the three passes cite this rebuttal. Consequence for the adjudication: the biological analogue the red team invokes to soften Claim C is **weaker and more contested** than presented — which, if anything, means the adjudicator slightly **under-credited** Claim C by taking the inflated 70% at face value. The core disanalogy ("no reliable, ungated, single-exposure, full-trust write") is if anything *strengthened* once the number is corrected.

## 3. Stale-title / version error on the Heap paper

The red team's headline D-correction is **validated**: arXiv:2501.17727 **was** retitled. v1 (29 Jan 2025) = "Sparse Autoencoders Can Interpret Randomly Initialized Transformers"; **v2 (revised 27 Jan 2026) = "Automated Interpretability Metrics Do Not Distinguish Trained and Random Transformers."** So the adjudicator correctly sided with the red team over the steelman. Two residual problems:
- **The steelman's verification ledger stamps the v1 title as "verified this session,"** and the adjudicator let that stand. As of July 2026 the **canonical title is the v2 metrics-claim title** — the "verified" stamp is stale and should be updated, not trusted.
- **The red team slightly overstated its own correction and the adjudicator didn't flag it.** Red team: authors "explicitly state they do **not** claim SAEs fail to capture information… confirmed via the arXiv abstract this session." I fetched the abstract: it does **not** contain that explicit disclaimer and **does not mention decoder-side artifacts** at all; its actual conclusion is the narrower "treat common SAE metrics as useful but insufficient proxies." So the disclaimer is a *reasonable inference from the retitle*, not a verbatim abstract statement as claimed. The substance is right; the "confirmed via abstract" provenance is overstated — a red-team overreach that mirrors, at smaller scale, the steelman overreach the adjudicator did flag.

## 4. Citations that check out clean (confirming prior flags hold)

- **Rank collapse** (Dong, Cordonnier & Loukas, 2103.03404, **ICML 2021 Oral**): confirmed, and the red team's attack is **fully vindicated** — the paper's own thesis and repo ("we show pure attention suffers rank collapse, and how skip connections + MLPs combat it") confirm the theorem is for the *undeployed* architecture. The steelman's use as a "deployed parametric degradation law" genuinely inverts the source. Adjudicator correct.
- **Ramasesh, Dyer, Lewkowycz** "Effect of Scale on Catastrophic Forgetting," **ICLR 2022**: confirmed (canonical author order is Dyer/Lewkowycz/Ramasesh; the record's "Ramasesh, Lewkowycz & Dyer" reorders but names the right people). Finding (larger pretrained transformers forget *less*) confirmed. The "contested at scale" adjudication holds.
- **Niu, Liu, Zhu & Penn** (2405.02421, **ICLR 2024 Spotlight**): confirmed exactly. No error.
- **PoisonedRAG** (Zou, Geng, Wang & Jia, 2402.07867, **USENIX Security 2025**): confirmed — venue is 2025, authors correct. The prior-pass flag correcting a "2024" summary to USENIX 2025 is right.
- **MINJA** (Dong et al., 2503.03704, 2025): confirmed; reported 98.2% injection / 76.8% attack success (record's ">95% injection" is consistent).
- **Chen et al. Degenerate Knowledge Neurons** (2402.13731): title/authors confirmed (Yuheng Chen et al.), and the persistent **"AAAI-2024 venue unconfirmed" flag is well-founded** — there is affirmative evidence of **conflation**: 2402.13731's v1 uses an *ACL* proceedings template, while the same authors' *AAAI 2024* paper is a **different-titled** work ("Journey to the center of the knowledge neurons…"). The AAAI-2024 attribution likely belongs to the sibling paper, not to 2402.13731. Keep flagged — do not use as AAAI-2024.
- The previously-caught fabrications/self-reports (KGGen/Titans NeurIPS-2025, AlphaEdit "Outstanding Paper," Mem0/Zep DMR) **do not appear** in this record and remain correctly out.

---

## Verdict-calibration attack

- **Claim A — weakened-but-stands (high):** Slightly **over-reads as generous**. All three named degradation laws (spectral collapse, "abrupt-and-complete" catastrophic loss, Lost-in-the-Middle occupancy) were substantially defeated; what survives is only the thin "frozen-weights + volatile-buffer gate." The verdict *text* concedes this, but attaching **"high"** confidence to a claim whose vivid content was stripped down to a one-line architectural gate risks misleading a downstream reader. Calibration would be cleaner as "core survives (high); the degradation-law framing does not (defeated)."
- **Claim B — genuinely-contested (medium):** Well-calibrated. The red team's "read/edit dissociation is the neuroscience default → convergence, not break" is a strong reversal and "medium" correctly refuses to hand the steelman its metaphysical escalation.
- **Claim C — weakened-but-stands (high):** Right verdict, **shaky reasoning** — rests on the inflated 70% Shaw-Porter figure (see §2). Correcting the number tightens C rather than loosening it.
- **Claim D — weakened-but-stands (high):** Correct; the Heap retitle and the "identity constrains the function class" rebuttal are both sound.

## Strawman/overstatement audit
The adjudicator's two strawman flags (red-team C-2 scoping-clarification-as-rebuttal; red-team under-crediting A's surviving gate) are **both fair and correctly reasoned**. The one it **missed** is the red team's Heap-abstract provenance overreach (§3). Its six overstatement flags against the steelman are all substantiated by my checks — none is itself an overstatement.

## Net
Two citation defects the gate should force-fix before the next pass: **(a) "Yu et al." → Hsieh et al.** for 2406.16008; **(b) the "~70%" Shaw-Porter figure → note the Wade/Garry/Pezdek 2018 recoding to 26-30%.** One housekeeping fix: **update the Heap title to the v2 metrics-claim title** and drop the stale "v1 verified" stamp. Everything else in the adjudication survives adversarial verification.

---

## Adversarial respect (defend)

Verification complete. Every named work in the T8 record checks out as real and correctly attributed — no fabrications in this topic's citation set. Below is the defender adjudication.

---

# DEFENDER REPORT — T8 "Where the LLM ↔ human analogy breaks down"

## Citation verification (all REAL; two flag changes)

| Work | Status |
|---|---|
| Heap et al. 2501.17727 | CONFIRMED **retitled** to "Automated Interpretability Metrics Do Not Distinguish Trained and Random Transformers"; authors explicitly scope claim to aggregate auto-interp metrics, NOT "features are artifacts" (fetched abstract) |
| Shaw & Porter 2015, *Psychological Science* | CONFIRMED — "Constructing Rich False Memories of Committing Crime," 70% figure. **CLEAR** the "not re-verified" flag — but **ADD NEW FLAG** (below) |
| Ramasesh, Lewkowycz & Dyer, ICLR 2022 | CONFIRMED — Google, "Effect of scale on catastrophic forgetting," larger pretrained models MORE resistant |
| Yu/Hsieh et al. "Found in the Middle" 2406.16008 | CONFIRMED — ACL 2024 Findings; recovers "up to 15pp"; attributes cause to **intrinsic** U-shaped attention bias |
| Chen et al. "Degenerate Knowledge Neurons" 2402.13731 | CONFIRMED **AAAI 2024** (38th AAAI, Vancouver). **CLEAR** the "venue unconfirmed" hedge — it is real |
| Niu, Liu, Zhu & Penn 2405.02421 | CONFIRMED ICLR 2024 **Spotlight** (OpenReview 2HJRwwbV3G) |

**Prior-pass fabrications (KGGen/Titans NeurIPS-2025, AlphaEdit "Outstanding Paper," Mem0, Zep DMR): none appear in this topic.** T8's citation set is clean of them — nothing to re-flag here. No new fabricated/misattributed citation found.

**NEW FLAG (the defender's most consequential finding):** the red team's Shaw & Porter (2015) 70% figure is **empirically contested downward**. Wade, Garry, et al. reanalysis (also *Psychological Science*) recoded the same data: only **~30%** met false-*memory* criteria; **~43%** were mere false *beliefs* (believing they committed the crime without a recollective memory). This was used with the uncontested 70% framing.

---

## Where the adjudication was TOO HARSH — uphold these

### 1. Claim C — the downgrade over-reached; its load-bearing counterexample is contested (STRONGEST UPHOLD)
The flag brands C's "no biological analogue" as "absolutism doing rhetorical work," and the red team demotes it to "no *reliable, ungated, privileged-write* analogue," resting the demotion entirely on Shaw & Porter (2015). But the property the red team needs — "retrieved-*as-genuine*, treated with the same authority as real autobiographical memory" — is **precisely the part Wade et al. re-coded away**: strip the false *beliefs* and only ~30% show an actual recollective false memory, not 70%. The memory/belief distinction is the authority/recollection axis the threat-model-equivalence argument depends on. So the biological analogue is even weaker and more gated than the red team's already-hedged version. C's steelman core — *no process installs a verbatim, single-exposure, immediately-and-fully-retrieved-as-trusted record* — survives fully intact; that open question is the true irreducible core and it is untouched. The adjudicator's verdict (weakened-but-stands / high) is correct, but the "absolutism" flag over-credits an attack built on a downward-re-analyzed result. **Under-credited strength: the single-shot ungated verbatim write is a real categorical break; Shaw-style implantation is probabilistic, multi-session, subject-reconstructed, AND contested even at 30%.**

### 2. Claim A — the "Lost-in-the-Middle = measurement artifact" ruling over-reached
The flag reframes Lost-in-the-Middle as "substantially a calibratable positional-encoding artifact… not a degradation law." But *Found in the Middle* — the very paper cited for the rebuttal — locates the cause in the model's **intrinsic U-shaped attention bias** (beginning/end tokens over-attended "regardless of relevance"). **Calibratable ≠ artifact.** A bias you estimate and subtract at inference is still a real architectural read-property (like a known sensor bias — correcting it does not make it unreal), and the calibration recovers only *up to* 15pp, leaving residual position-dependence. So A's disanalogy survives as **more than "just the frozen/volatile gate"**: an intrinsic positional read-bias over a verbatim token buffer has no clean human homolog (human primacy/recency is not a fixed per-head architectural U-curve you can subtract with a constant). This is a *partial* uphold — the steelman's specific "occupancy *starvation*, orthogonal to correction" phrasing IS legitimately weakened — but the red team's "everything reduces to the architectural gate" conclusion under-credits the surviving intrinsic-attention-bias disanalogy.

### 3. Claim B — "convergence, not break" is itself an over-reach
The red team's reversal ("steelman has it backwards; B is convergence") over-claims what the neuroscience licenses. Lashley + distributed-engram work establish biological storage is *distributed and non-localized* — but that is far weaker than Hase's specific, measured result: causal-tracing read-locus **statistically uncorrelated** with the optimal edit-layer, quantified and reproducible. There is **no equally-quantified biological counterpart** (you cannot run ROME-style causal-tracing-vs-optimal-edit-layer on a brain). The steelman already conceded distribution is shared and located the LLM-specific force in the *operational, measured* dissociation — exactly the epistemic-affordance open question the adjudicator preserved. B's "genuinely-contested / medium" verdict is fair, but the framing that B is simply "convergence" under-credits that a **quantified, operationally-exploitable read≠edit dissociation is a genuine methodological disanalogy even when the underlying distribution is shared**. The adjudicator's open question is the honest resolution, not the red team's flat "convergence."

---

## Where the attack LANDS — concede (do not defend)

- **D / Heap et al.:** CONFIRMED by fetching the abstract. The steelman's "single most damaging re-description result… SAE features are decoder-side artifacts" over-reads a paper whose authors explicitly limit the claim to aggregate auto-interp metrics ("high aggregate auto-interpretability scores do not, by themselves, guarantee… features have been recovered"). Keep the flag. Note the exhibit is *rescoped, not dead* — the narrow finding still supports D's meta-thesis (vocabulary outruns demonstrated mechanism), which is why D correctly stands as "weakened-but-stands."
- **A / spectral-collapse (Dong et al. 2021):** genuine steelman error — the paper's thesis is that residuals+MLPs *prevent* rank collapse; presenting it as a deployed-substrate degradation law inverts the source. Keep flagged. (Not re-verified this session, but the inversion is intrinsic to that paper's argument and was confirmed in prior passes.)
- **A / catastrophic-forgetting-at-scale:** genuinely contested — Ramasesh (confirmed real) finds *more* resistance with scale; the "abrupt and complete" 1989/1999 framing does not transfer cleanly to LLM scale. Keep flagged.
- **D / "identities prove too much":** the red team is right — the Hopfield identity (Ramsauer 2021) does constrain the function class (fixed points, capacity, retrieval dynamics); the blanket "identity = mere re-description" overgeneralizes. The real false-equivalence is the *biological* leap. Adjudicator credited this correctly.

---

## Net defender verdict
The topic-level "mixed" verdict is sound and the four per-claim verdicts should stand. Two adjudication calibrations are warranted: (1) **soften the C "absolutism" flag** — the demotion rests on a result (Shaw & Porter 70%) that has been re-analyzed down to ~30% on the exact property at issue; C's core break is stronger than the flag credits; (2) **soften the A "Lost-in-the-Middle = measurement artifact" flag** to "intrinsic-but-calibratable attention bias" — the rebuttal paper itself calls the cause intrinsic, so a real (if partially correctable) substrate read-property survives beyond the bare architectural gate. Clear two now-verified venue hedges: **Chen 2402.13731 = AAAI 2024** and **Shaw & Porter = *Psychological Science* 2015** (but record the contested-70% flag). The genuine steelman errors — Dong inversion, clean-catastrophic-loss-at-scale, Heap over-read, blanket "identities are re-description" — are correctly flagged and should remain.

