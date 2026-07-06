# Process Fixes for the Baumy `docs/research/` 5-Pass Program

Fixes are keyed to the adjudicated anti-pattern numbers (#1–#19). Ordered: cheap high-value first, then structural, then honestly un-fixable. A recurring theme: the repo already contains the two cheapest sources of genuine independence the program never used — **a working retrieval pipeline with offline test infra** (`lib/memory/`, `lib/memory/__tests__/pglite.ts`, `db/__tests__/`) and **web search/fetch tools** that pull out-of-distribution text into context.

---

## Tier 1 — Cheap, high-value: do before any reuse of the corpus

**F1. Run the never-executed engineering/security/IR lens (#13).** Execute the already-specified "sixth re-deriver": latency, index cost, injection surface, secret-handling, exactness-vs-gist tradeoffs — the axis the incumbent was actually chosen on. Feed it the security invariants from `AGENTS.md` (injection wall, trust tiers, fixed send destination) as its rubric, since those are the real product constraints the "human-like companion" objective (#6) displaced. **Cost: cheap** (one pass, spec exists in 04b). **Priority: critical** — it is the corpus's own named largest gap and the single most decision-relevant unrun test.

**F2. Ground at least one claim in observational/product data (#3).** Three escalating options, cheapest first: (a) **ablation runs on the real code** — the suite already runs offline (PGlite + `embedSync`); build a small gold set of house-style Q&A and measure hit-rate for RRF vs semantic-only vs lexical-only vs deep-tier-off. This directly tests the corpus's central "hybrid retrieval" claims against the actual system. (b) **Actually execute LoCoMo/LongMemEval** — cited, never run. (c) **Mine production logs**: which recall queries Baumy answered/failed in the live house group. Even one of these converts the program from theory-vs-theory to theory-vs-world for at least one load-bearing claim. **Cost: cheap (a), moderate (b/c).** **Priority: critical.**

**F3. Preregister before every future pass (#2).** Before a pass runs: freeze and git-commit the framework list, rubric, enum schema, scoring criteria, and success/failure conditions in a file authored by a **fresh session with no access to prior pass outputs**. The commit hash is the preregistration receipt; deviations require a logged amendment. This kills the forking-paths defect at near-zero cost. **Cost: cheap.** **Priority: critical.**

**F4. Fix the labels and fence the layers (#3, #4, #6, #16).** Edit `README.md` and `refined-baseline.md` now: (a) delete/replace "empirical bedrock … carried by data" with "theory-vs-theory synthesis, zero empirical contact"; (b) move the double-convergence claim behind its own deflating caveat instead of ahead of it; (c) hard-fence the portable descriptive map (refined-baseline §I/II) from the non-portable prescriptive essay (04 §IV) with an explicit "do not lift into fidelity-critical subsystems" banner; (d) state that the "human-like companion" objective is **not** Baumy's objective. This is pure editing of existing files. **Cost: cheap.** **Priority: critical** — it's the mislabeling, not the content, that makes the corpus dangerous to inherit.

**F5. Separate generator / checker / judge procedurally (#7, #10).** Different sessions, zero shared context; the checker receives claims **stripped of rhetorical framing and provenance** (blinding by transformation — it must not know which thesis is the incumbent or who wrote it); the judge sees both sides symmetrically. This does not fix prior correlation (see U1) but it removes **context contamination**, which is a separate, fully fixable correlation source — much of the observed agreement is plausibly sycophancy-to-visible-framing, not shared priors. **Cost: cheap.** **Priority: high.**

**F6. Calibrate the citation checker with known-fake injection (#7).** Seed each verification pass with N planted errors (fabricated authors, inverted findings, inflated magnitudes) and report recall on the plants. Turns "caught ~11 errors" from an uninterpretable floor into a calibrated detection rate. Also: every load-bearing citation must be verified against a **fetched source** (WebFetch), not parametric memory. **Cost: cheap.** **Priority: high.**

**F7. Null-model calibration for forced-choice scoring (#5, #9, #11).** Before trusting any enum rubric: (a) run it on a deliberately bad alternative and on two near-identical variants — if it can't separate those, the rubric is broken; (b) run each judgment k=5 times with permuted option order and report the distribution, not a single integer; (c) for advocacy designs, pre-state the tautological null ("all 14 champions will self-report under-weighting") and report only deviations from it. Replaces pseudo-quantification with cheap variance estimates. **Cost: cheap.** **Priority: high.**

**F8. Closure receipts and a terminal reconciliation pass (#15, #17).** (a) Every gate's MUST-FIX list gets a committed checklist mapping each item to the diff that fixed it, **before** the next pass consumes the corpus. (b) Add a mandatory final pass whose only job is folding the terminal critic's findings (currently 04b, orphaned) back into README/refined-baseline headlines. A program must not end on an un-actioned critique. **Cost: cheap.** **Priority: high.**

**F9. Commit the pipeline (#18).** Prompts, orchestration scripts, seeds, model IDs, and pass ordering go in the repo alongside outputs. Process-level reproducibility for free. **Cost: cheap.** **Priority: medium.**

**F10. Dedupe convergence counting (#12).** Before claiming N-way convergence, a fresh-context session clusters the re-derivations by semantic distinctness and the headline counts **clusters, not items** (04b already did this recount — 3 genuine + 1 additive + 6 restatements; the fix is making it the reported number). **Cost: cheap.** **Priority: medium.**

---

## Tier 2 — Structural / moderate cost

**F11. Real search protocol for landscape passes (#8, #19).** Replace parametric recall with actual retrieval: logged WebSearch queries, explicit inclusion/exclusion criteria, PRISMA-lite accounting of what was screened vs kept. Add targeted searches for the known holes (non-Western/cross-cultural memory literature, grey literature, the residual-list frameworks 03b/04b named). This is also a genuine partial independence gain: retrieved text enters context **out-of-distribution** — the model interprets it but did not author it. **Cost: moderate.** **Priority: high.**

**F12. One human adjudication choke point (#1, partial).** Ryan (or any human) rules on the top ~10 contested claims at a single point — ideally the Pass-4 incumbent-vs-alternatives verdict. This is the only genuinely out-of-distribution reviewer available at zero dollar cost. Per the adjudication's own meta-closure, the first thing that human should check is whether the monoculture consensus is itself a monoculture artifact. **Cost: cheap in tokens, moderate in human time.** **Priority: critical** — it is the cheapest possible break in the closed loop.

**F13. Register falsifiable predictions against the live product (#3, #4).** Derive 3–5 concrete predictions from the corpus about Baumy's production behavior (e.g., "gist-style queries will fail at ≥X rate under the current verbatim-biased pipeline"; "deep-tier expansion changes the answer on Y% of house queries"), commit them, and check against logs/eval after 30 days. This is the only mechanism that lets the corpus's theses ever be **wrong**, which is the property a reusable base most needs. **Cost: moderate.** **Priority: high.**

**F14. Rebuild the scaffold vocabulary neutrally (#14).** A fresh session, given only the neutrality requirement and none of the T1–T8 text, re-titles the theorem/question scaffold in theory-neutral terms; rivals must be expressible as first-class positions, not attacks on a default. Do this **before** the corpus is reused as a base, since ontology is a base's most-inherited property. **Cost: moderate.** **Priority: medium-high.**

**F15. Cross-vendor spot-check where the constraint permits (#1).** If the Anthropic-only rule is program policy rather than physics: a single non-Claude model red-teaming only the top-5 claims would be the highest-information tokens in the program. If it is absolute, say so in the disclosure (see U1) — and note that F2/F11/F12 are the substitutes. **Cost: cheap–moderate.** **Priority: high if permitted; otherwise convert to disclosure.**

---

## Un-fixable within the one-model-family constraint — disclose, don't pretend to fix

**U1. Distributional independence of judgment (#1, #4).** No arrangement of Claude instances — different prompts, personas, roles, temperatures, sessions, or model tiers (Haiku/Sonnet/Opus share training lineage) — produces independent draws. Disagreement is capped at the distribution's self-disagreement; agreement is the null expectation. **Every headline that reports convergence must carry, in the same sentence, the qualifier that N-agent agreement is evidence of one distribution's internal consistency, not of correspondence to reality.** Role separation (F5) fixes context contamination only; it must never be marketed as independence.

**U2. Uncalibratable false-negative rate on interpretive claims (#5, #7, #10).** Known-fake injection (F6) calibrates recall on **checkable facts** only. For interpretive judgments — "survives," "robust," "better on objective," "zero theses overturned" — a same-distribution checker's blind spots are shared with the generator by construction and cannot be measured from inside. Disclose: interpretive verdicts in this corpus have an unknown, unbounded miss rate; only F12 (human) or F13 (world) can bound it.

**U3. Recursive self-audit inflation.** Any future within-family audit of this program — including the 8-lens panel and its adjudication — inherits the same discount; "8/8 consensus" is eight correlated draws. Disclose that audit consensus is itself within-distribution, and (per the adjudicator) privilege audit findings whose evidence is **structural and checkable** (e.g., the provenance line: every agent is one vendor) over findings that are interpretive.

**U4. Prior-shaped framing even under preregistration (#2, residual).** F3 stops post-hoc tuning, but a preregistered frame is still authored from one distribution's priors — it freezes the garden, it doesn't diversify the seeds. Disclose: preregistration converts "tuned to the findings" into "one distribution's honest ex-ante guess," no further.

**The honest one-paragraph disclosure to ship with the corpus:** all generation, checking, and judging in this program came from a single model family; its agreements measure internal consistency; its interpretive verdicts have an unmeasurable error rate; the only escapes used/available are (a) external data entering context (benchmarks, product logs, fetched sources — F2/F11/F13), (b) verification of externally checkable facts, which demonstrably works, and (c) human spot-adjudication (F12). Claims not anchored by (a)–(c) are hypotheses, and the corpus is a **hypothesis map**, not an empirical base.

---

## Priority order if resources force a cut

1. **F4** (relabel/fence — cheap, removes the active hazard today)
2. **F1** (run the sixth lens — the decisive unrun test)
3. **F2a** (ablation on the real pipeline — first contact with reality, nearly free given existing test infra)
4. **F12** (one human choke point — cheapest loop-break)
5. **F3 + F5** (preregistration + role separation — makes every *future* pass trustworthy)
6. **U1–U4 disclosure block** (zero cost, mandatory regardless)

Everything else improves the program; these six change whether the corpus is safe to inherit.
