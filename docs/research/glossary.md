# Glossary — every name, study, system, and term, in plain language

For each: **what it is** (plain), then **how I used it in this research**. Grouped: (A) human-memory
people & studies, (B) formal cognitive models, (C) AI/ML memory systems & methods, (D) core jargon.

---

## A. People & landmark human-memory studies (psychology / neuroscience)

**Gilbert Ryle (1949, "The Concept of Mind").** A philosopher who drew the distinction between
*knowing-that* (facts you can state — "Paris is the capital of France") and *knowing-how* (skills you
just perform — riding a bike). — *How I used it:* this is the philosophical ancestor of the
**declarative vs. procedural** memory split. My point in the critique: when ACT-R (an AI/cognitive
model) claims a "declarative/procedural" architecture, that distinction traces back to Ryle via
Anderson — i.e. it's a *borrowed* philosophical idea, not something AI independently discovered. That
matters because it deflates the "independent convergence" story.

**John R. Anderson.** The cognitive scientist behind **ACT-R** (see B) and the **rational analysis of
memory**. — *How I used it:* two ways. (1) His activation equation is the formal ancestor of the
"recency × importance × relevance" scoring modern AI agents use. (2) With Schooler he argued memory
retrievability tracks how *likely you are to need something* (see "need-probability" below).

**Atkinson & Shiffrin (1968) — the "modal" / multi-store model.** The classic textbook diagram of
memory: sensory register → short-term store → long-term store, with "control processes" shuttling
information between them. — *How I used it:* it's the direct ancestor of the "working memory vs.
long-term memory" split. My critical point: this boxes-and-arrows model *was itself modelled on the
digital computer* (see von Neumann) — so when AI later re-adopts "stores," that's partly the computer
metaphor coming home, not a fresh convergence.

**von Neumann architecture.** The standard design of essentially every digital computer: a **stored-
program** machine with a clear separation between a **memory unit** (holding addressable data) and a
**processing unit**, shuttling data back and forth. Memory is **location-addressed** — you fetch by
*address* (slot number), not by content. — *How I used it:* as the thing Atkinson-Shiffrin's "stores"
resemble. The deeper contrast I kept drawing: **human/associative memory is content-addressed** (you
recall by meaning/cue), which is the *opposite* of von Neumann's address-based fetch — so the "memory
= a store you look things up in" intuition is a computer metaphor that may misdescribe the brain.

**Endel Tulving.** The foundational theorist of long-term memory structure. Three of his contributions
I lean on:
- **Tulving (1972) — episodic vs. semantic memory.** *Episodic* = memory for specific events tied to a
  time and place ("what I ate last Tuesday"); *semantic* = context-free facts ("Tuesdays come after
  Mondays"). — *How I used it:* the core of "memory is plural," and the label AI borrows when it calls
  a store "episodic."
- **Tulving & Pearlstone (1966) — accessibility ≠ availability.** The landmark experiment: people
  couldn't freely recall many words (low *accessibility*), but when given the category name as a cue,
  they suddenly produced them (the words were *available* — stored — all along). — *How I used it:*
  this is a ~60-year-replicated result proving a memory can be present-but-unreachable, which
  **refutes any model where retrieval is just "the trace is strong enough" or "look it up by key."**
  It's one of the claims that *survived* the red team, because the data itself is bedrock.
- **Tulving & Thomson (1973) — encoding specificity.** A cue helps you remember only if it matches
  *how the memory was originally encoded*. — *How I used it:* the human basis for "what you store
  determines what can later retrieve it," and the analogy to retrieval-embedding failures.

**Baddeley & Hitch (1974) — working memory.** Replaced the passive "short-term store" with an active,
multi-part *working* memory (a controller plus a verbal loop and a visual sketchpad); Baddeley (2000)
added an "episodic buffer." — *How I used it:* the modern form of the "fast, small, manipulable
scratchpad vs. big slow store" distinction — the ancestor of an agent's context window vs. its
external memory.

**Squire (declarative/nondeclarative taxonomy).** Neuroscientist who mapped the memory partition onto
brain systems: *declarative* (facts/events; medial temporal lobe) vs. *nondeclarative* (skills, habits,
priming, conditioning; basal ganglia/cerebellum). — *How I used it:* the neuroanatomical grounding
that makes "procedural memory" a real separate system, not just a label.

**Scoville & Milner (1957) — patient H.M.** The most famous case in memory science: a man whose
hippocampi were surgically removed lost the ability to form new *declarative* memories but could still
learn new *motor skills* (mirror-drawing) with no memory of practising. — *How I used it:* the
**double dissociation** that proves declarative and procedural memory are separable mechanisms. This
is why "memory is plural" survives even the harshest critique — it's a clinical fact, not a theory.

**Patient K.C. (Tulving's case).** A man who, after brain injury, lost all *episodic* memory (couldn't
recall a single personal event) yet kept his *semantic* knowledge (facts, vocabulary) intact. — *How I
used it:* the companion dissociation to H.M. — proof that episodic and semantic are separable too.

**Miller (1956) — "the magical number seven, plus or minus two."** The claim that working memory holds
~7 items (later revised down to ~4 "chunks" by Cowan). — *How I used it:* the evidence that working
memory is sharply **capacity-limited** — which is *why* prioritization and forgetting have to exist at
all (an unbounded store wouldn't need them). Flagged by the Opus critic as missing canon.

**Collins & Loftus (1975) — spreading activation.** A model of semantic memory as a network of concepts
connected by weighted links; activating one concept spreads activation to its neighbors, fading with
distance. Explains why "doctor" primes "nurse." — *How I used it:* the human ancestor of graph
traversal — the cognitive-science version of "walk the links from what you're thinking about." I
paired it with Personalized PageRank (the AI version).

**Ebbinghaus (1885) — the forgetting curve.** The first quantitative memory experiment: memory decays
rapidly at first, then levels off (a "negatively-accelerated" curve). — *How I used it:* the
foundational law that forgetting is *lawful and predictable*. Survived the red team as an effect; the
exact mathematical *form* (power law vs. exponential) did not.

**Craik & Lockhart (1972) — levels of processing.** The idea that "deeper" (more meaningful) encoding
produces more durable memory. — *How I used it (and its problem):* I flagged it as **circular** —
"depth" is usually *defined* by what's later remembered, so it can't cleanly *explain* what's
remembered. The corrective is **transfer-appropriate processing** (Morris, Bransford & Franks 1977):
what matters is the *match* between how you encoded and how you'll retrieve, not depth per se.

**Loftus — the misinformation effect** (e.g. Loftus & Palmer 1974). Showing people misleading
post-event information changes their memory of the original event (the "smashed vs. hit" car-crash
study). — *How I used it — and why it became a crux:* it's evidence that human memory can be *rewritten
after the fact*. But whether the original memory is truly **overwritten** or merely **coexists** with
the new info (a source-monitoring error) is contested — and that single interpretation flips three of
my topics (it's either biology's "durable false-fact insertion," or evidence *for* keeping old
versions around). It's crux #2 for Pass 3.

**Roediger & Karpicke (2006) — the testing effect.** Retrieving a memory (being tested) strengthens it
more than re-studying does. — *How I used it:* the clearest case that **retrieval is itself a write
operation** in humans — accessing a memory changes its future state. (Note: the effect actually dates
back to Abbott 1909 — I over-credited the 2006 paper as the origin.)

**Retrieval-induced forgetting (RIF; Anderson, Bjork & Bjork 1994).** Recalling one item can *suppress*
related but un-recalled items. — *How I used it:* another "retrieval changes the store" phenomenon.
Red-team caught that I mis-analogized it: RIF is *over-suppression of neighbors*, which is the opposite
direction from the AI "ripple problem" (*under*-propagation to neighbors).

**Reconsolidation (Nader, Schafe & LeDoux 2000).** When you reactivate a consolidated memory, it
briefly becomes labile (re-writable) before re-stabilizing — a biological "update-on-read" window. —
*How I used it:* the human analogue of "reconcile a fact when you touch it." Caveat I flagged: its
boundary conditions and human replicability are contested.

**Schooler & Hertwig (2005) — "how forgetting aids heuristic inference."** A simulation showing that
*intermediate* forgetting can *improve* decision accuracy (forgetting rare/old items sharpens
judgments). — *How I used it:* the case that **forgetting is partly a feature, not a bug** — the design
goal is "degrade *well*," not "retain everything." Red-team caveat: it's a simulation, architecture-
dependent, and risks "everything is adaptive" over-reach.

**Richards & Frankland (2017) — "the persistence and transience of memory."** Argues active forgetting
promotes *generalization* (letting go of specifics helps you see patterns), analogizing transience to
**regularization** in machine learning. — *How I used it:* support for "forgetting aids
generalization." Caveat: it's a review-article analogy, not a direct measurement.

**Anderson & Schooler (1991) — rational analysis / "need-probability."** The claim that how retrievable
a memory is tracks the *probability you'll actually need it soon*, and that real-world information
streams (news, speech, email) show the same frequency/recency/spacing statistics as human memory. —
*How I used it — and why it's a crux:* this is the **one strand** I concluded might genuinely transfer
from human memory to machines (design decay around *need-odds*). But it rests on matching two
*averaged* power-law curves, which may be a statistical artifact (see Heathcote). Crux #3 for Pass 3.

**Heathcote et al. (2000) — the power-law averaging artifact.** Showed that averaging many *individual*
exponential forgetting curves *manufactures* an aggregate power-law shape — so a power law seen in
group data may not exist in any individual. — *How I used it:* a debunking tool. The Opus meta-review
caught that I applied it unevenly — I used it to weaken the "need-probability" power law (T3) but let
the *structurally identical* forgetting-curve power law (T7) off easy. Pass 3 must apply it evenly.

**Cepeda et al. (2006) — the spacing meta-analysis.** 317 experiments confirming spaced practice beats
massed practice for retention. — *How I used it:* the bedrock evidence that spacing/testing effects are
real (among psychology's most replicated findings).

**Complementary Learning Systems (CLS; McClelland, McNaughton & O'Reilly 1995; updated Kumaran,
Hassabis & McClelland 2016).** The theory that the brain uses **two learning systems**: a *fast*,
sparse hippocampus that memorizes specific episodes quickly, feeding a *slow* neocortex that gradually
extracts general structure — the two-speed design that avoids "catastrophic interference." — *How I
used it:* the biological blueprint for a **fast/slow memory architecture**, and the neuroscience the AI
method EWC explicitly borrows. Red-team caveat: "necessity" is over-stated — big single networks can
get interference-resistance from *scale* alone.

**Hippocampal replay / sharp-wave ripples (Wilson & McNaughton 1994; Buzsáki).** During rest/sleep the
hippocampus "replays" recent experience in fast bursts, thought to drive consolidation. — *How I used
it:* the biological analogue of an offline "reflection"/summarization pass over recent memories.

**Tse et al. (2007) — schema-dependent fast consolidation.** Showed that when new information fits an
existing mental *schema*, the neocortex can learn it *fast* (within ~48h), not slowly. — *How I used
it:* a **crack in CLS** — it undercuts the clean "neocortex is always slow" premise.

**Multiple Trace Theory (MTT; Nadel & Moscovitch 1997).** A rival to standard consolidation: it says
vivid episodic memories *never* fully leave the hippocampus (each recall lays down a new trace), rather
than being transferred to cortex. — *How I used it:* the contested alternative to "consolidation =
transfer from fast to slow store." If MTT is right, the whole "transfer" framing is directionally
wrong, not just over-stated.

**Lashley — "in search of the engram."** Karl Lashley's decades-long (failed) attempt to find *where* a
memory is physically stored in the brain, concluding memory is **distributed**, not localized. — *How I
used it:* the reason "where is a fact stored?" being ill-posed in an LLM is *not* a disanalogy — the
brain has the same non-localizability. This is one of the two claims that *flipped sign* under the red
team (T8-B looks like a convergence, not a break).

**Hebbian learning ("cells that fire together wire together").** Donald Hebb's principle: simultaneously
active neurons strengthen their connection — the basis of associative memory. — *How I used it:*
background for why biological memory is associative (link-based), setting up the Hopfield/attention
discussion.

**Shaw & Porter (2015) — implanting false memories.** A study where ~70% of participants were led to
form rich false memories of having committed a crime in adolescence. — *How I used it:* the red team's
counter to my claim that "a writable memory is an attack surface with *no* biological analogue." Human
memory *can* be "poisoned" too — so the honest disanalogy is one of *degree* (a machine's single
`insert()` is more reliable/direct), not a categorical one.

---

## B. Formal cognitive models

**ACT-R (Adaptive Control of Thought—Rational; Anderson et al. 2004).** A long-running computational
"cognitive architecture" — a runnable simulation of human cognition — split into a **declarative**
memory (facts, retrieved by an *activation* score) and a **procedural** memory (if-then production
rules). — *How I used it:* the most formal statement of graded memory weighting, and the direct
ancestor of AI agents' scoring. Key pieces below.
- **Base-level activation.** In ACT-R, each memory's retrievability = a function of *how often* and
  *how recently* it's been used, with a built-in **power-law decay**. — *How I used it:* this is
  literally "recency + frequency" formalized decades before Generative Agents.
- **Spreading activation (ACT-R version) + the fan effect.** Context cues lend activation to associated
  memories; but a cue linked to *many* things (high "fan") gives each less boost — so you're *slower*
  to retrieve a fact about a concept that's associated with lots of other facts (the empirically robust
  **fan effect**). — *How I used it:* a principled, human-validated defense against "hub" concepts
  dominating retrieval — an idea directly relevant to weighting graph edges. Red-team caveat: the
  "same normalization for the same reason" across cognition and AI collapses three *different*
  mathematical derivations into one.

**MINERVA-2 (Hintzman 1984/1988).** An "instance" or "exemplar" model: it stores *every* individual
experience separately and never stores an abstract summary — yet when you probe it, a *prototype*
emerges on the fly from the blend of all matching instances. — *How I used it:* the striking claim that
**abstraction doesn't have to be stored** — generalizations can *emerge at retrieval time* from raw
instances. This is the counter-pole to "consolidate episodes into summaries" (crux #8).

**SAM (Raaijmakers & Shiffrin 1981) and REM (Shiffrin & Steyvers 1997).** "Global matching" models of
recall: a retrieval cue is compared against *all* stored traces at once, and recall is a probabilistic
sample weighted by similarity/associative strength. — *How I used it:* to show the "retrieval =
parallel similarity match over everything," not "look up one address," idea is old and well-founded in
psychology (and that ACT-R isn't the only serious model — a fairness point the critic raised).

**SIMPLE (Brown, Neath & Chater 2007).** A memory model that reproduces forgetting curves using
**discriminability** (items become harder to tell apart over time/among neighbors) with **no decay
parameter at all**. — *How I used it:* the leading rival to "memory strength decays with time" — it
says forgetting is *interference/confusability*, not decay. The decay-vs-interference dispute is
century-old and unresolved (crux for T7).

**TCM (Temporal Context Model; Howard & Kahana 2002).** Explains memory via a slowly-drifting mental
"context" signal; you retrieve items by reinstating the context they were encoded in, and forgetting is
**context drift**. — *How I used it:* a *third* account of forgetting (neither decay nor classic
interference) — part of why "the mechanism of forgetting" is genuinely open.

**Bjork & Bjork (1992) — New Theory of Disuse; storage strength vs. retrieval strength.** Distinguishes
how *well-learned* something is (storage strength, never decreases) from how *accessible* it is right
now (retrieval strength, fluctuates). — *How I used it:* the formalization of "forgetting is retrieval
failure, not erasure" — though I flagged this slogan is *not* universally agreed (ACT-R posits real
strength decay; biology has genuine active erasure).

---

## C. AI / ML memory systems & methods

**HippoRAG (Gutiérrez et al. 2024)** — *this is what you were calling "Hippogriff".* A
retrieval-augmented-generation method that builds a **knowledge graph** from documents and, at query
time, runs **Personalized PageRank** (a graph random-walk) from the entities in your question to gather
relevant facts in a single multi-hop step — explicitly inspired by the **hippocampal indexing** theory
of human memory. — *How I used it:* the clearest AI example of "retrieval = graph traversal /
associative spreading," and (critically) an *admitted borrowing* of a neuroscience idea — which is why
it can't count as *independent* convergence.

**Personalized PageRank (PPR).** The PageRank algorithm (random surfer walking links) but restarted
from a specific set of "seed" nodes, so it measures relevance/proximity *to those seeds*. — *How I used
it:* the graph-algorithm equivalent of spreading activation — start from what the query mentions, let
"importance" diffuse out along the edges. (This is essentially what Baumy's own graph traversal
approximates with its bounded walk.)

**GraphRAG (Edge et al. 2024, Microsoft).** A RAG system that clusters a knowledge graph into
communities and pre-writes hierarchical summaries, so it can answer *global/thematic* questions ("what
are the main themes?") that flat retrieval struggles with. — *How I used it:* the exemplar of
"graph/hierarchy beats flat retrieval for global queries" — and the source of an *overstated* claim
(that flat RAG "structurally cannot" do this), which RAPTOR disproves.

**RAPTOR (Sarthi et al. 2024).** Recursively clusters and summarizes documents into a *tree* of
summaries — multi-resolution retrieval **without any entity graph**. — *How I used it:* the
counterexample that breaks GraphRAG's "you need a graph" claim, and raises the open question: is the
active ingredient the **graph topology** or just **hierarchical summarization**? (crux #4).

**RAG (Retrieval-Augmented Generation; Lewis et al. 2020).** The now-standard technique of retrieving
relevant text and feeding it into an LLM's context at generation time (as opposed to baking knowledge
into the weights). Descendants: DPR, REALM, RETRO (dense-retrieval lineage). — *How I used it:* the
whole "non-parametric external memory" paradigm Baumy sits in. The Opus critic flagged I discussed RAG
throughout without citing its founding papers.

**RRF (Reciprocal Rank Fusion; Cormack et al. 2009).** A simple, robust way to *combine* several ranked
lists (e.g. semantic + keyword + graph results) into one, by summing reciprocal ranks. — *How I used
it:* the standard "hybrid fusion" method — and literally what Baumy already does (semantic ⊕ lexical
via RRF).

**Generative Agents (Park et al. 2023).** The famous "Smallville" simulation where LLM agents had a
**memory stream** scored by **recency × importance × relevance**, plus periodic **reflection** (synthe-
sizing memories into higher-level insights). — *How I used it:* the canonical AI statement of
multi-signal memory weighting, and the template Baumy's own scoring echoes. Red-team caveat: its
"importance" is a one-time LLM rating, which does *not* map onto ACT-R's use-frequency — so the
"convergence" with ACT-R is only on recency+relevance.

**MemGPT / Letta (Packer et al. 2023).** Treats an LLM's limited context like an operating system's RAM,
"paging" information in and out of a larger external memory, with summarization on eviction. — *How I
used it:* the "OS-style memory management / eviction as paging" reference point.

**MemoryBank (Zhong et al. 2024).** An LLM memory that updates retention using an **Ebbinghaus-style
forgetting curve** — memories decay unless "rehearsed." — *How I used it:* one of the *few* AI systems
that implements *principled time-decay* (most don't) — evidence for how thin that area is.

**Mem0 / A-MEM / Zep (Graphiti).** Recent LLM long-term-memory systems. Zep/Graphiti is notable for
**bi-temporal** fact storage (see D) — it invalidates outdated facts by closing a validity window
rather than deleting them. — *How I used it:* examples of the "reconcile/supersede, don't append"
convergence. Caveat flagged: several of their headline benchmark numbers are **self-reported**.

**CoALA (Cognitive Architectures for Language Agents; Sumers, Yao, Narasimhan & Griffiths 2024).** A
framework that organizes LLM agents using the classic memory partition — working + episodic + semantic
+ procedural — *explicitly borrowed* from cognitive psychology. — *How I used it:* the clearest case of
AI *importing* the human memory taxonomy — central to the "shared ancestry, not independent
convergence" finding.

**Soar (Laird).** A decades-old symbolic cognitive architecture that also splits memory into
procedural/semantic/episodic and compiles repeated reasoning into fast rules ("chunking"). — *How I
used it:* alongside ACT-R, evidence the memory partition arose in AI from *engineering* pressure too
(a mild counter-point to "pure borrowing").

**EWC (Elastic Weight Consolidation; Kirkpatrick et al. 2017).** A **continual-learning** method that
fights "catastrophic forgetting" (a neural net overwriting old skills when learning new ones) by
identifying which weights were important for old tasks and making them "stiffer" (harder to change).
The name and idea consciously borrow **synaptic consolidation** from neuroscience. — *How I used it:*
the machine-learning cousin of "protect important memories," and another *admitted* neuroscience import
(same DeepMind/Hassabis lineage as CLS). Red-team caveat: EWC actually performs poorly on the hardest
continual-learning benchmarks — so the *synaptic* branch of the analogy is shaky.

**Catastrophic forgetting (McCloskey & Cohen 1989).** The tendency of a neural network to abruptly lose
previously-learned knowledge when trained on new data. — *How I used it:* the core reason a fast/slow
(CLS-style) split exists in ML, and the failure mode that principled forgetting must *avoid* becoming.

**ROME / MEMIT / RippleEdits / AlphaEdit — "model editing".** Methods to surgically rewrite a *single
fact inside an LLM's weights* (ROME: one fact; MEMIT: thousands). **RippleEdits (Cohen et al. 2024)**
showed the "ripple problem": edit "the UK PM is X" and the model still fails on logical neighbors ("X's
spouse," "who leads the UK"). **AlphaEdit** constrains edits to a mathematical "null space" to reduce
damage. **Spectral collapse** = cumulative edits distort the weight matrix's dominant directions and
degrade the whole model. — *How I used it:* the hard evidence that **local edits don't propagate and
accumulate damage** — a caution about *any* update mechanism. Open question: does this even apply to a
*non-parametric* store like Baumy's (crux #6)? (Caveat: some of the spectral-collapse *mechanism* rests
on preprints, and one canonical "collapse" result was partly an implementation bug — the *phenomenon*
holds, the *mechanism* is unsettled.)

**Knowledge neurons (Dai et al. 2022) / Geva et al. (FFN as key-value memory) / Hase et al. (2023).**
Interpretability work on *where facts live* inside a transformer. Geva showed the feed-forward layers
act like **key-value memories** (a pattern in → a stored value out). "Knowledge neurons" claimed
specific neurons store specific facts. **Hase et al. (2023)** showed you can successfully *edit* a fact
at a layer *other* than where "causal tracing" says it's stored — i.e. **read-location ≠ edit-
location**. — *How I used it:* evidence that "where is a fact stored?" is genuinely murky in LLMs — and
(per the sign-flip) murky in the *same distributed way* as in brains, so not really a disanalogy.

**Superposition / SAE / dictionary learning (Elhage et al. 2022; Bricken et al. 2023; Templeton et al.
2024).** "Superposition" = a network packs *more features than it has neurons* by overlapping them.
**Sparse autoencoders (SAEs)** are a tool to *unpack* those overlapping features into individual,
interpretable "concepts" ("dictionary learning"). — *How I used it:* the "weighted vectors" you
referenced — how knowledge is actually distributed across weights, and the caution that the extracted
"concepts" may be an *imposed* description rather than the model's true ontology.

**Modern (continuous) Hopfield network ≈ attention (Ramsauer et al. 2021).** A mathematical proof that
the transformer's **attention** operation is equivalent to one step of retrieval in a modern Hopfield
network (an associative memory). — *How I used it:* the single "convergence" that *isn't* borrowing —
attention wasn't designed from Hopfield theory, yet turns out to *be* associative-memory retrieval.
(See the Hopfield/hetero-associative entries in D for the nuance you flagged.)

**PoisonedRAG (Zou et al. 2025) / MINJA.** Attacks that inject malicious content into a RAG/agent memory
so the system later retrieves it *as if trusted* and gives attacker-chosen answers. — *How I used it:*
concrete proof that a **writable memory is an unguarded attack surface** — directly relevant to Baumy's
whole "the LLM proposes, code disposes / trust-tiered writes" security model.

---

## D. Core jargon & concepts (the mechanisms)

**Auto-associative vs. hetero-associative memory.** *Auto-associative*: you give it a partial or noisy
version of a pattern and it completes/cleans it up to the *same* stored pattern (a classic Hopfield net
— give it half a face, get the whole face). *Hetero-associative*: you give it one pattern (a **key**)
and it returns a *different, paired* pattern (a **value**) — like a dictionary mapping word → definition.
— *Why the Hopfield nuance you flagged matters:* the "attention IS Hopfield retrieval" claim is
cleanest for the *auto*-associative case (pattern completion). But real attention uses *different*
weight matrices for keys and values (K ≠ V), making it **hetero-associative** — arguably a
*similarity-weighted lookup* rather than "completion." So my repeated phrase "retrieval is completion,
not lookup" is on shakier ground for actual transformers than the clean Hopfield story implies. That's
exactly crux #4 — is attention *completion* or *soft lookup*? (This is why the "nuances of how I used
Hopfield didn't quite make sense" — the auto- vs. hetero-associative distinction is the missing piece.)

**Hopfield network (original, Hopfield 1982).** A network that stores patterns as stable "attractor"
states; a noisy input settles into the nearest stored pattern — content-addressable, auto-associative
memory. The *modern/continuous* version (2021) massively increases capacity and equals attention. —
*How I used it:* the ancestor of "content-addressable completion," and the bridge to attention.

**Content-addressable vs. location-addressable memory.** *Content-addressable*: retrieve by *what
something is* (similarity/cue) — human memory, Hopfield nets, vector search. *Location-addressable*:
retrieve by *address/slot* — normal computer RAM (von Neumann). — *How I used it:* the crux distinction
between "memory as a store you index into" (computer metaphor) and "memory as associative completion"
(brain). Baumy's vector+graph retrieval is content-addressable.

**Pattern separation / pattern completion.** Two complementary hippocampal operations. *Separation*:
make similar experiences *more distinct* on storage (so they don't blur together — done by the dentate
gyrus). *Completion*: reconstruct a *whole* memory from a *partial* cue (done by region CA3). — *How I
used it:* separation is the biological version of "precision-first writes / don't over-merge";
completion is the biological version of "cue-driven associative recall."

**Autonoetic consciousness / "episodic-like" memory.** *Autonoetic* = the subjective sense of
mentally *re-living* a past event ("I remember *being there*"), which Tulving made the defining mark of
true episodic memory. Since you can't test for subjective re-experiencing in animals or machines,
Clayton & Dickinson coined **"episodic-*like*" memory** with an operational **what-where-when** test
instead. — *How I used it — crux #7:* whether calling an agent's store "episodic" is a *category error*
depends entirely on which definition you pick. Under the strict (autonoetic) one, it's a category
error; under the operational (what-where-when) one, the line is merely fuzzy — and it's an open
question whether agent stores even clear the *operational* bar or are just "a queryable timestamped log."

**Accessibility vs. availability.** *Available* = the memory is stored somewhere. *Accessible* = you can
actually retrieve it right now. Tulving & Pearlstone showed these come apart. — *How I used it:* the
proof that memory strength isn't a single scalar and retrieval isn't guaranteed by storage.

**Bi-temporal / bitemporal storage; soft invalidation.** A database technique that stamps every fact
with *two* timelines: when it was *true in the world* (event time) and when the system *recorded* it
(transaction time). To "update" a fact you **close its validity window** rather than deleting it, so
history stays queryable. — *How I used it:* the "reconcile/supersede, don't append, don't destroy"
convergence — and essentially what Baumy's own fact-lineage (`is_current`, `valid_from/valid_to`,
`superseded_by`) already does.

**AGM belief revision (Alchourrón, Gärdenfors & Makinson 1985).** A formal logical theory of how a
rational agent *should* update its beliefs when new information contradicts old — the philosophy/logic
of "expansion, revision, contraction." — *How I used it:* to argue the "you must reconcile updates, not
just append" principle isn't just an engineering habit, it's logically grounded. (Caveat the red team
raised: AGM assumes logical omniscience no real system has, so it can't *ground* an engineering
necessity.)

**Fan effect / fan-normalization.** See ACT-R above: the more associations a concept has, the slower/
weaker the retrieval of any one — and formally down-weighting by (log) number-of-connections. — *How I
used it:* a principled reason to *discount* highly-connected "hub" nodes in a memory graph so they
don't dominate.

**Need-probability / rational analysis.** The idea (Anderson & Schooler) that memory *should* prioritize
what you're statistically most likely to need next, and that it approximately does. — *How I used it:*
the normative anchor for *why* recency/frequency weighting is "rational," and the one human principle I
argued might genuinely transfer to machine memory design (contested — crux #3).

**Zipfian / power-law / heavy-tailed distribution.** A distribution where a few items are extremely
common and a long "tail" are rare (word frequencies, web-page popularity). — *How I used it:* the shape
of real information-demand streams that "need-probability" relies on — and the red-team point that the
three datasets used to "confirm" it are all the *same* Zipfian family, so not independent confirmations.

**Spectral / rank collapse.** In a matrix (like a weight matrix), degradation where the dominant
"directions" (singular values) that carry most of the useful signal get distorted or wiped out. — *How
I used it:* the proposed mechanism by which *cumulative* model edits wreck an LLM. Caveat: the source
paper actually argues residual/MLP components *prevent* this — so citing it as a "deployed failure law"
inverts it (a red-team catch).

**"Lost in the Middle" (Liu et al. 2024).** The finding that LLMs use information at the *start* and
*end* of a long context better than information in the *middle*. — *How I used it:* evidence that the
non-parametric "context memory" substrate has its own positional failure law. Caveat: much of it is a
*calibratable positional bias*, not a hard limit.

**Catastrophic interference / stability-plasticity tradeoff.** The fundamental tension: a system plastic
enough to learn new things fast is unstable enough to overwrite old ones. — *How I used it:* the reason
the fast/slow split and careful update policies exist at all.

**"Ripple problem".** (Model editing.) Editing one fact should logically force updates to its neighbors
("if X moved to city Y, then X's timezone changed too"), but local edits don't propagate. — *How I used
it:* the caution that a memory update is never truly "local" — it has a required *ripple set* — which is
exactly why Baumy's `derived_from`/supersession lineage matters.

**Provenance.** Keeping a record of *where a fact came from* and its history, so changes are auditable
and reversible. — *How I used it:* the thing that dissolves "over-merge is irreversible" — if you keep
provenance (as Baumy does), a bad merge is recoverable, so "precision-first write" becomes a design
choice, not an iron law (crux #5).
