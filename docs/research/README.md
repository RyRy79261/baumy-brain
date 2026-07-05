# Cognitive-memory research program

A multi-pass, adversarial research effort to establish an honest **cognitive baseline** — what the
science of memory (LLM/agent memory, cognitive psychology, memory neuroscience, knowledge-graph &
retrieval) actually supports — *before* evolving Baumy's memory architecture (a weighted, traversable
knowledge graph that should degrade gracefully over time). This directory is the durable record.

> **Status: research phase, ongoing.** Nothing here is implemented in Baumy, and none of it is a
> design or a decision. It is a *sentiment of the research landscape*, deliberately hedged, adversarially
> stress-tested, and framework-audited. Read it as "what the field can and cannot support," not "what to
> build." Implementation ("phase two") comes only after this stabilizes.

## Scope discipline (why this is trustworthy-ish)

- **Adversarial by construction.** Every claim is steelmanned *and* red-teamed; every verdict is
  independently verified; every dismissal and acceptance is re-litigated for hidden bias.
- **Citations are checked, not asserted.** Fabricated venues and misattributions were caught and logged
  (see the gate ruling); treat any remaining "2025/2026 venue" label as a preprint unless verified.
- **Framework-relativity is made explicit.** A late pass specifically hunts for the failure mode where,
  by tacitly adopting one philosophy of memory, we over-weight it and under-credit its rivals.

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

**➡️ [`refined-baseline.md`](refined-baseline.md) is the current best synthesis** — the framework-explicit,
evenly-weighted map (neutral bedrock / framework-relative questions / revived + downgraded / stones
unturned / open cruxes). Start there.

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

## Headline findings so far (empirical core — survived every pass)

- **Empirical bedrock survived every attack** — carried by *data*, not analogy: the lesion double
  dissociations (memory is plural); accessibility ≠ availability; the spacing/testing effects; the
  parametric-editing "ripple problem"; AI's genuinely missing principled *decay* of stale-but-
  uncontradicted facts; and the writable-memory attack surface.
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

Runs: Pass 0 (19 agents), Pass 1 (26), Pass 2 (26), Pass 3 (26). ~4.5M subagent tokens across the four
passes, 0 agent errors. Conducted 2026-07-05 → 2026-07-06. All findings are model-generated and
adversarially cross-checked; they are a research aid, not ground truth. Model policy: Fable 5 for opaque
generation + the verification gate; Opus 4.8 for bounded adjudication.
