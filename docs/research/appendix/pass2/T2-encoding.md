# T2-encoding — Pass-2 Fable verification

**Gate status:** pass-with-fixes

## Verified claim checks
- **[error-found]** A) Mature capacity-bounded systems store transformed/separated derivatives, never the raw input stream.
    - adjudicated: weakened-but-stands (high)
    - note: Verdict category is right (strong 'never raw' falls, operational form stands), but two real defects: (1) A's support attributes 'retrieval runs over the distilled layer, not the raw stream' to Park 2023 Generative Agents — web-verified false; raw observations + reflections share one stream and are co-retrieved by recency+importance+relevance; and (2) 'high' confidence over-credits the near-analytic surviving form the record's own open question admits is unfalsifiable. Downgrade to medium and strike the Generative Agents claim.
- **[confirmed]** B) Extract freely, canonicalize precisely: over-merge fatal/irreversible, under-merge recoverable.
    - adjudicated: genuinely-contested (medium)
    - note: Both adversaries concede this is fair; the provenance-dissolves-irreversibility and biology-over-merges hits are real and the in-practice cost claim survives. Minor unflagged item: using Fellegi-Sunter's cost-neutrality to attack B overshoots B's domain-scoped (high-merge-cost regime) claim — a mild red-team strawman the record only gestured at, not fatal.
- **[too-generous]** C) What is encoded fixes which cues retrieve it (encoding specificity/TAP); levels-of-processing is circular.
    - adjudicated: weakened-but-stands (high)
    - note: Category correct — Nairne 2002 is a genuine, verified, un-engaged standing rebuttal that sinks the strong causal form 'retrieval = f(match),' and the record rightly flagged the 'literal implementation in AI' overstatement. But 'high' attaches to the deflated design corollary ('distillation upper-bounds reachable cues') while the headline reads validated; downgrade to medium. Defense's push to upgrade toward 'stands' is rejected — the strong form really does fall to Nairne.
- **[confirmed]** D) AI extraction is a discrete errorful stage with no biological analogue and no write-time trust model.
    - adjudicated: genuinely-contested (medium)
    - note: Both adversaries concede fair. The two absolutes fall to misinformation-effect/confabulation/source-monitoring; the record correctly flagged the red team's 'D contradicts A/C' framing as a resolvable (functional-convergence + mechanistic-divergence) equivocation, not a fatal contradiction. Rests on the structural error-propagation argument, needing no contested benchmark.

## Citation issues
- Park et al. 2023, Generative Agents (UIST) — lines 9, 62: Misused/mischaracterized (citation itself is real and correctly attributed). The record attributes to it that retrieval 'runs over the distilled layer, not the raw stream.' Web-verified architecture: one chronological memory stream holds observations + plans + reflections; retrieval scores ALL memories (raw observations included) by recency+importance+relevance; reflections are added back into the same stream and retrieved alongside raw observations. It is at best neutral, arguably a counterexample (raw + distilled co-retrieved) — not evidence that raw material is a cold archive.

## Under-credited strengths
- The MTT self-undercut: the red team's 'CLS is not consensus' attack on A leans on Multiple Trace Theory, but the very paper it cites ('Has multiple trace theory been refuted?', Hippocampus 2020, PMID 31584226) finds little/no support for MTT's multi-trace storage prediction — it cuts toward CLS-style consolidation and against MTT's permanence story. Both adversaries independently confirm this. The record let the MTT-based A-attack stand at closer to full weight, so A's 'weakened' half is partly driven by an over-weighted attack.
- The record's flag that the red team's 'Morris rhyme-reversal is small/fragile' attack is uncited empirical hand-waving is a genuine, correct catch that both adversaries uphold — a defense search for a failed replication found none.
- C's surviving design corollary is more robust than 'weakened (high)' rhetorically conveys: Nairne relocates the mechanism (diagnosticity vs. raw match) while preserving the anti-'intrinsic-strength' conclusion the cluster needs, so the load-bearing read-side intuition stands even as the strong causal form falls.

## Must fix before Pass 3
- Strike or correct the Generative Agents 'retrieval runs over the distilled layer, not the raw stream' claim in A's support (lines 9, 62) — web-verified false; raw observations are co-retrieved and drive behavior. Do not present it as A's flagship 'independent AI rediscovery' without this correction.
- Downgrade the confidence on A and C from 'high' to 'medium', or explicitly re-anchor the label so it attaches to the surviving weak form, not the deflated headline — as written the 'high' launders confidence from the near-analytic/design-intuition form onto the strong 'never raw' / 'retrieval = f(match)' claims that the record itself concedes fall.
- Re-weight the MTT-based attack on A downward: note that its own cited 'Has MTT been refuted?' paper undercuts MTT's storage claim, so MTT is a weaker counter to A than the 'strongest attack' line credits.

---

## Adversarial review (attack)

I verified every named work against reality. Below is my attack on the adjudication itself. All citations in the record check out on year/venue/volume/pages (details in §2), so the fatal problems are calibration and two mischaracterizations the adjudicator propagated rather than flagged.

---

## VERDICT ON THE ADJUDICATION: passes on sourcing, fails on two substantive misses

### 1) Miscalibrated verdicts

**Claim A — "weakened-but-stands (high)" is laundered, and the adjudicator's own defense proves it.** The verdict is internally inconsistent with the adjudicator's own strawman flag. To rebut the Brady-2008 attack, the adjudicator writes (line 31): detail-rich memory "is still a stored, reconstructive representation, not verbatim replay of the input stream — so [Brady] refutes the steelman's 'only gist survives' framing, not the literal claim A." But that rescue *defines any stored representation as "transformed,"* which is exactly the vacuity the red team charged (line 132: "anything you can query has been indexed"). You cannot bat away Brady by making A unfalsifiable and simultaneously award A "high confidence." The honest bookkeeping: the *interesting* form ("never raw / only distilled gist is durable") is false-to-contested (Brady, sensory buffers, MTT), and the form that "stands" is the near-analytic one. "High" belongs only to the tautology. This is the single most over-generous call in the record.

**Claim C — "high" again over-credits the weak form.** The adjudicator correctly notes Nairne 2002 is a named, standing, un-engaged rebuttal to the *strong causal* form ("retrieval = f(match)"), and correctly flags the "literal implementation in AI" overstatement. But those two concessions gut precisely the version of C the cluster wants, leaving only "distillation upper-bounds reachable cues" as design intuition. Rating that "high" repeats the A-laundering: the confidence attaches to the deflated claim while the headline claim reads as validated.

**Claims B and D — "genuinely-contested (medium)" are both fair.** No complaint; both sides landed real, verified hits.

### 2) Citations: all real and correctly attributed — but two are *used* wrongly

I web-verified every load-bearing named work. All check out exactly as cited:
- Nairne 2002, *Memory* 10(5–6):389–395, doi:10.1080/09658210244000216 ✓
- "Testing the myth…", *Memory & Cognition* 2011, doi:10.3758/s13421-011-0133-9 ✓
- Brady, Konkle, Alvarez & Oliva 2008, *PNAS* 105(38):14325–14329 ✓
- Morris, Bransford & Franks 1977, *JVLVB* 16:519–533 ✓
- "Has multiple trace theory been refuted?" *Hippocampus* 2020, 30:842–850, PMID 31584226 ✓
- Berron et al. 2016, *J. Neurosci.* 36(29):7569–7579 ✓
- Baddeley 1978, *Psychol. Rev.* 85:139–152 ✓
- Nadel, Samsonovich, Ryan & Moscovitch 2000, *Hippocampus* 10:352–368 ✓
- Park et al. 2023 Generative Agents, UIST '23 ✓
- Tse et al. 2007, *Science* 316(5821):76–82 ✓
- arXiv:2510.20345, 2405.16929, **and 2603.07670 are all real preprints** ✓ (2603.07670 = "Memory for Autonomous LLM Agents," Mar 2026 — a genuine ID, not a fabricated placeholder despite looking like one).

**No fabricated citation was introduced in this pass**, and the prior-fabrication flags all held: KGGen is re-flagged as *not* NeurIPS-2025 (line 114); no Titans/AlphaEdit venue was reintroduced; no Mem0/Zep DMR self-reported benchmark number was smuggled in (line 116 explicitly declines). That part of the gate passes.

**But two real citations are misused, and the adjudicator did not catch either:**

**MISS #1 (the important one) — the Generative Agents description is factually wrong, and the adjudicator baked the error into A's *support* column.** The steelman (line 62) and the adjudicator's own "Strongest support" (line 9) claim Park 2023 "drives behavior off a distilled reflection layer, **not the raw stream**" / "retrieval runs over the distilled layer." That misreads the architecture. In Generative Agents the memory stream is a flat list of **observations**; retrieval scores *every* memory by recency + importance + relevance; **reflections are additional higher-level nodes stored back into the same stream and retrieved alongside raw observations, not in place of them.** Raw observations very much drive behavior. So Generative Agents is *not* evidence that "raw material is a cold archive, not the operational substrate" — it is closer to a counterexample (raw + distilled are co-retrieved). This is the steelman's flagship "independent AI rediscovery" for A, the adjudicator promoted it verbatim into the support, and it is wrong. That further undercuts the already-shaky "high" on A.

**MISS #2 — the "Has MTT been refuted?" (2020) paper points *against* the red team's use of it.** The red team cites it (line 137) to show "CLS is not consensus." But that paper is *skeptical of MTT*: it finds "little or no experimental support" for MTT's core prediction (temporally-graded RA in semantic tasks) and its strongest surviving claim is flat RA for episodic memory. It cuts *toward* CLS-style consolidation and *against* MTT's permanence story. The red team hedged ("cuts both ways"), but the adjudicator let the MTT-based attack on A stand at full weight. The red team's A-attack via MTT is weaker than credited — a place the adjudicator was too *generous to the red team.*

### 3) Strawman/overstatement the adjudicator missed

- The **Generative Agents overstatement** (Miss #1) is the clearest unflagged steelman overreach — more load-bearing than any of the five overstatements the adjudicator did flag, because it is A's primary AI evidence, not a rhetorical flourish.
- **Fellegi–Sunter as an anti-B weapon is a mild red-team strawman.** The red team (line 151) uses "FS licenses arbitrary asymmetric costs, so precision-first isn't a law" to damage B. But B never claimed universality — it claimed precision-first *in the high-merge-cost regime.* FS's neutrality neither supports nor refutes that domain-scoped claim; deploying it as a rebuttal attacks a stronger claim than B made. The adjudicator gestures at this in B's open question but does not flag it as a strawman the way it flagged the parallel moves on A/C/D.
- **Brady condition-label slip (minor, factual).** The red team says "87% even for same object, different **exemplar/state**." Per the paper the three figures are 92% (novel category), 88% (same category = *different exemplar*), 87% (*same object, different state/pose*). "Different exemplar" is the 88% condition, not the 87% one. The number and the qualitative point survive; the label conflation does not, and the adjudicator leaned on Brady without noticing.

### 4) Remaining unsupported leaps

- A's support line treats "independent AI rediscovery" as corroboration when, corrected (Miss #1), it is at best neutral. The cross-field "convergence — genuine" claim for A rests partly on a misread system.
- The adjudicator's A strawman-flag rests on a clean "reconstructive representation vs. verbatim replay" dichotomy. Brady's stimuli are recognized at the level of *item-specific perceptual state* (pose/exemplar), which is exactly the "detail" end of the gist–verbatim axis — so the dichotomy the adjudicator invokes to quarantine Brady is doing more work than the evidence licenses. The falsifiable boundary the open question asks for is genuinely unmet, which means A's "stands" should read *lower* than "high."

**Bottom line:** sourcing gate passes (no fabrications, priors held). Adjudication gate fails on two counts: (a) A and C are rated "high" by silently attaching the confidence to their deflated/near-analytic forms, and (b) the adjudicator propagated a factual misdescription of Generative Agents into A's support instead of flagging it. Recommend: downgrade A to *weakened-but-stands (medium)*, strike the Generative-Agents "not the raw stream" claim, and re-weight the MTT-based A-attack downward.

---

## Adversarial respect (defend)

Read the Pass-1 record and independently re-verified the load-bearing citations via web search. Report follows.

# FABLE-5 DEFENDER — T2 "Encoding is distillation, never raw storage"

## Verdict on the adjudication: broadly sound, but too harsh on A and C; correct on B and D.

The Pass-1 record is unusually honest — it flags its own strawmen mid-stream. My defense mostly consists of holding the adjudicator to its own flags, plus one citation-level finding that materially weakens the red team's strongest attack on A.

---

## Where the adjudication was TOO HARSH

### Claim A — the MTT counter-weight is weaker than the "weakened" verdict credits
The red team downgraded A by casting CLS as "not consensus," anchored on Multiple Trace Theory and the paper **"Has multiple trace theory been refuted?" (Hippocampus 2020, 30:842–850, PubMed 31584226)**. I fetched that paper's actual conclusion: it finds **"little or no experimental support"** for MTT's core predictions — explicitly including **"the existence of storage of multiple hippocampus traces."** So the very citation deployed to show CLS is contested is a paper whose net finding runs *against* MTT's storage claim, not against CLS. The red team weaponized a title ("...been refuted?") whose body largely answers "the storage claim, yes." This is a genuine strength the red team's aggression caused the adjudicator to under-credit: A's biological grounding is *less* contested than "weakened-but-stands" implies.

Second, the adjudicator itself flagged (correctly) that the Brady-2008 attack is a strawman — Brady refutes the steelman's self-imposed "only gist survives," not claim A's literal "transformed traces, never the raw stream." A high-fidelity stored object representation is still a reconstructed, indexed derivative, not verbatim replay of the raw perceptual input stream. **Brady 2008 is verified real** (PNAS 105(38):14325–14329) and is a legitimate hit on the gist-only framing — concede that — but it does not touch claim A as literally worded. The "weakened" half of the verdict is thus partly driven by an equivocation the adjudicator already identified as illegitimate. A deserves closer to **"stands, with an operational-scope caveat"** than "weakened."

### Claim C — Nairne is a refinement of the core, not a refutation of it
**Nairne 2002 is verified** (Memory 10(5–6):389–395, doi:10.1080/09658210244000216) and the 2011 follow-up is verified (Memory & Cognition, doi:10.3758/s13421-011-0133-9). The steelman genuinely never engaged it — concede that gap fully. But per the verified abstract, Nairne's claim is that cue effectiveness turns on **diagnostic value relative to competitors** rather than absolute encoding-retrieval overlap. That still makes retrieval a function of the *relationship between the encoded trace and the available cue set* — it relocates the mechanism (diagnosticity vs. raw match) while preserving the anti-"intrinsic-strength" conclusion the cluster actually needs. So Nairne defeats the **strong causal form** ("retrieval = f(match)") — which the steelman had already conceded — but leaves the load-bearing design corollary ("how you distill upper-bounds the reachable cue space") standing. The adjudicator's own open question gestures at exactly this. Net: C's surviving core is more robust than "genuinely contested by a named rebuttal" reads.

Also uphold the adjudicator's flag against the red team's **"Morris reversal is fragile/small"** attack: I searched for a failed replication and found none; the fragility assertion remains uncited empirical hand-waving presented as established. The red team over-reached here and the adjudicator correctly caught it.

---

## Where the attack lands — concede cleanly

- **Claim B (genuinely-contested, medium):** fair. The provenance-dissolves-irreversibility critique lands at the information-theoretic level (Swoosh + append-only/bitemporal stores make merges reconstructible), and the biology-points-*opposite* point (brains over-merge adaptively via schema conflation) is a real hit on the convergence claim. I do **not** over-defend B. I only uphold the adjudicator's existing flag: the *in-practice* cost claim ("lossy to reverse in the provenance-discarding implementations that are actually common") survives even though the absolute "information-theoretically irreversible" does not. B is doctrine-plus-suggestive-analogy, not proven convergence — correctly rated.
- **Claim D (genuinely-contested, medium):** fair. The absolutes "no biological analogue" and "no write-time trust model" do fail against the misinformation effect, confabulation, and source-monitoring (all canonical). Concede. I uphold the adjudicator's flag that the red team's "D *contradicts* A/C" framing over-reaches: the dissolving distinction (functional convergence under capacity pressure + mechanistic divergence) is supplied by the red team itself, so this is a resolvable equivocation, not a fatal formal contradiction. The cluster is coherent if it states convergence as *functional* and divergence as *mechanistic* — which is the most rigorous reading and one step from where the steelman already sits.

---

## Citation integrity — fabrication hunt (nothing new fabricated)

Verified real this pass: Nairne 2002; Nairne 2011 test; Brady et al. 2008; "Has MTT been refuted?" (Hippocampus 2020); Morris, Bransford & Franks 1977 (JVLVB 16:519–533); Bussey & Saksida representational-hierarchical account (confirmed real counter-framework, not invented).

All three flagged arXiv preprints **exist and are correctly flagged as non-peer-reviewed** — none fabricated:
- **2510.20345** — "LLM-empowered knowledge graph construction: A survey" (Bian, Oct 2025). Real preprint.
- **2405.16929** — "Uncertainty Management in the Construction of Knowledge Graphs: a Survey" (Jarnac, Chabot, Couceiro). Real preprint.
- **2603.07670** — "Memory for Autonomous LLM Agents" (Mar 2026). Real preprint.

Prior fabrication catches remain correctly flagged and were **not** reintroduced in this record: **KGGen** is kept flagged as *not* a NeurIPS-2025 paper; **Titans/AlphaEdit "Outstanding Paper," Mem0, Zep DMR** self-reported benchmarks are absent — the steelman explicitly refuses to cite any benchmark number and names DMR/Mem0/Zep as known traps. That discipline holds; D rests on the structural error-propagation argument, which needs no contested benchmark.

One honesty item to carry forward (already self-disclosed, not a defect): **Fellegi–Sunter 1969** and **Benjelloun "Swoosh" (VLDB J. 2009)** pagination remains unverified — the works are real and standard; confirm page numbers before any formal citation.

---

## What survives, precisely (defender's ledger)
- **A:** upgrade from "weakened" toward **"stands (operational-scope)."** The MTT attack self-undercuts (its own cited paper rejects MTT's storage claim); Brady refutes only the strawman "gist-only," not A's literal form. Honest caveat kept: "never raw" is operational, not ontological.
- **B:** verdict fair — **contested convergence, sound engineering doctrine.** No over-defense.
- **C:** core design corollary **survives Nairne intact**; only the pre-conceded strong causal form falls. Morris-fragility attack stays flagged as uncited.
- **D:** absolutes correctly fall; disanalogy survives **as degree/engineering-maturity**, and coexists with A/C convergence under functional-vs-mechanistic framing (no fatal contradiction).

No new fabricated or misattributed citations found in this record. The gate's prior fabrication flags remain intact and uncontaminated.

Source record: `/tmp/claude-1000/-home-ryan-repos-Personal-baumy-brain/ea3a6d1f-a733-4d87-8107-38a8a03a6300/scratchpad/research/pass1-T2-encoding.md`

