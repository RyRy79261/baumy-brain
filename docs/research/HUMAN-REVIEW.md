# Human review package — the out-of-distribution check

Pass 5 concluded the one thing this entire stack **cannot do for itself** is a review from outside the
model distribution. That's you. This is the short list of what actually needs a *human* — not another
Fable pass — before we start building on any of it. Everything here is a question *for you*; none of it
is settled.

Read alongside: [`README.md`](README.md) (§ ⚠️ Methodological status), [`refined-baseline.md`](refined-baseline.md)
(the framework-audited map), [`04-alternative-theorems.md`](04-alternative-theorems.md) (the conversational
reframe), [`05-methodology-review.md`](05-methodology-review.md) (how much to trust it), and
[`06-empirical-ablation.md`](06-empirical-ablation.md) (the one thing that touched data).

---

## 1. The check only you can make: is it signal or a fluent echo?

The Pass-5 meta-critic's sharpest point: *LLMs have a rehearsed "monoculture / no-preregistration / no-
ground-truth" self-criticism genre, and producing it fluently is not evidence it fits **this** corpus.*
I cannot tell, from inside, whether the whole program found a real signal or argued itself in a
persuasive circle. **Your read is the tiebreak.** Concretely:

- [ ] **Verify the one "structural, checkable" claim I lean everything on:** that every agent was Claude
      (Fable 5 / Opus 4.8). It's on the README Provenance line — but it's *self-reported*; the honest
      check is the run scripts in the session, not my say-so. If that's true, the monoculture caveat is
      real; if you trust it, everything downstream inherits the discount.
- [ ] Skim `refined-baseline.md` §I ("framework-neutral bedrock") and ask the human question: **does any
      of this feel obviously true or obviously wrong to you** in a way the models glossed? Your gut is
      out-of-distribution signal the panel doesn't have.

## 2. The decision that gates everything: what IS Baumy?

The single most consequential fork the research surfaced (Pass 4 critic, README objective-substitution).
The models optimized a *human-like companion*; `AGENTS.md` says Baumy is a *house-management secretary,
accuracy- and security-first*. **This is a product decision, not a research one — it's yours.** It
changes which of Pass 4's recommendations even apply:

- **Pure secretary** → keep the accurate graph; add only the *accuracy-neutral, safe* pieces (the
  common-ground / who-knows-what ledger, hedging "you haven't told me that"). Reject gist-over-verbatim
  and adaptive forgetting — they're anti-features for "what's the wifi password".
- **Companion-leaning** → the relationship-indexed reconstructive layer becomes the point.
- **Secretary now, base for more later** (your stated intent) → the firewalled hybrid: reconstructive/
  relational *surface*, exact graph *spine*, security core walled off. This is where the research points.

> **Your call, in one line:** ________________________________________________

## 3. Feed the empirical loop some human randomness (5 minutes, real impact)

The ablation (`06-empirical-ablation.md`) is currently graded on **queries the model wrote**. The cheapest
way to break that is for *you* to add how *you'd actually ask* in the house chat:

1. Open `scripts/ablation/queries.human.json`.
2. Add entries to `queries` in your own words — awkward phrasings, typos, half-sentences, the weird way
   people actually ask. `relevant` = substrings of the seeded corpus (see `NOTES`/`FACTS` at the top of
   `scripts/ablation/retrieval.ablation.test.ts`) that would count as a right answer.
3. Re-run: `RUN_ABLATION=1 pnpm vitest run scripts/ablation` → your queries are folded in and counted
   separately in `docs/research/data/ablation-lexical.json`.
4. **The honest version** (real semantic space, ~1¢): add `ABLATION_EMBEDDER=voyage VOYAGE_API_KEY=…`.
   This is the run that would fix the paraphrase (F2) numbers and give the true measurement.

If your human queries score much worse than the model's, that's the monoculture leaking into the
benchmark — exactly the thing we want to catch.

## 4. The empirical finding worth your judgment

The data (Pass 6) both **confirmed** the fact-arm and graph-walk claims and **challenged** one: query
expansion is *not* a pure win — it traded hit@1 (0.55→0.35) for hit@8 (0.70→0.80). The design already
reserves expansion for the deep tier, so this validates the current split — but **do you want a memory
that reliably puts the right answer *first* (secretary), or one that reliably *finds* it somewhere
(companion)?** Same tradeoff, different product. Another fork for you.

## 5. What to do with the corpus (my recommendation, your decision)

The research is now honestly labeled as a **question-set, not an answer-set**, with one small empirical
anchor. The three defensible next moves:

- **(a) Build the safe, high-value, cross-cutting piece first** — the **common-ground / transactive
  ledger** (who-knows-what, "you already told me", anti-repetition). Pass 4 rated it the *most apt* and
  *safest* addition for a group-house bot: it traffics in pointers/provenance, never reconstructs
  security content, so it doesn't touch the injection wall. It's a genuine feature the current design
  lacks, works for secretary *and* companion, and is the natural first brick of "phase two".
- **(b) Run the still-missing engineering/security re-derivation** (the "6th lens") if you want the map
  airtight before building.
- **(c) Just start** — resolve §2, and I scope a concrete design against `AGENTS.md`'s invariants.

I lean **(a)** — it's the one recommendation the whole research chain agrees on, it's safe against
Baumy's golden rule, and it's real product value rather than more meta-analysis. But this is the moment
the squishy human decides, so: over to you.
