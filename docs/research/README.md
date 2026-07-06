# Cognitive-memory research program

A multi-pass, adversarial research effort to establish an honest **cognitive baseline** — what the
science of memory (LLM/agent memory, cognitive psychology, memory neuroscience, knowledge-graph &
retrieval) actually supports — *before* evolving Baumy's memory architecture (a weighted, traversable
knowledge graph that should degrade gracefully over time). This directory is the durable record.

> **Status: research phase, ongoing.** Nothing here is implemented in Baumy, and none of it is a
> design or a decision. It is a *sentiment of the research landscape*, deliberately hedged, adversarially
> stress-tested, and framework-audited. Read it as "what the field can and cannot support," not "what to
> build." Implementation ("phase two") comes only after this stabilizes.

## ⚠️ Methodological status — read before inheriting anything here

A Pass-5 methodology audit ([`05-methodology-review.md`](05-methodology-review.md)) rated this program
**"a durable *hypothesis map*, not a verified base model — recoverable, not yet safe to inherit as-is."**
Four disclosures govern every claim below:

- **U1 — Single-vendor monoculture.** *Every* agent across all passes is one vendor's model (Claude
  Fable 5 / Opus 4.8). "Steelman vs red-team", "independent verification", "blind re-derivation", and
  "N/N converged" are all the **same training distribution re-prompted** — so agreement measures one
  model's internal consistency, **not correspondence to reality**. This is structural and *not fixable*
  within the model-family constraint; it can only be disclosed. **N-agent agreement ≠ field consensus.**
- **U2 — No empirical contact.** No transcripts, benchmark runs, ablations, or falsifiable predictions
  were executed. It is theory-vs-theory throughout. Where the headlines below say "survived every pass",
  read *"survived Claude red-teaming Claude"* — **not** validated against data.
- **U3 — No preregistration.** The topics, the 14 frameworks, the 10 theorems, the schemas, and the
  Pass-4 objective were all authored *after* seeing prior results by one orchestrator (garden of forking
  paths). The frame that decides "what counts as a finding" was tuned to the findings.
- **U4 — Recursive self-audit.** The Pass-5 audit is itself Claude auditing Claude's research; it
  discounts *itself* by the same amount. The only exit it names is **one out-of-distribution reviewer
  (a human, or a non-Claude model) at one choke point** — starting by checking that provenance claim.

Treat this corpus as a **rigorous starting *question* set, not a settled *answer* set.** Verdicts that are
**structural/checkable** (provenance, citation catches) are trustworthy; **interpretive** verdicts
("robust", "better", "bedrock") carry an unbounded, unmeasured miss rate.

## Scope discipline (what the machinery actually is)

- **Adversarial by construction — within one distribution.** Every claim is steelmanned *and* red-teamed
  and re-litigated for bias; this catches internal inconsistency and reliably surfaces overreach, but it
  is *self*-checking, not *independent* verification (see U1). It produced real deflations, not a rubber
  stamp — but it cannot certify correspondence to reality.
- **Citations are checked, not asserted.** Fabricated venues and misattributions were caught and logged
  (see the gate ruling) — the *one* place monoculture doesn't bite, since facts are checked against
  external sources. The caught-count is a floor, not a calibrated recall (no known-fakes were injected).
- **Framework-relativity is made explicit.** A pass hunts the failure mode where, by tacitly adopting one
  philosophy of memory, we over-weight it and under-credit rivals (Pass 3) — though the audit notes the
  scaffold vocabulary itself stays theory-laden.

## Method & model policy

Multi-agent orchestration (see `.claude/workflows` run scripts, not committed). Model policy, per owner:
**Claude Fable 5** for the opaque, generative first-pass work (surveying, steelmanning, red-teaming,
synthesizing) and for the Fable-exclusive verification gate; **Claude Opus 4.8** for bounded
verification/adjudication. Minimum model Opus 4.8. Everything persisted to disk each pass so later
passes (and later sessions) read from the record, not from conversation memory.

## The passes

| Pass | What it did | Model | Status | Where |
| --- | --- | --- | --- | --- |
| **0 — Landscape** | 8-domain survey of the field, validated + citation-checked | Fable survey / Opus validate | ✅ done | [`00-landscape-survey.md`](00-landscape-survey.md) |
| **1 — Adversarial** | Steelman → red-team → adjudicate each of 8 topics; cross-topic meta-review | Fable generate / Opus adjudicate | ✅ done | [`01a`](01a-adversarial-synthesis.md) · [`01b`](01b-adversarial-ledger.md) · [`01c`](01c-adversarial-meta-review.md) · [appendix](appendix/pass1/) |
| **2 — Verification gate** | Fable-exclusive: adversarially review *and* respect every finding; audit all citations | Fable only | ✅ done | [`02a`](02a-verification-gate-ruling.md) · [`02b`](02b-verification-gate-issues.md) · [`02c`](02c-verification-gate-metasynth.md) · [appendix](appendix/pass2/) |
| **3 — Framework-bias audit** | One advocate per memory philosophy; re-litigate all dismissals/acceptances; rebalance → refined baseline | Fable only | ✅ done | [**`refined-baseline.md`**](refined-baseline.md) · [`03a`](03a-framework-reconciliation.md) · [`03b`](03b-framework-residual-bias.md) · [`frameworks-map`](frameworks-map.md) · [appendix](appendix/pass3/) |
| **Phase two** | Implementation, once the baseline stabilizes | — | not started | — |

| **4 — Alternative-theorem** | Treat corpus as incumbent; blind-re-derive; hunt for a *competing* theorem, re-anchored to the conversational objective | Fable generate / Opus score | ✅ done | [**`04`**](04-alternative-theorems.md) · [`04a`](04a-replication-convergence.md) · [`04b`](04b-alternative-critic.md) · [appendix](appendix/pass4/) |
| **5 — Methodology audit** | Review the *process*, not the content: anti-patterns, gaps, fitness as a reusable base | Fable lenses / Opus adjudicate | ✅ done | [**`05`**](05-methodology-review.md) · [`05a`](05a-methodology-remediation.md) · [`05b`](05b-methodology-metacritic.md) · [appendix](appendix/pass5/) |
| **Phase two** | Implementation, once the baseline stabilizes | — | not started | — |

**➡️ [`refined-baseline.md`](refined-baseline.md)** is the framework-audited map (bedrock vs relative);
**[`04-alternative-theorems.md`](04-alternative-theorems.md)** is the alternative-frame synthesis for the
*conversational* objective. Read both; they answer different questions.

Supporting: [`glossary.md`](glossary.md) — every name/study/system/term in plain language + what it's
used for. [`seeds.md`](seeds.md) — the 8 topics distilled into the claim-clusters that are the
adversarial targets.

## The 8 topics

1. **T1 — Memory is plural** (working / episodic / semantic / procedural systems partition).
2. **T2 — Encoding is distillation** (never raw storage; precision-write / fuzzy-read).
3. **T3 — Weighting** (recency × importance × relevance; ACT-R activation & cousins).
4. **T4 — Retrieval is associative traversal** (spreading activation / PPR / Hopfield completion).
5. **T5 — Consolidation & the fast/slow architecture** (CLS, replay, reflection).
6. **T6 — Updating** (reconcile/supersede, not append; the ripple problem).
7. **T7 — Degradation** (forgetting is lawful, mechanism unknown, partly a feature).
8. **T8 — Where the LLM ↔ human analogy breaks down.**

## The framework-bias finding (Pass 3 — the reason this program exists)

The audit seated 14 competing philosophies of memory and let each advocate audit the corpus. **All 14
rated themselves under-weighted; three — single-signal/unitary, connectionist/PDP-distributed, and
transfer-appropriate-processing — significantly so.** The neutral re-audit found **29 of 132 decisions
were "framework-biased"** (the verdict silently depends on an unstated school), 10 wrongly-accepted, 3
wrongly-dismissed, and ~82 stones unturned.

**Our primary thumb:** the discrete-store *structuralist* lineage (Atkinson–Shiffrin → Tulving → symbolic
boxes) was quietly treated as **neutral bedrock**, while its live rivals (Cowan embedded-processes,
single-signal, PDP-connectionist, levels-of-processing, TAP, and the instance/global-matching family) had
to appear only as *attacks on a default*. The load-bearing device was the **"coarse plurality is
unanimous" gloss**, which manufactures agreement by defining "plural" as mere behavioral *dissociability*
— which a single-substrate model happily grants. **Secondary thumb:** CLS-*necessity* ("close to a
theorem") over its rivals in T5.

The refined baseline corrects this by (a) reclassifying ~half of "bedrock" as **framework-relative**
(9 genuinely-neutral N-claims vs 11 relative R-questions, each with competing positions at fair weight +
a named decider), (b) **reviving 7** wrongly-dismissed arguments and **downgrading 11** wrongly-accepted,
(c) surfacing **14 stones unturned** (esp. the instance/global-matching "third pole" that dissolves the
T3 per-item-scalar and T4 completion-vs-lookup binaries; interference theory of forgetting; caching/
unlearning refuting the "AI has no principled decay" gap), and (d) naming **counter-thumbs** so the fix
is "a filled table, not a flipped default." It is *not* fully neutral — see `03b-framework-residual-bias.md`
(the scaffold vocabulary itself is still store-flavored; memory-augmented nets that literally do address
lookup are missing), a candidate seed for a future pass.

## The alternative-theorem finding (Pass 4 — "would we replay to the same result?")

Treating the corpus as the incumbent and re-deriving blind, from 5 lenses, re-anchored to the *conversational*
objective: **no — a blind replay does not reproduce our fact-graph frame.** All 5 independently landed on
**relationship-indexed, two-speed, reconstructive memory** (fast episodic capture → slow consolidation into
person/relationship gist → **recall as generative reconstruction, not lookup**), rating only *partial*
convergence with the incumbent. **The incumbent is relocated, not refuted:** our weighted knowledge-graph is
what they each reconstruct as the *slow consolidated + fidelity/audit layer* — never the organizing frame.

**Evidence-linked additions the incumbent lacks:** a fast episodic layer (affect / who-was-there / temporal
context, not flattened to triples); a **reconstruction read step** (gist-first, hedged — the biggest omission,
the direct cure for "robotic lookup"); a **common-ground / transactive ledger** (who-knows-what, "what I already
told you," anti-repetition, epistemic rights — a *clean* omission, conversation-specific, and the *safest* to
add since it traffics in pointers/provenance); need-probability ranking + adaptive forgetting; a metamemory/
hedging surface; and `reflect` reframed as the *learning engine*. **Crucially, the security core stays
firewalled** — reconstruction is structurally unsafe for secrets/reminders/authz, so every winning theorem
walls itself out of it, and Baumy's "deterministic code disposes" rule is *re-justified from memory theory*.

**Two honesty caveats (from the Opus scorer + the critic), so this is not over-sold:**
- **Weak independence + priming.** The objective prompt said "recalls naturally rather than robotic database
  lookups" — pre-stating the conclusion; both processes sampled the same training canon; and *all 10 theorems
  scoring "better" is a rubric-bias red flag*. The **engineering/IR/security lens — the axis on which the
  incumbent was actually chosen — was never run.** So "under-weights process/relationship" is robust;
  "replace the graph" is not. The defensible conclusion is **re-frame + augment into a firewalled hybrid.**
- **⚠️ Objective substitution (the fork to resolve before phase two).** The exercise optimized a *human-like
  companion*. Baumy is, per `AGENTS.md`, a **house-management secretary** — explicitly "not a personal
  assistant," accuracy- and security-first. Several recommendations (gist-over-verbatim, adaptive forgetting)
  are **anti-features for a secretary** answering "what's the wifi password / when is rent due." Companion vs
  secretary changes which additions apply. Also still missing: fuzzy-trace theory, Schank/Kolodner case-based
  reasoning ("that reminds me…"), contextual-integrity for a *multiparty* group, and any observational data on
  whether the incumbent actually *sounds* robotic. See `04b-alternative-critic.md`.

## Headline findings so far (the claims that survived our adversarial review — *not* validated against data; see U2)

- **The most attack-resistant claims** — the ones that held under Claude red-teaming Claude across every
  pass because they rest on *widely-replicated* results the models could not talk down (NOT because *this
  process* tested them against data): the lesion double dissociations (memory is plural); accessibility ≠
  availability; the spacing/testing effects; the parametric-editing "ripple problem"; AI's apparent
  missing principled *decay* of stale-but-uncontradicted facts; and the writable-memory attack surface.
- **The "grand convergence" narrative was deflated** to *"shared ancestry + useful borrowing."* Much of
  the AI/cognitive/neuro overlap is a scheme AI *imported* (CoALA, HippoRAG, EWC), not independent
  rediscovery — so it can't be sold as cross-field corroboration. (Pass-2 nuance: the *lesion-
  neuroscience* base is independent, so two independent evidentiary bases survive, not one lineage.)
- **The biggest opportunity/gap:** principled, *evaluated* memory **decay** (age-driven consolidation,
  salience-based pruning of uncontradicted facts) is where cognitive science is richest and AI
  engineering is emptiest — and whether time-based decay even helps task performance is empirically
  unsettled. Proceed empirically.
- **Corrections logged** (Pass-2 gate): several Pass-1 flags were themselves wrong — e.g. AlphaEdit's
  ICLR-2025 Outstanding Paper award is **real** (an earlier "fabrication" flag was mistaken); the
  "averaging artifact" objection was applied to the wrong domain; fan-effect normalization was over-
  dismissed. "Trust the direction, not yet the text" — the verdicts hold, the grounding needed cleanup.

## How to read

- **Start here:** [`refined-baseline.md`](refined-baseline.md) — the framework-audited, evenly-weighted synthesis.
- **For the residual caveats:** `03b-framework-residual-bias.md` (what the refined doc *still* leans on / omits).
- **For the earlier synthesis + its errata:** `01a-adversarial-synthesis.md` corrected by `02a-verification-gate-ruling.md`.
- **For any unfamiliar term:** `glossary.md`.
- **For full traceability:** `appendix/` holds the raw per-topic + per-framework essays for every pass.

## Provenance

Runs: Pass 0 (19 agents), Pass 1 (26), Pass 2 (26), Pass 3 (26), Pass 4 (32; 1 failed on a retry cap),
Pass 5 methodology audit (12). ~6.5M subagent tokens across six passes. Conducted 2026-07-05 → 2026-07-06.
Findings are model-generated and
adversarially cross-checked; they are a research aid, not ground truth. Model policy: Fable 5 for opaque
generation + the verification gate; Opus 4.8 for bounded adjudication.
