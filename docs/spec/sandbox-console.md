# The console — looking inside Baumy's brain (and, later, a sandbox to poke it)

**Status:** Phase 1 (read-only console) implemented. Phases 2–3 designed, not built.

## Why

Baumy is a stateful, background-driven system whose most important behaviour happens when nobody
is watching: a cron writes a fact, a reminder waits three days, a reflect sweep rewrites a profile.
When it goes wrong the only surface is the house group — which is to say, the blast radius *is* the
feedback mechanism. The heads-up regression (`docs/spec/event-surfacing.md` v2) was found by a
housemate reading five garbage lines at breakfast, and the months-late reminder was found the same
way. Both were visible in the database hours earlier.

So: a place to see what Baumy currently believes, what it is *about to do*, and eventually to run
"what happens if…" without touching the house.

## What the prior art agrees on (and where we already comply)

Surveyed: Inngest dev server, Temporal (Web UI + time-skipping test server), LangGraph/LangSmith
time travel, Langfuse/Phoenix/Braintrust/Weave, seven schema-derived admin panels, and the
Postgres-sandbox toolchain (Neon branching, template DBs, PGlite, clock faking).

1. **Nobody edits live state — every intervention appends or forks.** Temporal offers no state
   edit at all (signal / reset / new run). Inngest's whole mutation surface is app CRUD plus
   `invokeFunction` / `cancelRun` / `rerun`; its "edit and rerun from step" reads the original
   run's trace, memoises completed steps into a **new** run, and substitutes the edited input.
   LangGraph's `update_state()` writes a **new child checkpoint** rather than mutating one, and
   resuming is a separate call — so an edit is durably recorded even if nobody runs it.
   *We already comply:* facts supersede rather than update.
2. **One primary object, everything else derived from it.** Temporal: the workflow execution, with
   all state a fold over one append-only log. Langfuse: session → trace → observation, and what you
   click is the single LLM call.
3. **Derived columns are where admin panels break.** Full-row write-back is the root cause of
   nearly every derived-column bug in the survey; Prisma Studio refuses tables containing extension
   types outright (it would refuse ours); Django's own `SearchVectorField` is editable by default.
   The correct shape is Supabase's: edit the source text, invalidate the derived value, let a queue
   recompute — which is exactly what forget-purge already does here.
4. **Do not fake the clock ambiently.** `libfaketime` / container clocks move Postgres's `now()`
   too, and Inngest's scheduler runs on real time regardless, so the app and the durable-execution
   engine immediately disagree about "now". Inject a clock instead.

## The primary object is the message

One inbound message fans out into evidence, facts, reminders, list mutations, a reply, sometimes a
confirm card. The console groups by that message rather than showing five disconnected tables. The
join already exists: `facts.source_memory_item_id` → the evidence note, and
`reminders.event_fact_id` → the fact a heads-up is anchored to.

Three views:

- **Timeline** — recent memory items, each with the facts it produced and the heads-ups those facts
  scheduled. "What did Baumy make of what we said?"
- **Pending** — everything the system is *about to do*, ordered by fire time and evaluated against a
  given `now`. This is the view that makes background behaviour legible before the house sees it.
- **Fact chain** — a fact rendered as its supersession lineage (`derived_from_fact_id` ←→
  `superseded_by`), not as a row. A fact's meaning is its history.

We are better placed than Temporal on pending work: their pending timers are *inferred* from the
event log, ours are literally rows in `baumy_reminders` with a `(status, fire_at)` index.

## Column policy — the data-type answer, made executable

`lib/console/policy.ts` classifies **every column of every table** into one of four classes. The
console renders from the policy, so a column cannot reach the UI without a deliberate verdict, and
`lib/console/__tests__/policy.test.ts` fails if `db/schema.ts` grows a column the policy doesn't
mention. Schema drift therefore cannot silently introduce an unpoliced field.

| Class | Meaning | Examples |
|---|---|---|
| `open` | Plain data. Safe to display; the Phase-3 edit allowlist is drawn from here. | `memory_items.content`, `reminders.content`, `list_items.item`, `entities.canonical_name` |
| `derived` | Computed from other columns. Display read-only; **never** hand-write — fix the source and re-derive. | `memory_embeddings.embedding`, `memory_items.content_tsv`, `list_items.item_normalized` |
| `provenance` | The audit and trust substrate. Display read-only; it is only worth anything if it is known-unmodified. | `facts.is_current`, `superseded_by`, `derived_from_fact_id`, `source_memory_item_id`, `trust_level`, `recorded_at` |
| `secret` | Never selected, never rendered, at any access level. | `memory_items.content_encrypted`, `facts.value_ciphertext`, `dashboard_login_tokens.token_hash` |

Two notes that matter more than they look:

- **`content_tsv` is `GENERATED ALWAYS … STORED`** (migration `0006`), so Postgres itself rejects a
  direct write. **`embedding` is application-maintained** and has no such protection — the database
  will happily accept a hand-typed vector, and retrieval filters on `model = EMBED_MODEL`, so the
  poisoning would be silent. Policy is the only guard there.
- **Secrets are already structurally absent** from the displayable columns: `memory_items.content`
  holds only a non-secret descriptor and `facts.object_value` is NULL when `is_secure`. The console
  can render those columns *precisely because* they can never contain a decrypted secret. It never
  decrypts, and there is no code path that would let it.

## Editing a fact means replaying `reconcileFact`, not an UPDATE

Documented here because it is the single sharpest edge in the data model, and Phase 3 depends on it.

`baumy_facts` is trust-gated, bitemporal and soft-superseding. The invariant "exactly one
`is_current` row per (group, subject, predicate)" is enforced **only in code**
(`lib/memory/facts.ts`) — there is no unique index. An in-place UPDATE therefore silently breaks:

1. the **trust gate** (a new value may only supersede one of ≤ its own trust) — the memory-poisoning
   defence;
2. **sensitivity re-scan** — an edited value that now trips secure must be encrypted and its
   plaintext NULLed;
3. **entity re-resolution** — an object that is a node makes an edge, not an attribute;
4. **`recorded_at`** — the reflect cron picks people whose newest fact is newer than their newest
   profile, so an edit that doesn't move `recorded_at` leaves that person's profile permanently
   stale;
5. **`event_at`** — must come from `parseEventDate`, never a bare chrono call.

And a hard DELETE is worse than an edit: `reminders.event_fact_id` is `ON DELETE CASCADE`, so
deleting a fact vaporises its scheduled heads-ups, while orphan-cancellation only fires on
`is_current = false`.

## Access

Owner-only. `requireOwner` (`lib/auth/require-admin.ts`) re-checks the live roster on every request —
the session cookie proves identity, never authorisation. The rest of `/admin` stays member-visible;
the console is a strictly narrower surface, gated separately and defence-in-depth re-checked in the
page itself, not just the layout.

## Roadmap

**Phase 1 — read-only console (done).** Timeline, pending, fact chains, column policy + its
drift test. No writes. Everything takes an injectable `now`, so Phase 2 gets the views for free.

**Phase 2 — the time machine.** The cores are already injectable: `deliverDueReminders(db, now)`,
`runEventSurfacingScan(db, groupId, now, tz)`, `runConsolidationSweep(...)`,
`buildDigest/weeklyReport/guestReport(db, groupId, now)`, `dueScheduled(before, notBefore)`. A
sandbox drives *those* at a simulated timestamp rather than trying to fake Inngest's cron. The
remaining wall-clock reads to close first: `lib/ai/reply.ts:29` (`houseToday()` with no argument —
the reply model's "today" is the wall clock), `lib/inngest/functions/ingest.ts:185` and `:284`
(`parseWhen` without a `now`), `lib/inngest/functions/reminders.ts:152` (slot gate reads
`DateTime.now()` one line before the `now` it was handed), `reconcileFact`'s hard-coded
`validFrom: new Date()`, and the confirm-card / magic-link expiry walls, which are hard-wired on
both the create and the check side. 17 `defaultNow()` columns are unreachable from a JS clock —
`facts.recorded_at` is load-bearing, not audit, so the write paths must accept an explicit
timestamp.

Two warnings from the survey, both directly relevant: **fast-forwarding produces a reminder flood**
(jump six months and every scheduled reminder is due at once — precisely the bug the staleness
window now prevents, which is a good first test to write), and **a sandbox must never inherit
`TELEGRAM_BOT_TOKEN` / `BAUMY_HOUSE_CHAT_ID`**, or it posts to the real house.

**Phase 3 — surgical editing.** Propose/apply, never direct SQL. Fact edits go through
`reconcileFact` as superseding rows; text edits invalidate the embedding and let the reembed sweep
recompute; the write allowlist is derived from the `open` class and enforced **server-side**,
independent of the form, so a hand-crafted POST cannot widen it.

**Sandbox substrate (Phase 2+):** a Neon **schema-only branch** (`init_source: schema-only`) —
production shape, zero production data, which deletes the anonymisation problem rather than
mitigating it — with a branch TTL so it disposes of itself and reset-from-parent for one-click
reset (same connection string, so env vars keep working).

## Deliberately not doing

- **Self-hosting Langfuse or Phoenix.** Langfuse v3 is six containers including ClickHouse, with
  reports of the volume inflating at zero load. For one house, the shape is worth stealing (a
  `source_trace_id`-style provenance FK; a dataset-run join row that makes diffing a self-join) and
  the infrastructure is not.
- **A generic schema-derived grid.** The survey's own bug trackers are the argument: the generic
  tools break on exactly the columns we have most of.
- **Live-editing Inngest run state.** Not exposed by Inngest, and the durable state we care about is
  in Postgres anyway.
