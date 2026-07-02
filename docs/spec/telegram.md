# Telegram bot (built fresh)

> Workstream key: `telegram`. Built clean; the `camp-404` implementation is untrusted
> and lifted only as **plumbing shape** (fetch client, secret-verify, Zod passthrough
> parse). Every foreign identifier must be renamed — see the clean-room guard task.
> Verified against Telegram **Bot API 10.1** (released 2026-06-11, current as of 2026-07-01).

## Overview

Baumy's Telegram surface is a **thin, authenticated, deterministic enqueuer**, not an
application framework. Privacy mode is OFF, so the bot reads every message in the fixed
house group and **every inbound byte is untrusted prompt-injection input**. The webhook's
entire job is:

1. verify the `X-Telegram-Bot-Api-Secret-Token` header (constant-time, fail-closed),
2. minimally validate the update shape (`update_id` only),
3. apply a **deterministic inbound allow-list** (the house group `chat_id` — the trust
   boundary — plus private-chat DMs, which are the narrow channel for the dashboard
   magic-link),
4. emit exactly **one Inngest event** carrying the raw update verbatim,
5. ack a bodyless `200` fast.

The handler **never** interprets message text, **never** derives a send destination from a
message, and **never** uses Telegram's "reply-with-a-method" webhook trick. All AI work
(classification, retrieval-grounded replies, memory writes, reminders) and **all command
handling** (`/dashboard`, `/start`) happen **downstream in Inngest**, where the deterministic
write-gate lives and where the 60s Hobby invocation cap applies per step. The send
destination is a **fixed house `chat_id`** read from the DB (bootstrapped from env), never
from an incoming update.

**Authorization model (owner interview, finalized).** Group membership *is* the roster —
there is no curated allow-list.

- **Owner = whoever invited the bot.** Captured deterministically from the `my_chat_member`
  "added" transition (the inviter's Telegram-authenticated `from.id`); `BAUMY_OWNER_ID`
  overrides. This replaces the old `/start <BOOTSTRAP_SECRET>` dance.
- **Members are auto-discovered.** The first group message from a new `from.id` upserts a
  `members` row (name from the `from` field). No `/bind`, no deep-link tokens — the owner
  never handles raw ids. Leaving the group deactivates the member; their house-memory stays.
- **Trust boundary = `chat_id === BAUMY_HOUSE_CHAT_ID`.** Being in the house group is baseline
  housemate trust (contribute/query). Owner-tier actions are a separate code check. Group text
  still NEVER drives privileged writes/config (the injection wall).
- **DMs are for the dashboard magic-link only.** A member with `can_access_dashboard` DMs
  `/dashboard`; Baumy issues a one-time, short-TTL, single-use signed login URL bound to their
  `telegram_user_id` and DMs it back (the token/session layer is owned by `auth-identity.md`).
  A DM is also where a member's `dm_chat_id` is first captured.
- **Edited messages are corrections.** An `edited_message` is reread, re-run through the FULL
  gate, and treated as a supersede — never trusted more than the original.

Two structural facts drive the receiver design:

- **At-least-once delivery.** Telegram redelivers any update whose webhook returns non-2xx
  (or that times out). Idempotency is therefore mandatory and layered: an Inngest event-id
  key on the hot path plus a durable `update_id` primary key inside the function.
- **The `chat_id` is not stable.** A basic group silently migrates to a supergroup (new
  `chat_id`) on several triggers. The destination is stored in the DB and self-heals from
  Telegram-authenticated signals (`migrate_to_chat_id`, `my_chat_member`), never from text.

**Library choice: raw `fetch`** — a thin hand-rolled outbound client plus a Web-standard
App Router route handler — is the primary recommendation for v1. grammY 1.44.0 is the
explicit runner-up (adopt if rich interactive UI is needed later); Telegraf is rejected.
Rationale in Decisions.

## Decisions (with rationale)

### D1 — Library: raw `fetch` for v1; grammY as the pre-planned upgrade path; reject Telegraf
- **Raw `fetch`.** Baumy's webhook is a thin enqueuer, so grammY's entire value-add
  (middleware, sessions, conversations, filter queries — i.e. "do work *in* the handler")
  is precisely the model Baumy deliberately avoids. Hand-owned code is the most auditable
  path from untrusted bytes to the write-gate, with no framework middleware ordering to
  reason about. Outbound surface is tiny (`sendMessage` to a fixed chat, `setWebhook` once,
  `getMe` healthcheck). Smallest cold-start/bundle on Hobby. Confidence: **high**.
- **grammY 1.44.0 runner-up** (published 2026-06-14, 4 runtime deps, always tracks the
  latest Bot API). If Baumy grows inline keyboards, `/commands`, `callback_query`,
  reactions or editing flows, switch to grammY. Low-risk swap because the receiver stays a
  thin enqueuer either way. **If adopted, the App Router adapter is `webhookCallback(bot,
  "std/http", { secretToken })` — NOT `"https"`** (which is for classic Node `(req,res)`
  Pages functions and will not work in a Route Handler). Confidence: medium.
- **Reject Telegraf 4.16.3** (2026-03-06): lags the Bot API by several versions, ~8 runtime
  deps, `webhookCallback` is historically Node `(req,res)`-oriented. Nothing wins for a thin
  serverless webhook. Confidence: high.
- **Types without runtime cost:** install `@grammyjs/types` (3.28.0, the version grammY
  1.44.0 itself uses) as a **types-only dev dependency** to type the raw-fetch client
  against the current Bot API. Confidence: medium.

### D2 — Runtime `nodejs`; authenticate with `node:crypto` `timingSafeEqual` (length-guarded)
`timingSafeEqual` is native/audited but **throws `RangeError` on unequal-length buffers**,
so a length check must precede it (the fixed 32/64-char token makes the length side-channel
irrelevant). Node runtime gives `Buffer`, `node:crypto`, a clean `inngest.send`, and the DB
driver. Do **not** hand-roll an XOR loop (as camp-404 does). Confidence: high.

### D3 — The auth boundary is the ONLY non-2xx source (except transient Inngest failure)
- Bad/missing secret → **401** (fail closed, before reading the body).
- Past the auth gate, **always ack 200** on unfixable inputs (malformed JSON, shape-invalid,
  non-allow-listed chat, duplicate) — a non-2xx would trigger Telegram redelivery storms.
- **Return 500 only when `inngest.send()` throws.** That is the one case worth a retry:
  Telegram redelivers, and the event-id idempotency key makes reprocessing safe, so no
  housemate's message is silently lost. Acking 200 on a send failure would silently drop a
  memory — unacceptable in a memory-first product. Confidence: high.

### D4 — Dedupe primarily via Inngest event-id `tg-<update_id>`; back it with a durable PK
No synchronous DB round-trip on the hot path: set the Inngest event-level `id` to
`tg-<update_id>`. **Verified:** Inngest's event-id idempotency is a **bounded 24-hour
window** (current documented value, not "forever"), and the id is **global across all event
types** (the `tg-` prefix namespaces it correctly). Because the window is bounded — and
because a Telegram idle-week can reissue a random `update_id`, and a *paused* Inngest
function ignores event idempotency — durable dedupe is enforced inside the function by a
`telegram_updates(update_id BIGINT PRIMARY KEY)` upsert with `ON CONFLICT DO NOTHING`. That
row also gives provenance (source + timestamp + raw) the memory substrate wants. Use
**BIGINT** everywhere: supergroup `chat_id` is a large negative `-100…` value and
`migrate_to_chat_id` can exceed 32 bits (up to 52). Confidence: high.

### D5 — Deterministic inbound allow-list: house group id (the trust boundary) + member DMs
Extract `chat.id` **and** `chat.type` from whichever update field is present and forward two
classes of update; ack 200 (drop) everything else:
- **House group.** `chat.id` equal to the active house group id in `telegram_chats` (source of
  truth, seeded from `BAUMY_HOUSE_CHAT_ID`). This equality **is** the trust boundary for house
  memory + privileged writes (owner decision B10: "trust boundary = `chat_id ===
  BAUMY_HOUSE_CHAT_ID`"). The migration counterpart id is accepted only during the
  reconciliation window via trusted service fields (D9).
- **Private DMs.** `chat.type === 'private'` — the narrow channel for the `/dashboard`
  magic-link and `dm_chat_id` capture. `chat.type` is a Telegram-authenticated field (not
  message text), so gating on it satisfies the write-gate. DM updates are **narrowly gated
  downstream**: only a known member's `/dashboard`/`/start` is actioned; DM text never drives a
  privileged write; unknown senders are dropped in the Inngest function. The webhook does **no**
  membership DB lookup (stays deterministic and sub-second) — the downstream write-gate + cached
  member set enforce DM trust.

Pure field-equality / field-type checks, no text interpretation — consistent with the
write-gate. This cuts event volume/cost and shrinks the injection surface (the bot could be
added to arbitrary chats; those are dropped). Confidence: high.

### D6 — Do NOT use the "reply-with-a-method" webhook response
**Verified feature** (Telegram lets the webhook HTTP *response* body carry a Bot API method
call via a `method` field, in `application/json`, `x-www-form-urlencoded`, or
`multipart/form-data`; you get no result back). Baumy deliberately does **not** use it:
replies are retrieval-grounded, async, and multi-second/multi-step across Inngest
invocations. Inlining a method would couple the fast-ack path to LLM latency. Return an empty
`200` and send any reply later via a separate authenticated `sendMessage`. Confidence: high.

### D7 — Privacy mode OFF via BotFather, then remove+re-add the bot; keep it NON-admin
`/setprivacy → Disable` in @BotFather is **silently insufficient on a group the bot is
already in** — the bot must be **removed and re-added** for the change to take effect there,
and Telegram raises no error if you forget (the bot just looks "quiet"). Keep `/setjoingroups`
**Enabled** so the re-add is possible. **Verify programmatically:** `getMe` →
`can_read_all_group_messages === true`. Prefer **non-admin** (least privilege): an admin bot
also receives all messages but gains send-to-anyone/ban/pin powers Baumy doesn't need, and
`can_read_all_group_messages` reflects only the `/setprivacy` flag (an admin bot with privacy
still "enabled" reads everything yet reports `false`). Confidence: high.

### D8 — `allowed_updates` = `["message","edited_message","my_chat_member"]` for v1
- **`message`** carries all group text **and** every service message
  (`migrate_to_chat_id`, `migrate_from_chat_id`, `new_chat_members`, `left_chat_member`) —
  so migration and membership signals (including member deactivation on leave) arrive without
  a dedicated update type.
- **`edited_message`** — **CONFIRMED in v1 (owner decision D18).** A housemate correcting a
  fact is first-class in a memory-first product: **reread the edit, re-run the FULL gate
  (re-classify), and treat it as a correction that supersedes** the prior fact (keyed on
  `chat_id` + `message_id`). **Never trust an edit more than the original.** Each edit carries a
  fresh `update_id`, so `update_id` dedupe still holds and the edit is not confused with the
  original message.
- **`my_chat_member`** — the bot's own add/remove/promote transitions. Load-bearing: it (a)
  confirms the post-privacy re-add and triggers a `getMe` re-check, (b) registers/deactivates
  the house group, and (c) **captures the OWNER** — the `from.id` on the "added" transition is
  the inviter (owner decision: owner = bot inviter). It is in the default set but **is silently
  dropped once you pass `allowed_updates` unless re-listed**.
- **Excluded for v1:** `chat_member` (needs the bot to be an **admin** — conflicts with the
  non-admin least-privilege stance; member join/leave comes from the `message` service fields
  `new_chat_members`/`left_chat_member`), `callback_query` (add only if reminder inline
  keyboards ship in v1), and everything else (reactions/polls/inline/channel/business) to cut
  noise and injection surface.
- **Always pass the explicit array.** Calling `setWebhook` without `allowed_updates` keeps
  the previous set; changes are **not** retroactive to already-queued updates. Confidence: high.

### D9 — Store the house destination in the DB; self-heal on group→supergroup migration
Env `BAUMY_HOUSE_CHAT_ID` is a **bootstrap seed only**; the authoritative destination is a
row in `telegram_chats` (BIGINT). **Verified:** a basic group upgrades to a supergroup
(instant, irreversible, new `chat_id`) on triggers including exceeding 200 members, assigning
a public username, enabling Topics/forum mode, changing granular member/admin permissions,
changing chat-history visibility, enabling slow mode, or linking as a channel's discussion
group (the list is non-exhaustive — hence "commonly"). The new id is **not derivable by
arithmetic** (the `-100` prefix is not concatenated onto the old id). Capture it from
Telegram on **both** deterministic channels and converge to one id:
- **Inbound:** `message.migrate_to_chat_id` (old chat) / `message.migrate_from_chat_id`
  (new supergroup) → update the stored id, set `type='supergroup'`, record `migrated_from`.
- **Outbound:** a `sendMessage` to a stale id returns **HTTP 400 "Bad Request: group chat was
  upgraded to a supergroup chat"** with `parameters.migrate_to_chat_id` → update the stored
  id and **retry the send once** against the new id.

Both signals come from Telegram service fields / API errors, never from message content, so
acting on them satisfies the write-gate. Also handle `parameters.retry_after` (flood control)
with bounded backoff / Inngest retry. Confidence: high.

### D10 — Register `setWebhook` from a one-shot protected admin action, not Vercel cron
`setWebhook` is a run-once deploy-time operation; Vercel cron is banned for cost. Trigger it
from an admin-CLI `tsx` one-shot **or** a `BAUMY_ADMIN_SECRET`-guarded route, then verify with
`getWebhookInfo` (assert `url` matches, `last_error_message` is null, `pending_update_count`
is sane). Use `drop_pending_updates: true` on (re)deploy to flush stale backlog.
**Must register the stable production domain (`BAUMY_PUBLIC_URL`), NOT `VERCEL_URL`** — a
preview host triggers Vercel deployment-protection/SSO `403`, which Telegram then retries
indefinitely with no update ever processed. Confidence: high.

### D11 — Identity = numeric `from.id`; members AUTO-DISCOVERED; owner = the bot's inviter; DMs only for the dashboard magic-link
Per-user identity is **in v1 scope** (the magic-link login and author-attribution both need
it), but it is populated **automatically from group activity** — there is no manual binding
and no deep-link token for access.
- **Identity key = `from.id`** (BIGINT), spoof-proof numeric. Persist `username`/`first_name`
  as **mutable, non-authoritative display fields** (usernames are user-editable → impersonation
  vector).
- **Auto-discovery (no `/bind`).** The first group message from a new `from.id` upserts a
  `members` row (`display_name` from the `from` field, `role='member'`, `group_id` = the house
  group, `is_active=true`). **Group membership IS access** (owner decision B10) — the owner
  never handles raw ids. The cached "known member" set is refreshed on discovery.
- **Owner = the bot's inviter.** Capture `from.id` from the `my_chat_member` "added" transition
  (the bot's status changing to `member`/`administrator` in the house group) and set that
  member `role='owner'`. `BAUMY_OWNER_ID` env override wins when set. Replaces the old
  `/start <BOOTSTRAP_SECRET>` dance. The owner tier is a **code check** (owner `from.id`), never
  a Telegram UI feature.
- **Deactivation.** `left_chat_member` (a `message` service field) or a `my_chat_member` showing
  a member `left`/`kicked` → set `is_active=false`. Their contributed house-memory **remains**
  (provenance preserved).
- **Guard anonymous/service senders** (`GroupAnonymousBot ~1087968824`, service `777000`,
  channel posts, missing `from`) → resolve to "unidentified", **zero capability, never
  auto-created** as a member.
- **DMs are the dashboard magic-link channel only.** A member DMs `/dashboard`; the downstream
  handler (a) captures/refreshes `dm_chat_id` (a bot cannot DM a user who has not messaged it
  first — `403 "bot can't initiate conversation"`), (b) checks `can_access_dashboard`, (c) calls
  the `auth-identity` mint to issue a **one-time, short-TTL, single-use signed login URL** bound
  to `telegram_user_id`, and (d) `sendMessage`s the URL back. **No BotFather `/setdomain`, no
  login widget, no deep-link bind tokens.** The magic-link token/session layer is owned by
  `auth-identity.md`; this workstream only receives `/dashboard`, gates it, and delivers the URL.
- `members` is the **canonical identity row, owned by `product.md`/`data.md`**; this workstream
  populates + maintains it. Confidence: high.

## Concrete design / APIs / DDL / config

### Environment variables
| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token (outbound calls). |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` (64 hex chars — valid subset of `[A-Za-z0-9_-]`, 1-256). Echoed in the `X-Telegram-Bot-Api-Secret-Token` header. |
| `BAUMY_HOUSE_CHAT_ID` | Bootstrap seed for the house group row **and the trust boundary** (DB is source of truth). |
| `BAUMY_OWNER_ID` | Optional owner override. Default owner = the bot's inviter, captured from `my_chat_member` "added". |
| `BAUMY_PUBLIC_URL` | Stable production domain for `setWebhook` **and** the dashboard magic-link base (never `VERCEL_URL`). |
| `BAUMY_ADMIN_SECRET` | Guards the one-shot `setWebhook` admin route (if not using the CLI). |

`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` come from the Vercel↔Inngest integration — do
**not** add them to `.env.example` or `turbo.json globalEnv`. Add `TELEGRAM_*` and
`BAUMY_*` to `turbo.json globalEnv`.

### Typed Inngest client (`apps/web/lib/inngest/client.ts`)
```ts
import { Inngest, EventSchemas } from 'inngest';

type BaumyEvents = {
  'telegram/update.received': {
    // chatType lets the downstream write-gate branch group vs DM without re-parsing raw
    data: { updateId: number; chatId: number; chatType: string; raw: unknown };
  };
};

export const inngest = new Inngest({
  id: 'baumy',
  schemas: new EventSchemas().fromRecord<BaumyEvents>(),
});
```
`inngest.send({ id, name, data })` is compile-checked; keys are auto-read from env. Register
the consuming function in `apps/web/app/api/inngest/route.ts` `serve()` with
`runtime='nodejs'`, `maxDuration=60`.

### Webhook route handler (`apps/web/app/api/telegram/webhook/route.ts`)
```ts
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { inngest } from '@/lib/inngest/client';
import { getActiveHouseChatId } from '@/lib/telegram/house-chat'; // DB source of truth (D9)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15; // handler is sub-second; low cap fails a hung send fast into an idempotent retry

const HEADER = 'x-telegram-bot-api-secret-token';
const envelope = z.object({ update_id: z.number().int() }).passthrough();

function ctEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(ab, bb);
}

function chatOf(u: any): { id: number; type: string } | null {
  const c =
    u.message ?? u.edited_message ?? u.my_chat_member ?? u.callback_query?.message ?? null;
  const id = c?.chat?.id;
  const type = c?.chat?.type;
  return typeof id === 'number' && typeof type === 'string' ? { id, type } : null;
}

export async function POST(req: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const presented = req.headers.get(HEADER);
  if (!expected || !presented || !ctEqual(presented, expected)) {
    return new Response('unauthorized', { status: 401 }); // fail closed, before body read
  }

  let json: unknown;
  try {
    json = await req.json(); // read body once; Telegram signs only the header, not the body
  } catch {
    return new Response(null, { status: 200 }); // malformed → ack, no retry storm
  }

  const p = envelope.safeParse(json);
  if (!p.success) return new Response(null, { status: 200 });
  const update = p.data;

  const chat = chatOf(update);
  const house = await getActiveHouseChatId(); // DB-backed; self-heals on migration
  const isHouseGroup =
    !!chat && (chat.id === house.current || chat.id === house.migratedFrom);
  const isPrivateDm = chat?.type === 'private'; // narrow channel for /dashboard + /start
  if (!chat || (!isHouseGroup && !isPrivateDm)) {
    return new Response(null, { status: 200 }); // deterministic inbound allow-list (D5)
  }

  try {
    await inngest.send({
      id: `tg-${update.update_id}`,
      name: 'telegram/update.received',
      data: { updateId: update.update_id, chatId: chat.id, chatType: chat.type, raw: update }, // untrusted, verbatim
    });
  } catch (err) {
    console.error('[telegram/webhook] inngest.send failed', err);
    return new Response('upstream unavailable', { status: 500 }); // Telegram redelivers; idempotent
  }

  return new Response(null, { status: 200 });
}

export function GET() {
  return new Response('method not allowed', { status: 405 }); // short-circuit scanners/health checks
}
```
**Invariants:** `401` is the only pre-auth non-2xx; post-auth acks `200` on all unfixable
inputs; `500` only on transient send failure; `raw` is forwarded untouched; the only
text/type interpretation is the authenticated `chat.type` field, never message content.

### First Inngest step — durable dedupe + provenance + routing
In the `telegram/update.received` function's first step:
```sql
INSERT INTO telegram_updates (update_id, chat_id, update_type, raw)
VALUES ($1, $2, $3, $4)
ON CONFLICT (update_id) DO NOTHING
RETURNING update_id;
```
If 0 rows returned → duplicate → stop (idempotent no-op). Derive `update_type` from which
`raw.*` field is present, then route:
- **Service messages** (migration/join/leave — no `text`) → **early-return before any AI
  classification or memory write**, so a service message cannot enter the write path. Join/leave
  service fields (`new_chat_members`/`left_chat_member`) drive member auto-discovery /
  deactivation (D11); `migrate_to/from_chat_id` drive migration convergence (D9).
- **Edited messages** → do **NOT** early-return. **Reread, re-run the FULL gate (re-classify),
  and supersede** the prior derived fact keyed on `(chat_id, message_id)` — never trusting an
  edit more than the original (D18). The supersede itself is executed by the memory substrate
  (`memory-core.md`); this step only re-enters the gate.
- **Private-chat updates** → gated here, not in the webhook: a **known** member's
  `/dashboard`/`/start` is actioned (magic-link mint + `dm_chat_id` capture); all other DM
  handling follows the write-gate (house-management-only, author-attributed); **unknown DM
  senders are dropped**.

### DDL (Drizzle → Postgres)
```sql
-- Dedupe + provenance (memory-first substrate wants source + timestamp + raw)
CREATE TABLE telegram_updates (
  update_id    BIGINT PRIMARY KEY,
  chat_id      BIGINT NOT NULL,
  update_type  TEXT   NOT NULL,
  raw          JSONB  NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Chat allow-list + self-healing destination (DB is source of truth; env only bootstraps)
CREATE TABLE telegram_chats (
  chat_id               BIGINT PRIMARY KEY,
  type                  TEXT NOT NULL,          -- 'group' | 'supergroup'
  role                  TEXT NOT NULL,          -- 'house_group'
  title                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  migrated_from_chat_id BIGINT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- exactly one active house group
CREATE UNIQUE INDEX one_active_house_group
  ON telegram_chats (role) WHERE role = 'house_group' AND is_active;
```

**Identity lives in the canonical `members` row (owned by `product.md`/`data.md`).** Telegram
auto-discovery (D11) populates + maintains it; there is **no bind-token table** (deep-link
binding for access is removed) and the dashboard magic-link token/session layer is owned by
`auth-identity.md`. Columns this workstream reads/writes (types per the ratified
`product.md`/`data.md` `members` DDL):
```text
telegram_user_id      -- spoof-proof numeric from.id; the identity key (UNIQUE)
display_name          -- from the `from` first_name/username; mutable, non-authoritative
role                  -- 'owner' | 'member'  (owner = my_chat_member inviter / BAUMY_OWNER_ID)
can_access_dashboard  -- boolean grant; gates the /dashboard magic-link (default false)
dm_chat_id            -- private-chat id, captured on the member's first DM; NULL until then
group_id              -- origin-scope (owner decision D-sec); the house group discovered in
is_active             -- false on left_chat_member / my_chat_member 'left'|'kicked'
discovered_at, last_seen_at
```
Auto-discovery upsert (first group message from a new `from.id`, and last-seen refresh):
```sql
INSERT INTO members (telegram_user_id, display_name, role, group_id, is_active, discovered_at)
VALUES ($fromId, $displayName, 'member', $houseGroupId, true, now())
ON CONFLICT (telegram_user_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      is_active    = true,
      last_seen_at = now();
-- Owner capture (my_chat_member "added"; BAUMY_OWNER_ID overrides): same upsert with role='owner'
-- (role escalates but never de-escalates on merge). Deactivation on leave: SET is_active=false.
```

### `setWebhook` registration (one-shot)
```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://<prod-domain>/api/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message","edited_message","my_chat_member"],
    "max_connections": 40,
    "drop_pending_updates": true
  }'
# then verify:
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
# assert: url matches, last_error_message == null, pending_update_count sane
```
Add `"callback_query"` to `allowed_updates` only if reminder inline keyboards ship in v1.
Member join/leave (auto-discovery + deactivation) comes from the `message` service fields
(`new_chat_members`/`left_chat_member`) and `my_chat_member` — the bot stays **non-admin**, so
`chat_member` stays **excluded**.

### Outbound send wrappers (fixed destination + migration reconciliation)
`apps/web/lib/telegram.ts` (server-only), called from **Inngest steps, never the webhook**:
- `sendToHouse(text, opts?)` always targets the **DB** active house `chat_id` (a constant,
  never taken from an incoming update — enforces the write-gate/fixed-destination rule).
- `sendDm(memberId, text)` targets a member's stored `dm_chat_id` and **must guard on
  `dm_chat_id IS NOT NULL`** (a bot cannot DM a user who has not messaged it first — `403`).
  Used for the `/dashboard` magic-link reply; never for house broadcasts.
- On HTTP `400` with `parameters.migrate_to_chat_id`: update the stored id, set
  `type='supergroup'`, set `migrated_from_chat_id`, and **retry the send once** to the new id.
- On `parameters.retry_after` (flood): bounded backoff / Inngest retry.

### Verified reference values
- **Bot API 10.1**, released 2026-06-11 (confirmed against `core.telegram.org/bots/api`,
  the changelog, and `@BotNews`).
- `secret_token`: 1-256 chars, `[A-Za-z0-9_-]` only; delivered in
  `X-Telegram-Bot-Api-Secret-Token` on every request.
- Webhook ports: 443/80/88/8443 (Vercel serves 443 → compliant).
- `max_connections`: default 40, range 1-100.
- `allowed_updates` default = all types **except** `chat_member`, `message_reaction`,
  `message_reaction_count`.
- `my_chat_member.from` on an "added" transition = the inviting user (the owner); `new_chat_member.user` = the bot.
- Inngest event-id idempotency window = **24 hours** (documented current value), id is
  **global across event types** (namespace with the `tg-` prefix).

## Gotchas

- **`timingSafeEqual` throws on unequal-length buffers** — length-guard before calling it.
- **Header lookup lowercase:** `req.headers.get('x-telegram-bot-api-secret-token')`.
- **Read the body once** (`req.json()` in `try/catch`). Reading twice throws "Body already
  read"; Telegram signs only the header, so there is nothing to verify against the raw bytes.
- **Passing `allowed_updates` silently drops `my_chat_member`** unless re-listed — a subtle
  way to lose "bot added to group" and never learn the `chat_id` **or the owner**. Later
  `setWebhook` calls that omit `allowed_updates` silently revert to the broad default set.
- **Never set the webhook to a `VERCEL_URL` preview domain** — Vercel SSO returns `403` and
  Telegram retries forever. Use `BAUMY_PUBLIC_URL` (the stable production domain), or exclude
  `/api/telegram/*` from deployment protection.
- **BIGINT everywhere.** Supergroup `chat_id` is a large negative `-100…`; `migrate_to_chat_id`
  can exceed 32 bits. `INT4` silently corrupts it.
- **Never compute the supergroup id from the old id** — capture `migrate_to_chat_id`.
- **Privacy footgun:** after `/setprivacy → Disable`, forgetting the remove+re-add leaves the
  bot deaf in the group with **no error**. Add a boot/health assertion on
  `getMe.can_read_all_group_messages === true`. Keep `/setjoingroups` **Enabled**.
- **`can_read_all_group_messages` reflects only the `/setprivacy` flag, not the admin
  override** — don't rely solely on it if you ever promote the bot to admin.
- **SERVICE messages must early-return before AI/memory writes** — a service message (empty
  `text`) could otherwise smuggle content past classification.
- **EDITED messages must NOT early-return** — they re-run the **full** gate (re-classify) and
  **supersede** the prior fact keyed on `(chat_id, message_id)`; never trust an edit more than
  the original (D18). They carry a fresh `update_id`, so dedupe still holds.
- **Owner is captured from `my_chat_member.from`, never from message text** — a group message
  typing "make me owner" does nothing. `BAUMY_OWNER_ID` is the only override.
- **During migration you may see both** a `migrate_to_chat_id` (old chat) and a
  `migrate_from_chat_id` (new supergroup) message — dedupe on `update_id`, converge to the
  new `-100` id.
- **`drop_pending_updates: true`** on (re)deploy flushes stale backlog (good — no replay of
  old chatter) but also discards genuinely missed messages; acceptable for a house bot.
- **Bot cannot DM first** — a member's `dm_chat_id` is unknown until they DM the bot, so the
  `/dashboard` reply is only possible after that first DM (which captures `dm_chat_id`); guard
  all outbound DMs on `dm_chat_id IS NOT NULL`.
- **DMs are forwarded but narrowly gated** — the webhook lets `chat.type === 'private'` through;
  the Inngest function actions only a **known** member's `/dashboard`/`/start` and drops unknown
  senders. DM text never drives a privileged write.
- **Guard against missing/anonymous `from`** (`GroupAnonymousBot`, service `777000`,
  channel posts) → "unidentified", zero capability, **never** auto-created as a member.
- **GET/HEAD** to the webhook (health checkers, scanners) short-circuit to 405 without
  touching auth, so they don't spam error logs.
- **The webhook must treat `raw` as fully untrusted** — forwarded verbatim, never
  string-matched for commands, never used to choose a send destination in the hot path.

## Tasks (ordered, with dependencies + estimates)

1. **Env vars + secret generation** — *no deps, 20m.* Add `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`), `BAUMY_HOUSE_CHAT_ID`,
   `BAUMY_PUBLIC_URL`, `BAUMY_ADMIN_SECRET` (+ optional `BAUMY_OWNER_ID`) to `.env.example`
   and Vercel. Add `TELEGRAM_*`/`BAUMY_*` to `turbo.json globalEnv`; **do not** add the
   Inngest keys there.
2. **BotFather: privacy OFF + re-add bot; verify** — *no deps, 30m.* `/setprivacy → Disable`,
   confirm `/setjoingroups` Enabled, remove + re-add the bot as a **non-admin** member,
   assert `getMe.can_read_all_group_messages === true`, record the current `chat.id`.
3. **Scaffold `@baumy/telegram` (clean-room, raw fetch)** — *no deps, 2-3h.* Fetch-based
   client (`call<T>(method,payload)`, `getMe`, `sendMessage`, `setWebhook`, `deleteWebhook`,
   `getWebhookInfo`, `setMyCommands`, `escapeMarkdownV2`), `verifyWebhookSecret` (length-guarded
   constant-time), Zod passthrough `parseUpdate`. Reference camp-404 **shape only**; drop all
   camp-domain handlers. `@grammyjs/types` as a **types-only dev dep**. No grammy/telegraf.
4. **Typed Inngest client + serve()** — *deps: 1, 30m.* `inngest` (id `baumy`) with
   `BaumyEvents` (incl. `chatType`); register the `telegram/update.received` consumer in the
   `serve()` route (`nodejs`, `maxDuration=60`).
5. **`telegram_chats` allow-list + house-chat resolver + seed** — *deps: 1, 1h.* DDL +
   `getActiveHouseChatId()` (returns `{ current, migratedFrom }`), upsert-seed row from
   `BAUMY_HOUSE_CHAT_ID` on boot.
6. **Webhook route handler** — *deps: 3, 4, 5; 1.5h.* Implement per the code above:
   auth → parse → allow-list (house group **or** private DM) → single `inngest.send` → 200;
   `401` pre-auth only, `500` only on send failure.
7. **`telegram_updates` dedupe/provenance table + first Inngest step** — *deps: 4; 1h.* DDL +
   `INSERT … ON CONFLICT DO NOTHING RETURNING`; stop on duplicate; **service messages
   early-return; edited messages re-enter the full gate; private DMs gated (known-member-only)**
   before any AI/memory write.
8. **Send wrappers: fixed destination + migration reconciliation** — *deps: 3, 5; 2h.*
   `sendToHouse` + `sendDm` (guard `dm_chat_id IS NOT NULL`), outbound `400 migrate_to_chat_id`
   self-heal + retry-once, `retry_after` backoff. Called from Inngest steps only.
9. **`setWebhook` registration + verification** — *deps: 3, 6; 1h.* Admin-CLI `tsx` one-shot or
   `BAUMY_ADMIN_SECRET`-guarded route; `allowed_updates=["message","edited_message",
   "my_chat_member"]`, `drop_pending_updates:true`; verify via `getWebhookInfo`.
10. **Membership + owner capture + migration reconciliation (inbound)** — *deps: 6, 7; 2h.*
    Handle `my_chat_member` (activate/deactivate house row, re-check `getMe` on re-add, **capture
    the inviter as `owner`** / honour `BAUMY_OWNER_ID`), `message` service fields
    (`new_chat_members` → auto-discover, `left_chat_member` → deactivate), and
    `message.migrate_to/from_chat_id` (converge the stored id).
11. **Member auto-discovery + `/dashboard` magic-link handoff (v1 scope)** — *deps: 4, 6, 7;
    ~1 day.* On the first group message from a new `from.id`, upsert the `members` row
    (name from `from`, `role='member'`, `group_id`, refresh `last_seen_at`); anonymous/service
    senders excluded. Handle the private `/dashboard` command: gate on a known member with
    `can_access_dashboard`, capture/refresh `dm_chat_id`, call the `auth-identity` mint for a
    one-time signed login URL, and `sendDm` it back. **No deep-link bind tokens.**
12. **Unit tests (handler + verify + dedupe + gating)** — *deps: 6, 7; 2h.* Vitest: bad/missing
    secret → 401 (no send); malformed JSON → 200 (no send); missing `update_id` → 200; wrong
    `chat_id` non-private → 200 (no send); house happy path → one send with `id=tg-<update_id>`,
    `chatType='supergroup'` + 200; **private DM → forwarded (200, one send)**; `inngest.send`
    throws → 500; duplicate → stable idempotency id / `ON CONFLICT` no-op; **edited message →
    not early-returned (re-enters gate); service message → early-return; owner captured from
    `my_chat_member.from`, not text.** Mock `inngest` + lowercase-header `Request`.
13. **Clean-room guard** — *deps: 3, 6; 20m.* `grep -riE
    'camp[-]?404|ops[-]?board|opsboard|intake|captain|mission|ryanjnoble'` over all new files →
    zero hits. New package scope `@baumy/telegram`.

## Risks & mitigations

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Acking 200 on `inngest.send` failure silently drops a housemate's message (a permanently lost memory). | **High** | Return **500** on send failure so Telegram redelivers; idempotency via `id=tg-<update_id>` + `telegram_updates` PK makes reprocessing safe. |
| R2 | Slow hot path exceeds Telegram's delivery tolerance → redelivery / retry storms / duplicate processing. | **High** | Handler does only auth+parse+allow-list+one send (sub-100ms); zero LLM/heavy DB work inline; `maxDuration=15` fails a hung send fast into an idempotent retry. **Verified tolerance is ~60s** (tdlib reference server `idle_timeout=60`), not the ~10s sometimes cited — that ~10s is grammY's *client-side* default, not Telegram's edge — so the fast-ack rule is conservatively correct. |
| R3 | Prompt injection: with privacy OFF, group text is attacker-controlled; a text-derived privileged decision could be steered. | **High** | Webhook forwards `raw` verbatim, makes **no** text-derived decision (only authenticated `chat.id`/`chat.type`); send destination is the fixed DB chat id; owner/config writes are gated downstream on authenticated `from.id`, never on message text. |
| R4 | Group→supergroup migration mid-op → scheduled send targets the stale id and 400s. | **High** | Send wrapper auto-detects `parameters.migrate_to_chat_id`, updates the DB id, retries once; inbound `migrate_to/from` service messages also converge proactively. |
| R5 | Privacy re-add step skipped → bot silently reads nothing, no error. | **Medium** | Boot/health check asserts `getMe.can_read_all_group_messages === true`; loud alert if false; runbook documents the remove+re-add. |
| R6 | Webhook set to a preview/SSO-protected URL → Telegram gets 403 and retries forever. | **Medium** | Register only `BAUMY_PUBLIC_URL`; verify `getWebhookInfo.last_error_message`; exclude `/api/telegram/webhook` from deployment protection. |
| R7 | Missing `update_id` dedupe (as in camp-404) → duplicate memory writes / duplicate reminders. | **Medium** | Dual-layer: Inngest `id=tg-<update_id>` (24h) + `telegram_updates(update_id PK)` `ON CONFLICT DO NOTHING`. |
| R8 | A later `setWebhook` omits `allowed_updates` → silently reverts to the broad default set (noise + injection surface). | **Low** | Always pass the explicit array; config test reads `getWebhookInfo` and asserts `allowed_updates`. |
| R9 | `chat_id` stored as `INT4` truncates a >32-bit id → corrupted destination. | **Low** | Use `BIGINT` for all chat/user ids; migration-drift test. |
| R10 | Verbatim reuse of camp-404 code imports untrusted assumptions (no migration handling, predates the write-gate) or leaks foreign identifiers. | **Medium** | Rebuild `@baumy/telegram` fresh (reference method shapes only); clean-room grep guard. |
| R11 | Wrong user auto-elevated to owner (e.g. text claims ownership, or a non-owner admin re-adds the bot). | **Medium** | Owner captured strictly from the Telegram-authenticated `my_chat_member.from` on the "added" transition, never from message text; `BAUMY_OWNER_ID` override; single-owner invariant; role escalates-only on merge; owner tier is a code check on `from.id`. |
| R12 | Private-DM allow-listing widens the injection/cost surface (any user can DM the bot). | **Medium** | Webhook forwards DMs but the Inngest function actions **only** a known member's `/dashboard`/`/start` and drops unknown senders; DM text never drives a privileged write; `drop_pending_updates` + fixed outbound destination contain blast radius. |
| R13 | Dashboard magic-link URL leakage/reuse (visible in the DM). | **Medium** | Owned by `auth-identity.md`: one-time, short-TTL, single-use signed URL bound to `telegram_user_id`, gated on `can_access_dashboard`, atomic consume; second use rejected. Delivered only to the member's own `dm_chat_id`. |
| R14 | `telegram_updates` grows unbounded. | **Low** | Prune rows older than ~48h via a **scheduled Inngest** function (never Vercel cron); null `raw` after processing (privacy — the bot reads *all* group messages). |
| R15 | Public endpoint hit by scanners/replay; 401 path abused. | **Low** | 401 path does header compare only (no body read, no DB); secret is unguessable; optional lightweight edge rate limit. |

## Open questions (for the owner)

1. **Will reminder confirmations use inline keyboards?** Decides whether `callback_query` must
   be in `allowed_updates` for v1 (currently excluded). E22 (daily-arm + `sleepUntil` +
   sweeper) doesn't require them.
2. **Is the house group already a supergroup at launch?** If yes, no go-live migration — but
   keep the reconciliation paths for resilience.
3. **Owner-capture edge case:** if the bot is added by someone *other* than the intended owner
   (e.g. a housemate adds it on the owner's behalf), `BAUMY_OWNER_ID` is the override. Confirm
   whether a mismatch between the `my_chat_member` inviter and `BAUMY_OWNER_ID` should warn.
4. **Should a silent `chat_id` migration fire an audit/notify Inngest event** so operators are
   alerted? Recommended, not yet specced.
5. **Strict memory-write ordering:** **Verification refuted** the earlier "`max_connections=1`
   forces officially-guaranteed global serial delivery" claim. Telegram guarantees only
   *ordering by increasing `update_id`* and explicitly admits updates can arrive out of order;
   `max_connections=1` limits *in-flight connections* (practical serialization) but is **not**
   a documented global-serialization guarantee, and same-chat updates can be batched. If strict
   per-chat write ordering is a hard requirement, enforce it **app-side** (process by
   `update_id`, or a per-chat sequentialize step in Inngest) rather than relying on
   `max_connections`. This matters especially for `edited_message` supersede ordering.
