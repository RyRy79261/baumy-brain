# Inngest — all async / scheduled work

> Workstream key: `inngest`
> Scope: every asynchronous, delayed, and scheduled unit of work in Baumy runs on **Inngest** — message ingestion, **reminders** (daily-arm + `sleepUntil` + catch-up sweeper "heartbeat"), **user-defined scheduled recurring tasks** (of which the digests are a built-in instance — see `scheduled-tasks.md`), the dated-event surfacing scan, nightly memory consolidation, and the outage-recovery fallback. **Vercel cron is not used anywhere** (locked cost constraint).
> Stack context (locked): Next.js 16 on **Vercel Hobby ($0)**, Neon Postgres + Drizzle + pgvector, Vercel AI SDK (Anthropic default / OpenAI nano classifier), Telegram privacy mode **OFF** (every group message is untrusted prompt-injection input), fixed house `chat_id` send destination, house timezone **`Europe/Berlin`** (single, shared, DST-aware — decision B9). All lifted reference code (`ops-board`, `camp-404`) is clean-room renamed to `baumy` / `@/*` — zero foreign identifiers.
> Pricing / limits / SDK versions verified **2026-07-01** against official Inngest sources; refuted claims corrected inline.

---

## Overview

Inngest is Baumy's **durable execution substrate**. The webhook returns `200` in well under a second and hands off to Inngest; everything expensive or time-shifted (LLM classify/extract/embed, reminder delivery, scheduled-task runs, consolidation) runs as durable, retried step functions off the request path. This is simultaneously the **cost posture** (heavy work amortized, not billed to Vercel request time) and the **security posture** (untrusted group text never synchronously drives a privileged write; the deterministic write-gate lives before/inside the deferred function and every send is hard-pinned to the fixed house `chat_id`).

The design is dominated by **one binding constraint: the Inngest Free (Hobby) tier bills an "execution" per function *run* PLUS per *step*, capped at 50,000 executions/month, and *pauses all execution* (no overage billing) once that cap is hit.** Everything below optimizes for that number:

- **Message ingestion** is gated cheaply *before* enqueue and kept to 2–3 steps so a chatty always-on group (privacy mode OFF) can't multiply into a runaway execution bill.
- **Reminders** (decision E22, CONFIRMED) use **daily-arm + short per-reminder `sleepUntil` + a catch-up sweeper "heartbeat"** — house-scoped and delivered to the **house group** (decision A3), never per-user DM. They cannot use a single long sleep (Free caps any sleep at **7 days**) and *must not* use a per-minute cron scanner (that alone is ~43k–86k executions/month — it busts the cap before any real work). A once-daily "arm" cron over the durable Neon `baumy_reminders` table + a short (<7-day) per-reminder `step.sleepUntil` gives exact-minute delivery and handles arbitrarily far-future reminders; an independent low-frequency **catch-up sweep** is the reliability net that guarantees the "fire at the due moment" requirement even if a delivery run is lost or the quota briefly paused.
- **Scheduled recurring tasks** (decision A4b — "run this query/prompt on a cadence and report back until we're done") are **user-definable**, one stored cadence per task (evaluated in `Europe/Berlin`), run on the **deliberate/heavier model path** (Sonnet `assess` / Opus `advisor`) with **web search allowed** (INPUT-only), and report to the **house group**. **Digests become a built-in instance** of this mechanism (cadence settable on the fly). Because Inngest cron triggers are statically code-defined, dynamic per-task schedules are dispatched by **one shared dispatcher cron** over a `baumy_scheduled_tasks` table — never one registered function per task. Full behavioural spec in `scheduled-tasks.md`; this section owns the Inngest wiring, tables, and budget.
- **Observability lives in Neon, not Inngest.** Free trace/log retention is only **24 hours**, so a reminder or task that fires days after it was created leaves no Inngest trace to debug. Neon rows are the durable source of truth and audit log.

Modelled workload for a 4-person house: **~9k–22k executions/month (18–44% of the 50k cap)** with gating + lean steps in place — the ~1.5k–3k added by the reminder catch-up sweep, the scheduled-task dispatcher, and a handful of active scheduled tasks (both fixed-overhead crons kept **hourly**, not per-minute) stays comfortably inside budget. Without gating, naive per-message ingestion (4 steps ≈ 5 executions/msg) can exceed 50k on its own — hence the gate and the optional batching valve are load-bearing, not cosmetic.

**SDK version:** build on **Inngest v4** (`^4.11.0`, GA 2026-03-17). The reference repos are on v3 and will **not compile** on v4 (`EventSchemas` removed → `eventType()`; triggers moved into the first `createFunction` arg). This matches `architecture.md` D15. Only the `serve()` route copies over version-unchanged.

---

## Decisions (with rationale)

### D1 — Ship v1 entirely on the Inngest Free (Hobby) tier; do NOT budget for Pro
Verified caps (50k executions/mo, 5 concurrent steps, 500k events ingested/mo, 7-day sleep, 24h trace retention, 30-day max run) all exceed the modelled 4-person demand by 2–5×. Staying free is a locked constraint. **Confidence: high.**
*Corrected:* an outlier secondary source claiming "100k free executions / 25 concurrency" is **refuted** — verification against the live pricing page and docs usage-limits table confirms **50k executions and 5 concurrency** (that outlier conflates the Basic tier or is stale).

### D2 — Build on Inngest v4 (`^4.11.0`), porting reference *patterns*, not copying reference *code*
v4 is GA and current (`4.11.0`, published 2026-06-23; `v3-lts` dist-tag is `3.54.0`). Baumy is greenfield, so adopting v4 now avoids a forced migration. The v3→v4 deltas that force a rewrite: `new EventSchemas().fromRecord<…>()` is gone (use `eventType(name, { schema })`); `createFunction(config, {event}, handler)` (3-arg) becomes `createFunction(config, handler)` (2-arg) with triggers **inside** config as `triggers: [...]`; `signingKey`/`baseUrl`/`serveOrigin` move from `serve()` onto the client. The `serve()` route export shape is identical across v3/v4. Pin the version and add a CI typecheck. **Confidence: high** (matches `architecture.md` D15).

### D3 — App-local files, no `@baumy/*` package; `/api/inngest` on Node runtime, `maxDuration = 300`
Wire Inngest with exactly `lib/inngest/client.ts` (client), `lib/inngest/events.ts` (typed `eventType()` defs), `lib/inngest/functions/*` (one file per function), and `app/api/inngest/route.ts` (`serve`). Node runtime is required (Neon serverless driver + AI SDK need Node, not Edge). **`maxDuration = 300`** — Vercel Hobby now gets the full 300s per function via Fluid Compute (default-on since 2025-04-23); the reference repos' `maxDuration = 60` is **stale**. Keep *individual* steps well under 60s anyway for safety margin and to bound active-CPU exposure. **Confidence: high** (matches `architecture.md` D5).

### D4 — Do NOT auth-gate `/api/inngest`; keys come from the Vercel↔Inngest integration
The `INNGEST_SIGNING_KEY` signature verification *inside* `serve()` **is** the authentication for the server-to-server sync/callback. The app auth middleware MUST short-circuit `/api/*` (reference `proxy.ts` does `if (pathname.startsWith('/api/')) return NextResponse.next()`). If a broad middleware matcher gates this route, Inngest's sync callback gets `401` and **functions silently never register — reminders and scheduled tasks never fire in production**. `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` are injected by the official Vercel↔Inngest integration and auto-read by the SDK, so they stay **out of `.env.example` and `turbo.json` globalEnv** (listing them implies manual plumbing that does not exist). **Confidence: high.**

### D5 — Reminders = durable Neon table + once-daily "arm" cron + short `step.sleepUntil` + catch-up sweeper; house-group delivery
Decision E22 (CONFIRMED): reminders must **fire reliably at the due moment and notify the group**; the three-part model is daily-arm + `sleepUntil` + catch-up sweeper, where the sweeper is the "heartbeat" that makes the guarantee hold. The Free 7-day sleep cap makes a single `step.sleepUntil` for "remind me in 2 weeks" impossible, and a per-minute cron scanner is a **budget trap** (`60 × 24 × 30 = 43,200` fires/month; with even one `step.run` per fire that is **~86,400 executions/month — over the 50k cap before any real work**). Instead:
1. `baumy_reminders` (Neon) is the **source of truth**.
2. The **deterministic create path** inserts a row (`pending`) and, if `due_at` is within the arm window (≤6 days), immediately arms it (`pending → armed`) and emits `reminder/arm.due` so near-term reminders don't wait for the next daily cron.
3. A **once-daily** `reminder-arm` cron (`TZ=Europe/Berlin 5 0 * * *`) claims rows due within the next ~6 days that are still `pending`, atomically flips them `armed`, and emits one `reminder/arm.due` event per row (~30 cron fires/month) — this pulls **arbitrarily far-future** reminders into range as they enter the window.
4. A per-reminder `reminder-deliver` function does `step.sleepUntil(dueAt)` — **guaranteed < 7 days** by the arm window — then atomically claims and **sends to the fixed `BAUMY_HOUSE_CHAT_ID`** (house group; per-user DM reminders are a NON-GOAL per A3), flipping `armed → sent`.
5. An independent **`reminder-sweep`** cron (hourly, `TZ=Europe/Berlin`) is the catch-up "heartbeat": it re-claims any **overdue** row (`due_at <= now()` AND `status IN ('pending','armed')` — i.e. a lost delivery run, a create-time send that failed, or a reminder that slipped an arm window) via the same atomic claim and sends immediately. It also stamps a liveness marker the health endpoint reads (D12).

This gives exact-minute delivery on the happy path, keeps every Inngest run ≤ ~6 days (well under the 30-day max-run-length), handles arbitrarily far-future reminders with no chunked-sleep loop, and costs ~4 executions per *actually-due* reminder plus ~720 cheap (mostly no-op) sweep fires/month. **Confidence: high.**
*Reconciliation note:* `architecture.md` D10/D11 sketches a `{ cron: '* * * * *' }` per-minute scanner over the reminders table. On the verified per-step billing model that is not viable on Free. **Decision E22 CONFIRMS this section's daily-arm + `sleepUntil` + catch-up-sweeper model** (owner explicitly accepted daily-arm), so `architecture.md` D10/D11 is **SUPERSEDED and must be updated to match** — this is no longer an open question.

### D6 — One reminder is claimed exactly once at send time via an atomic status flip
Both the `sleepUntil` delivery path and the catch-up sweep call the same guard: `UPDATE baumy_reminders SET status='sent', sent_at=now() WHERE id=$1 AND status IN ('pending','armed') RETURNING *`. Only the winner sends; a lost run, a duplicate arm, or the catch-up sweep can never double-send. `cancelOn` + an atomic `armed/pending → cancelled` flip (done in the deterministic cancel API, never inside the reminder function) handles cancellation. **Confidence: high.**

### D7 — Message ingestion: cheap gate in the webhook, then a lean 2–3 step durable function
Route every gate-passing message through **one** `handle-telegram-message` function: `record-inbound` (idempotent upsert on `update_id`) → `classify-extract` (ONE OpenAI-nano call returning routing decision *and* extracted facts — combined to save an execution) → conditional `embed-store` (embed + pgvector upsert + fact write in one step). The deterministic write-gate runs in the webhook *before* the event is sent, so untrusted group text can never trigger a privileged write here; the ingest function's output is **memory-only** and may never emit reminder/notification events or send to the house chat. **Confidence: high** (aligns with `architecture.md` D9 / `llm-pipeline.md`).

### D8 — Idempotency is stacked in layers, all keyed on Telegram `update_id`
(1) Inngest event `id: `tg:update:${update_id}`` → free 24h dedup (deduped events are stored but trigger **no run**, so cost nothing). (2) Function-level `idempotency: 'event.data.updateId'` → redundant 24h guard against manual replay. (3) `baumy_telegram_updates(update_id PK)` upsert with `onConflictDoNothing` → durable **>24h** backstop + audit/replay log. (4) Memory table `UNIQUE(source, source_update_id, source_ordinal)` upsert → makes an at-least-once step re-execution a pure no-op. Layers 1–2 cover the hot path; 3–4 are the durable backstops the outage-recovery sweep relies on. **Confidence: high.**

### D9 — The non-deterministic LLM extraction MUST live in its own memoized `step.run`
Inngest is at-least-once **at the step boundary**: a step whose completion ack is lost is re-executed. Because a *completed* step's result is memoized and replayed verbatim, isolating classify/extract in its own `step.run` makes the downstream write step deterministic — the ordinal-keyed `UNIQUE` upsert then reduces any re-run to a no-op. If the LLM ran outside a step (or merged into the write step), a retry would produce **different facts**, and the `(update_id, ordinal)` key would silently map new content onto old slots, corrupting memory. This is the single most important correctness decision. **Confidence: high.**

### D10 — Use deliberate retries + `onFailure` dead-lettering; do NOT blanket-apply `retries: 0`
*Corrected:* the reference `retries: 0` was context-specific — it existed because that function spent user tokens in a single non-idempotent step where any retry = full re-spend. Baumy's writes **are** idempotent and completed steps are memoized, so retrying through transient Neon/LLM blips is safe and *desirable* (permanently dropping a housemate's fact is worse than a retry). Set retries **per function**: `retries: 3` for ingest/consolidation, `retries: 2` for reminder delivery and scheduled-task runs (idempotent send via atomic claim / occurrence dedup). Add an `onFailure` handler (fires only after retries exhaust) that flips the owning Neon row to `dead_letter`/`failed` and sends **one fixed-template** notice to the house chat (deterministic, never steered by untrusted text). Throw `NonRetriableError` on malformed/unhandled updates so poison messages dead-letter immediately instead of burning all attempts. **Confidence: high.**

### D11 — Neon is the observability source of truth; treat Inngest run history as ephemeral
Free trace/log retention is 24h and event lookback is 1h, so event replay/recovery for anything older is effectively unavailable. Every async outcome (reminder armed/sent/failed, message processed/dead-lettered, scheduled-task run/failed, consolidation run) is persisted to a Neon status/audit row. Recovery comes from re-querying Neon, never from replaying Inngest events. **Confidence: high.**

### D12 — Fail-silent quota exhaustion is guarded by an external heartbeat; the catch-up sweep is the internal net
Hobby **pauses** (does not bill) at 50k executions, so a blown budget silently stalls reminders, scheduled tasks, and memory writes with **no error**. Two layers: (a) the in-Inngest `reminder-sweep` (D5) is the *internal* reliability net that re-fires anything the happy path missed and stamps a liveness marker; (b) an *external* project heartbeat — the "scheduled Claude routine" pinging `/api/health-reminders` — asserts the arm/sweep ran within the last ~2–25h and alerts the house group if not. The external layer is essential precisely because a **paused Inngest quota also pauses the internal sweep**, so only an out-of-band check can detect the stall. Also log a lightweight per-function execution counter to Neon to watch headroom. **Confidence: high.**

### D13 — Local dev uses `INNGEST_DEV=1` + the Inngest dev server (no keys)
v4's default mode is **cloud** — the `/api/inngest` endpoint throws *"A signing key is required to run in Cloud mode"* locally unless `isDev: true` / `INNGEST_DEV=1` is set. Run `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest` (UI on `:8288`), which auto-discovers the route. No cloud keys needed locally or in CI. **Confidence: high.**

### D14 — Scheduled recurring tasks = one `baumy_scheduled_tasks` row per task + ONE shared dispatcher cron; digests are a built-in instance (decision A4b)
Members can define recurring tasks ("run this query/prompt on a cadence and report back, until we're done", e.g. *"weekly, look for specials + hardware stores near us for the sink rebuild, until done"*). Model (see `scheduled-tasks.md` for the full behavioural spec):
- **One durable row per task** in `baumy_scheduled_tasks` `{prompt, cron_expr, tz='Europe/Berlin', model_tier, web_search, requester, group_id, expires_at, next_due_at}` — the "one schedule per task" is a **stored cadence**, NOT a separately registered Inngest function (Inngest cron triggers are static/code-defined and cannot be minted per user request).
- **One shared `scheduled-task-dispatch` cron** (hourly, `TZ=Europe/Berlin`) mirrors the reminder-arm pattern: it atomically claims `active` rows whose `next_due_at <= now()`, advances `next_due_at` (computed from `cron_expr` in Berlin), and emits one `scheduled-task/run.due` event per due task — cap-safe (~720 fires/mo) and immune to the 7-day sleep cap that a per-task `sleepUntil` would hit for monthly/annual cadences.
- **`scheduled-task-run`** executes on the **DELIBERATE path**: heavier model per `model_tier` (Sonnet `assess` default / Opus `advisor`) with the **web-search tool allowed** (INPUT-only) per decisions C + CAP, retrieves/reasons, then reports to the **fixed house group** through the outbound chokepoint. Cancellable (`status='cancelled'`), auto-completes at `expires_at`.
- **Digests are a built-in instance**: system-seeded `kind='digest'` rows (mid-week + end-of-week per proactive.md; cadence now **settable on the fly** by editing the row instead of a hardcoded cron). The digest run reuses the proactive summarize-from-DB + notify-gate builder; only the *schedule* moves into `baumy_scheduled_tasks`. This reconciles proactive.md's hardcoded digest crons into the on-the-fly-settable model.
- **Security invariant (held):** scheduled tasks are created **only via the deterministic write-gate** from a trusted member request (never minted by raw untrusted group text); web search is INPUT-only; OUTPUT goes **only** to the fixed house group; the daily spend cap governs; the reactive reply path stays memory-only, zero tools. **Confidence: high.**

---

## Concrete design / APIs / DDL / config

### File layout (all in the single Next.js app)
```
lib/inngest/client.ts              # new Inngest({ id: 'baumy', isDev })
lib/inngest/events.ts              # eventType() typed event defs
lib/inngest/functions/
  handle-telegram-message.ts       # ingest (event-triggered)
  reminder-arm.ts                  # daily cron -> emits reminder/arm.due
  reminder-deliver.ts              # per-reminder sleepUntil + send (house group)
  reminder-sweep.ts                # hourly catch-up "heartbeat" (D5.5/D12)
  scheduled-task-dispatch.ts       # hourly cron -> emits scheduled-task/run.due per due row
  scheduled-task-run.ts            # deliberate run (Sonnet/Opus + web search) -> house group
  memory-consolidate.ts            # nightly cron (+ dated-event surfacing scan; see proactive.md)
  index.ts                         # re-export array for serve()
app/api/inngest/route.ts           # serve() — the only version-agnostic file
app/api/telegram/webhook/route.ts  # verify + gate + inngest.send (200 fast)
app/api/health-reminders/route.ts  # heartbeat target for the external routine
```

### Client + typed events (v4)
```ts
// lib/inngest/client.ts
import { Inngest } from "inngest";
export const inngest = new Inngest({
  id: "baumy",                                // namespaces functions/events in the dashboard — NOT "opsboard"/"camp-404"
  isDev: process.env.INNGEST_DEV === "1",     // v4 defaults to cloud; local dev needs this
});
```
```ts
// lib/inngest/events.ts
import { eventType } from "inngest";
import { z } from "zod";

// Ingest: keep the payload minimal; text may travel in the event (default) or be
// re-read from baumy_telegram_updates (privacy-hardened variant — see Gotchas).
export const telegramMessageReceived = eventType("telegram/message.received", {
  schema: z.object({ updateId: z.number(), chatId: z.number() /* + message fields per architecture.md D6 */ }),
});
export const reminderArmDue = eventType("reminder/arm.due", {
  schema: z.object({ reminderId: z.string().uuid() }),
});
export const reminderCancelled = eventType("reminder/cancelled", {
  schema: z.object({ reminderId: z.string().uuid() }),
});
// Scheduled recurring tasks (decision A4b; behaviour in scheduled-tasks.md)
export const scheduledTaskRunDue = eventType("scheduled-task/run.due", {
  schema: z.object({ taskId: z.string().uuid(), occurrence: z.string() /* ISO of the fired occurrence, for idempotency */ }),
});
```

### serve() route (version-agnostic; the only file that copies verbatim)
```ts
// app/api/inngest/route.ts
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

export const runtime = "nodejs";
export const maxDuration = 300;               // Vercel Hobby max via Fluid Compute; keep each step < 60s

export const { GET, POST, PUT } = serve({ client: inngest, functions });
// NOTE: middleware/proxy MUST short-circuit /api/* — the signing-key signature is the auth (D4).
```

### Reminder "arm" daily cron (v4 — triggers in first arg)
```ts
// lib/inngest/functions/reminder-arm.ts
export const reminderArm = inngest.createFunction(
  { id: "reminder-arm", retries: 3, concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=Europe/Berlin 5 0 * * *" }] },   // ~00:05 Berlin; avoid 01:00–03:00 (DST)
  async ({ step }) => {
    // Atomically claim rows due within the sleep-safe window (6 days < 7-day Free cap).
    const armed = await step.run("arm-due", async () =>
      db.execute(sql`
        UPDATE baumy_reminders SET status='armed', armed_at=now(), updated_at=now()
        WHERE status='pending' AND due_at < now() + interval '6 days'
        RETURNING id`)
    );
    if (armed.length === 0) return { armed: 0 };
    // One durable send-event step (not N inngest.send calls) keeps the execution count low.
    await step.sendEvent("enqueue-deliver",
      armed.map((r) => reminderArmDue.create({ reminderId: r.id })));
    return { armed: armed.length };
  }
);
```

### Per-reminder delivery (short sleepUntil + cancelOn + idempotency + atomic claim → house group)
```ts
// lib/inngest/functions/reminder-deliver.ts
export const reminderDeliver = inngest.createFunction(
  {
    id: "reminder-deliver",
    retries: 2,
    idempotency: "event.data.reminderId",                                  // 24h double-arm guard
    cancelOn: [{ event: "reminder/cancelled", match: "data.reminderId" }], // cancels the sleeping run
    onFailure: async ({ event, step }) => {                                // fires after retries exhaust
      const id = event.data.event.data.reminderId;                         // NOTE nested shape
      await step.run("mark-failed", () =>
        db.execute(sql`UPDATE baumy_reminders SET status='failed', updated_at=now()
                       WHERE id=${id} AND status='armed'`));
    },
    triggers: [reminderArmDue],
  },
  async ({ event, step }) => {
    const row = await step.run("load", () => getReminder(event.data.reminderId));
    if (!row || row.status !== "armed") return { skipped: "not-armed" };   // idempotent / cancellation / already-swept guard
    await step.sleepUntil("until-due", new Date(row.dueAt));               // guaranteed < 6 days by the arm query
    await step.run("send", async () => {
      const claimed = await db.execute(sql`
        UPDATE baumy_reminders SET status='sent', sent_at=now()
        WHERE id=${row.id} AND status IN ('pending','armed') RETURNING id`); // atomic single-send guard (D6)
      if (claimed.length === 0) return { skipped: "already-sent" };
      await sendToHouseChat(BAUMY_HOUSE_CHAT_ID, row.body);                // fixed destination — house group (A3)
    });
  }
);
```

### Reminder catch-up sweep — the "heartbeat" (E22 / D5.5 / D12)
```ts
// lib/inngest/functions/reminder-sweep.ts
export const reminderSweep = inngest.createFunction(
  { id: "reminder-sweep", retries: 2, concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=Europe/Berlin 15 * * * *" }] },   // hourly; catch-up net, NOT the primary path
  async ({ step }) => {
    // Anything overdue that the happy path missed (lost deliver run, failed create-send, paused-then-resumed quota).
    const overdue = await step.run("sweep", async () =>
      db.execute(sql`
        UPDATE baumy_reminders SET status='sent', sent_at=now(), updated_at=now()
        WHERE status IN ('pending','armed') AND due_at <= now()
        RETURNING id, body`)
    );
    for (const r of overdue) await step.run(`send-${r.id}`, () => sendToHouseChat(BAUMY_HOUSE_CHAT_ID, r.body));
    // Liveness marker the external heartbeat reads via /api/health-reminders (D12).
    await step.run("mark-alive", () => touchHealth("reminder-sweep"));
    return { swept: overdue.length };
  }
);
```

### Ingest function (lean steps + stacked idempotency + memoized LLM step)
```ts
// lib/inngest/functions/handle-telegram-message.ts
export const handleTelegramMessage = inngest.createFunction(
  {
    id: "handle-telegram-message",
    retries: 3,
    idempotency: "event.data.updateId",
    onFailure: deadLetterUpdate,                        // flip baumy_telegram_updates -> 'dead_letter' + fixed-template notice
    triggers: [telegramMessageReceived],
    // Scale valve if measured volume approaches budget (see Gotchas):
    // batchEvents: { maxSize: 50, timeout: "10s" }, concurrency: { limit: 5 },
  },
  async ({ event, step }) => {
    const { updateId, chatId } = event.data;
    const fresh = await step.run("record-inbound", () => insertUpdateOnConflictDoNothing(updateId, chatId /*, raw */));
    if (!fresh) return { skipped: "duplicate" };        // >24h durable dedup (D8 layer 3)
    const extracted = await step.run("classify-extract", () => classifyAndExtract(event.data)); // ONE nano call, memoized (D9)
    if (extracted.noise) return await step.run("mark-noise", () => markProcessed(updateId));
    await step.run("embed-store", () =>                 // embed + pgvector + UNIQUE(source,update_id,ordinal) onConflictDoNothing (D8 layer 4)
      upsertMemories(extracted, { source: "telegram", sourceUpdateId: updateId }));
    // Memory-only. This function NEVER emits reminder/notify events or sends to the house chat.
    // If malformed/unhandled: throw new NonRetriableError(...) so it dead-letters immediately (D10).
  }
);
```

### Scheduled-task dispatcher + runner (deliberate path; digests are a built-in instance)
```ts
// lib/inngest/functions/scheduled-task-dispatch.ts
export const scheduledTaskDispatch = inngest.createFunction(
  { id: "scheduled-task-dispatch", retries: 2, concurrency: { limit: 1 },
    triggers: [{ cron: "TZ=Europe/Berlin 10 * * * *" }] },   // hourly; ONE shared cron over all task rows (D14)
  async ({ step }) => {
    // Claim due rows and advance next_due_at (computed from cron_expr in Europe/Berlin). Retire past-expiry rows.
    const due = await step.run("claim-due", async () =>
      db.execute(sql`
        UPDATE baumy_scheduled_tasks
           SET last_dispatched_at = now(),
               next_due_at        = next_cron_occurrence(cron_expr, tz, now()),
               run_count          = run_count + 1,
               status             = CASE WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'done' ELSE status END,
               updated_at         = now()
         WHERE status = 'active' AND next_due_at <= now()
           AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, next_due_at`)
    );
    if (due.length === 0) return { dispatched: 0 };
    await step.sendEvent("enqueue-runs",
      due.map((t) => scheduledTaskRunDue.create({ taskId: t.id, occurrence: new Date().toISOString() })));
    return { dispatched: due.length };
  }
);
```
```ts
// lib/inngest/functions/scheduled-task-run.ts
export const scheduledTaskRun = inngest.createFunction(
  {
    id: "scheduled-task-run",
    retries: 2,
    idempotency: "event.data.taskId + event.data.occurrence",   // dedupe a single occurrence
    concurrency: { limit: 2 },                                  // deliberate/heavy; keep it small
    onFailure: markScheduledTaskFailed,                         // Neon row -> 'error' + fixed-template notice
    triggers: [scheduledTaskRunDue],
  },
  async ({ event, step }) => {
    const task = await step.run("load", () => getActiveTask(event.data.taskId));
    if (!task) return { skipped: "inactive" };
    // DELIBERATE path: model_tier -> Sonnet `assess` (default) / Opus `advisor`; web-search tool if task.web_search
    // (INPUT-only). Digest tasks (kind='digest') call the proactive summarize-from-DB builder instead of the LLM tool run.
    const result = await step.run("run-prompt", () => runDeliberateTask(task));   // spend-cap governed; see llm-pipeline.md
    // OUTPUT -> fixed house group ONLY, via the outbound chokepoint (never a raw send; never task-steered destination).
    await step.run("report", () =>
      raiseHouseNotice({ kind: task.kind === "digest" ? "digest" : "scheduled_task", groupId: task.groupId, body: result.summary }));
    await step.run("record", () => recordTaskRun(task.id, result));               // Neon audit row (D11)
  }
);
```

### Nightly consolidation cron (+ dated-event surfacing scan)
```ts
// lib/inngest/functions/memory-consolidate.ts
export const memoryConsolidate = inngest.createFunction(
  { id: "memory-consolidate", retries: 1, triggers: [{ cron: "TZ=Europe/Berlin 30 3 * * *" }] },
  async ({ step }) => {
    /* summarize/promote/prune tiered memory + re-embed; keep step count modest (~0.3k/mo) */
    /* dated-event surfacing scan (A4): find dated facts entering the ~1-week horizon and raise
       proactive candidates through the notify chokepoint — full spec in proactive.md. */
  }
);
```

### DDL (Drizzle-backed Postgres)
```sql
-- Reminder source of truth (authoritative because Free history=24h, Free sleep=7d)
CREATE TABLE baumy_reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     text        NOT NULL,          -- origin-scope (decision D-sec); v1 single house group
  created_by   text        NOT NULL,          -- Telegram user id of the requesting member (all members may request; A3/B10)
  chat_id      bigint      NOT NULL,          -- destination = fixed house group (per-user DM reminders are a NON-GOAL, A3)
  body         text        NOT NULL,
  due_at       timestamptz NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',  -- pending | armed | sent | failed | cancelled
  armed_at     timestamptz,
  sent_at      timestamptz,
  cancelled_at timestamptz,
  inngest_event_id text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Partial indexes make the daily arm AND the hourly sweep cheap:
CREATE INDEX baumy_reminders_arm_idx   ON baumy_reminders (status, due_at) WHERE status = 'pending';
CREATE INDEX baumy_reminders_sweep_idx ON baumy_reminders (due_at)         WHERE status IN ('pending','armed');

-- User-defined scheduled recurring tasks (decision A4b; behaviour in scheduled-tasks.md).
-- Digests are seeded rows with kind='digest' (cadence settable on the fly).
CREATE TABLE baumy_scheduled_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          text        NOT NULL,                 -- origin-scope (D-sec); v1 single house group
  kind              text        NOT NULL DEFAULT 'user',  -- user | digest (built-in instance)
  title             text,
  prompt            text        NOT NULL,                 -- the recurring query/instruction (trusted-sourced only)
  cron_expr         text        NOT NULL,                 -- 5-field cron; evaluated in `tz`
  tz                text        NOT NULL DEFAULT 'Europe/Berlin',
  model_tier        text        NOT NULL DEFAULT 'assess',-- assess (Sonnet) | advisor (Opus) — DELIBERATE path (decisions C)
  web_search        boolean     NOT NULL DEFAULT false,   -- INPUT-only tool; allowed on this path (decision CAP)
  created_by        text        NOT NULL,                 -- requesting member (trusted source; write-gate)
  status            text        NOT NULL DEFAULT 'active',-- active | paused | done | cancelled
  expires_at        timestamptz,                          -- "until we're done" / until date
  next_due_at       timestamptz NOT NULL,                 -- precomputed next fire; dispatcher reads this
  last_dispatched_at timestamptz,
  run_count         int         NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX baumy_scheduled_tasks_due_idx ON baumy_scheduled_tasks (next_due_at) WHERE status = 'active';

-- Ingest dedup / audit / replay log
CREATE TABLE baumy_telegram_updates (
  update_id    bigint PRIMARY KEY,            -- Telegram's monotonic unique id = natural idempotency key
  chat_id      bigint NOT NULL,
  raw          jsonb  NOT NULL,               -- full Update for replay/audit (or omit if text kept off Inngest)
  status       text   NOT NULL DEFAULT 'received',  -- received | processed | dead_letter
  error_message text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX baumy_telegram_updates_status_idx ON baumy_telegram_updates (status);

-- Idempotent memory-write key (added to the memory substrate table)
ALTER TABLE baumy_memories
  ADD COLUMN source           text   NOT NULL DEFAULT 'telegram',
  ADD COLUMN source_update_id  bigint NOT NULL,
  ADD COLUMN source_ordinal    int    NOT NULL DEFAULT 0,
  ADD CONSTRAINT baumy_memories_source_uniq UNIQUE (source, source_update_id, source_ordinal);
-- writes: .onConflictDoNothing({ target: [source, source_update_id, source_ordinal] })
```

### Verified Free (Hobby) tier limits — the design envelope
| Limit | Free value | Design impact |
|---|---|---|
| Executions / month | **50,000** (run + each step); **PAUSES** at cap, no overage | The binding constraint; gate + lean steps + daily-arm reminders + hourly (not per-minute) sweep/dispatch crons |
| Max concurrent steps | **5** | Adds queue latency under bursts, not failure — fine for 4 users |
| Max sleep (`sleep` & `sleepUntil`) | **7 days** | Reminders use daily-arm + <6-day `sleepUntil`; scheduled tasks use a dispatcher (no per-task long sleep) |
| Trace / log retention | **24 hours** | Neon is the durable audit/observability source of truth |
| Events ingested / month | **500,000** (separate meter; non-matching event = 0 executions) | Firing 1 event/message is fine; optimize *step* count, not event count |
| Max function run length | **30 days** | Per-reminder runs stay ≤6 days by construction |
| Event lookback | **1 hour** | Recovery = re-query Neon, not Inngest event replay |
| Single event size | **256 KiB** | Keep event payloads minimal |
| Platform (all plans) | step timeout ≤2h (host-bounded → Vercel 300s), step payload 4 MiB, run state 32 MiB, ≤1000 steps/fn, ≤5000 events/req | — |

### Env / config
- **Provisioned by the Vercel↔Inngest integration (do NOT list in `.env.example` / `turbo.json` globalEnv):** `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`.
- **Tracked config:** `INNGEST_DEV` (local `=1`), `BAUMY_HOUSE_CHAT_ID` (fixed send destination = house group), `BAUMY_TZ` (house timezone, **`Europe/Berlin`** per B9; used for every cron `TZ=` prefix and for evaluating each scheduled task's `cron_expr`).

---

## Gotchas

- **Executions are billed per STEP, not per function.** A naive `classify→extract→embed→store→notify` pipeline is 6 executions/message; against an always-on group (privacy OFF) this is the single biggest way to blow 50k. Keep pipelines to 2–3 steps; combine `classify+extract` and `embed+store`; gate before enqueue.
- **A per-minute reminder cron is a trap:** `60×24×30 = 43,200` fires/month; with one step per fire that is **~86k executions/month — over the 50k cap before any real work.** Use daily-arm (D5). The catch-up sweep and the scheduled-task dispatcher run **hourly** (~720 fires/mo each), never per-minute; a fallback sweep should never drop below **≥15-minute** intervals (~2,880 fires/mo).
- **Inngest cron triggers are STATIC / code-defined.** You cannot register a new cron-triggered function per user-created task at runtime. "One schedule per task" (A4b) is implemented as a **stored `cron_expr` per row + one shared dispatcher cron** that evaluates `next_due_at` and emits per-task events (D14) — not one function per task.
- **Scheduled-task-run is the DELIBERATE path** — it may call web search (INPUT-only) and the heavier model. It **must never** be reachable from the reactive reply/ingest path, must be created only through the deterministic write-gate from a trusted member (never raw group text), must send OUTPUT only to the fixed house group, and is governed by the daily spend cap. Treat any way for group text to mint/steer a task or its destination as a security bug.
- **Digest cadence now lives in `baumy_scheduled_tasks`, not a hardcoded cron.** Editing the `kind='digest'` row's `cron_expr` re-schedules the digest on the fly; do not also wire a static digest cron (that would double-fire). Reconcile with proactive.md, which keeps the digest *content* builder + notify-gate.
- **The 7-day sleep cap applies to `step.sleepUntil` too**, not just `step.sleep`. You literally cannot schedule "remind me in 2 weeks" with one durable sleep on Free. Chunked ≤6-day sleep loops "work" but break at the **30-day max-run-length** for very-far reminders — which is exactly why daily-arm (each run ≤6 days) beats a single long-lived function, and why scheduled tasks use a dispatcher rather than a per-task `sleepUntil` (monthly/annual cadences would exceed 7 days).
- **24h trace retention makes the Inngest dashboard useless for anything >1 day old** (i.e. most reminders and scheduled tasks). Neon MUST hold the durable status/audit trail.
- **Hobby PAUSES (does not bill) at 50k** — a blown budget silently stops reminders, scheduled tasks, AND memory writes with no error, and **the internal catch-up sweep pauses with it**. Only the *external* heartbeat (D12) can detect this; keep it out-of-band.
- **Copying reference v3 Inngest code onto v4 will not compile:** `new EventSchemas().fromRecord()` is removed (→ `eventType()`), `createFunction` is 2-arg with triggers in config, and `serve()` no longer accepts `signingKey`/`baseUrl` (moved to the client). Only `app/api/inngest/route.ts` copies unchanged.
- **v4 default mode is `cloud`** — the local `/api/inngest` throws *"A signing key is required to run in Cloud mode"* unless `INNGEST_DEV=1` / `isDev:true`.
- **Do NOT auth-gate `/api/inngest`.** The signature check inside `serve()` is the auth; a broad middleware matcher returns `401` to Inngest's sync callback and **functions silently never register**. After every deploy, verify in Inngest Cloud that the `baumy` app + all functions (ingest, arm, deliver, sweep, dispatch, run, consolidate) are present — treat a missing function as a release blocker.
- **`onFailure` receives the ORIGINAL event nested as `event.data.event.data`** (system event `inngest/function.failed`), not `event.data`. Read the wrong path and you get `undefined`. Confirm the exact v4 payload shape before lifting the access pattern.
- **The idempotency guarantee only holds if the LLM extraction is in its own `step.run`** (D9). If it runs outside a step or is merged into the write step, a retry re-runs the LLM, yields different facts, and `(update_id, ordinal)` maps new content onto old slots — corrupting memory.
- **Do NOT gate the webhook's `inngest.send` on a DB insert.** "Insert-if-new then send" creates a lost-update hole (insert succeeds, crash before send, Telegram retry hits DB conflict and never re-sends). Always send; let event-id dedup + the in-function `record-inbound` step absorb duplicates.
- **The failure/ack notice AND all reminder/digest/task output must be a FIXED template / deterministic destination** — never interpolate untrusted update text into a privileged send, and never let a task/reminder row choose its own `chat_id`; a group message could otherwise steer or redirect a notification (violating the write-gate + exfil wall). Every send targets `BAUMY_HOUSE_CHAT_ID`.
- **`getUpdates` returns 409 while a webhook is set.** The outage-recovery drain must `deleteWebhook` → `getUpdates(offset=max(update_id)+1)` → `setWebhook`, as a single serialized one-shot. It's safe to replay an overlapping window precisely because ingest is idempotent on `update_id`.
- **`update_id` resets to a RANDOM value after 7 days of no updates.** Use it only as a dedup key; derive reconcile offsets from `max(update_id)+1` at drain time, never persist an "expected next id" invariant.
- **Privacy note:** if text travels in the Inngest event, it persists in event/step state for the retention window (third-party infra). For a private house bot, the hardened variant sends only `{updateId, chatId}` and re-reads `raw` from `baumy_telegram_updates` inside the function — at the cost of a webhook DB write (still idempotent, still always-send). Owner decision.
- **DST (Berlin):** `Europe/Berlin` transitions occur at 02:00 local (spring-forward skips 02:00→03:00; autumn repeats 02:00→03:00). Pin `TZ=Europe/Berlin` explicitly on every cron and avoid scheduling at **01:00–03:00 local** (the arm cron at 00:05 and consolidation at 03:30 are chosen to dodge it); optionally add `jitter: '30s'`. Storing IANA `Europe/Berlin` (not a fixed GMT offset) is what makes reminder/digest fire times DST-correct across the winter/summer switch.

---

## Tasks (ordered, with dependencies + estimates)

| # | Task | Depends on | Est. |
|---|---|---|---|
| **T1** | Install `inngest@^4.11`; connect the official **Vercel↔Inngest integration** so `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` are auto-injected and deploys auto-sync. Confirm peer compat with Next 16 / React 19 / zod 4. Keep keys OUT of `.env.example` & `turbo.json`. | — | 0.5h |
| **T2** | Create `lib/inngest/client.ts` (`new Inngest({ id:'baumy', isDev })`) and `lib/inngest/events.ts` (v4 `eventType()` defs for `telegram/message.received`, `reminder/arm.due`, `reminder/cancelled`, `scheduled-task/run.due`). Rename all foreign identifiers → `baumy`. | T1 | 1h |
| **T3** | Add `app/api/inngest/route.ts` (`serve`, `runtime='nodejs'`, `maxDuration=300`). Confirm middleware/proxy short-circuits `/api/*` so the route is NOT auth-gated. | T2 | 0.5h |
| **T4** | Create Neon `baumy_reminders` table (Drizzle schema + migration; `group_id` origin-scope; partial `(status,due_at) WHERE status='pending'` arm index + `(due_at) WHERE status IN ('pending','armed')` sweep index; `chat_id`=house group). | — | 0.5d |
| **T5** | Create Neon `baumy_telegram_updates` table (`update_id` PK, status, raw, index) + add memory dedup columns/`UNIQUE(source,source_update_id,source_ordinal)`. Audit for any foreign leftover identifiers. | — | 0.5d |
| **T6** | Implement `reminder-arm` daily cron (`TZ=Europe/Berlin 5 0 * * *`): atomic `pending→armed` for rows due within 6 days, then one batched `step.sendEvent`. ~30 fires/mo. | T3, T4 | 0.5d |
| **T7** | Implement `reminder-deliver` (event `reminder/arm.due`): `load` guard → `step.sleepUntil(dueAt)` (<6d) → atomic `→sent` claim → send to fixed `BAUMY_HOUSE_CHAT_ID` (house group); `cancelOn` + `idempotency` + `onFailure`→`failed`. | T6 | 0.75d |
| **T8** | Implement `reminder-sweep` catch-up "heartbeat" (`TZ=Europe/Berlin 15 * * * *`, hourly): atomic claim + send of any overdue `pending/armed` row (D5.5/D6), stamp the liveness marker. Wire `/api/health-reminders` to read it. | T7 | 0.5d |
| **T9** | Deterministic reminder **create/cancel** paths (write-gate): create from a member request via the confirmed-intent gate (never raw group text) — insert row, and if `due_at ≤ 6d` immediately arm + `inngest.send`; on send-failure flip row `failed`. Cancel: atomic `→cancelled` THEN emit `reminder/cancelled`. Never mutate the row from inside the cancelled function. | T7 | 0.75d |
| **T10** | Create Neon `baumy_scheduled_tasks` table (Drizzle; `group_id`, `cron_expr`, `tz='Europe/Berlin'`, `model_tier`, `web_search`, `expires_at`, `next_due_at` + partial due index) and a `next_cron_occurrence(cron_expr,tz,ts)` helper. Seed the built-in `kind='digest'` rows (mid-week + end-of-week). | T4 | 0.5d |
| **T11** | Implement `scheduled-task-dispatch` hourly cron (`TZ=Europe/Berlin 10 * * * *`): atomic claim of `active` rows with `next_due_at ≤ now()`, advance `next_due_at`, retire past-`expires_at` → `done`, batched `scheduled-task/run.due`. | T3, T10 | 0.5d |
| **T12** | Implement `scheduled-task-run` (event `scheduled-task/run.due`): DELIBERATE run per `model_tier` (Sonnet `assess`/Opus `advisor`) + optional web-search tool; `kind='digest'` calls the proactive digest builder; report to fixed house group via the outbound chokepoint; occurrence-idempotent; `onFailure`→`error`; spend-cap governed. Cross-ref `scheduled-tasks.md` + `llm-pipeline.md`. | T11 | 1d |
| **T13** | Implement `handle-telegram-message` ingest function: `record-inbound` (upsert on `update_id`) → `classify-extract` (ONE nano call, own memoized step) → `embed-store` (UNIQUE upsert). `retries:3`, `idempotency`, `onFailure` dead-letter, `NonRetriableError` on poison. Memory-only output. | T3, T5 | 1.5d |
| **T14** | Harden Telegram webhook: constant-time verify secret token (401 fail-closed), Zod-parse, `chat_id` gate, cheap pre-filter, `inngest.send({ id:`tg:update:${update_id}` })` (always send; 503 on throw), return 200 fast. | T13 | 0.75d |
| **T15** | Nightly `memory-consolidate` cron (`TZ=Europe/Berlin 30 3 * * *`): summarize/promote/prune + re-embed; add the dated-event surfacing scan raising proactive candidates (see proactive.md). Keep step count modest. | T13 | 0.5d |
| **T16** | Usage-monitoring + fail-silent guard + outage recovery: per-function execution counter to Neon; `/api/health-reminders` asserting the arm/sweep ran recently; external Claude-routine heartbeat + drain endpoint (`deleteWebhook`→`getUpdates(offset)`→`setWebhook`, serialized, secret-guarded). | T8, T13 | 0.75d |
| **T17** | Test suite (Vitest/PGlite): duplicate `update_id`→one row/fact; memoized-extract survives a simulated write-step retry (LLM called once, zero new rows); malformed update→`NonRetriableError`→`dead_letter`; reconcile replay→no double-write; a 30-day-out reminder proves the re-arm loop delivers it; the sweep re-fires an `armed`-but-unsent overdue row exactly once; `cancelOn` cancels a sleeping run; a scheduled task fires on cadence in `Europe/Berlin`, respects `expires_at`, and reports to the house group; **Berlin DST** transition dates fire reminders/tasks at the correct wall-clock time. | T7, T8, T12, T13 | 1.25d |
| **T18** | Local dev + deploy verification: `INNGEST_DEV=1` + `npx inngest-cli@latest dev`, confirm auto-discovery + test runs in the `:8288` UI; deploy and confirm Inngest Cloud shows the `baumy` app + all functions synced. | T3 | 1h |

**Total ≈ 10 days.**

---

## Risks & mitigations

| Risk | Sev. | Mitigation |
|---|---|---|
| **Execution quota (50k) exhausted → Hobby PAUSES all execution** (reminders, scheduled tasks, AND memory writes stop silently — the internal sweep pauses too). | High | Cheap webhook gate + lean/combined steps + daily-arm reminders + **hourly** (not per-minute) sweep/dispatch crons keep usage at 18–44% of cap; per-function counter + **external** out-of-band heartbeat (D12) alerts on stall; Neon is source of truth so nothing is lost, only delayed; `batchEvents` valve if volume climbs. |
| **7-day sleep cap breaks long-horizon reminders/tasks** ("remind me in 3 weeks"; monthly/annual task cadence). | High | Daily-arm + <6-day `sleepUntil` for reminders (far-future rows stay `pending`, armed on entry); scheduled tasks use a **dispatcher** (no per-task long sleep); runtime assert `(due_at - now) < 7d` before any sleep; test a 30-day-out reminder. |
| **Non-deterministic LLM extraction not isolated in its own step** → retry yields different facts, `(update_id,ordinal)` corrupts memory. | High | Mandate `classify-extract` as a dedicated memoized `step.run` (D9); write step consumes only memoized output; test asserts the LLM is called once across a simulated write-step retry. |
| **Untrusted group text steers a privileged write/notification or a scheduled-task's prompt/destination** (privacy mode OFF; deliberate path has web search). | High | Ingest output is memory-only with a strict event allow-list; reminder create/cancel + scheduled-task create are separate deterministic write-gate paths gated on trusted members; web search is INPUT-only; every OUTPUT pinned to `BAUMY_HOUSE_CHAT_ID`; fixed-template notices; verify secret token, dedupe `update_id`, fail closed. |
| **`/api/inngest` accidentally auth-gated** → Inngest sync callback 401s → functions never register → reminders/tasks silently never run in prod. | High | Ensure middleware short-circuits `/api/*`; after every deploy verify the `baumy` app + all functions appear in Inngest Cloud (release blocker if missing). |
| **Reminder never / late / double fires** (lost deliver run; failed create-send; cancellation race). | High | Independent **catch-up sweep** re-fires overdue rows; single atomic claim `UPDATE … SET status='sent' WHERE id=$1 AND status IN ('pending','armed') RETURNING` (D6) — only the winner sends; `idempotency` prevents double-arm; `onFailure` marks stranded rows. |
| **Copying reference v3 code onto v4** → type/compile failures; default-cloud blocks local dev. | Med | Adopt v4 shapes from the start (`eventType()`, triggers-in-config); only `route.ts` copies unchanged; `INNGEST_DEV=1` locally; pin `^4.11` + CI typecheck. |
| **Chatty group drives ingest executions above model** (privacy OFF). | Med | Deterministic + cheap-classifier gate before enqueue; combine steps; measure real volume in week 1; flip on `batchEvents:{maxSize:50,timeout:'10s'}` to amortize many messages into one run. |
| **Scheduled tasks / web search drive cost or duplicate reports** (many active tasks; a task fired twice). | Med | Occurrence-level `idempotency` on `scheduled-task-run`; dispatcher advances `next_due_at` atomically; `concurrency:{limit:2}`; daily spend cap governs the deliberate path; `expires_at` auto-retires finished tasks. |
| **DST / timezone drift** — a Berlin transition fires a reminder/digest an hour off, or a cron runs during the skipped 02:00–03:00 window. | Med | Store IANA `Europe/Berlin` (auto-DST); pin `TZ=Europe/Berlin` on every cron; schedule outside 01:00–03:00 local; test both Berlin transition dates in T17. |
| **Debugging blind after 24h** (Free trace retention; most reminders/tasks fire >24h after creation). | Med | Write every outcome (armed/sent/failed/dead_letter + error; task run/failed) to Neon; treat Inngest history as best-effort. |
| **A step exceeds Vercel's per-invocation cap** and is killed mid-step, stranding state. | Low | `maxDuration=300` gives headroom; keep each `step.run` well under 60s by splitting heavy AI work; `onFailure` flips any stranded row to a terminal state. |
| **5-concurrent-step cap throttles bursts** (many reminders/tasks at once). | Low | Adds queue latency, not failure — acceptable for 4 users; if it ever bites, the Basic tier (25 concurrency) is a cheaper bump than Pro. |
| **Pricing/tier numbers shift** (Pro quoted $75 vs $99; a stale "100k free executions" claim). | Low | v1 stays Free where the binding limits (5 concurrency, 7-day sleep, 24h history, 30-day run, 50k executions) are confirmed from official docs; re-confirm in-app before any spend. |

---

## Open questions (for the owner)

1. **`architecture.md` D10/D11 reconciliation is now RESOLVED, not open.** Decision E22 CONFIRMS daily-arm + short `sleepUntil` + catch-up-sweeper over the per-minute cron scanner. Action item (not a decision): update `architecture.md` D10/D11 to match this section — no owner input needed.
2. **Vercel Hobby `maxDuration`.** This section (and `architecture.md` D5) uses **300s** (Fluid Compute, default-on since 2025-04-23). Confirm at build time on the account — it materially changes step-splitting design (older sources cite a 60s Hobby ceiling).
3. **Pin `inngest@^4.11.0` — confirm peer compatibility** with Next 16 / React 19 / zod 4 before locking, and confirm the exact v4 `onFailure` failure-event payload path (`event.data.event.data`) for the pinned version.
4. **Confirm the 50k execution quota + measure real volume.** Re-confirm 50k in-app on the billing page once the account exists (a stale secondary source claims 100k), and replace the 9k–22k/mo estimate with a week of measured production traffic (now including scheduled-task + sweep overhead) to verify headroom.
5. **Event-payload privacy:** send message text in the Inngest event (simpler, matches `architecture.md` D6) or send only `{updateId, chatId}` and re-read `raw` from `baumy_telegram_updates` inside the function (keeps housemate text off Inngest infra, at a webhook DB write)? Product/privacy decision.
6. **Dead-letter UX:** on a failed ingest/reminder/scheduled-task run, does the house want a visible fixed-template "couldn't do that, mind resending?" notice, or a silent dead-letter + operator-only alert?
7. **Heartbeat/fallback ownership:** the internal `reminder-sweep` is confirmed (E22). Keep the *external* "scheduled Claude routine pinging `/api/health-reminders`" heartbeat as the out-of-band liveness check (recommended — it survives a paused Inngest quota), or rely on the internal sweep alone? (Recommend: keep external.)
8. **Scheduled-task granularity + limits (defer to `scheduled-tasks.md`):** the hourly dispatcher gives ~1-hour fire granularity — fine for weekly/digest cadences; do any v1 tasks need finer (→ 15-min dispatcher or per-occurrence `sleepUntil`)? Also: max concurrent active tasks per house, and the exact web-search tool/provider (verify at build; "near us" may need a maps-capable search per decision CAP).
