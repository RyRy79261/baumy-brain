# Baumy Brain — Clean-Room Lift & Rename Map

> The build lifts plumbing from three of your repos, but **zero foreign identifiers may survive** into `baumy-brain` (your explicit "keep it clean" rule). This map says exactly *what to lift from where*, *what to rename*, *what to delete outright*, and the *CI guard* that enforces it.
>
> **Golden rule:** rename the *plumbing*; **delete** the *domain features*. When in doubt, delete and rebuild — a foreign table/route tree is worse than a missing one.
>
> **Light-refresh note (2026-07-02):** the lift/rename/delete map below **still holds**. The two features that graduated after the interview — **`scheduled-tasks`** (A4b) and **`web-search`** (CAP) — introduced **no new workspace scope** and no new foreign lineage: web-search lands in the existing `@/ai` module (`web-search.ts`), scheduled-tasks in `@/core` (`scheduled-tasks-gate.ts`) + `@/db` + app `lib/scheduled-tasks/*` + `lib/inngest/functions/*`. Their new Inngest crons are lifted from the same **ops-board** reminder-arm pattern already covered by the guard. This refresh only *adds* their new module/function/env names to the rename convention + grep-guard assertions.

## What to lift, from which repo

| From | Lift (plumbing only) | Do NOT lift |
|------|----------------------|-------------|
| **`camp-404`** (primary skeleton) | Next.js app shell + `next.config`; `packages/db` dual-driver factory (`createHttpDb`/`createPooledDb`/`__setDbOverride`/`BUILD_PLACEHOLDER_URL`) + `drizzle.config`; Better Auth wiring (`@better-auth/cli` tables, `/api/auth/[...all]`); Telegram webhook *shell* (rebuild the handler — its logic is untrusted/broken); MCP + OAuth 2.1 plumbing (**deferred to v2**); PGlite `__setDbOverride` test seam; CI migration-drift + clean-room grep patterns; `camp_settings` singleton pattern (`boolean('id').pk().default(true)` + `check`) | `/captains`, `camp-management`, `announcements`, roster/rank/promotion, `GOD_EMAILS`, `INVITE_CODES`, `issueGroupInviteForUser`, `queueAnnouncement`, `handleChatMemberUpdate`, family-tree/questionnaires/feedback route trees, push/firebase-messaging, mobile app |
| **`ops-board`** (Inngest reference) | Inngest client + `serve` wiring, function/step patterns, event-map shape, throttle/concurrency/rate-limit usage, the in-memory `rate-limit.ts` helper — **now also the source for the `scheduled-task-dispatch` cron + `scheduled-task-run` / `deliberative-run` step patterns** (the reminder-arm daily-claim pattern generalized) | `/board`, `missions`, `mission-form-dialog`, `/research`, all `@opsboard/*` brand assets (`_brand/brand.tsx`, `manifest.ts`, `opengraph/twitter/apple` image routes) |
| **`intake-tracker`** (secondary) | Any generic helper patterns only | Everything domain/native: `apps/native/capacitor.config.ts` (`appId dev.ryanjnoble.intaketracker`), Java package paths, `@intake/*` |

## Rename table (apply mechanically)

| Slot | Foreign value(s) | → Baumy value |
|------|------------------|---------------|
| Repo / root pkg `name` | `camp-404`, `ops-board`, `intake-tracker` | `baumy-brain` |
| Workspace scope (every import) | `@camp404/*`, `@opsboard/*`, `@intake/*` | **`@/*` path imports** — architecture.md **D1** collapses to a **single Next.js app (no `packages/*`, no workspaces)**, so `@camp404/*` scope renames become `@/db`, `@/lib/*`, `@/core/*`, `@/ai/*`. `@baumy/*` names below are the *logical* module namespace; physically they are `@/*`. Modules: `@/core` (write-gate, **`scheduled-tasks-gate`**), `@/db`, `@/telegram`, `@/ai` (providers, **`web-search`**), `@/ai-prompts`, `@/types`, `@/evals`, plus app trees `@/lib/scheduled-tasks/*` + `@/lib/inngest/functions/*`. **No NEW scope** from scheduled-tasks/web-search (see addendum) |
| DB table / enum prefix | `camp_*`, `mission_*` | `baumy_*` (e.g. `baumy_reminders`, `baumy_telegram_updates`). New Baumy-native tables/enums carry **no foreign prefix**: `scheduled_tasks`, `scheduled_task_runs`, `scheduled_task_status`, `deliberative_runs`, `deliberative_trigger`, `deliberative_status`, and the added `ai_model_config` web-search columns |
| Config singleton | `camp_settings` | `house_config` (`baumy_*`) |
| Inngest client id | `camp404` / `opsboard` | `baumy` (`new Inngest({ id: 'baumy' })`). New function ids stay brand-neutral: **`scheduled-task-dispatch`**, **`scheduled-task-run`**, **`deliberative-run`**; new events **`scheduled-task/run.due`**, **`scheduled-task/cancelled`** — carry **no** `opsboard`/`mission` lineage even though lifted from ops-board |
| MCP `serverInfo.name` / registrar | `"camp-404"`/`"opsboard"`, `registerCampMcpTools`/`registerOpsboardTools` | `baumy-brain`, `registerBaumyMcpTools` *(v2)* |
| Env prefix (custom vars only) | `OPSBOARD_SESSION_SECRET`, `GOD_EMAILS` | `BAUMY_*` (`BAUMY_SESSION_SECRET`, `BAUMY_HOUSE_CHAT_ID`, `BAUMY_ADMIN_CHAT_ID`, `BAUMY_ALLOWED_TELEGRAM_USER_IDS`, `BAUMY_TZ`/`BAUMY_TIMEZONE`, `BAUMY_BOOTSTRAP_SECRET`, `BAUMY_ADMIN_EMAILS`; **scheduled-tasks:** `BAUMY_SCHEDULED_TASK_DISPATCH_CRON`, `BAUMY_SCHEDULED_TASK_MAX_ACTIVE`, `BAUMY_SCHEDULED_TASK_DEFAULT_UNTIL_DAYS`, `BAUMY_SCHEDULED_TASK_MAX_WEB_SEARCHES_PER_RUN`; **web-search:** `BAUMY_HOUSE_CITY`/`BAUMY_HOUSE_REGION`/`BAUMY_HOUSE_COUNTRY`, `BAUMY_WEB_SEARCH_PROVIDER`) |
| Test seam | `E2E_TEST_MODE` cookie / `campXXX_*` | `baumy_*` cookie names |
| Brand / manifest / persona | `OpsBoard`, `"OPS"`+`"BOARD"` wordmark, camp-404 brand | `Baumy` (name + short_name + persona) |
| (deferred) native `appId` | `dev.ryanjnoble.intaketracker` | `dev.ryanjnoble.baumybrain` *(mobile is out of v1 scope — drop entirely)* |

### Where scheduled-tasks + web-search land (light-refresh addendum)

Neither workstream adds a workspace scope; both extend existing modules. Recorded here so the CI guard and any future package-split stay honest:

- **web-search** → `@/ai/web-search.ts` (`houseWebSearchTool`, `HOUSE_LOCATION`; **never** export `web_fetch`/`webFetch`) + `@/lib/inngest/functions/deliberative-run.ts` + `ai_model_config` columns + the `deliberative_runs` audit table. All Baumy-native; `@baumy/search` is a **reserved name only** if ever hived into its own package.
- **scheduled-tasks** → `@/core/scheduled-tasks-gate.ts` + `@/db` (`scheduled_tasks`, `scheduled_task_runs`, `scheduled_task_status` enum) + app `@/lib/scheduled-tasks/*` (`create`, `cancel`, `cadence`, `extract`, `runner`, `digest-runner`) + `@/lib/inngest/functions/{scheduled-task-dispatch,scheduled-task-run}.ts`. `@baumy/tasks` is a **reserved name only** if ever split out.
- Both consume — never re-implement — the existing write-gate (`@/core`), model roster (`@/ai/providers`), outbound chokepoint (`sendToHouse`), and spend ledger.

## Keep as-is (vendor-standard, neutral — do NOT rename)

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `NEON_AUTH_*`, `CRON_SECRET`, **`BRAVE_API_KEY`, `TAVILY_API_KEY`** (web-search fallback providers, unset in v1). These are provider contracts, not project identity.

## Delete-don't-rename checklist (domain taxonomy Baumy forbids)

These conflict with the memory-first, schema-light substrate — lifting them reintroduces exactly the category system the product rejects:
- camp-404: `captains`, `camp-management`, `announcements`, roster/rank/promotion tables + enums, invites/`INVITE_CODES`, family-tree, questionnaires, feedback, push/firebase.
- ops-board: `missions`, `board`, `research`, `mission-form-dialog`. **Watch this on the scheduled-task/deliberative lift** — those crons are lifted from ops-board's reminder-arm pattern, so re-grep the copied files for `mission`/`opsboard` before keeping them.
- **Audit `packages/db/migrations/*.sql`** for any `camp_`/`mission_` table or enum names *before* reusing a migration — do not copy migration history; regenerate fresh from the Baumy `schema.ts`.

## Enforcement — CI grep guard (required check)

Add to CI as a blocking step; it must return **zero hits**:

```bash
grep -riE 'camp[-]?404|ops[-]?board|opsboard|intake[-]?tracker|@intake/|@campXXX|captain|mission|god_emails|invite_code|ryanjnoble' \
  --include='*.ts' --include='*.tsx' --include='*.json' --include='*.sql' --include='*.md' \
  . && { echo "FOREIGN IDENTIFIER LEAK"; exit 1; } || echo "clean-room OK"
```

Also assert in the same job:
- Root `package.json name === "baumy-brain"`.
- No `@camp404/`, `@opsboard/`, `@intake/` in any import (single-app → imports are `@/*`, so *any* `@campXXX/`/`@opsboard/`/`@intake/` scope is a leak).
- No `camp_`/`mission_` in generated migration SQL — including the new Baumy-native tables (`scheduled_tasks`, `scheduled_task_runs`, `deliberative_runs`) and enums.
- Inngest client `id === "baumy"`; **new function ids ∈ {`scheduled-task-dispatch`, `scheduled-task-run`, `deliberative-run`}** and events (`scheduled-task/run.due`, `scheduled-task/cancelled`) are brand-neutral; MCP `serverInfo.name` (when v2 lands) `=== "baumy-brain"`.
- **web-search package hygiene (from `web-search.md`, runs in the same job):** no `web_fetch`/`webFetch` export anywhere (`v1` ships search-only — zero-click exfil guard), and no bare-string gateway model ids (`'anthropic/…'`) — always the `createAnthropic` factory. These are security guards, not clean-room, but belong to the same blocking CI step.

## Procedure

1. Copy a plumbing package/file into `baumy-brain`.
2. Global-replace the scope/prefix per the rename table (single-app → `@/*`, not `@baumy/*` scopes).
3. **Delete** any domain feature it drags in (don't adapt).
4. Run the grep guard locally; iterate to zero hits.
5. Regenerate migrations from the Baumy `schema.ts` — never port foreign migration history.
6. Commit only once the guard is green.
