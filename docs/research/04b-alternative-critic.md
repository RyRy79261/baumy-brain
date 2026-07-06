## (1) Genuinely ALTERNATIVE vs RELABELING

**Genuinely alternative (change what is stored or when abstraction happens):**
- **Instance/global-matching (#7)** — the cleanest real inversion: abstraction at read-time vs the incumbent's write-time `extractFacts`/`reconcileFact`. Different data structure, different failure modes.
- **Rate-distortion (#2)** — a different objective function (relationship-specific distortion metric, surprise-gated retention) rather than a different gloss on the same store.
- **Social-transactive (#1) / communicative-relevance (#9)** — change the *unit* (dyad, addressee-at-encoding) and add stores that don't exist (who-knows-what, destination memory). Alternative, though #1 is really an *additive* subsystem, not a competing ontology.

**Substantially RELABELING:**
- **Predictive-processing (#3) and reconstructive-goal (#4)** — their central claim, "recall = in-voice generation conditioned on cue + context," describes what the incumbent *already does*: `retrieve.ts` rows feed Sonnet, which composes an in-voice reply. The "retrieve-rows-then-re-narrate seam" is asserted, never demonstrated. Unless they change what is stored (they mostly don't), they relabel the existing RAG+generation pipeline as "reconstruction."
- **Narrative-SMS (#5)** — bitemporal supersession already stores the arc; "narrate change" is an output policy on the incumbent, and person-indexing is a re-sort of the existing entity graph.
- **Dynamical-attractor (#8)** — the synthesis itself concedes `resolveEntity` + pgvector cosine *are* discrete pattern completion. Vocabulary swap.
- **Global-workspace (#6)** — hedging/metamemory is a prompt-layer surface on stored provenance the incumbent already has. Additive UI, not an alternative frame.
- **Enactive (#10)** — self-declared "corrective lens, not substrate"; shouldn't have been counted as a competing theorem at all.

Net: the "ten theorems" are closer to **3 genuine alternatives + 1 additive subsystem + 6 restatements**, and the reconstruction "family" is one theorem counted five times — which inflates the apparent convergence in §III.

## (2) Still missing — frames and data

- **The sixth re-deriver was hypothesized, never run.** The engineering/IR/latency/security lens is named as the blind spot and then left unexecuted. The convergence claim is untested against the one axis that could break it. This is the largest open gap.
- **Zero observational data on the incumbent.** No Baumy transcripts, no user complaints, no measured "robotic recall" failures. The entire exercise is theory-vs-theory; the premise that the incumbent *sounds* robotic is unevidenced. Also no data on the flip-side risk: LLM confabulation rates when generating "gist-first reconstruction" — the safety-critical unknown for the recommended frame.
- **Fuzzy-trace theory (Brainerd & Reyna)** — invoked twice as a mechanism ("fuzzy-trace verbatim gate," "dual-code prescription") but never fielded as a theorem, though it is *the* canonical verbatim⟂gist dual-store frame and arguably subsumes half the reconstruction family.
- **Schank/Kolodner dynamic memory & case-based reasoning** — the canonical computational account of conversational *reminding* ("that reminds me of…"), MOPs/scripts as retrieval structure. Directly on-objective, entirely absent.
- **ACT-R declarative memory** — Anderson & Schooler is cited 5/5, but its engineering-ready implementation (base-level activation, spreading activation) — the shortest path from "need-probability" to code — is missing.
- **Contextual integrity (Nissenbaum)** — for a *multiparty* house bot, the norms-of-information-flow frame is more apt than dyadic epistemic-rights, and it's the frame that governs "don't tell B what A said in DM."
- **Multiparty group memory generally** — nearly every citation is dyadic; Baumy's setting is a group chat plus DMs. Cluster A gestures at it but no group-conversation memory literature (multiparty grounding, Traum) appears.
- **Quantitative benchmark scoring** — LoCoMo/LongMemEval are cited but no theorem is scored against them; no theorem is given a falsifiable prediction the incumbent fails.

## (3) Evidence-driven or rhetoric?

**Mixed, tilting rhetorical at the top-level claim; evidence-driven in the components.**
- The 5/5 reconstruction convergence is **partially circular**: the objective prompt contains "naturally rather than robotic database lookups," which is the conclusion pre-stated. The synthesis admits this, then proceeds as if the finding survives anyway.
- **All 10/10 theorems scoring "better on fitToObjective" is a scorer-bias red flag**, not a result — an adversarially-generated field where nothing scores worse means the rubric (or the objective wording) embeds the answer.
- The "double convergence" is **weak independence**: both processes are LLMs sampling the same training-distribution canon (the identical citation list across "independent" derivers — CLS 5/5, A&S 5/5 — is as consistent with shared priors as with truth).
- The **concrete additions are evidence-linked** (common-ground ledger ← Clark/Horton & Gerrig; anti-repetition ← Gopie & MacLeod; hedging ← Bjork; gist-over-verbatim ← Cox & Ooi, Stafford & Daly). The **"inversion of primacy" is rhetoric**: no evidence is offered that re-*framing* (vs. adding the components) changes any behavior. "We are upside-down" is an aesthetic claim about diagram topology.
- Credit: §I's caveat and §V's "re-frame and augment, not replace" show the synthesis mostly restrains its own rhetoric at the conclusion. But headline framing ("landed on the *same* organizing frame," "double convergence") oversells relative to the caveats beneath it.

## (4) Drift from the objective?

- **Within its stated objective: mostly held.** Every section circles back to the companion criterion, and the firewall discussion is justified drift (it's load-bearing for feasibility).
- **But the stated objective itself may be the drift.** Per AGENTS.md, Baumy is a *house-management secretary* — explicitly "not a personal assistant," recall-accuracy- and security-first. The exercise's fixed objective ("human-like conversational companion… natural recall") quietly substitutes a companion product for a secretary product. Several conclusions (deliberate decay to gist, gist-over-verbatim, adaptive forgetting) are *anti-features* for a secretary whose job is "what's the wifi password / when is rent due." If the objective substitution was deliberate, say so; if not, half of §IV optimizes the wrong product.
- **Minor scope creep:** Clusters E/F (extended mind, Margalit, Heersmink) are erudite but non-actionable padding; §V drifts from theorem *evaluation* into design *prescription* (the a–f add-list), which was not the deliverable.
- **One consistency slip:** §I calls the common-ground ledger a "clean omission" specific to conversation at 4/5 independence, but §IV promotes it to "the most apt addition of all" — the promotion rests on the group-house setting (the secretary framing), i.e., the synthesis leans on the *incumbent's* objective exactly where it strengthens the alternative, and on the *companion* objective everywhere else. Pick one objective and re-rank.
