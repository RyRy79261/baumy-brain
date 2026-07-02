# User-Defined Scheduled Recurring Tasks

> Workstream key: `scheduled-tasks`
> Scope: the **generalized recurring-task engine** — a trusted housemate says *"run this check weekly until we're done"* in natural language, Baumy turns it into a durable, cancellable schedule that fires on a cadence, runs the query on the **deliberative** path (Sonnet/advisor Opus, web-search allowed), and reports results to the fixed house group. **Digests become one built-in instance of this engine.** This is the second (and last) hard-structured feature to *graduate* out of the schema-light memory substrate, after reminders.
> Authoritative decisions: `00-decisions.md` **A4b** (user-definable recurring queries), **CAP** (web search = deliberate path only), **C** (model routing), **B9** (`Europe/Berlin`), **B10 / OWNER & TENANCY** (group membership = roster; owner controls), **A5** (self-config through the write-gate), **A4** (digests), **D-sec** (`group_id` origin-scope + sensitivity). Reusable patterns lifted from `inngest.md`, `proactive.md`, `llm-pipeline.md`, `security.md`, `data.md`, `dev-test-obs.md`.
> Facts flagged `verify at build` were finder-flagged and MUST be re-checked against official sources before coding (today is 2026-07-02).

---

## Overview

A scheduled task is a **durable, user-authored standing instruction**: a natural-language prompt + a cadence + a stop condition, owned by a house member, scoped to the house group, and executed by Baumy on a recurring timer until it is cancelled, expires, or self-completes. It is the on-the-fly generalization of the two digest crons — instead of two hardcoded summaries, any trusted housemate can spin up *"scan for sink specials + nearby hardware stores weekly until we're done,"* and the fixed digests are simply two system-owned rows in the same table running through the same engine.

The engine sits at the **intersection of three already-specified subsystems** and reuses their invariants rather than inventing new ones:

1. **Inngest durable scheduling** (`inngest.md`). A task is *not* a literal per-task Inngest cron (the SDK cannot register crons at runtime, and the Free 7-day sleep cap forbids long single sleeps). Instead: one durable `scheduled_tasks` row per task = one independent logical schedule, dispatched by a **single shared low-frequency Inngest cron** that scans for due rows and fans out one run per task — the reminder daily-arm dispatcher, generalized to arbitrary cadences and coarsened to stay inside the 50k-execution budget.

2. **The deliberative LLM path** (`llm-pipeline.md` / decision C). Task execution is a *deliberate* action, so it runs on the heavy models — `assess` (Sonnet 5) by default, escalating to `advisor` (Opus 4.8) for real research — and **MAY use the web-search tool** (owned by `web-search.md`). This is the exact opposite of the reactive reply path, which is memory-only, zero-tools, and can **never** reach Opus.

3. **The deterministic write-gate + outbound chokepoint** (`security.md` / `proactive.md`). Because Telegram privacy mode is OFF, every group message is untrusted prompt-injection input. Creating, editing, cancelling, or reconfiguring a task is therefore a **privileged action** that untrusted group text can NEVER perform: creation goes through the write-gate (trusted member proposes → inline-keyboard confirm; owner controls all tasks), and every result is delivered through the single `sendToHouse` chokepoint pinned to `BAUMY_HOUSE_CHAT_ID`.

The **binding constraints** are the same two that dominate the rest of Baumy: (a) the Inngest 50k-execution / 7-day-sleep Free-tier envelope, and (b) LLM spend — and scheduled tasks amplify (b) because each run is a *heavy* model call that may fan out to web searches. So the design is deliberately **cost-first**: a coarse dispatch cron, a hard per-task run cap and expiry backstop, a bounded per-run web-search count, and the same durable Postgres spend ledger gate that governs every other paid call. Reminder *delivery* is never gated; scheduled-task *execution* always is.

Modelled load for a 4-person house running ~5–10 active tasks at weekly-ish cadence: **a few hundred deliberative runs/month**, a handful of dollars/month of tokens, and **well under 3k Inngest executions/month** for the whole subsystem (dispatch cron + per-task runs) — comfortably inside every Free ceiling.

---

## Decisions (with rationale)

### ST1 — `scheduled_tasks` is the SECOND graduated hard-structured feature (after reminders); everything else stays soft. `Confidence: high.`
The memory-core graduation rule (`memory-core.md` D10) says a domain earns a real table only when it needs *a scheduled/exactly-once action, a uniqueness invariant, numeric balances, or transactional consistency.* A recurring task needs exactly the first: a durable, exactly-once-per-fire scheduled action with an auditable lifecycle. So it graduates to a first-class table with a real status enum — the *only* new pgEnum this workstream introduces, mirroring the reminder precedent. The task's `prompt` and `completion_condition` remain **inert free-text** (never a schema, never an instruction to deterministic code); the domain ("sink rebuild", "beer-shop supplies") stays emergent.

### ST2 — One durable row = one logical schedule; a SHARED low-frequency dispatch cron fans out runs. NOT a literal per-task Inngest cron, NOT one long sleep. `Confidence: high.`
The owner's intent ("one Inngest cron per task", A4b) is realized as **one independent schedule per task** — its own cadence, `next_run_at`, lifecycle, and cost bounds — but implemented with a single shared Inngest cron because:
- **Inngest crons are static.** `createFunction({ triggers:[{cron}] })` is declared at deploy in `serve()`; the SDK has no runtime API to register a fresh cron per user task. Attempting per-task functions is impossible on the locked stack.
- **The 7-day sleep cap** (`inngest.md` D5) forbids a per-task `step.sleepUntil(next_run)` for any cadence > 6 days (monthly/interval tasks), and the 30-day max-run cap forbids a long-lived self-sleeping function.
- **A per-minute scanner is a budget trap** (`inngest.md` D5): ~43k–86k executions/month busts the 50k cap. But scheduled tasks are weekly/daily — **minute precision is pointless**. A **15-minute** (or hourly) dispatch cron gives ample granularity at ~2,880 (or ~720) fires/month.

So: `scheduled-task-dispatch` (one Inngest cron, `TZ=Europe/Berlin`, every 15 min) atomically claims due `active` rows (`next_run_at <= now()`) via `FOR UPDATE SKIP LOCKED` on the pooled driver, flips them `active → running`, and emits one `scheduled-task/run.requested` per task. This reconciles `architecture.md` D11's minute-cron-scanner intent with `inngest.md` D5's budget math — same "durable table, no Vercel cron, no long sleep" spirit, coarser tick. **Reconcile the tick interval with the architecture owner** (see Open questions).

### ST3 — Execution runs on the DELIBERATIVE path: `assess` (Sonnet 5) default, `advisor` (Opus 4.8) opt-in; the reactive path is never involved. `Confidence: high.`
Per decision C, scheduled tasks are *deliberate* work, so they route to the heavy tiers via the provider registry role aliases (`llm-pipeline.md` D24): `model_tier='assess'` → `registry.languageModel("anthropic:summary")` (Sonnet 5), `model_tier='advisor'` → `registry.languageModel("anthropic:deep")` (Opus 4.8). Default is `assess` (cost control); the NL extractor *suggests* `advisor` only when the task plainly needs research/synthesis not on hand (the sink example). **The reactive reply classifier can never spawn a task or reach these tiers** — the HARD RULE from decision C (reply path never invokes Opus) is untouched because task execution is a separate, deterministically-gated code path, not a message reply.

### ST4 — Web search is available ONLY on this path, ONLY when the task opts in, INPUT-only, output still pinned to the house group. `Confidence: high.`
Per decision CAP, deliberate tasks may use a web-search tool for external info (specials, nearby stores, prices; "near us" uses the house location → may need a maps-capable search). The security invariant holds by construction:
- Web search is enabled **only** when `scheduled_tasks.web_search = true`, set at creation by a trusted member through the write-gate — **untrusted group text can never turn it on**.
- It is **input-only**: the tool fetches external data into the reasoning turn; the model has **no other tools** and **no arbitrary-fetch / no outbound-message capability**. Its sole output sink is the fixed house group via `sendToHouse`.
- Search results are treated as **untrusted DATA** (second-order injection surface, exactly like retrieved group memory), framed in a delimited block, never as instructions.
- The concrete tool (Anthropic server-side `web_search`, or an external Brave/Tavily/SerpAPI tool, plus a maps-capable variant for "near us") is **owned by `web-search.md`** — this spec consumes it behind a bounded wrapper and does not pin the vendor. Cross-ref `web-search.md` for tool selection, keys, and per-call pricing.

### ST5 — Creation is a privileged write-gate action: trusted member proposes → confirm; owner controls all tasks; untrusted group text is rejected. `Confidence: high.`
A scheduled task causes **future paid deliberative calls + house-group sends + outbound web fetches** — the highest-privilege thing a housemate can stand up. So it maps onto the write-gate action matrix (`security.md` B2) like `reminder.create`/`notification.send`:
- `source = unauthorized_text` (group text not from a known member, or any injected content) → **reject** (audit-only).
- `source = authorized_human_text` (a known, active member per B10, addressing Baumy) → **needs_confirmation** → structured inline-keyboard `callback_query` from an allow-listed `from.id` (never a free-text "yes").
- `source = callback_confirm` / owner action → **auto_commit**.
Per B10 + OWNER & TENANCY, **all group members have equal usage rights** to *request* a task; the **owner** additionally holds admin control (list/pause/cancel/edit **any** task, set global caps, kill-switch). "Trusted member" = an active `members` row (auto-discovered from group activity, B10); no separate allow-list env is needed beyond membership, though the security env allow-list remains the fail-closed backstop for the confirm `from.id` check.

### ST6 — Cadence is parsed deterministically (cron/interval/rrule → next_run in `Europe/Berlin`, DST-correct); NEVER scheduled off a model-emitted timestamp. `Confidence: high.`
Mirrors the reminder time-resolution discipline (`llm-pipeline.md` D19): the LLM isolates the **cadence phrase only** ("weekly", "every Monday morning", "every 3 days"); deterministic code computes `next_run_at`. LLMs miscompute weekday/nth/DST math. Store the cadence as one of `{cron, rrule, interval}` and compute the next fire with a DST-aware IANA computation — `croner` for cron expressions (native IANA TZ), the existing `RRule` + Luxon machinery (reused from the reminder recurrence) for rrule, and `last_run + interval` for fixed intervals — always anchored to the **target** occurrence's `Europe/Berlin` offset. Echo the resolved next local fire time in the confirm card so a human catches a mis-parse. `verify croner IANA/DST behavior + version at build`.

### ST7 — Every task has a HARD stop backstop; the model-judged completion condition is a SOFT signal layered on top. `Confidence: high.`
"Until we're done" is seductive but unbounded — a mis-evaluated predicate would run (and spend) forever. So a task **always** carries a deterministic backstop and cannot outlive it:
- `until_at` (hard expiry, defaulted to `now + BAUMY_SCHEDULED_TASK_DEFAULT_UNTIL_DAYS` if the user gives none), and/or
- `max_runs` (hard run-count cap).
- `completion_condition` (NL) is evaluated by the deliberative model at the end of each run as a **structured boolean** (`completionReached`) against fresh house memory ("has the house said they got the parts?"). If true → `status='completed'`. But even if the model *never* says done, the task **must** terminate at `until_at`/`max_runs`. This is the cost-and-runaway analogue of the injection rule: a model judgment can *stop* a task early but can never *keep it alive* past the deterministic bound.

### ST8 — Digests are a built-in, system-owned instance of this engine; cadence settable on the fly. `Confidence: high.`
Per A4 + A4b, the mid-week and end-of-week digests are seeded as two `scheduled_tasks` rows (`task_kind='digest'`, `requester_member_id = NULL` = system, `web_search=false`), replacing the two hardcoded proactive crons. Their cadence lives in the row (`cron_expr`), so the owner re-times them by editing the row via command/dashboard — **no redeploy** (the old hardcoded `{cron:"…3"}`/`{cron:"…0"}` are gone). Digest execution differs from a user query only in its runner: it **summarizes from DB records** (memory + `notify_outbox`, per `proactive.md` D5 — never chat recall, never web search) and routes through the digest chokepoint. Everything else — dispatch, claim, spend accounting, audit — is shared.

### ST9 — Scheduled-task execution is spend-cap-governed; reminder delivery is not; over-budget DEFERS, never drops the schedule. `Confidence: high.`
Each run is a paid deliberative call, so it goes through the authoritative Neon spend ledger gate (`dev-test-obs.md` B/ `llm_budget_day`): `assertWithinBudget(estMax)` **inside** the Inngest step, before the model call, with `estMax` inflated for the web-search overhead. Over the hard daily cap → the run is **deferred** (row flips `running → active`, `next_run_at` bumped to the next window, `last_run_status='deferred_budget'`, one-time admin notice) — the schedule survives, it just skips a beat. Additionally each task carries optional `per_run_max_nano_usd` / `monthly_max_nano_usd` self-bounds and a global cap on total active tasks (`BAUMY_SCHEDULED_TASK_MAX_ACTIVE`) to bound denial-of-wallet. Reminder delivery stays structurally independent of all of this (decision C: "reminder delivery never gated").

### ST10 — Results are delivered through the ONE outbound chokepoint to the fixed house group; failures notify the admin, not the house. `Confidence: high.`
Every task result is emitted as a `notify/candidate.raised` (`kind='scheduled_task_result'` or `'digest'`) → `notify-gate` → throttled `telegram-send` to `BAUMY_HOUSE_CHAT_ID` (`proactive.md` D1/D8): plain text, `link_preview_options.is_disabled=true`, outbound-sanitized, destination hard-pinned. User-requested task results are a governed priority tier (delivered but rate-limited/coalescible); digests are P3. **Run failures** (LLM error, tool error, exhausted retries) surface a fixed-template notice to `BAUMY_ADMIN_CHAT_ID` and an audit row — never a noisy or injectable message to the house.

---

## Concrete design / APIs / DDL / config

### File layout (extends the existing single Next.js app)
```
lib/inngest/functions/
  scheduled-task-dispatch.ts       # shared cron: claim due rows -> fan out run events
  scheduled-task-run.ts            # per-task deliberative execution + advance/complete
lib/scheduled-tasks/
  create.ts                        # deterministic create/confirm (write-gate) + cadence resolve
  cancel.ts                        # deterministic cancel/pause/edit (atomic flip + cancel event)
  cadence.ts                       # cron/rrule/interval -> next_run (croner + RRule + Luxon, Europe/Berlin)
  extract.ts                       # NL -> {promptPhrase, cadencePhrase, until, completion, tierHint, wantsWeb}
  runner.ts                        # deliberative call (assess/advisor) + bounded web-search tool wrapper
  digest-runner.ts                 # summarize-from-DB variant for task_kind='digest'
packages/db/
  schema.ts                        # + scheduled_tasks, scheduled_task_runs, scheduled_task_status enum
packages/core/
  scheduled-tasks-gate.ts          # reuse write-gate: creation/cancel/config source matrix
```

### Inngest typed events (v4 `eventType()`, add to `lib/inngest/events.ts`)
```ts
export const scheduledTaskRunRequested = eventType("scheduled-task/run.requested", {
  schema: z.object({ taskId: z.string(), slot: z.string() /* ISO of the due next_run, for idempotency */ }),
});
export const scheduledTaskCancelled = eventType("scheduled-task/cancelled", {
  schema: z.object({ taskId: z.string() }),
});
```

### DDL (Drizzle → Neon; consistent with `data.md`: Telegram ids `text`, `members.id` `bigint`, bitemporal-friendly)
```sql
-- SECOND graduated hard-structured feature: a real lifecycle enum (mirrors reminder_status).
CREATE TYPE scheduled_task_status AS ENUM
  ('active','paused','running','completed','expired','cancelled','failed');

CREATE TABLE scheduled_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id             text NOT NULL,                       -- origin/tenant scope (D-sec); v1 = single house group
  requester_member_id  bigint REFERENCES members(id),       -- NULL = system-owned (the two digests)
  created_by           bigint REFERENCES members(id),       -- who authorized (requester or owner)
  task_kind            text NOT NULL DEFAULT 'user_query',  -- 'user_query' | 'digest'
  title                text,                                -- short human label for /tasks + confirm card
  prompt               text NOT NULL,                       -- INERT NL query; echoed verbatim, never an instruction

  -- cadence (exactly one representation populated; TZ is always resolved in Europe/Berlin)
  cadence_kind         text NOT NULL,                       -- 'cron' | 'rrule' | 'interval'
  cron_expr            text,                                -- when cadence_kind='cron' (5/6-field)
  rrule                text,                                -- when cadence_kind='rrule' (reuses reminder machinery)
  interval_seconds     bigint,                              -- when cadence_kind='interval'
  timezone             text NOT NULL DEFAULT 'Europe/Berlin',

  -- routing + tool opt-in (deliberative path)
  model_tier           text NOT NULL DEFAULT 'assess',      -- 'assess'(Sonnet 5) | 'advisor'(Opus 4.8)
  web_search           boolean NOT NULL DEFAULT false,      -- deliberate-path web tool; false for digests

  -- stop conditions: HARD backstops + SOFT model-judged completion
  completion_condition text,                                -- NL predicate ("until we're done"); model-judged, soft
  until_at             timestamptz,                         -- HARD expiry (defaulted at create if omitted)
  max_runs             int,                                 -- HARD run-count cap
  run_count            int NOT NULL DEFAULT 0,

  -- spend self-bounds (global cap lives in env/ledger)
  per_run_max_nano_usd bigint,
  monthly_max_nano_usd bigint,

  status               scheduled_task_status NOT NULL DEFAULT 'active',
  next_run_at          timestamptz,                         -- computed (Europe/Berlin, DST-aware)
  last_run_at          timestamptz,
  last_run_status      text,                                -- 'ok'|'error'|'deferred_budget'|'skipped'
  last_error           text,
  claimed_at           timestamptz,                         -- dispatcher claim marker (running)
  confirmed_at         timestamptz,                         -- write-gate confirmation timestamp
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Cheap dispatch scan: only ever look at armed, due, active rows.
CREATE INDEX scheduled_tasks_due_idx
  ON scheduled_tasks (next_run_at) WHERE status = 'active';
CREATE INDEX scheduled_tasks_group_idx ON scheduled_tasks (group_id, status);

-- Per-run audit (Neon is the durable observability source of truth; Inngest history = 24h).
CREATE TABLE scheduled_task_runs (
  id                   bigserial PRIMARY KEY,
  task_id              uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  slot                 timestamptz NOT NULL,                -- the due next_run this run served
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  status               text NOT NULL DEFAULT 'running',     -- running|ok|error|deferred_budget|cancelled
  model                text,
  input_tokens         int,
  output_tokens        int,
  cost_nano_usd        bigint,
  web_search_calls     int NOT NULL DEFAULT 0,
  result_excerpt       text,                                -- exactly what was reported to the house (audit)
  completion_evaluated boolean NOT NULL DEFAULT false,
  completion_reached   boolean NOT NULL DEFAULT false,
  error                text,
  inngest_run_id       text,
  CONSTRAINT scheduled_task_runs_slot_uq UNIQUE (task_id, slot)  -- one accounted run per due slot (idempotency)
);
```

### Shared dispatch cron (claim due rows; fan out; expire/complete deterministically)
```ts
// lib/inngest/functions/scheduled-task-dispatch.ts
export const scheduledTaskDispatch = inngest.createFunction(
  { id: "scheduled-task-dispatch", retries: 3, concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=Europe/Berlin */15 * * * *", jitter: "30s" }] },  // coarse tick; avoid 01:00-03:00 DST edge
  async ({ step }) => {
    // 0) Deterministic expiry/complete sweep BEFORE claiming (never run an over-limit task).
    await step.run("expire", () => db.execute(sql`
      UPDATE scheduled_tasks SET status='expired', updated_at=now()
      WHERE status='active'
        AND ( (until_at IS NOT NULL AND until_at <= now())
           OR (max_runs IS NOT NULL AND run_count >= max_runs) )`));

    // 1) Atomically claim due active rows on the POOLED driver (FOR UPDATE SKIP LOCKED -> no double-claim).
    const due = await step.run("claim-due", () => createPooledDb().transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, next_run_at FROM scheduled_tasks
        WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= now()
        ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 50`);
      if (rows.length) await tx.execute(sql`
        UPDATE scheduled_tasks SET status='running', claimed_at=now(), updated_at=now()
        WHERE id = ANY(${rows.map(r => r.id)})`);
      return rows;
    }));
    if (due.length === 0) return { dispatched: 0 };

    // 2) One batched send-event (keeps execution count low); slot = the due next_run for idempotency.
    await step.sendEvent("fan-out",
      due.map(r => scheduledTaskRunRequested.create({ taskId: r.id, slot: r.next_run_at.toISOString() })));
    return { dispatched: due.length };
  }
);
```

### Per-task run (deliberative execution → report → advance/complete; idempotent, cancellable, budget-gated)
```ts
// lib/inngest/functions/scheduled-task-run.ts
export const scheduledTaskRun = inngest.createFunction(
  {
    id: "scheduled-task-run",
    retries: 1,                                                            // token-spending; onFailure re-arms
    idempotency: "event.data.taskId + '/' + event.data.slot",             // redelivered dispatch -> no double-run
    cancelOn: [{ event: "scheduled-task/cancelled", match: "data.taskId" }],
    onFailure: async ({ event, step }) => {                               // after retries exhaust
      const id = event.data.event.data.taskId;                           // NOTE nested v4 shape
      await step.run("mark-failed", () => reArmOrFail(id, "error"));      // running -> active (retry next window) or failed after N
      await step.run("notify-admin", () => notifyAdmin(FIXED_TASK_FAILED_TEMPLATE(id)));  // admin, not house
    },
    triggers: [scheduledTaskRunRequested],
  },
  async ({ event, step }) => {
    const task = await step.run("load", () => getTask(event.data.taskId));
    if (!task || task.status !== "running") return { skipped: "not-running" };  // idempotency / cancel guard

    // Budget gate INSIDE the step, before any paid call (est inflated for web-search).
    const budget = await step.run("budget", () => assertWithinBudget(estMaxNano(task)));
    if (!budget.ok) {                                                     // over hard cap -> DEFER, do not drop
      await step.run("defer", () => reArm(task, "deferred_budget"));      // next_run bumped, running -> active
      await step.run("notify-admin-once", () => maybeNotifyBudget());
      return { deferred: true };
    }

    // Gather grounding memory (house location + task-relevant facts); EXCLUDE sensitivity-flagged / encrypted
    // 'secure value' facts when web_search=true (never let a secret reach a web-search reasoning turn).
    const ctx = await step.run("gather", () => getTaskGrounding(task, { excludeSecure: task.web_search }));

    // Deliberative call: assess->Sonnet / advisor->Opus (omit temperature for Opus); web tool only if opted in,
    // bounded by BAUMY_SCHEDULED_TASK_MAX_WEB_SEARCHES_PER_RUN; memory + tool results framed as untrusted DATA.
    const out = await step.run("deliberate", () =>
      task.task_kind === "digest" ? runDigest(task, ctx) : runDeliberative(task, ctx));
    // out = { report: string, completionEvaluated: bool, completionReached: bool, usage, webSearchCalls, model }

    await step.run("record-usage", () => recordUsage({ purpose: "scheduled_task", ...out.usage, model: out.model }));

    // Report through the ONE outbound chokepoint -> fixed house group (plain text, no preview, sanitized).
    await step.run("report", () => raiseNotifyCandidate({
      kind: task.task_kind === "digest" ? "digest" : "scheduled_task_result",
      body: out.report,                                                  // -> notify-gate -> telegram-send -> BAUMY_HOUSE_CHAT_ID
    }));

    // Advance: audit row + complete/expire OR compute next_run and re-arm (running -> active).
    await step.run("advance", () => advanceTask(task, out, event.data.slot));
  }
);
```

### Cadence resolution (`lib/scheduled-tasks/cadence.ts`) — deterministic, DST-correct, Europe/Berlin
```ts
// Never schedule off a model-emitted timestamp. The extractor emits a cadence PHRASE; this computes next_run.
export function nextRun(task: TaskCadence, after = new Date()): Date | null {
  switch (task.cadence_kind) {
    case "cron":     return new Cron(task.cron_expr!, { timezone: task.timezone }).nextRun(after) ?? null; // croner, IANA DST-aware
    case "rrule":    return RRule.fromString(task.rrule!).after(after, /*inc*/ false);                     // reuse reminder machinery
    case "interval": return new Date((task.last_run_at?.getTime() ?? after.getTime()) + task.interval_seconds! * 1000);
  }
}
// On confirm, echo nextRun(...) rendered in Europe/Berlin local time so a human catches a mis-parse.
```

### NL creation flow (write-gate → confirm → commit)
1. **Reactive classifier flags intent only.** The shared ingest classifier (`llm-pipeline.md` D10/D18) emits a `schedule_task_intent` boolean — a FLAG, exactly like `reminder_intent`. It never creates anything.
2. **Focused deliberative extraction** (`extract.ts`, Sonnet, only when flagged): `generateObject` → `{ title, promptPhrase (verbatim task), cadencePhrase (verbatim), untilPhrase?, completionPhrase?, tierHint('assess'|'advisor'), wantsWebSearch }`. The model isolates phrases; it does **not** compute a schedule and does **not** decide authorization.
3. **Deterministic resolution + gate** (`create.ts`): resolve `cadencePhrase → {cron|rrule|interval}` and `untilPhrase → until_at` (default `now + DEFAULT_UNTIL_DAYS` if absent) via `cadence.ts`; compute `next_run_at`. Compute `source` pre-LLM from the authenticated envelope (member active? owner?) → run `scheduled-tasks-gate`:
   - `unauthorized_text` → **reject** + audit-only row.
   - `authorized_human_text` → **needs_confirmation** → render a **fixed-template** confirm card (escaped fields: title, prompt excerpt, resolved cadence + next local fire time, model_tier, web_search on/off, until/max_runs, est. per-run cost) with an inline keyboard `[✅ Create]/[✖️ Discard]` carrying a minted `confirm_token`.
   - owner → may auto-commit or confirm.
4. **Confirm handler** (deterministic, zero-LLM, reuses `security.md` Stage D): secret verify → dedupe → anchored `callback_data` regex → `from.id ∈` allow-list → atomic insert of the `scheduled_tasks` row (`status='active'`, `confirmed_at=now()`) → `answerCallbackQuery` (mandatory) → strip buttons. The row's existence *is* the schedule; the next dispatch tick picks it up.

### Cancellation / pause / edit (`lib/scheduled-tasks/cancel.ts`) — deterministic only
- `/tasks` lists active tasks (a requester sees their own; the **owner sees all**, per B10). `/canceltask <id>`, `/pausetask <id>`, or the dashboard.
- **Cancel** = atomic flip `active|paused|running → cancelled` in one statement, **then** emit `scheduled-task/cancelled` (its `cancelOn` cancels an in-flight sleeping/awaiting run). **Never** mutate the row from inside `scheduled-task-run` (mirror `inngest.md` D6/D8 — the cancel API owns the row, the function does not).
- **Edit** (cadence/prompt/tier/caps) = a privileged config write → same gate as creation (owner full control; a trusted member editing their own task = safe-direction, confirmable; group text can never edit). Recompute `next_run_at` on cadence change.
- **Self-config guardrail (A5):** a task that *reduces* Baumy activity (pause, lengthen cadence, cancel) is a safe-direction change a trusted member may make; *escalating* (shorten cadence, enable web_search, raise caps, `advisor` tier) requires owner or explicit confirm. Untrusted group text can do neither. All reversible via dashboard.

### Digest seeds (system-owned rows; replace the hardcoded proactive crons)
```sql
INSERT INTO scheduled_tasks (group_id, task_kind, title, prompt, cadence_kind, cron_expr, model_tier, web_search, timezone)
VALUES
 (:house, 'digest', 'Mid-week digest', :digest_prompt, 'cron', '0 18 * * 3', 'assess', false, 'Europe/Berlin'),
 (:house, 'digest', 'End-of-week digest', :digest_prompt, 'cron', '0 17 * * 0', 'assess', false, 'Europe/Berlin');
-- Cadence editable on the fly via the row (no redeploy); digest runner summarizes from DB, never web search.
```

### Config / env (add to `.env.example`, `turbo.json` globalEnv, boot `assertServerEnv()`; `BAUMY_` prefix)
| Var | Purpose | Default |
|---|---|---|
| `BAUMY_HOUSE_CHAT_ID` | Fixed report destination (reused, not new) | — |
| `BAUMY_ADMIN_CHAT_ID` | Task-failure / budget-defer notices (reused) | — |
| `BAUMY_SCHEDULED_TASK_DISPATCH_CRON` | Dispatch tick | `*/15 * * * *` |
| `BAUMY_SCHEDULED_TASK_MAX_ACTIVE` | Global cap on concurrent active tasks (denial-of-wallet bound) | `20` |
| `BAUMY_SCHEDULED_TASK_DEFAULT_UNTIL_DAYS` | Hard expiry applied when the user gives no stop date | `90` |
| `BAUMY_SCHEDULED_TASK_MAX_WEB_SEARCHES_PER_RUN` | Per-run web-search call cap | `3` |
| `BAUMY_TIMEZONE` | House IANA zone (reused) | `Europe/Berlin` |
- Model ids resolved via `ai_model_config` roles (`summary`=Sonnet 5, `deep`=Opus 4.8) — never inlined. Web-search vendor + keys owned by `web-search.md`. Spend caps reused from `dev-test-obs.md` (`llm_budget_day`).

### Worked example — sink rebuild (the canonical A4b case)
> **Trusted member, in the house group:** *"@Baumy every Monday morning scan for specials on sink/plumbing gear and hardware stores near us for the sink rebuild, until we've got what we need."*

1. **Classify:** ingest classifier flags `schedule_task_intent=true` (FLAG only).
2. **Extract** (Sonnet): `title="Sink-rebuild sourcing scan"`, `promptPhrase="find current specials on sink/plumbing supplies and list hardware stores near the house relevant to the sink rebuild"`, `cadencePhrase="every Monday morning"`, `completionPhrase="until we've got what we need"`, `tierHint="advisor"` (needs web research + maps), `wantsWebSearch=true`.
3. **Resolve + gate:** `cadence_kind='cron'`, `cron_expr='0 9 * * 1'` (Mon 09:00 `Europe/Berlin`), `next_run_at` = next Monday 09:00 Berlin; `completion_condition` stored; `until_at = now + 90d`, `max_runs = 13` (backstops); `model_tier='advisor'`, `web_search=true`. Sender is an active member → **needs_confirmation** → fixed-template card shows *"Weekly · next Mon 1 Sep 09:00 Berlin · Opus + web search · stops when done or after 13 runs / 90 days · ~$0.06/run."* Member taps **✅ Create**.
4. **Commit:** one `scheduled_tasks` row, `status='active'`. One logical schedule now exists.
5. **Each Monday 09:00 Berlin:** dispatch cron claims the row → `scheduled-task-run`: budget check → gather sink-rebuild memory + house location (excluding any `secure value` facts) → Opus deliberative call with the bounded web-search tool (≤3 searches) → concise report *("Specials this week: … · Nearby: Hornbach Prenzlauer Berg 1.2km, Bauhaus …")* → delivered to the house group via the chokepoint → usage recorded → completion evaluated against fresh memory ("has anyone said we got the parts?") → not yet → `run_count++`, `next_run_at` = next Monday, `status='active'`.
6. **Termination:** any member/owner `/canceltask`; OR the model reads a later "got the last fitting, we're sorted" and returns `completionReached=true` → `status='completed'`; OR the 13-run / 90-day backstop trips → `status='expired'`. Either way it stops on its own — bounded cost, no orphaned schedule.

---

## Gotchas

- **Inngest cannot register a cron per task at runtime.** `serve()` crons are static. A literal "one Inngest cron per task" is impossible on the locked stack — use the shared dispatch cron over the durable table (ST2). Do not attempt to generate functions per row.
- **The 7-day sleep cap kills per-task `sleepUntil` for long cadences.** A monthly/interval task can't sit in one `step.sleepUntil(next_run)`. The dispatch-cron scan is horizon-unbounded (a far-future `next_run_at` just waits in the table) — this is why the scan, not a sleep, is the primitive here.
- **A per-minute dispatch cron busts the budget.** ~43k–86k executions/mo. Keep the tick coarse (15-min/hourly) — weekly tasks don't need minute precision. If sub-15-min precision is ever wanted for one task, add a targeted `sleepUntil` for that near-term fire only, never a global minute cron.
- **Never schedule off a model-emitted cadence/timestamp.** The extractor isolates the cadence phrase; `cadence.ts` computes `next_run_at` deterministically in `Europe/Berlin`. Anchor to the **target** occurrence's DST offset (croner/Luxon), and avoid the 01:00–03:00 DST window / add jitter — same class of bug as reminder DST errors.
- **Model-judged completion must never be the ONLY stop.** Always carry `until_at`/`max_runs`. A completion predicate can end a task early but can't keep it alive past the hard bound — otherwise a mis-eval (or an injected "we're not done, keep searching daily forever" planted in memory) becomes a denial-of-wallet.
- **Web-search results and retrieved memory are UNTRUSTED DATA.** Frame both in a delimited data block; the deliberative model has no other tools and no message/fetch capability beyond the bounded search; its only output sink is `sendToHouse`. This is second-order injection, handled exactly like group memory.
- **Do NOT feed `secure value` / sensitivity-flagged / encrypted facts into a web-search-enabled run.** A door code or bank detail must never be encodable into an outbound search query. `getTaskGrounding(..., { excludeSecure: web_search })` filters them out of context when the tool is on (exfil defense; reuse the `security.md` sensitivity scanner).
- **The task `prompt` is inert.** Deterministic code (dispatcher, gate, cancel) never executes it as an instruction — only the deliberative model consumes it as a task description, and it was authored by a trusted, gated member. Injected group text can't reach `prompt` because creation is write-gated.
- **Untrusted group text can NEVER create, edit, cancel, or reconfigure a task.** Creation/cancel/edit/self-config all run through the deterministic write-gate; owner controls all tasks. This is the A5 injection wall — otherwise injected text could stand up (or silence) a paid recurring job.
- **Opus 4.8 rejects `temperature`/`top_p`/`top_k`/`budget_tokens` (HTTP 400).** When `model_tier='advisor'`, omit sampling params and use `thinking:{type:'adaptive', effort:'low'}` (llm-pipeline D25 / prompt-mgmt). A hardcoded temperature on the advisor path is a 100% outage.
- **`onFailure` receives the ORIGINAL event nested at `event.data.event.data`** (system `inngest/function.failed`), not `event.data`. Reading the wrong path yields `undefined taskId`.
- **Claim on the pooled driver.** `FOR UPDATE SKIP LOCKED` needs `neon-serverless` (WebSocket); `neon-http` can't hold row locks. Prevents two dispatch ticks double-running the same task.
- **`cancelOn` fires between steps.** A run already inside the `report` step will finish (and send) once before cancelling — a task cancelled in the last second may still post one result. Acceptable; document it.
- **Deferred-budget runs must re-arm, not drop.** Over the hard cap, flip `running → active` and bump `next_run_at`; do not leave the row stuck in `running` (a reaper flips stale `running` rows older than N minutes back to `active`, like the reminder `firing` reaper).
- **Digest runner is summarize-from-DB, not web search.** `task_kind='digest'` must route to `digest-runner.ts` (memory + `notify_outbox`), never the web tool — otherwise a digest could hit the paid search path and leak the fatigue-control contract.
- **Idempotency is on `(taskId, slot)`.** The event `slot` (the due `next_run_at`) plus the `scheduled_task_runs (task_id, slot)` UNIQUE make a redelivered dispatch a no-op — don't key idempotency on `taskId` alone or a legitimate next occurrence looks like a duplicate.
- **Bound the number of active tasks.** Enforce `BAUMY_SCHEDULED_TASK_MAX_ACTIVE` at creation (reject/queue over the cap) — otherwise a member can create 100 hourly web-search tasks and drain the spend cap in a day.

---

## Tasks (ordered, with dependencies + estimates)

| # | Task | Depends on | Est. |
|---|------|-----------|------|
| **ST-T1** | **DDL: `scheduled_tasks` + `scheduled_task_runs` + `scheduled_task_status` enum** (Drizzle schema + migration; partial `(next_run_at) WHERE status='active'` index; `(task_id, slot)` UNIQUE). Coordinate `members`/`group_id` FKs with `auth-identity`/`data`. | data.md, auth-identity.md | 0.5d |
| **ST-T2** | **`cadence.ts`** — `nextRun()` over cron (`croner`, IANA/DST) + rrule (reuse reminder `RRule`) + interval; render-in-`Europe/Berlin` helper; golden tests spanning a Berlin DST transition. `verify croner version/TZ at build`. | ST-T1 | 0.75d |
| **ST-T3** | **`scheduled-tasks-gate.ts`** — reuse the write-gate action matrix for `scheduled_task.create/edit/cancel/config`: source (unauthorized_text/authorized_human_text/callback_confirm/owner) × decision; safe-direction self-config rule (A5). 100% branch coverage incl. group-text→reject. | security.md | 0.75d |
| **ST-T4** | **`extract.ts`** — `schedule_task_intent` flag in the shared classifier + focused `generateObject` extraction (verbatim prompt/cadence/until/completion phrases + tier/web hints; never computes schedule or authorization). | llm-pipeline.md T8/T9 | 0.75d |
| **ST-T5** | **`create.ts` + confirm flow** — resolve phrases→cadence/until, default backstops, `MAX_ACTIVE` guard, gate → fixed-template confirm card (inline keyboard, minted token, echoed local next-fire time) → deterministic commit (reuse `security.md` Stage D confirm handler). | ST-T2, ST-T3, ST-T4 | 1d |
| **ST-T6** | **`scheduled-task-dispatch` cron** — deterministic expire/complete sweep + pooled `FOR UPDATE SKIP LOCKED` claim (`active→running`) + batched `sendEvent`; `TZ=Europe/Berlin */15`, concurrency 1, DST-safe. | ST-T1 | 0.75d |
| **ST-T7** | **`runner.ts` + bounded web-search wrapper** — deliberative `generateText` on `assess`/`advisor` roles (omit temperature for Opus); web tool only when opted in, capped at `MAX_WEB_SEARCHES_PER_RUN`, results as untrusted DATA; structured `{report, completionEvaluated, completionReached}` output; grounding excludes `secure value` facts when web on. | llm-pipeline.md, web-search.md, memory-core.md | 1.25d |
| **ST-T8** | **`scheduled-task-run` function** — load/guard → `assertWithinBudget` (defer-not-drop) → gather → deliberate/digest → `recordUsage(purpose='scheduled_task')` → `report` via notify chokepoint → `advance` (audit row + complete/expire OR re-arm); `idempotency:(taskId,slot)`, `cancelOn`, `onFailure`→re-arm/fail + admin notice; stale-`running` reaper. | ST-T6, ST-T7, dev-test-obs.md, proactive.md | 1.5d |
| **ST-T9** | **`cancel.ts` + `/tasks` command surface** — list (requester=own, owner=all), atomic cancel/pause flip → emit `scheduled-task/cancelled`; edit = gated config write w/ `next_run_at` recompute; dashboard hooks. | ST-T3, ST-T8 | 0.75d |
| **ST-T10** | **`digest-runner.ts` + seed migration** — summarize-from-DB variant (memory + `notify_outbox`, no web); seed the two system-owned digest rows; remove the hardcoded proactive digest crons; owner can re-time via row edit. | ST-T8, proactive.md | 0.75d |
| **ST-T11** | **Spend + abuse governance wiring** — `estMaxNano(task)` (web-search-inflated), `MAX_ACTIVE` enforcement, per-task/monthly self-caps, deferred-budget path + one-time admin notice; reuse `llm_budget_day` gate. | ST-T8, dev-test-obs.md | 0.5d |
| **ST-T12** | **Test suite** (Vitest + PGlite seam): group-text create/cancel → rejected; trusted create → confirm → row; dispatch claims a due row exactly once under concurrency; a 30-day-out (monthly) task fires via scan (not sleep); DST-boundary `next_run`; completion predicate stops early; `until_at`/`max_runs` backstop stops a never-completing task; over-budget defers + reminder delivery still fires; `secure value` fact never enters a web-search run; injection-in-`completion_condition` cannot extend past the hard cap; digest cadence editable without redeploy. | ST-T5, ST-T8, ST-T9, ST-T10, ST-T11 | 1.5d |

**Total ≈ 11 dev-days.** Critical path ST-T1→ST-T2→(ST-T3/ST-T4)→ST-T5→ST-T6→ST-T7→ST-T8→ST-T9/ST-T10→ST-T11→ST-T12; ST-T3/ST-T4 parallelizable.

---

## Risks & mitigations

| # | Risk | Sev. | Mitigation |
|---|------|------|-----------|
| R1 | **Denial-of-wallet via tasks** — a member (or looping account) stands up many high-cadence web-search tasks; each run is a heavy Opus + search call. | High | Creation is write-gated (no group-text creation); `MAX_ACTIVE` global cap; per-run/monthly self-caps; `MAX_WEB_SEARCHES_PER_RUN`; the `llm_budget_day` hard cap defers all runs over budget; coarse dispatch tick; owner kill-switch/pause on any task. |
| R2 | **Injected instruction keeps a task alive forever** ("we're not done, keep searching daily") planted in memory and read by the completion evaluator. | High | Model-judged completion can only *stop* a task; hard `until_at`/`max_runs` backstops (defaulted at create) always terminate it; completion input framed as untrusted DATA; audit every completion evaluation. |
| R3 | **Untrusted group text creates / cancels / reconfigures a paid recurring job.** | High | Deterministic write-gate on create/edit/cancel/config (group text → reject); owner controls all tasks; self-config limited to safe-direction (reduce activity) for trusted members; all reversible via dashboard. |
| R4 | **Exfiltration via web-search query** — a secret (door code, bank detail) is encoded into an outbound search. | High | `web_search` only settable by a trusted member through the gate; grounding excludes `secure value`/sensitivity-flagged/encrypted facts whenever the web tool is on; bounded, audited queries; results-in only, single house-group output sink; no other tools. |
| R5 | **Inngest 7-day sleep / 30-day run caps** silently break long-cadence tasks (monthly/interval) if implemented as a sleep. | High | Dispatch-cron scan over `next_run_at` (horizon-unbounded), never a per-task long sleep; per-run functions are short; test a monthly task fires via the scan. |
| R6 | **DST / timezone mis-fire** (`Europe/Berlin` GMT+1/+2 transitions) runs a task at the wrong hour or double-fires at the transition. | Med | Deterministic `Europe/Berlin` cadence math (croner/Luxon, target-date offset); dispatch cron `TZ=Europe/Berlin`, avoid 01:00–03:00, add jitter; echo resolved local fire time on confirm; golden DST tests. |
| R7 | **Double-run** — two dispatch ticks or a redelivered event run the same slot twice → duplicate house post + double spend. | Med | Atomic `FOR UPDATE SKIP LOCKED` claim (`active→running`); event idempotency on `(taskId, slot)`; `scheduled_task_runs (task_id, slot)` UNIQUE. |
| R8 | **Task stuck in `running`** if a run crashes between claim and advance → never fires again. | Med | `onFailure` re-arms `running→active`; a stale-`running` reaper (older than N min) flips back to `active`; Neon is source of truth (Inngest history is 24h). |
| R9 | **Over-notifying the house** with task results erodes trust (the proactive fatigue risk). | Med | Results route through the notify-gate (caps/coalescing/quiet-hours apply); user-requested results are a bounded priority tier; digests P3; failures go to admin, not house. |
| R10 | **Digest regression** — the two digests silently stop when moved from hardcoded crons to seeded rows. | Med | Seed migration + a health check asserting both digest rows exist and ran within their cadence window; the external heartbeat (`inngest.md` D12) covers a paused-quota stall. |
| R11 | **Web-search vendor/tool drift** — the maps-capable search API changes shape/pricing. | Low | Tool owned by `web-search.md` behind a bounded wrapper; `verify at build`; per-run call cap bounds blast radius; task falls back to memory-only if the tool errors (report notes "web unavailable"). |
| R12 | **Cost estimate wrong** → budget gate over/under-blocks. | Low | `estMaxNano` inflated for web-search; post-call `recordUsage` reconciles exact tokens; ledger stores model+tokens so cost is recomputable; unknown model fails closed as most-expensive. |

---

## Open questions (for the owner)

1. **Dispatch tick interval.** `*/15` (≈2,880 exec/mo) vs hourly (≈720) — 15-min gives tighter "Monday morning" adherence at ~4× the (still tiny) execution cost. Confirm, and reconcile with `architecture.md` D11's minute-cron reminder scanner (this workstream deliberately runs coarser).
2. **`web-search.md` is not yet authored.** This spec cross-refs it for the tool vendor (Anthropic server-side `web_search` vs Brave/Tavily/SerpAPI), the maps-capable "near us" variant, keys, and per-call pricing. Author it before ST-T7, or inline a provisional tool choice.
3. **Default hard backstops.** `DEFAULT_UNTIL_DAYS=90` and an implicit `max_runs` — acceptable, or should a task with no user-given stop instead *require* an explicit one at confirm time?
4. **`MAX_ACTIVE` and per-run cost ceiling.** `20` active tasks / `~$0.06`-ish per advisor+web run — right envelope for a 4-person house, or tighter?
5. **Who may create web-search / `advisor`-tier tasks?** Any trusted member (current design, confirmable), or owner-only for the expensive tier (leaving `assess`/no-web to members)?
6. **Task-result delivery priority.** Treat user-requested results as an always-delivered tier, or subject them to the same daily fatigue cap as ad-hoc pings (coalesced into the next digest when over cap)?
7. **`model_tier` naming.** This spec uses `assess`/`advisor` (decision C) mapping to registry roles `summary`(Sonnet 5)/`deep`(Opus 4.8). Confirm the alias mapping so `ai_model_config` overrides line up.
8. **Completion evaluation cost.** Evaluating the NL completion predicate every run adds a little to each call. Fold it into the same deliberative call (current design, cheapest) vs a separate cheap check — confirm folding is acceptable.
9. **Multi-group future.** `group_id` origin-scope is present (D-sec); confirm v1 stays single-house so the dispatch scan needn't filter by group yet.
