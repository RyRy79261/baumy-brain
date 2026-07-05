# T4-traversal — Pass-2 Fable verification

**Gate status:** pass-with-fixes

## Verified claim checks
- **[confirmed]** Claim A: spreading activation = PPR = Hopfield completion; attention IS one-step Hopfield retrieval, exactly — adjudicated weakened-but-stands (medium)
    - adjudicated: weakened-but-stands (confidence: medium)
    - note: Verdict and level stand: the review's downgrade-to-'does-not-stand' ignores that the enrichment flags already confine the surviving content (that is what weakened-but-stands means), and the defense's upgrade to medium-high overshoots because the 'independence' and 'three regimes' pillars remain broken; Pass 3 must state the reduced form explicitly and cite Millidge et al. ICML 2022 (verified) on Open Question A.
- **[too-harsh]** Review sub-claim: Claim A as worded should be rated 'does-not-stand; only a weaker sub-claim survives'
    - adjudicated: rejected — medium weakened-but-stands retained
    - note: The verified Millidge similarity/separation/projection framework (ICML 2022) restores hetero-associative one-step attention as canonical content-addressable associative memory, and the Ramsauer one-update-with-exponentially-small-error theorem contradicts the 'one non-settling step ≈ soft lookup' attack in the well-separated regime, so more than the bare K=V identity survives.
- **[too-generous]** Defense sub-claim: Claim A confidence should be raised medium → medium-high for the reduced form
    - adjudicated: rejected — stays medium
    - note: The gate adjudicates the claim as written, whose 'three INDEPENDENT formalisms' and 'three regimes' pillars are conceded broken, and the unrebutted generic-diffusion base-rate objection (review finding 4) exerts real downward pressure the adjudication never absorbed.
- **[confirmed]** Review sub-claim: the generic-diffusion base-rate objection (diffusion/energy-descent describes heat flow, epidemics, Markov chains, original PageRank — near-zero discriminating power) was silently dropped by the adjudicator
    - adjudicated: landed and unaddressed — must be folded into Claim A in Pass 3
    - note: The Pass-1 record flags three other red-team meta-moves but never rebuts or credits meta-point 1; it is distinct from the 'three regimes is numerology' flag and directly undercuts the 'deep, not lexical' defense.
- **[confirmed]** Claim B: retrieval is cue-dependent, not strength-absolute (Tulving 1966/1973 → BEIR bridge) — adjudicated survives (high)
    - adjudicated: survives (confidence: high)
    - note: Both review and defense endorse; the review's frequency-dependence finding on Tulving–Wiseman further supports the existing contested-invariant flag, and the 'Tulving predicts, BEIR measures' overstated-enrichment flag correctly stays.
- **[error-found]** Claim C: hybrid fusion with graph-wins-multi-hop / flat-wins-single-fact complementarity — adjudicated weakened-but-stands (medium)
    - adjudicated: weakened-but-stands (confidence: medium)
    - note: Verdict level is right but the imported grounding contains two verified defects — the LLM-judge/knowledge-leaking attack is anchored to misattributed arXiv 2507.03226, and the '5–10 F1' figure is a fake quotation — and the reasoning wrongly lumps hard-metric multi-hop (recall/F1/EM on MuSiQue/2Wiki/HotpotQA) with LLM-judge global sensemaking; re-source, split the halves, and add the passage-integration qualifier.
- **[error-found]** Red-team sub-claim inside C: HippoRAG 2 states structure-based methods 'generally reduce performance on simple QA by 5–10 F1' (presented as a quotation)
    - adjudicated: unverifiable quoted statistic — direction true, number fabricated
    - note: Verified against arXiv 2502.14802: the paper says only 'drops considerably below standard RAG' with heterogeneous per-system gaps (some larger than the band); the qualitative regression and the RAPTOR-lumped-as-structure-based point both remain true.
- **[error-found]** Red-team sub-claim inside C: the 'graph wins global' evidence is confounded by LLM-as-judge knowledge leaking and verbosity bias (cited to arXiv 2507.03226)
    - adjudicated: substance partially survives under corrected citation; citation as given is wrong
    - note: 2507.03226 is a pro-GraphRAG engineering paper (verified); arXiv 2502.11371 verifiably supports LLM-judge position bias and community-GraphRAG losing to standard RAG on ground-truth metrics, but does NOT discuss knowledge leaking — that rider must be independently sourced or dropped.
- **[confirmed]** Defense sub-claim: 'fixable plumbing artifact ⇒ dissolves complementarity' over-reaches because HippoRAG 2's fix is passage-arm hybridization, relocating complementarity to component level
    - adjudicated: accepted as a qualifier for Pass 3
    - note: Verified from the 2502.14802 abstract ('deeper passage integration and more effective online use of an LLM') — the regression is closed by integrating the flat/dense arm, not by making graph traversal good at single facts.
- **[confirmed]** Claim D: 'flat RAG structurally cannot do global' is overstated (RAPTOR counterexample); hierarchy-vs-topology unresolved — adjudicated survives (high)
    - adjudicated: survives (confidence: high)
    - note: Both sides endorse; the existing strawman flags (B-tree absorption, symmetric underdetermination) stand, and Millidge's similarity-vs-pointer-dereference criterion gives Pass 3 a non-gerrymandered test for the completion-vs-addressing crux.

## Citation issues
- arXiv 2507.03226 — 'Towards Practical GraphRAG: Efficient Knowledge Graph Construction and Hybrid Retrieval at Scale' (Min et al.): Misattributed by the red team as a 'practical-GraphRAG evaluation critique' supporting knowledge-leaking/verbosity-bias claims; verified to be a pro-GraphRAG engineering/cost paper that uses LLM-as-judge itself and contains no such critique. Replace with arXiv 2502.11371 (verified: LLM-judge position bias + community-GraphRAG underperforming standard RAG on ground-truth metrics) — noting 2502.11371 does not cover knowledge leaking.
- arXiv 2502.14802 — 'From RAG to Memory' (HippoRAG 2, ICML 2025): The red team's quoted statistic 'generally reduce performance on simple QA by 5–10 F1' does not appear in the paper; the paper is qualitative ('drops considerably below standard RAG') and actual per-system gaps are heterogeneous, some exceeding the band. A paraphrase with invented precision was passed off as a quotation. Venue and qualitative claim are otherwise correct.
- quicktakes.io (Collins & Loftus unfalsifiability critique) and hugocisneros.com (one-step dynamics attack): Tertiary/content-farm and personal-blog sources used as load-bearing grounding for red-team attacks A(v) and A(ii); the underlying critiques have real academic ancestry but must be re-sourced to primary literature or downweighted.
- arXiv 2309.12673 — 'On Sparse Modern Hopfield Model' (Hu et al., NeurIPS 2023): Minor sourcing softness: the paper is real and correctly cited by venue, but the specific 'spurious metastable states under correlated patterns' statement attributed to it could not be confirmed from the abstract; the property is a classic Hopfield result and should be cited to the classical literature or verified in the paper body.

## Under-credited strengths
- Claim C's multi-hop half rests on hard metrics (recall@k/F1/EM on MuSiQue, 2WikiMultiHopQA, HotpotQA), not LLM-as-judge — the measurement-artifact attack only reaches the global-sensemaking half, so 'graph wins multi-hop' is stronger than the Pass-1 attack text implies.
- Ramsauer's verified headline is one-update retrieval with exponentially small error, so the 'one non-settling step ≈ soft lookup' attack partially contradicts its own citation; the genuine limitation is pattern separation, and attacks (ii) and (iii) double-count it.
- Millidge et al., Universal Hopfield Networks (ICML 2022, PMLR v162 — verified real) supplies a field-established similarity/separation/projection taxonomy under which hetero-associative single-step attention is content-addressable associative memory, substantially answering Open Question A and giving Claim D a principled completion-vs-addressing test.
- The steelman's citation hygiene is clean end-to-end: every steelman citation verified to a primary venue; the only citation defects found anywhere in the record are the red team's.
- Prior fabrication quarantine held: KGGen/Titans 'NeurIPS 2025', AlphaEdit 'Outstanding Paper', and Mem0/Zep DMR self-reported numbers stay flagged and appear nowhere as load-bearing — confirmed by both adversaries and by inspection.

## Must fix before Pass 3
- Swap arXiv 2507.03226 → arXiv 2502.11371 everywhere the LLM-judge attack on Claim C is grounded (Claim C strongest-attack text, Claim C open question, fresh open-questions list); drop or independently source the 'knowledge leaking' rider, which 2502.11371 verifiably does not cover (it covers position bias and ground-truth underperformance).
- Replace the fake-quoted '5–10 F1' with HippoRAG 2's actual qualitative wording ('drops considerably below standard RAG'), noting heterogeneous magnitudes (RAPTOR ~11 pts NQ, GraphRAG ~15, LightRAG catastrophic, PopQA near parity).
- Repartition Claim C's reasoning: multi-hop (hard-metric, stronger than credited) vs. global sensemaking (LLM-judge-scored, weaker — 2502.11371 shows community-GraphRAG losing to standard RAG on ground-truth metrics); add the 'fix = passage-arm hybridization ⇒ complementarity survives at component level' qualifier. Verdict/confidence unchanged.
- Restate Claim A explicitly in its reduced form ('attention is one step of content-addressable associative retrieval; exactness rider confined to K=V; independence claim limited to the Hopfield↔attention identity'), cite Millidge et al. ICML 2022 to update Open Question A, de-duplicate the one-step and pattern-separation attacks, and fold in the previously unaddressed generic-diffusion base-rate objection as a standing limitation.
- Re-source or downweight the quicktakes.io- and blog-grounded attacks (spreading-activation unfalsifiability; one-step dynamics) to primary academic literature; verify or re-cite the spurious-metastable-states attribution currently pinned to arXiv 2309.12673.

---

## Adversarial review (attack)

I read the full Pass-1 record at `/tmp/claude-1000/-home-ryan-repos-Personal-baumy-brain/ea3a6d1f-a733-4d87-8107-38a8a03a6300/scratchpad/research/pass1-T4-traversal.md`. I verified every load-bearing citation against primary venues. Here is my attack on the adjudication.

---

## PRIMARY FINDING — a misattributed citation the adjudicator MISSED (and then amplified)

**arXiv 2507.03226 does not say what the red team (and the adjudicator) claim it says.** The red team grounds its entire Claim-C(iii) "measurement artifact" attack on it: *"the multi-hop/sensemaking gains … are largely scored by LLM-as-judge on subjective axes … confounded by knowledge leaking ([practical-GraphRAG evaluation critique, arXiv 2507.03226])."*

The actual paper at 2507.03226 is **"Towards Practical GraphRAG: Efficient Knowledge Graph Construction and Hybrid Retrieval at Scale"** (Min, Bansal, Pan, Keshavarzi, Mathew, Kannan). It is an **engineering/cost-reduction paper** that *proposes* cheap KG construction and *uses* LLM-as-judge for its own evaluation. It does **not** critique GraphRAG evaluation methodology, LLM-as-judge reliability, knowledge leaking, or verbosity bias — the exact things it is cited for. This is a citation attached to a claim it does not support.

Why this matters for the adjudication: the adjudicator did not merely let it pass — it **promoted** the unsupported attack into three places: Claim C's "Strongest attack" (*"rests disproportionately on LLM-as-judge … prompt-sensitive and exposed to knowledge-leaking and verbosity bias"*), Claim C's open question, and the fresh open-questions list. The knowledge-leaking/verbosity-bias concern is a *real* phenomenon in the LLM-judge literature, so the adjudicator had no reason to doubt it — but the **one source anchoring it is misattributed**, so the attack is weaker than its "medium/weakened-but-stands" framing implies. This is the clearest thing the gate should send back: re-source or drop the LLM-judge attack.

## SECOND FINDING — a quoted statistic that is not in the source (adjudicator marked it "verified")

The red team writes: structure-based methods *"'generally reduce performance on simple QA by 5–10 F1' ([From RAG to Memory, arXiv 2502.14802])"* — presented in quotation marks as a paper statement, and the adjudicator's Claim-C attack repeats *"HippoRAG 2 … 5–10 F1"* and calls the concession "verified."

I fetched the paper (arXiv 2502.14802 / PMLR 267:21497–21515, ICML 2025 — venue itself **confirmed correct**). It states the regression only **qualitatively** ("performance on more basic factual memory tasks drops considerably below standard RAG"). No "5–10 F1" range appears in the abstract or the checked body. And the paper's own Table 2 gap (RAPTOR 50.7 vs. HippoRAG 2 63.3 F1 on NQ ≈ 12.6) is *larger* than the cited band. So the **direction is verified but the quoted number is unverifiable** — quantified precision dressed as a quotation. The adjudicator should have flagged the number, not blessed it. (The qualitative claim, and the fact that the paper lumps **RAPTOR — a tree, no graph — in with "structure-augmented" methods**, are both confirmed true, so that part of the reasoning stands.)

## THIRD FINDING — Claim A's verdict is mis-labeled (too generous *as worded*)

The adjudicator concedes, in its own flags, that **both** pillars of A's "deepest convergence" are broken: (a) "attention IS one-step Hopfield — exact" holds only for K=V, which real transformers violate; (b) HippoRAG's PPR-as-activation is instantiation-by-design, not independent corroboration (circular); (c) "three fields, three regimes, same structure" is numerology (no mechanism-preserving derivation). After removing all three, what "stands" is **only the bare algebraic identity under a special case** — which is a far narrower proposition than Claim A's actual text ("three INDEPENDENT formalisms describe … *exactly* the same operation"). The red team's own bottom line says A is "the weakest structural claim, not the strongest." Rating the claim-*as-written* "weakened-but-stands (medium)" attaches the verdict to a steelmanned residue, not to the sentence being adjudicated. This is a labeling generosity: the honest verdict for Claim A *as stated* is closer to "does-not-stand; a much weaker sub-claim survives."

## FOURTH — a landed attack the adjudicator neither credited nor flagged

Red-team meta-point 1 (diffusion/energy-descent is generic — it equally describes heat flow, epidemics, Markov chains, the *original non-cognitive* PageRank; huge base rate, near-zero discriminating power) is a legitimate, unrebutted base-rate objection that directly undercuts A's "deep, not lexical" defense. The adjudicator flagged three *other* red-team moves as strawman/overstated but left this one entirely unaddressed — neither rebutted nor folded into A's confidence. Given it survives, A's "medium" is again on the generous side.

## Calibration checks that came out CLEAN (adjudicator got these right)

- **Claim B contested-ness is if anything understated, not overstated.** My search on Tulving–Wiseman (DOI 10.3758/BF03333153, real, 1975) surfaced that the recognition-failure relation is **frequency-dependent** (holds for high-frequency, fails for low-frequency words) — *additional* grounds for the "contested statistical invariant" reading the adjudicator already flagged. The Claim-B flag is well-calibrated.
- **Prior-pass fabrications stay out.** No KGGen/Titans "NeurIPS 2025," no AlphaEdit "Outstanding Paper," and Mem0/Zep/DMR are explicitly quarantined as unverified vendor numbers in the steelman. None reappear as load-bearing. Confirmed clean.
- **Verified-real citations:** Ramsauer ICLR 2021 (arXiv 2008.02217); RAPTOR ICLR 2024 (Sarthi, Abdullah, Tuli, Khanna, Goldie, Manning — "authors incl. Manning, Goldie" is correct); HippoRAG NeurIPS 2024 (arXiv 2405.14831); HippoRAG 2 ICML 2025 / PMLR 267:21497–21515; "On Sparse Modern Hopfield Model" (Hu et al., NeurIPS 2023, arXiv 2309.12673 — real, though I could not confirm from the abstract that *this specific paper* states the "spurious metastable states under correlated patterns" claim the red team attributes to it; the property is a classic true Hopfield result, so this is a minor sourcing softness, not a fabrication). Collins & Loftus 1975, Tulving & Pearlstone 1966, Tulving & Thomson 1973, Cormack RRF SIGIR 2009 are all standard, correctly cited.

## Verdict for the gate

Two defects should block a clean pass until fixed: **(1)** the LLM-as-judge/knowledge-leaking attack on Claim C is anchored to a **misattributed source (arXiv 2507.03226)** and must be re-sourced or dropped; **(2)** the **"5–10 F1" figure is an unverifiable quoted statistic** — downgrade to the paper's actual qualitative wording. Two calibration corrections recommended: Claim A's verdict is generous *as worded* (the surviving content is only the special-case identity, not "three independent formalisms = exactly the same"), and the generic-diffusion base-rate objection is a landed attack the adjudication silently dropped. Claim B and Claim D adjudications are sound.

---

## Adversarial respect (defend)

# FABLE-5 DEFENDER GATE — T4-traversal (Retrieval is associative traversal/completion)

Record read in full at `/tmp/claude-1000/-home-ryan-repos-Personal-baumy-brain/ea3a6d1f-a733-4d87-8107-38a8a03a6300/scratchpad/research/pass1-T4-traversal.md`. Web verification performed. Findings below.

## 1. CITATION AUDIT — new problems found (in the RED TEAM's grounding, not the steelman's)

**NEW FLAG (misattribution): arXiv 2507.03226 is not what the red team says it is.** The red team grounds its Claim-C measurement-artifact attack in "practical-GraphRAG evaluation critique, arXiv 2507.03226." Fetched: that paper is *"Towards Practical GraphRAG: Efficient Knowledge Graph Construction and Hybrid Retrieval at Scale"* (Min et al.) — a pro-GraphRAG engineering paper that **uses** LLM-as-judge as its own metric and contains no critique of knowledge leaking or verbosity bias. The critique the red team describes does exist in the literature — it matches **arXiv 2502.11371, "RAG vs. GraphRAG: A Systematic Evaluation and Key Insights"** (knowledge leaking, LLM-judge position bias, community-GraphRAG underperforming standard RAG on ground-truth metrics). Attack substance survives under the corrected citation; the citation as given is wrong and must be swapped before the next pass.

**NEW FLAG (unverifiable quotation): the red team's "generally reduce performance on simple QA by 5–10 F1," presented in quotation marks as HippoRAG 2's words.** I searched two HTML versions of arXiv 2502.14802; no such sentence found. What the paper actually says: "all previous structure-augmented methods underperform against the strongest embedding-based RAG methods available on all three benchmark types," and Table 2 shows **heterogeneous** drops — RAPTOR ~11 pts on NQ but roughly at parity on PopQA; GraphRAG ~15 pts on NQ; LightRAG catastrophic (6.6 avg F1 vs 57.0). The qualitative point survives (drops are real, some larger than 5–10), but a paraphrase was passed off as a quote and the uniform "5–10" figure is not the paper's. Flag it.

**NEW FLAG (low-grade grounding):** the red team's "Collins & Loftus is unfalsifiable" attack (A-v) is cited to **quicktakes.io**, a study-notes content farm, and the one-step-dynamics attack partially to a personal blog (hugocisneros.com). The unfalsifiability critique has genuine academic ancestry, but as grounded in Pass 1 it is tertiary-source hearsay and should carry less adjudicative weight than it apparently did.

**Verified good (all confirmed against primary venues/abstracts):** Ramsauer et al. ICLR 2021 (arXiv 2008.02217 — abstract confirms one-update retrieval, exponentially small error, exponential capacity, attention equivalence); HippoRAG NeurIPS 2024 (2405.14831); HippoRAG 2 ICML 2025 (2502.14802); RAPTOR ICLR 2024; GraphRAG (2404.16130); Cormack et al. SIGIR 2009; Tulving & Pearlstone 1966; Tulving & Thomson 1973; Collins & Loftus 1975; BEIR (Thakur et al. 2021); Sparse Modern Hopfield (2309.12673). The Tulving–Wiseman controversy is **real** (Hintzman 1991/1992 mathematical-constraint critique; itself contested, e.g. Memory & Cognition 3758/BF03211390).

**Prior flags confirmed held:** KGGen/Titans "NeurIPS 2025," AlphaEdit "Outstanding Paper," and Mem0/Zep-DMR self-reported numbers appear nowhere as load-bearing in this record; the steelman explicitly quarantines them (line 88, 111). No new fabrication found in the **steelman's** citation set — the only citation defects found in this pass are the red team's.

## 2. WHERE THE ADJUDICATION WAS TOO HARSH

### Claim A (weakened-but-stands, medium) — the two central attacks are weaker than the verdict credits; the reduced form deserves medium-high.

- **The "one non-settling step ≈ soft lookup" attack contradicts the theorem it cites.** Ramsauer's abstract-level result (verified) is precisely that **one update retrieves the pattern with exponentially small error** — i.e., in the well-separated regime, the single step lands (approximately) *on the attractor*. One-step-ness is not evidence against completion; it is the paper's headline that completion needs only one step. The genuine limitation is pattern separation (attack iii). Attacks (ii) and (iii) are **the same limitation counted twice**, and the adjudicated "strongest attack" text absorbed the double-count.
- **The K≠V attack conflates "auto-associative" with "associative."** Hetero-association is canonical associative memory (Willshaw 1969 non-holographic memory; Kosko's BAM; linear associators), and — decisively — **Millidge et al., "Universal Hopfield Networks," ICML 2022 (PMLR v162:15561–15583, arXiv 2202.04557; verified)** gives the general framework (similarity → separation → **projection**) under which attention *with separate value projection* is derived as a single-shot associative memory instance. This **answers the adjudicator's Open Question A from verified literature: yes** — hetero-associative one-step attention is content-addressable retrieval by the field's own established taxonomy, without any dilution of "content-addressable vs location-addressable" (a real distinction: CAM vs RAM; it still excludes B-trees). The "exact identity" rider stays correctly confined to K=V — concede that — but the downgrade pressure on the *claim* from K≠V was over-weighted.
- **Concede fully:** "three INDEPENDENT formalisms" (HippoRAG is importation-by-design; only Hopfield↔attention is post-hoc convergence) and "three regimes, three fields" (cardinality-matching without a mechanism-preserving map). These attacks land and the enrichment flags should stand verbatim.

### Claim C (weakened-but-stands, medium) — verdict level is right, but two pieces of the internal reasoning over-reach; the claim's multi-hop half is under-credited.

- **The verdict lumps multi-hop with global.** HippoRAG's multi-hop gains are measured with **hard metrics** (recall@k / F1 / EM on MuSiQue, 2WikiMultiHopQA, HotpotQA), not LLM-as-judge. The LLM-judge/knowledge-leaking critique applies only to the **global-sensemaking** half (GraphRAG's comprehensiveness/diversity win-rates). The adjudicated open question ("does the graph wins global/multi-hop advantage survive hard metrics") is already half-answered: the multi-hop half **is** hard-metric. The corrected critique citation (2502.11371) simultaneously *strengthens* doubt on the global half (community-GraphRAG loses to standard RAG on ground truth) — so the right repartition is: "graph wins multi-hop" stronger than credited; "graph wins global" weaker. Net verdict unchanged, reasoning corrected.
- **"Fixable plumbing artifact ⇒ dissolves complementarity" over-reaches, given HOW HippoRAG 2 fixes it.** Verified abstract: the fix is "**deeper passage integration** and more effective online use of an LLM" — i.e., the single-fact regression is closed by **hybridizing the flat/dense passage arm into the graph system**, not by making graph traversal good at single facts. That relocates the complementarity from system level to component level; it does not dissolve it. The adjudicator adopted the red team's reading without this qualifier.
- **Concede fully:** the RAPTOR-lumped-as-"structure-based" point (verified — HippoRAG 2 does group RAPTOR with graph methods, so the evidence never isolates graph-ness) and the RRF-durability-as-survivorship point both land.

### Claim B (survives, high) — verdict correct; one under-credit worth recording.
The red team demanded a "mechanism-level" link for the Tulving→BEIR bridge, but the claim works at the **computational level**: retrievability is a function of cue×representation match, not of trace strength alone — a lawful shared abstraction both systems instantiate, not a pure mnemonic. Concede that "Tulving *predicts*, BEIR *measures*" is too strong as phrased and that the recognition-failure rider is genuinely contested (Hintzman verified real). The enrichment flag stands; the adjudicated open question stands.

### Claim D (survives, high) — verdict correct; uphold the existing strawman flags.
The adjudicator already caught the red team's over-reaches here (B-tree absorption jab; "hierarchy is the active ingredient" symmetric-underdetermination correction). Both flags are right and should carry forward unchanged. The genuinely unresolved crux — is coarse-to-fine summary-tree routing "completion" or "addressing" — is real; note that the Millidge similarity/separation/projection framework gives the next pass a **non-gerrymandered test**: similarity-driven selection = content-addressable; key/pointer dereference = location-addressable.

## 3. RECOMMENDED ADJUSTMENTS FOR NEXT PASS

1. Claim A: keep "weakened-but-stands," raise confidence medium → **medium-high** for the reduced form ("attention is one step of content-addressable associative retrieval; exactness rider confined to K=V"); mark Open Question A **answered** (Millidge et al. ICML 2022, verified).
2. Claim C: keep verdict/confidence; **split multi-hop (hard-metric, stronger) from global (LLM-judge, weaker)**; replace citation 2507.03226 → **2502.11371**; add the "fix = passage-integration ⇒ component-level complementarity survives" qualifier.
3. Claims B, D: no change.
4. Add three red-team citation flags: 2507.03226 misattributed; "5–10 F1" fake-quoted; quicktakes.io/blog used as load-bearing grounding.
5. Prior fabrication flags (KGGen/Titans NeurIPS-2025, AlphaEdit award, Mem0/Zep DMR): **confirmed still flagged, still excluded from load-bearing use.**

Sources: [arXiv 2507.03226](https://arxiv.org/abs/2507.03226), [arXiv 2502.14802](https://arxiv.org/abs/2502.14802), [HippoRAG 2 HTML](https://arxiv.org/html/2502.14802v2), [arXiv 2008.02217](https://arxiv.org/abs/2008.02217), [RAG vs. GraphRAG (2502.11371)](https://arxiv.org/html/2502.11371v2), [Universal Hopfield Networks, PMLR v162](https://proceedings.mlr.press/v162/millidge22a.html), [arXiv 2202.04557](https://arxiv.org/abs/2202.04557), [Tulving–Wiseman rejection, Memory & Cognition](https://link.springer.com/article/10.3758/BF03211390), [Ärlemalm 1992, Scand. J. Psychol.](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-9450.1992.tb00915.x)

