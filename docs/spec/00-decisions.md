# Baumy Brain — Decision Log (owner interview)

> Running record of Ryan's answers to `00-open-questions.md`, captured live during the interview. Supersedes the "recommended default" in the open-questions doc wherever an answer is recorded here.

_Started 2026-07-01._

---

## A1 — Dashboard in v1? → **YES, dashboard from v1.**
**Locks in:** `(private)/admin` route group + self-hosted Better Auth (`/api/auth/[...all]`) + `proxy.ts` matcher scoped to `['/admin/:path*','/api/auth/:path*']` (machine endpoints excluded); env `BETTER_AUTH_URL`/`BETTER_AUTH_SECRET`/`GOOGLE_*`/`BAUMY_SESSION_SECRET`. Auth-identity tasks 1–6 + architecture **T19 now IN scope** (not optional).
**Dashboard surface:** memory browser (+ provenance), member management + user-to-member mapping, reminder management, prompt editing, cost/usage view.
**Ripple:** raises the auth-identity "housemate logins vs owner-only" question (→ A1b, next).

## A1b — Dashboard access model + login → **Telegram-native.**
- **Lead owner** (`role='owner'`, bootstrap identity) has dashboard access by default; **any housemate can be granted** access via a `members.can_access_dashboard` boolean (owner grants via command/UI toggle). "Only 1 needs it, but easy to add more" = a boolean grant on an already-bound member. No RLS needed for this.
- **Login = Telegram-verified** (Telegram `user_id` *is* the dashboard identity). Better Auth kept as the **session layer only**.
- **SIMPLIFICATION vs plan:** drops Google OAuth + Resend magic-link + the `/link` dashboard-link-code flow (auth task 13). Auth-identity plan shrinks.
- **Login mechanism → (a) bot-DM magic link.** DM `/dashboard` → Baumy issues a one-time, short-TTL, single-use signed login URL bound to `telegram_user_id` and gated on `can_access_dashboard` → mints a Better Auth session. No BotFather `/setdomain`, no widget JS. (Widget option (b) rejected.)

## A2 — Per-user identity binding vs group-anonymous → **Per-user binding IN v1** (implied by Telegram-native login).
`members` table, `telegram_user_id → member` mapping, `/bind`, and `/start`→`dm_chat_id` capture are all load-bearing (the magic link needs them). Baumy knows who's who; not purely group-anonymous. Roles: `owner` (lead) + `member`; `can_access_dashboard` boolean is an independent grant.

## A3 — Memory scope → **All house-shared. Baumy is a HOUSE-MANAGEMENT tool, NOT a personal PA.**
Owner reframe (cost-driven + intentional): members do **not** use Baumy as a personal assistant — it manages the house/group. You may disclose things to it *for the group's purposes*, but it is not your personal secretary.
- **Memory = one shared house pool.** No `visibility`/`owner_user_id`, no per-user private memory, no RLS for memory. (Sensitivity scanner may still redact e.g. door codes in public replies, but there is **no private lane**.)
- **Explicit NON-GOALS:** per-user private memory, personal-PA reminders/tasks, "my personal assistant" framing.
- **Reminders → house-scoped, delivered to the GROUP** (resolves data Q5 / llm-pipeline Q9). Not per-user DM reminders.
- **DM purpose = house-management only:** dashboard magic-link login, member binding/`/start`, owner/admin commands, and house-purposed disclosures.
- **Simplifications unlocked:** `dm_chat_id`/DM `/start` only needed for members granted `can_access_dashboard`; regular member binding = owner adds `telegram_user_id` to the allow-list (no personal DM channel). Drops memory `visibility`/RLS work (memory-core Q1, security Q9/Q14) and most "no-DM-channel" risk. Intentional AI-cost control.

## A3b — Memory attribution & discretion (refines A3)
- Single shared house pool, but every memory/fact is **attributed to its author** (`telegram_user_id → member → name`), group or DM alike. Baumy can answer "what did Tom say about the landlord?" and cite who/when.
- Retrieval can filter/boost by author when a query names a person.
- **No hard private/shared partition** — a **"privacy discretion"** behavior instead: Baumy uses judgment about public disclosure (reuse the sensitivity scanner for soft redaction), not private silos.

## A5 — When Baumy replies → **Auto-answer house questions; configurable, incl. self-config.**
- Default: silent capture always; **reply on @mention/reply AND auto-answer house-relevant questions it can ground a confident answer to** — esp. scheduling + info lookups (landlord's number, bin day). "If it can answer, it should."
- **Configurable response policy** (DB config): enabled categories, confidence threshold, muted topics, global on/off — editable in the dashboard.
- **Self-configurable via natural language:** a trusted member tells Baumy "don't respond to X" and it updates its own response config.
  - **SECURITY:** privileged config write → through the deterministic **write-gate** only. Owner = full control; trusted housemates = safe-direction (reduce-noise) changes, audited; **untrusted group text can NEVER reconfigure** (injection would otherwise mute Baumy); always reversible via dashboard.
- **Ripple:** adds a `response_policy` config model + an `adjust_response_policy` gated intent. Modest scope growth vs address-only.

## A4 — Proactive output → **digests + conversational reminders + event surfacing + on-demand audits.**
- **Digests:** periodic house summaries, from memory (confirmed).
- **Conversational (Slack-style) reminders:** "let us know a week before Tom arrives", "tell us when rent's due" → **house reminders delivered to the group.** Anchors:
  - **Time-based** (absolute date/time or relative "in N days").
  - **Event-anchored** (offset like "a week before" a **dated event** captured in memory — guest arrival, bill due).
- **Proactive event surfacing:** Baumy is "privy to" dated events in memory; a **scheduled Inngest scan** over dated facts surfaces upcoming ones (advance notice ~a week) → feeds digests + conservative nudges.
- **On-demand checks/audits:** "go check what annual bills are due / what's needed" → retrieve + reason over relevant memory → report back. Pull-based (user-initiated, bounded cost); use the heavier model (Sonnet) for multi-fact reasoning.
- **Schema implications:** memory must capture **dated events with recurrence** (annual/monthly bills); the reminder engine handles **absolute times, relative lead-times, AND event-offsets** — richer than "fire at timestamp T."
- **Deferred to v1.1:** *condition-based watches* ("tell us WHEN the landlord replies" — evaluated against every future message; a standing subscription, heavier mechanism). v1 covers date/event-anchored cases.
- Nudges stay conservative + configurable/self-configurable (per A5).

## B9 — House timezone → **`Europe/Berlin`** (single, shared; DST-aware GMT+1 winter / GMT+2 summer).
House is in Berlin. Store IANA `Europe/Berlin` (auto-handles DST); reminder/digest DST-correctness (Berlin transitions) is the exact case the engine must pass.

## B10 — Roster / authorization → **group membership IS the roster.** "Baumy is a custodial feature of the group itself."
- **No curated allow-list.** Authorization = being in the house group; trust boundary = `chat_id === BAUMY_HOUSE_CHAT_ID`.
- **Members auto-discovered:** first group message from a new `user_id` → auto-create a `members` row (`user_id → name` from the `from` field). **No `/bind` needed for access** (owner never handles raw ids).
- **Leaving the group → member deactivated** (`left_chat_member`/`my_chat_member`); their contributed house-memory remains.
- **Single bootstrap `owner`** = dashboard + config + kill-switch. Extra dashboard access = `can_access_dashboard` grant; only those members `/start` a DM (for the magic link + `dm_chat_id`).
- **Security unchanged:** group membership = baseline housemate trust (contribute/query); group text still NEVER drives privileged writes/config (injection wall); owner tier for privileged actions; forwarded/bot content still untrusted.
- **Refines A2:** `members` table auto-populated from group activity; explicit `/bind` largely unnecessary.
- Reaffirms A3: group-helper, not personal PA (owner doesn't want to fund personal-secretary inference).

## C — Model routing → **decouple REACTIVE (cheap, capped) from DELIBERATIVE/ADVISOR (Opus, explicit-only).**
Core principle: the expensive model must NOT be reachable by a misclassified message. Roles (`model_route`/`ai_model_config`):
- **`classify` = OpenAI nano** — triage on every pre-filtered message.
- **`reply` = Haiku** — live chat replies + retrieval-grounded answers + trigger management. **HARD RULE: the reactive/reply path NEVER invokes Opus** (false-positive cost control).
- **`assess` = Sonnet** — assessment/reasoning over information that's on-hand/retrieved.
- **`advisor` = Opus** — derived answers needing real reasoning/research NOT directly on hand. **Invoked ONLY by explicit deliberate intent** ("go research/assess X"), never by the reactive classifier. "A calm, deliberate thing." Maps to the on-demand audits (A4).
- **All routing config-driven + tweakable** (no redeploy); exact tier thresholds are **TBD pending real UX** — ship defaults, tune from usage.
- **Spend cap:** hard daily ceiling **~$0.50/day (~$15/mo)**, tweakable; degraded mode past cap; **reminder delivery never gated**.
- Exact model ids/prices **verified at build** (per project rule).

## D17 (FINAL) — Retention → **keep BOTH verbatim messages AND a derived knowledge graph.** (Supersedes the earlier discard lean — no storage concern.)
- **Store all messages verbatim** (`source_messages`/`messages`: full text + author + timestamp) = evidence/quote layer. Enables exact quoting, re-extraction on model improvement, debugging/audit, and — key — a **bot-queryable transcript that fixes the no-scrollback limitation** (Baumy searches its OWN copy; it still can't read Telegram history). Trivial storage at house scale.
- **Derived knowledge graph** (`entities`/`facts`/`edges`, bitemporal + provenance) = understanding/reasoning layer; grounds replies, answers "what's due / what did X say"; points back to source messages for quotes.
- **Embed BOTH** raw messages (evidence, `memory_items`) AND derived facts → semantic search finds a relevant message even when extraction didn't structure it (hedge against misses).
- **Ceiling of fancy:** this dual layer (pgvector + relational graph, both in Postgres) is the sweet spot. **Do NOT overbuild** — no dedicated graph DB (Neo4j) / heavy GraphRAG at 4-person scale; add later "by need."
- **No schema change:** the already-spec'd `source_messages` + `memory_items`+embeddings + `entities`/`facts` design does exactly this. Telegram no-scrollback constraint resolved via our own store.
- **NOTE — Telegram bots CANNOT backfill group history** (only receive messages live post-join). Baumy's memory starts empty at deploy → cold-start seeding matters (see product cold-start).

## D-sec — Sensitive data → **app-side encryption of a flagged subset; access scoped to originating group.**
- **"Secure value" sensitivity flag** on facts; genuinely-secret items (door/gate/alarm codes, wifi, bank details) get it. Little secret data overall → proportionate ("standard secure, not military").
- **App-side encryption:** the bot holds an encryption key (Vercel secret / env); flagged values encrypted before write, decrypted on read to answer. A DB dump alone is useless without the app key. (Preferred over DB-side pgcrypto — key lives with the app, not the DB.)
- **Disclosure discretion:** answer secrets on request to a house member; NEVER volunteer unprompted; NEVER include in digests/broadcasts.
- **Access-control principle (owner):** data access = membership of the **group the data originated from.** v1 = single house group → any house member accesses house data (consistent with B10). **Add a `group_id`/origin-scope column now** so multi-group / multi-house Baumy is an additive flip later, not a rewrite.
- PENDING confirm: v1 single-group; schema future-proofed for multi-group.

## OWNER & TENANCY — **Owner = bot inviter; single-tenant (no hosting others' data).**
- **Owner = whoever invites the bot to the group** (captured from `my_chat_member` "added" event; `BAUMY_OWNER_ID` env override allowed). Replaces the `/start <BOOTSTRAP_SECRET>` dance.
- **All group members = equal usage rights** (contribute/query/ask for scheduled tasks). **Owner additionally holds admin/API/config controls** (kill-switch, model routing, spend, dashboard, keys); exact control surface TBD.
- **Single-tenant / personal project.** Baumy hosts only THIS house's data; owner does not want others' data. Others **self-host by forking** (own infra/keys). Keep `group_id` origin-scope as cheap hygiene (supports owner running a 2nd group), but **multi-tenant SaaS = NON-GOAL** (answers Q0).

## DOMAIN (reframe — refines cold-start/product) — **creative space / event HQ, NOT bills.**
- House = a **creative space & friends' event headquarters**: guests staying over, friends running events out of the house as venue/HQ, shopping, open-ended coordination. NOT rent/bills tracking.
- **Deliberately open/unstructured** ("no distinct structure yet") → strongly validates the schema-light memory-first substrate.
- **Cold-start seeding** = owner brain-dumps the current baseline (housemates, standing arrangements, upcoming guests/events) — not a bills setup.

## A4b — Scheduled tasks (NEW; generalizes digests) — **user-definable recurring queries.**
- Digest cadence **settable on the fly** (not hardcoded); generalizes to **user-defined scheduled tasks**: "run this query/prompt on a cadence and report back, until we're done."
- Example: "look for specials + hardware stores near us for the sink rebuild, weekly, until done."
- Model: `scheduled_tasks` {prompt, cadence, until/expiry, requester, model_tier, group_id} + one schedule per task via a shared dispatch cron; reports to the house group; cancellable; **digests become a built-in instance.**
- These are **deliberate tasks → heavier model (Sonnet/`advisor` Opus) + WEB SEARCH allowed.**

## CAP — Web search → **DELIBERATE path only.**
- Deliberate/advisor tasks (explicit trusted "go check/research X" + scheduled tasks) may use a **web-search tool** (verify tool at build; "near us" uses house location — may need maps-capable search) for external info (specials, nearby stores, prices).
- **Security invariant held:** reactive reply path stays **memory-only, zero tools** (exfil-safe). Web search is INPUT-only; OUTPUT still goes only to the fixed house group; never triggerable by untrusted group text; spend cap governs.

## E22 — Reminders → **daily-arm + `sleepUntil` + catch-up sweeper "heartbeat"** (CONFIRMED). Must fire reliably at the due moment and notify the group; sweeper = the heartbeat.

## D18 — Edited messages → **reread + re-run full gate + treat as correction/supersede** (CONFIRMED; never trust an edit more than the original).

## Nice-to-have — **member-askable spend query** ("how much have we spent this month?") answered from the spend ledger. Low priority; ledger already exists.

## Batch accepted — **#4** nudge triggers (guest/event/shopping/supplies focus, not bills); **#5** digests midweek + end-of-week (now on-the-fly settable); **#6** conservative thresholds tuned from real usage; **#7** verify model ids/prices + AI-SDK fields at build; **#8** defer multi-owner / anonymous-announce / message-reactions / condition-based-watches to v1.1+.

## #9 — Eval fixtures → **synthetic chats, owner-reviewed before use** (no real data exists yet; feature isn't live). Baumy generates candidate fixtures → owner approves.

_Interview decision set: COMPLETE for v1 scope. Next: reconcile these into the section specs + task graph._










