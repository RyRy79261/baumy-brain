# T6-updating — Pass-2 Fable verification

**Gate status:** pass-with-fixes

## Verified claim checks
- **[confirmed]** Claim A — Append-only is fatal; field converges on ADD/UPDATE/DELETE/NOOP reconciliation + bitemporal soft-invalidation, echoed by AGM and SQL:2011 (verdict: weakened-but-stands, high)
    - adjudicated: weakened-but-stands (high)
    - note: Both attackers agree the tautology diagnosis is right and the narrowed core ('you can only choose where the supersession policy lives') survives; AGM 1985 and SQL:2011 citations are real and correctly attributed.
- **[too-generous]** Claim B — Human analogue = reconsolidation + misinformation effect + 'retrieval is a write' (testing effect, RIF); intrinsic-in-humans/optional-in-machines (verdict: genuinely-contested, high)
    - adjudicated: genuinely-contested (high)
    - note: Verdict itself is fair, but the record's 'strongest attack' text (line 16) mis-deploys Murayama 2014 as reliability-contesting when it is primarily inhibition-confirming; the contested-RIF point should rest on Frontiers-2014 + Cortex-2018, not Murayama.
- **[confirmed]** Claim C — Parametric editing doesn't propagate to neighbors (RippleEdits); cumulative edits collapse; AlphaEdit only delays under linear associative-memory approximation (verdict: survives, high)
    - adjudicated: survives (high)
    - note: Analytic core is sound and independent of award status; RippleEdits/Gupta-ACL/r-ROME/AlphaEdit all verified real — but the embedded credit at line 21 ('steelman correctly flags AlphaEdit Outstanding Paper as unsupported') is factually wrong and must be struck.
- **[error-found]** Claim C sub-point: AlphaEdit 'Outstanding Paper' (ICLR 2025) is NOT SUPPORTED / self-reported (poster, no award)
    - adjudicated: FLAGGED as unsupported fabrication (lines 21, 41, 120, 134)
    - note: Verified false: AlphaEdit won a genuine ICLR 2025 Outstanding Paper Award (official ICLR awards PDF + NUS Computing press release). Reverse the flag and state the award as fact.
- **[confirmed]** Claim D — No consensus hard-delete vs soft-invalidate; whether in-place editing is safe at scale is unresolved; mirrored across machine-unlearning and temporal-DB/GDPR (verdict: weakened-but-stands, high)
    - adjudicated: weakened-but-stands (high)
    - note: Both attackers agree the near-unfalsifiability critique is fair and the verdict is correctly calibrated; the unlearning/GDPR category-slip flags are well-placed.
- **[too-harsh]** Overstated-enrichment flag: temporal-DB theory shares the late-1970s/early-1980s nonmonotonic-reasoning / CS-logic lineage and citation graph (line 33)
    - adjudicated: flagged as overstated enrichment on the steelman side
    - note: Over-corrects: AGM and Doyle/de Kleer TMS/ATMS share the AI-logic lineage, but temporal-DB theory (Snodgrass, valid/transaction-time) grew from the DB-systems community (SIGMOD/VLDB/TODS), largely independent. Accurate framing: two of three CS traditions share a lineage; temporal-DB and neuroscience are both largely independent.
- **[confirmed]** 2025-26 preprints (2502.19416, 2601.11042, 2511.05852, 2606.26783) flagged as directional-only, not peer-reviewed
    - adjudicated: flagged, use as directional support only
    - note: Conservative posture is correct and should stay; both attackers affirm no fabrication to add here (2606.26783 and 2502.19416/2601.11042 resolve to real arXiv items, non-top-tier venues).

## Citation issues
- AlphaEdit — Fang et al., ICLR 2025 (arXiv 2410.02355): MISATTRIBUTED. Ledger (lines 41, 120, 134) and Claim C (line 21) brand it a 'poster with no award' and the 'Outstanding Paper' label a self-reported fabrication. Verified false against the official ICLR 2025 Outstanding Paper Awards PDF and NUS Computing's institutional press release: AlphaEdit is one of the genuine Outstanding Paper Award winners. Poster presentation slot and award status are orthogonal, not mutually exclusive. Reverse the flag.
- Murayama, Miyatsu, Buchli & Storm 2014, Psychological Bulletin 140:1383-1409: MIS-DEPLOYED (inverted). Used at line 16 as the lead 'RIF is reliability-contested' citation. The meta-analysis 'largely supported inhibition accounts' — it is primarily RIF-confirming, documenting heterogeneity in effect magnitude, not a reliability indictment. Correctly attributed as a real paper, but pointed the wrong direction; the contested-RIF point should draw on the Frontiers-2014 reliability paper and the Cortex-2018 inhibition reanalysis instead.

## Under-credited strengths
- Claim C's analytic core — 'AlphaEdit delays-not-eliminates collapse under the linear associative-memory approximation with a null space estimated from a finite preserved-key sample' — is a fair, well-reasoned reading of the method and stands fully independent of the (now-corrected) award status; both attackers affirm it.
- The three strawman flags (line 31: B1 shared-concession-recast-as-kill, B2 attacking a mechanistic-identity claim the steelman disowns, and 'synthesis-is-not-an-error') are well-adjudicated and land per both attackers.
- The RIF directional attack (over-suppression of neighbors vs under-propagation to them) is a genuine, correctly-credited red-team hit — the RIF-as-ripple-echo mapping really does point the wrong way.
- The conservative posture on 2025-26 preprints (flagged, directional-only, not peer-reviewed) is correct and should stay; no fabrication among them.
- Every other named work in the ledger (RippleEdits/TACL, r-ROME/EMNLP 2024, Gupta Findings-ACL-2024, McCloskey & Zaragoza 1985, Nader/Schafe/LeDoux 2000, Loftus 1974/1978, Roediger & Karpicke 2006, Anderson/Bjork/Bjork 1994, AGM 1985, Doyle TMS 1979, Snodgrass & Ahn 1986, SQL:2011) is real and correctly attributed — no other fabrications.

## Must fix before Pass 3
- REVERSE the AlphaEdit 'Outstanding Paper' flag. AlphaEdit won a genuine ICLR 2025 Outstanding Paper Award (official ICLR awards PDF + NUS Computing press release). Un-flag it, correct the ledger (lines 41, 120, 134), and strike the false self-credit at line 21 ('steelman correctly flags ... unsupported'). Note: this is provenance only — Claim C's analytic verdict is unaffected.
- FIX the Murayama 2014 deployment at line 16. It is a primarily inhibition-CONFIRMING RIF meta-analysis, not a reliability indictment. Re-anchor the 'RIF is reliability-contested' point on the Frontiers-2014 reliability paper and the Cortex-2018 reanalysis; remove Murayama as the lead skeptical citation.
- CORRECT the temporal-DB lineage claim in the overstated-enrichment flag (line 33). Temporal-database theory (Snodgrass, valid/transaction-time) grew from the DB-systems community, not the nonmonotonic-reasoning citation graph. Accurate framing: two of the three CS traditions (AGM, TMS/ATMS) share the AI-logic lineage; temporal databases and neuroscience are both largely independent.

---

## Adversarial review (attack)

I have what I need. Verification complete — one prior-pass "fabrication" flag is itself the fabrication. Here is my adversarial review.

---

# GATE ATTACK — T6 "Updating: reconcile/supersede not append; the ripple problem"

I could read the full Pass-1 record. Attacking the adjudication itself.

## THE HEADLINE: the adjudication's own flagship "catch" is factually FALSE

**AlphaEdit DID win an ICLR 2025 Outstanding Paper Award. The record's repeated "NOT SUPPORTED / self-reported fabrication" flag is a false positive — and it is propagated in three places.**

The record states, with confidence:
- Steelman grounding note (line 41): *"The ICLR page confirms AlphaEdit was a **poster** with **no award**."*
- Ledger (line 120): *"AlphaEdit — ICLR 2025, **poster**."*
- Ledger FLAGGED section (line 134): *"AlphaEdit 'Outstanding Paper' (ICLR 2025): **NOT SUPPORTED.** The official ICLR 2025 virtual page lists it as a poster with no award; the 'Outstanding Paper' label appears only on the authors' GitHub/a YouTube title (self-reported)."*
- Adjudicated Claim C (line 21): *"The steelman also correctly flags that the AlphaEdit 'Outstanding Paper' claim is unsupported."*

Every one of these is wrong. I verified against **four independent sources**:
1. The **official ICLR 2025 blog announcement** ([blog.iclr.cc, 2025-04-22](https://blog.iclr.cc/2025/04/22/announcing-the-outstanding-paper-awards-at-iclr-2025/)) lists AlphaEdit (Fang, Jiang, et al.) as one of the **three Outstanding Paper Award winners**.
2. **NUS Computing's own institutional press release** ([comp.nus.edu.sg](https://www.comp.nus.edu.sg/bytes/prof-chua-tat-seng-iclr-2025/)): *"Prof Chua Tat Seng Receives Outstanding Paper Award at ICLR 2025"* — explicitly for *"AlphaEdit: Null-Space Constrained Knowledge Editing for Language Models."* This is the senior author's own university, not a self-reported GitHub tag.
3. Independent press coverage (bincial) reporting the ICLR 2025 Outstanding Papers list.
4. The GitHub/YouTube tags the record dismissed as "self-reported" — which turn out to be *correct*.

The error is a **conflation of presentation format with award status**. ICLR papers, including award winners, are commonly still assigned a "Poster" presentation slot on the virtual site. "Presented as a poster" and "won an Outstanding Paper Award" are orthogonal, not mutually exclusive. The reviewer who wrote "poster with no award" read the presentation-type field and inferred absence of an award — an unsupported leap that then hardened into a "fabrication caught."

**Why this matters for the gate:** The task brief instructed me to *keep* "AlphaEdit 'Outstanding Paper'" flagged as a prior-caught fabrication. That instruction is based on a prior-pass false positive. The gate should **reverse the flag**: AlphaEdit's Outstanding Paper Award is real and verifiable. Note the caveat: the small-model WebFetch of the ICLR *PDF* returned garbled paper titles (binary misread) — I discount that read; the blog HTML fetch and the NUS press release are the reliable confirmations, and they agree.

This is a miscalibration in the **too-harsh** direction: a true, verifiable fact was branded fabrication, and the record awards itself credit for the "catch" (line 21). An adversarial gate that fabricates a fabrication is failing in the same way it's meant to police.

## (1) Miscalibrated verdicts

**Claim B "genuinely-contested (high)" leans on a misused citation the adjudicator accepted.** The adjudicated "strongest attack" (line 16) states *"RIF is both reliability-contested (Murayama et al. 2014, Psych Bulletin)…"*. This inverts the paper. Murayama, Miyatsu, Buchli & Storm (2014), *"Forgetting as a consequence of retrieval: a meta-analytic review of retrieval-induced forgetting,"* Psychological Bulletin — is the meta-analysis that **broadly validated RIF and concluded in favor of the inhibition account** (*"support the assumption of inhibition causing it, although non-inhibitory processes also contribute"* — [CoLab/CentAUR](https://centaur.reading.ac.uk/37052/)). It documents heterogeneity in effect *magnitude*, yes, but its headline finding is confirmatory, not a reliability indictment. Using it as the lead "RIF is unstable" citation is backwards. The *broader* "RIF is contested" point can still draw on the Frontiers-2014 reliability paper and the Cortex-2018 inhibition reanalysis (both real), so the verdict survives — but the adjudicator swallowed the red team's strongest-sounding citation without noticing it points the other way. That should lower, not sustain, "high" confidence on the attack side.

**Verdicts I judge correctly calibrated:** Claim A "weakened-but-stands" (the tautology diagnosis is right); Claim C "survives" *within its stated parametric scope* (the claim is explicitly about mechanistic/parametric editing, so the red team's category-slip is an attack on *using* it for the broader thesis, not on the claim's own truth — the adjudicator correctly parked that as an open question rather than a defeater); Claim D "weakened-but-stands" (the near-unfalsifiability critique is fair).

## (2) Citation attribution check

- **AlphaEdit** — see headline. Real paper, real award, arXiv 2410.02355, ICLR 2025 Outstanding Paper. The *flag* is the fabrication.
- **Rebuilding ROME / r-ROME** (Gupta, Baskaran, Anumanchipalli, EMNLP 2024, arXiv 2403.07175) — **verified**: authors, venue (EMNLP 2024 Main), and the "disabling edits are an implementation artifact" finding all confirmed.
- **RippleEdits** (Cohen et al., TACL 12:283–298, 2024, arXiv 2307.12976), **Gupta et al. Findings-ACL-2024** (2401.07453), **Murayama 2014**, **McCloskey & Zaragoza 1985 (JEP:General 114:1–16)** — all confirmed real and correctly attributed. The psychology landmarks (Nader/Schafe/LeDoux 2000, Loftus & Palmer 1974, Loftus/Miller/Burns 1978, Roediger & Karpicke 2006, Anderson/Bjork/Bjork 1994) and the formal-methods citations (AGM 1985, Doyle TMS 1979, Snodgrass & Ahn 1986, SQL:2011) are all correctly cited — no fabrications among them.
- **2025–26 preprints** (2502.19416, 2601.11042, 2511.05852, 2606.26783) — the adjudicator's conservative "flagged, directional-only, do not treat as peer-reviewed" posture is correct and should stay. I confirmed 2606.26783 ("Reproducibility Study of AlphaEdit") exists in arXiv listings; the others I did not independently confirm, so the flag is appropriate. **No fabrication to add here** — the posture is right.
- **KGGen/Titans NeurIPS-2025, Mem0, Zep DMR** (named in the brief as prior catches): **not present anywhere in the T6 record**, so nothing to re-flag here — they belong to other topics.

## (3) Red-team strawman / steelman overstatement the adjudicator MISSED

**The "shared lineage" rebuttal is itself overstated — and the adjudicator adopted it wholesale.** The red-team meta-attack (line 154) rebuts "three fields never coordinated" by asserting the fields *did* coordinate: *"Temporal-database theory (Snodgrass) shares the CS-logic lineage and citation graph… These fields did coordinate — they read each other."* The adjudicator not only credited this but **repeated it in its own overstated-enrichment flag** (line 33): *"AGM, Doyle/de Kleer TMS/ATMS, and temporal-DB theory share the late-1970s/early-1980s nonmonotonic-reasoning / CS-logic lineage and citation graph; only neuroscience is genuinely independent."* This over-corrects. AGM (belief revision/modal logic) and Doyle/de Kleer TMS/ATMS (nonmonotonic reasoning) genuinely do share the early-1980s AI-logic lineage — but **temporal-database theory (Snodgrass, valid-time/transaction-time) grew out of the database-systems community (SIGMOD/VLDB/TODS data modeling), not the nonmonotonic-reasoning citation graph.** The red team lumped a substantially separate DB-systems tradition into the logic lineage to strengthen its "not independent" rebuttal, and the adjudicator ratified it. So both poles are overstated: the steelman's "never coordinated" is too strong, *and* the red team's "shared citation graph" is too strong for the temporal-DB leg. The accurate statement is "two of the three CS traditions share a lineage; temporal databases and neuroscience are both largely independent." The adjudicator flagged only the steelman's side of this.

**Correctly-caught items I confirm stand:** The three strawman flags (lines 31) are well-adjudicated — B1 (shared concession recast as novel kill), B2 (attacking a mechanistic-identity claim the steelman explicitly disowns), and the "synthesis-is-not-an-error" point all land. The RIF-directionality attack (over-suppression vs under-propagation) is a genuine, correct red-team hit and rightly credited.

## (4) Remaining unsupported leaps

- The record grants **all four verdicts "high confidence."** Given that the record's own citation ledger contains a confidently-wrong entry (AlphaEdit) and a backwards one (Murayama), a uniform "high" across the board is itself mildly miscalibrated — the meta-lesson is that this record's ledger was *less* reliable than its confidence stamps imply. Claim C's "high" in particular rides on a ledger that mislabeled its own flagship editing paper.
- Substantively, the AlphaEdit award reversal does **not** change Claim C's *analytic* core: "AlphaEdit delays-not-eliminates under the linear associative-memory approximation" is a fair reading of the method (null-space projection valid only under the linear key–value approximation of a nonlinear layer, with a null space estimated from a finite preserved-key sample). That reasoning stands independent of the award. Only the *provenance/ledger* claim was wrong — but a verification gate exists precisely to catch ledger errors, and this one slipped through two passes.

## Bottom line for the gate

The adjudication's substantive reasoning is largely sound and its strawman/overstatement flags are mostly well-placed. But it fails the gate on **factual ledger accuracy** in a way that is ironic given its adversarial mandate: it (a) brands a real, quadruple-verifiable ICLR 2025 Outstanding Paper Award as an unsupported/self-reported fabrication (too harsh, factually false — reverse it), (b) accepts a RIF meta-analysis (Murayama 2014) as reliability-*contesting* when it is reliability-*confirming* (inverted), and (c) over-adopts the red team's "shared lineage" rebuttal, mislabeling temporal-database theory as part of the nonmonotonic-reasoning citation graph. None of these sink the topic-level verdicts, but all three must be corrected before Pass 1 is allowed to clear.

---

## Adversarial respect (defend)

Read complete. Verified the load-bearing citations against primary sources. Findings below.

---

# FABLE-5 DEFENDER — T6 "Updating: reconcile/supersede not append; the ripple problem"

## HEADLINE CORRECTION: a prior "flag" is a false positive — the AlphaEdit award is REAL

The Pass-1 ledger flagged **AlphaEdit "Outstanding Paper" (ICLR 2025) as NOT SUPPORTED / self-reported**, and the orchestrator's brief instructed me to "confirm these stay flagged." I cannot, because the primary source disproves the flag. The official ICLR awards document — `media.iclr.cc/Conferences/ICLR2025/ICLR2025_Outstanding_Paper_Awards.pdf` — lists, verbatim, under **Outstanding Paper Awards**:

> "AlphaEdit: Null-Space Constrained Knowledge Editing for Language Models"

as one of exactly three Outstanding Paper recipients, independently corroborated by NUS Computing's institutional announcement (Prof. Chua Tat-Seng, KITHCT Chair). This is not a GitHub/YouTube self-report; it is the conference's own award roster.

The Pass-1 steelman's grounding note ("The ICLR page confirms AlphaEdit was a poster with no award") was mistaken — it evidently read a stale or pre-award virtual listing. **The award should be UN-flagged and stated as fact.** This does not change any load-bearing claim (C's "AlphaEdit only delays collapse under a linear approximation" is independent of award status), but the prompt asked me to hunt misattribution, and here the misattribution runs the other way: a genuine result was branded a fabrication.

Note: KGGen/Titans NeurIPS-2025 and Mem0/Zep-DMR do **not** appear anywhere in the T6 record, so there is nothing in this topic to re-confirm on those.

## Citations verified REAL this session (no fabrications found in T6)

- **RippleEdits** — Cohen, Biran, Yoran, Globerson, Geva, *TACL* 12:283–298, 2024 — confirmed, including the "5K edits / in-context baseline wins" detail. Claim C's anchor is solid.
- **McCloskey & Zaragoza 1985**, *JEP:General* 114:1–16 — real, correctly attributed; exact title is "…Arguments and Evidence **Against** Memory Impairment Hypotheses." The red team's key counter-citation is legitimate.
- **Murayama et al. 2014**, *Psych Bulletin* 140(5):1383–1409 — real (see caveat below).
- **AGM recovery-postulate contestation** — confirmed: recovery is "the most controversial AGM postulate," attacked by Makinson, Hansson, Levi, Fuhrmann, Niederée. The red team's Claim-A attack is well-grounded.
- **2502.19416 "Norm Growth…"** — real, and it has a **venue**: accepted **oral, KnowFM @ AAAI 2025** (Gupta et al., Feb 2025), not a bare preprint.
- **2601.11042 "Spectral Characterization and Mitigation of Sequential Knowledge Editing Collapse"** — real (Shandong/BUPT/Tsinghua, Jan 2026); explicitly states the dominant-singular-direction corruption mechanism and proposes REVIVE.
- **2606.26783 "Reproducibility Study of AlphaEdit"** — real; independently confirms the "delays not eliminates" reading ("protection against catastrophic forgetting is **bounded rather than unconditional**").

## Where the adjudication was TOO HARSH / the red team OVER-REACHED (uphold these)

**1. RIF reliability — the Murayama citation was deployed backwards.** The adjudicator absorbed the red team's B5 as "RIF is both reliability-contested (Murayama et al. 2014)." But Murayama 2014 is the field's major RIF meta-analysis and its result **"largely supported inhibition accounts."** It is arguably the *strongest* evidence FOR RIF's reliability, not against it. Using it as a skeptical citation is an over-reach; the phenomenon's existence is meta-analytically confirmed. The genuinely surviving half of B5 is only the *directional* point (RIF = over-suppression of neighbors vs. ripple = under-propagation), which stands on its own and needs no reliability attack.

**2. The spectral/norm-growth mechanism is better-supported than "preprint-stage hypothesis atop a phenomenon" credits.** The mechanism now has **convergent, independent support**: a KnowFM@AAAI-2025 oral (2502.19416, Gupta lineage), a separate group's January-2026 paper naming the identical dominant-singular-direction mechanism (2601.11042, Shandong et al.), and a reproducibility study confirming AlphaEdit's protection is bounded (2606.26783). These remain non-top-tier venues and the "preprint" flag is *technically* fair, but "rests disproportionately on unverified preprints" undersells two-independent-group convergence plus the peer-reviewed phenomenon. The mechanistic story is not one lab's hunch.

**3. Claim C's "survives (high)" is correct and should not be softened by the category-slip caution.** The red team's "these results indict parametric editing, not supersession policy" is a fair *scoping* note, but it does not weaken C's internal validity: C is a claim *about parametric editing*, and it is true about parametric editing. The adjudicator rightly kept C at survives — I uphold that at full strength. (The scoping point belongs downstream as "don't over-generalize C," not as a demotion of C.)

**4. AGM attack on Claim A lands but is narrower than framed.** The recovery-postulate contestation is real, but it disputes *which* contraction operator is well-behaved — not *whether* contraction is irreducible to expansion (the AGM result Claim A actually leans on). So the attack dents "AGM is a settled, single-voiced foundation" without touching "append alone cannot yield contraction." Claim A's narrowed core — "you cannot avoid a supersession policy; you can only choose where it lives," which the red team itself concedes — survives intact; calling that core "empirically empty" over-reaches, since it correctly rules out the common naive-append-only design error. "weakened-but-stands" is the right verdict.

## Where the attack genuinely LANDS (do not defend)

- **Claim B's misinformation-as-overwrite leg is contested at the root.** McCloskey & Zaragoza 1985 (real, verified) is a legitimate coexistence/source-monitoring counter; Claim B cannot cite Loftus as clean proof of trace supersession. Concede.
- **"Retrieval is a write" equivocates** — the testing effect is about future accessibility, not content editing. Concede.
- **The "three traditions independently converged" framing** overstates independence: AGM, Doyle/de Kleer TMS/ATMS, and temporal-DB theory share the late-1970s/early-1980s nonmonotonic-reasoning lineage; only neuroscience is genuinely independent. Concede.
- **No cited primary source makes the cross-field "↔" convergence claim** — it is a synthesizer overlay. Fair as a caution (though a synthesis being a synthesis is not itself an error unless a specific mapping is shown wrong, which the red team only did for RIF-vs-ripple).

## Net

T6 contains **no fabricated citations.** Every named work resolves to a real paper at the stated venue. The one item the brief told me to keep flagged as fabricated — the AlphaEdit ICLR-2025 Outstanding Paper Award — is **genuine per the official ICLR awards roster**, and the Pass-1 flag on it should be reversed. Claim C emerges strongest (verified, convergent mechanistic support, survives at high confidence); Claim A's narrow core is sound with real citations; Claim B's landmark citations are all real but its *interpretive* load-bearing legs (misinformation-as-overwrite, "retrieval is a write," RIF-as-ripple-echo) are genuinely contested or directionally loose — the adjudicator's "genuinely-contested" verdict is fair, except it under-credited RIF's meta-analytic reliability by mis-deploying Murayama 2014.

Sources: [ICLR 2025 Outstanding Paper Awards (official)](https://media.iclr.cc/Conferences/ICLR2025/ICLR2025_Outstanding_Paper_Awards.pdf), [NUS Computing announcement](https://www.comp.nus.edu.sg/bytes/prof-chua-tat-seng-iclr-2025/), [RippleEdits TACL](https://aclanthology.org/2024.tacl-1.16/), [McCloskey & Zaragoza 1985](https://pure.johnshopkins.edu/en/publications/misleading-postevent-information-and-memory-for-events-arguments--3/), [Murayama et al. 2014](https://centaur.reading.ac.uk/37052/), [arXiv 2502.19416](https://arxiv.org/abs/2502.19416), [arXiv 2601.11042](https://arxiv.org/abs/2601.11042), [arXiv 2606.26783](https://arxiv.org/pdf/2606.26783), [AGM recovery postulate (belief revision)](https://en.wikipedia.org/wiki/Belief_revision).

