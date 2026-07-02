# Admin Auth + Identity — Spec Section

> Workstream key: `auth-identity`
> Scope: the **admin dashboard login** (who may open Baumy's web surface), the **identity graph**
> that reconciles a Telegram numeric id with a dashboard session, **auto-discovery** of housemates
> from group activity, the **owner bootstrap** (bot inviter), the **`can_access_dashboard` grant**,
> the **group/allow-list registries** the write-gate reads, and the **deferred** row-level-security +
> MCP layers. MCP is **documentation-only** here — nothing in the MCP subsection is built in v1.
> Anchored to `product.md` (identity DDL, write-gate, env inventory) and `llm-pipeline.md`
> (webhook filter, `allowed_updates`). Reconciled to `00-decisions.md` (A1/A1b/A2/A3/B10/OWNER +
> RLS-drop). Verified against current official sources as of **2026-07-02**.

---

## Overview

Baumy has two human-facing surfaces with two different trust models:

1. **Telegram (primary).** A housemate just talks to the bot in the house group. Identity here is a
   numeric `telegram_user_id`, and a member row is **auto-created the moment a new id first speaks in
   the house group** — no command, no `/start`, no owner action. This is the surface the whole product
   runs on; a housemate is a first-class member with **zero web account and zero DM**.
2. **Admin dashboard (secondary).** A small Next.js web surface (owner + optionally a housemate or two)
   for managing members, reminders, the response policy, prompts, and cost/usage. There are **no
   passwords, no Google, no email.** The **only** way in is a **Telegram bot-DM magic link**: a member
   who has been granted `can_access_dashboard` DMs `/dashboard`, and Baumy replies with a single-use,
   short-TTL, HMAC-signed login URL that mints a **Better Auth session**. Better Auth is the
   **session layer only** — it holds no provider accounts and performs no sign-in of its own.

This workstream owns the seam between them. The design is deliberately **Telegram-primary**: the
canonical identity row is `members`, keyed on `telegram_user_id`; a nullable `auth_user_id` links a
member to their (lazily created) Better Auth user, and a `can_access_dashboard` boolean is the single
grant that gates the magic link. Everything else (auto-discovery, owner bootstrap, the group registry,
the housemate allow-list accessor, and the deferred RLS/MCP layers) hangs off that one row.

Four invariants govern the whole section:

- **Auth governs the dashboard only; it never touches Telegram authorization.** Group text (privacy
  mode OFF = untrusted) must never mint or steer an admin session. The Telegram side is governed by the
  deterministic write-gate + the owner-command code check, *not* by web sessions.
- **Owner is the bot inviter, resolved by a code check — never a Telegram UI feature.** The owner is
  **whoever added the bot to the house group** (`my_chat_member` "added" event; `from.id`), overridable
  by `BAUMY_OWNER_ID`. `setMyCommands`/`BotCommandScope` only *render* a menu; Bot API updates
  carry zero scope info, so every admin command is authorized in code (`chat.type === 'private'` **and**
  `from.id === house.owner_telegram_id`).
- **The dashboard login is member-gated, then re-gated at redeem.** `/dashboard` issues a link only to a
  member with `can_access_dashboard AND is_active`; the verify endpoint **re-checks the same grant** at
  redeem, so a grant revoked between issue and click fails closed.
- **Fail closed everywhere.** The housemate allow-list accessor falls back to the env seed (never
  allow-all) on DB error; the magic-link token is a single atomic guarded `UPDATE` consume; owner-command
  authorization drops group/non-owner attempts silently and audits them.

For v1, **all memory is house-shared** (`00-decisions.md` A3: Baumy is a house-management tool, one
shared pool). That single product fact collapses the whole per-user RLS question: **per-user row
isolation is the wrong model for v1 and is dropped.** The JWKS surface is left as a config-only switch
for a hypothetical later scoping need, but nothing in v1 depends on it.

---

## Decisions (with rationale)

### D1 — Self-host Better Auth (GA `1.6.23`) as the SESSION LAYER ONLY, Drizzle adapter on the same Neon DB (`confidence: high`)
Use `better-auth` core (self-hosted) + `@better-auth/drizzle-adapter`, **not** the Neon-hosted
`@neondatabase/auth` wrapper that the camp-404 reference repo lifted. Better Auth provides **sessions and
nothing else**: no social providers, no password auth, no email magic-link plugin. Users and sessions are
minted by Baumy's own Telegram magic-link verify endpoint via the internal adapter (D2/D8).

*Rationale:* `better-auth` core is **GA and current — `1.6.23`** (verification **CONFIRMED** 2026-07-01:
`npm dist-tag latest = 1.6.23`; `@better-auth/drizzle-adapter = 1.6.23`; both MIT). The Neon-hosted SDK is
still **beta**. Self-hosting puts `user`/`session`/`account`/`verification` (+ `jwks` if the optional jwt
plugin is ever enabled) in your own Neon DB via Drizzle — one migration pipeline, data ownership, and full
access to `betterAuth()` internals (`ctx.context.internalAdapter.createSession`/`createUser`,
`setSessionCookie`) that a wrapper constrains. The wrapper's real friction in camp-404 (the verifier→cookie
exchange and RSC "cookies can only be modified" workaround) existed to serve **cross-site MCP OAuth
round-trips, which Baumy defers** — so that justification is gone. All $0 on Vercel Hobby + Neon Free.
Exact version/table set **re-verified at build** (project rule).

> **Reconciliation:** other findings in this workstream referenced camp-404's Neon-hosted
> `getAuthenticatedUser()` / `@neondatabase/auth`. Under D1 those map to the self-hosted equivalents:
> session read = `auth.api.getSession({ headers })`; `members.auth_user_id` = Better Auth `user.id`.
> Wherever a downstream task says "getAuthenticatedUser()", read "Better Auth session".

### D2 — Dashboard login = Telegram bot-DM magic link, gated on `can_access_dashboard`; no Google/email/password (`confidence: high`)
The **only** sign-in path: a member with `can_access_dashboard` DMs Baumy `/dashboard`; Baumy replies in
that same DM with a **single-use, short-TTL (~5 min), HMAC-signed** login URL. Opening the URL hits a
Better Auth verify endpoint that atomically consumes the token, re-checks the grant, and **mints a Better
Auth session** (session cookie). No BotFather `/setdomain`, no OIDC client, no Login Widget JS, no email.

*Rationale (`00-decisions.md` A1b, mechanism (a)):* the Telegram `user_id` **is** the dashboard identity —
housemates already trust the bot, so binding the web session to a Telegram DM is the lowest-friction,
lowest-infra, revocable path for a 1–4 person private tool. It drops Google OAuth (redirect-URI/consent
plumbing, preview-domain breakage), Resend magic-link (email infra + deliverability), and the widget's
BotFather domain coupling. Because a bot **cannot initiate a DM** (403), the link is delivered as a *reply*
to the member's own `/dashboard` message — the member's action both establishes the DM (captures
`dm_chat_id`) and requests the link. Gating at **issue** (only granted members get a link) **and** at
**redeem** (verify re-checks `can_access_dashboard AND is_active`) means a revoked grant closes the door
even mid-flight.

### D3 — Identity is Telegram-primary: extend the existing `members` row; add the grant column (`confidence: high`)
`members` (already defined in `product.md`) is the single identity row. `telegram_user_id text NOT NULL
UNIQUE` is the primary identity. Add: `auth_user_id text UNIQUE` (**nullable**, lazily set on first
magic-link login) as the one-to-one link to a Better Auth user; `can_access_dashboard boolean NOT NULL
DEFAULT false` as the dashboard grant; `bind_method` provenance; `linked_at`.

*Rationale:* Baumy's primary surface is Telegram, so identity must survive with zero web account. A member
who never opens the dashboard simply keeps `auth_user_id` NULL and `can_access_dashboard` false. A
nullable-UNIQUE `auth_user_id` preserves one-login-to-one-member integrity while keeping the dashboard
genuinely optional. This inverts camp-404's web-first `users` row (`auth_user_id NOT NULL`) to
Telegram-primary.

> **Correction to an upstream proposal:** one finding proposed a fresh `members(id uuid …, telegram_user_id
> bigint …)`. That conflicts with the **already-ratified** `product.md` DDL, which is authoritative:
> `members.id` is **`bigint GENERATED ALWAYS AS IDENTITY`** and `telegram_user_id` is **`text`** (64-bit
> ids stored as TEXT because JS `Number` rounds them). We extend that table; we do not redefine it, and we
> do not introduce a `uuid` PK or a `bigint` telegram id.

### D4 — Members are AUTO-DISCOVERED from group activity; no `/bind`, no `/start`-to-join (`confidence: high`)
Group membership **is** the roster (`00-decisions.md` B10). The first message from an unknown
`telegram_user_id` in the confirmed house group **auto-creates a `members` row** (`display_name`/`username`
from the update's `from` field, `bind_method='group_seed'`, `is_active=true`). Leaving the group
(`left_chat_member` / a `my_chat_member` "left/kicked" for that user) **deactivates** the row
(`is_active=false`); their contributed house-memory is retained. There is **no** owner-issued invite link,
no `/mint`, and no `/bind` numeric-id provisioning.

*Rationale:* the owner should never handle raw numeric ids or run a binding dance to onboard a housemate
(B10: "Baumy is a custodial feature of the group itself"). Auto-discovery makes the allow-list
self-maintaining and keeps the trust boundary crisp: being in the house group = baseline housemate trust
(contribute/query). `dm_chat_id` is **not** needed for membership — it is captured only when a *granted*
member first DMs the bot (see D5/D2), because that is the only case a DM channel is required.

### D5 — Owner = bot inviter (auto), captured from `my_chat_member`; `can_access_dashboard` is an owner grant (`confidence: high`)
- **Owner bootstrap:** the owner is **whoever added the bot to the house group**, captured from the
  `my_chat_member` "added" event's `from.id` and written to `house.owner_telegram_id`. `BAUMY_OWNER_ID`
  (env) **overrides** the captured value when set. This **replaces** the old `/start <BOOTSTRAP_SECRET>`
  dance entirely.
- **Dashboard grant:** `members.can_access_dashboard` is toggled by the owner via **command**
  (`/grant <name|id>` / `/ungrant <name|id>`) **or the dashboard UI toggle**. Default false. "Only one
  needs it, but easy to add more" = flipping a boolean on an already-discovered member. Roles stay
  `owner` (single) + `member`; multi-owner/`/promote` is **deferred to v1.1** (`00-decisions.md` batch #8).

*Rationale:* tying ownership to the invite event means the person who set Baumy up is the admin with zero
extra steps and zero secret to leak; the env override covers migration/recovery. The dashboard grant is a
single cheap boolean because dashboard access is a small, owner-controlled privilege on top of ordinary
membership, not a separate identity.

### D6 — The housemate allow-list is a DB-derived live set (cached, fail-closed); env is a seed (`confidence: high`)
`isHousemate(id)` = `EXISTS member WHERE telegram_user_id = id AND is_active AND role IN ('owner','member')`.
Because members auto-discover (D4), this set is self-populating. `BAUMY_HOUSEMATE_IDS` (a.k.a.
`BAUMY_ALLOWED_TELEGRAM_USER_IDS` in the rename map) becomes a **boot seed**, not runtime truth. The accessor
is cached (~30 s TTL, invalidated on discover/grant/revoke) because it sits on the webhook hot path, and it
**fails closed to the env seed** on DB error — never allow-all.

*Rationale:* the write-gate's `trusted_dm` decision (`product.md`) and the webhook filter's known-housemate
step (`llm-pipeline.md`) both consume this set on the per-message path. Deriving it from `members` means the
house manages itself at runtime; caching keeps it off the critical path; fail-closed-to-seed preserves
security if Neon is briefly unreachable.

### D7 — Model the group allow-list as a `chats` registry; `my_chat_member` seeds owner + candidate, `/setgroup` confirms (`confidence: high`)
A candidate `house_group` row is inserted the moment the bot is added to a group (from the `my_chat_member`
update, `is_active=false`), and the **same event captures the owner** (D5). The group becomes the pinned
outbound destination only after the owner confirms via `/setgroup`, cross-checked with
`getChatMember(chat_id, owner_id).status === 'creator'`. A partial-unique index enforces exactly one active
`house_group`.

*Rationale:* "bot added to multiple groups" is a real foot-gun (post house info to the wrong chat). Capturing
candidates but requiring owner confirmation + a creator cross-check, and pinning outbound sends to the single
confirmed `house.group_chat_id` (server-known, never from message text), matches the product invariant against
a wrong `group_chat_id`. Folding owner-capture into this same event removes a separate bootstrap step.

### D8 — Magic-link mechanism: Baumy mints the signed single-use token; Better Auth only mints the session (`confidence: high`)
Token = a compact **HMAC-SHA256-signed** value `base64url({ jti, exp }).base64url(sig)`, `sig =
HMAC(payload, BAUMY_SESSION_SECRET)`; `jti` is a random nonce recorded in a `dashboard_login_tokens` row
(`member_id`, `expires_at ~5 min`, `consumed_at`). Delivery: DM reply to `/dashboard`. Redeem: a **custom
Better Auth plugin endpoint** `/api/auth/telegram/verify` (1) constant-time-verifies the signature, (2) does
the **atomic guarded consume** of `jti` (`UPDATE … SET consumed_at=now() WHERE jti=$1 AND consumed_at IS NULL
AND expires_at > now() RETURNING member_id`), (3) re-checks `can_access_dashboard AND is_active`, (4) lazily
creates the member's Better Auth `user` (synthetic non-deliverable email `tg-<telegram_user_id>@telegram.baumy.local`,
`emailVerified:true`) and sets `members.auth_user_id`/`linked_at` on first login, then (5)
`internalAdapter.createSession(user.id)` + `setSessionCookie(ctx, …)` and redirects to `/admin`.

*Rationale:* honours "Better Auth = session layer only" (`00-decisions.md` A1b): the token is **ours**
(single-use + short-TTL + signed all satisfied by Baumy), and Better Auth is invoked *only* to establish the
cookie session via its internal adapter — the exact pattern its own admin-impersonate and
autoSignInAfterVerification paths use (`ctx.context.internalAdapter.createSession(userId, …)`; confirmed via
Better Auth source). The HMAC signature is defense-in-depth over an already-unguessable `jti`, and the DB
consume is what actually enforces single-use under a race. Running verify as a plugin endpoint (rather than a
bare Next route) gives a real `GenericEndpointContext`, so `setSessionCookie` works without hand-rolling the
cookie. **The old `/link` dashboard-link-code flow is dropped** — this replaces it.

### D9 — DROP per-user RLS from v1; leave JWKS as a dormant config-only switch (`confidence: high`)
Do **not** ship RLS in v1. The `jwt` plugin (EdDSA/Ed25519, JWKS at `/api/auth/jwks`) is **optional and
off by default** — the v1 dashboard is protected by the session cookie + the app-layer
`requireAdmin()`/`can_access_dashboard` gate, not by signed JWTs. Enable the jwt plugin **only** if the
deferred RLS JWT branch (D10) is ever built.

*Rationale:* v1 memory is **house-shared** (`00-decisions.md` A3), so Baumy is a **single shared-house
tenant**. Per-user (`authUid`) RLS is the wrong model — it would hide the house's shared facts from the owner
and add real plumbing for near-zero isolation value. The v1 write control is the **deterministic write-gate**;
the v1 dashboard control is the **app-layer grant**. Nothing in v1 reads a JWT, so wiring the jwt plugin is
deferred rather than done-now — one less moving part.

### D10 — If RLS is ever built, use PLAIN Postgres RLS (custom-GUC) with a coarse role gate — not standalone Neon RLS (`confidence: high`)
The deferred design: three Postgres roles — `neondb_owner` (via `DATABASE_URL`, owns tables → **bypasses
RLS**; runs migrations + the Telegram/Inngest write path), `baumy_authenticated` (non-owner, RLS-enforced;
dashboard read/edit), `baumy_readonly` (non-owner, SELECT-only; reserved for the deferred MCP read path).
Policies funnel through one `STABLE SECURITY DEFINER` helper `baumy.current_member_id()` that reads a
transaction-local custom GUC `app.current_member_id` (injected by trusted server code), with an optional
fallback to `auth.user_id()` for a signed-JWT web path. Use **`ENABLE`, never `FORCE`** RLS. If any table
gets a policy, use a **coarse role gate** (authenticated = allow, anonymous = deny), **never per-user
`authUid()`** on the shared substrate.

*Rationale:* **Verification correction:** Neon's standalone "**Neon RLS**" (formerly "Neon Authorize") is
being **deprecated**; Neon recommends the Data API **or** plain Postgres RLS. The Data API is still **Beta**
and its **Free-plan availability is unconfirmed**. Both point the same way: Baumy's primary RLS channel, if
ever built, is **plain Postgres RLS with a custom GUC** — pure Postgres, free on every plan, independent of
`pg_session_jwt`/Data-API Beta churn. `auth.user_id()` (via the optional Better Auth JWKS) is a stronger
branch only. **`FORCE` would break the bot** (subject `neondb_owner` to RLS, require a GUC on every ingestion
statement) — hence `ENABLE` only.

### D11 — The Telegram webhook / Inngest write path stays on the privileged service connection (`confidence: high`)
Webhook + async writes use `DATABASE_URL` (pooled `neondb_owner`), **not** any authenticated RLS role. There
is no user JWT in a webhook. Its security controls are the `X-Telegram-Bot-Api-Secret-Token` verification,
`update_id` dedupe, and the deterministic write-gate. RLS (if ever enabled) applies only to the dashboard/MCP
read paths; the service path bypasses it **by design**.

### D12 — MCP stays deferred to post-v1 (documentation-only); when lifted, target the 2025-11-25 spec and add RFC 8707 (`confidence: high`)
Do not build MCP in v1. The camp-404 OAuth 2.1 layer (RFC 7591 DCR, RFC 8414 AS metadata, RFC 9728 PRM,
OAuth 2.1 + PKCE-S256, opaque SHA-256 tokens) is a lift-later asset. Three deltas on lift: (1) **ADD RFC
8707 resource-indicator / token-audience validation** (camp-404 omits it — the biggest compliance gap vs the
2025-06-18+ spec); (2) **ADD the path-scoped PRM route** `/.well-known/oauth-protected-resource/api/mcp`; (3)
strip the camp rank/team taxonomy to a **single house-member gate** and expose **READ-ONLY** tools only.
Reserve the `baumy_readonly` role (D10) now so the lift is drop-in.

*Rationale:* MCP is an additional untrusted-instruction channel and an unauthenticated DCR surface that isn't
needed until a housemate wants to drive Baumy from Claude.ai. Read-only tools honour the write-gate invariant;
writes stay behind the Telegram deterministic path.

---

## Concrete design / APIs / DDL / config

### Better Auth server config (`@baumy/auth`, self-hosted, session layer only)

```ts
// packages/auth/src/index.ts  (or apps/web/lib/auth.ts)
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db, schema } from "@baumy/db";
import { telegramMagicLink } from "./telegram-magic-link";   // custom plugin (see below)

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,          // pin to the PRODUCTION domain
  secret: process.env.BETTER_AUTH_SECRET,        // stable, long-lived; signs/encrypts Better Auth sessions
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: false },          // no passwords
  socialProviders: {},                           // no Google / no OAuth — session layer only
  plugins: [
    telegramMagicLink(),                         // the ONLY sign-in path (D2/D8)
    // jwt({ ... }),                             // DEFERRED (D9): enable only for the RLS JWT branch
    nextCookies(),                               // MUST be LAST
  ],
});
```

No `databaseHooks.user.create.before` email allow-list (there is no email sign-up). Access is decided by
`can_access_dashboard` at magic-link issue **and** redeem, not by an email set.

### Custom Better Auth plugin — Telegram magic-link verify (`telegram-magic-link.ts`)

```ts
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { db, members, dashboardLoginTokens } from "@baumy/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { verifyMagicToken } from "@baumy/core/magic-link";   // constant-time HMAC verify

// Endpoint mounts under the auth basePath → GET /api/auth/telegram/verify?token=...
export const telegramMagicLink = () =>
  ({
    id: "telegram-magic-link",
    endpoints: {
      verifyTelegramLogin: createAuthEndpoint(
        "/telegram/verify",
        { method: "GET" },
        async (ctx) => {
          const parsed = verifyMagicToken(String(ctx.query?.token ?? ""));   // sig + shape; throws on bad sig
          if (!parsed) throw ctx.redirect("/sign-in?e=badtoken");
          const { jti } = parsed;

          // (1) atomic single-use consume — one guarded UPDATE
          const [tok] = await db.update(dashboardLoginTokens)
            .set({ consumedAt: sql`now()` })
            .where(and(eq(dashboardLoginTokens.jti, jti),
                       isNull(dashboardLoginTokens.consumedAt),
                       gt(dashboardLoginTokens.expiresAt, sql`now()`)))
            .returning({ memberId: dashboardLoginTokens.memberId });
          if (!tok) throw ctx.redirect("/sign-in?e=expired");

          // (2) re-check the grant at redeem (may have been revoked since issue)
          const [m] = await db.select().from(members)
            .where(and(eq(members.id, tok.memberId), members.isActive, members.canAccessDashboard));
          if (!m) throw ctx.redirect("/sign-in?e=norights");

          // (3) lazily provision the Better Auth user on first login
          let userId = m.authUserId;
          if (!userId) {
            const email = `tg-${m.telegramUserId}@telegram.baumy.local`;      // synthetic, never delivered
            const created = await ctx.context.internalAdapter.createUser(
              { email, name: m.displayName ?? m.username ?? `member-${m.id}`, emailVerified: true }, ctx);
            userId = created.id;
            await db.update(members)
              .set({ authUserId: userId, linkedAt: sql`now()` })
              .where(and(eq(members.id, m.id), isNull(members.authUserId)));  // UNIQUE guard
          }

          // (4) mint the Better Auth SESSION (session layer only)
          const session = await ctx.context.internalAdapter.createSession(userId, ctx);
          if (!session) throw ctx.redirect("/sign-in?e=session");
          await setSessionCookie(ctx, { session, user: { id: userId } as any });
          throw ctx.redirect("/admin");
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
```

> **`verify_needed` (build):** confirm the exact `createAuthEndpoint` query-schema shape,
> `internalAdapter.createUser`/`createSession` signatures, and `setSessionCookie` payload for
> `better-auth 1.6.x`. Fallback if the plugin route is awkward: a plain `app/(auth)/auth/tg/route.ts` that
> uses `const c = await auth.$context; await c.internalAdapter.createSession(...)` and constructs the cookie
> from `c.authCookies` — same internal adapter, more manual cookie handling.

### Magic-link mint + `/dashboard` handler (bot side, `@baumy/core`)

```ts
// @baumy/core/magic-link.ts — mint is called from the Telegram webhook worker on "/dashboard"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const b64u = (b: Buffer) => b.toString("base64url");
const SECRET = () => process.env.BAUMY_SESSION_SECRET!;        // HMAC key (rename-map: BAUMY_SESSION_SECRET)

export async function issueDashboardMagicLink(member: { id: bigint }): Promise<string> {
  // caller has already verified can_access_dashboard && is_active && private chat
  const jti = b64u(randomBytes(24));
  const exp = Math.floor(Date.now() / 1000) + 300;             // ~5 min TTL
  await db.insert(dashboardLoginTokens)
    .values({ jti, memberId: member.id, expiresAt: new Date(exp * 1000) });
  const payload = b64u(Buffer.from(JSON.stringify({ jti, exp })));
  const sig = b64u(createHmac("sha256", SECRET()).update(payload).digest());
  const token = `${payload}.${sig}`;
  return `${process.env.BETTER_AUTH_URL}/api/auth/telegram/verify?token=${token}`;
}

export function verifyMagicToken(token: string): { jti: string; exp: number } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expect = b64u(createHmac("sha256", SECRET()).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;      // constant-time
  try {
    const { jti, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof jti !== "string" || typeof exp !== "number" || exp * 1000 < Date.now()) return null;
    return { jti, exp };                                                 // DB consume still enforces single-use
  } catch { return null; }
}
```

`/dashboard` DM flow (in the webhook worker, after the shared fail-closed pre-gate):
1. Require `message.chat.type === 'private'`; look up the member by `from.id`.
2. Backfill `members.dm_chat_id = message.chat.id` (the `/dashboard` message *is* the DM — no `/start` needed).
3. If `!member || !member.is_active || !member.can_access_dashboard` → reply "You don't have dashboard
   access — ask the house owner to grant it." (no link, audited).
4. Else `sendMessage(dm_chat_id, issueDashboardMagicLink(member))` — the link is a reply to the member's own DM.

### Route handler, client, and the `requireAdmin()` gate

```ts
// app/api/auth/[...all]/route.ts
export const runtime = "nodejs";                 // Node is the safe default; Neon tx driver matches
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@baumy/auth";
export const { GET, POST } = toNextJsHandler(auth);   // also serves /api/auth/telegram/verify (plugin)
```

```ts
// lib/auth-client.ts  ("use client") — no social/magic-link sign-in; login happens over Telegram
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient();   // useSession(), signOut() only
```

```ts
// lib/require-admin.ts  (server) — call at the top of EVERY dashboard server component/action
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@baumy/auth";
import { db, members } from "@baumy/db";
export async function requireAdmin() {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) redirect("/sign-in");
  const [m] = await db.select().from(members)
    .where(and(eq(members.authUserId, s.user.id), members.isActive, members.canAccessDashboard));
  if (!m) redirect("/sign-in");                  // grant revoked / member deactivated ⇒ session no longer admits
  return { session: s, member: m };              // m.role === 'owner' ⇒ owner-only sub-surfaces
}
```

`/sign-in` is a static page: "To open the Baumy dashboard, DM the bot `/dashboard` in Telegram." There is no
web form — the link arrives in Telegram.

### Schema — extend `members`, add identity registries

Extends the ratified `product.md` DDL (`members` / `house` / `bind_tokens`). Types match product:
`members.id` is `bigint`, all Telegram ids are `text`.

```sql
-- 1) Extend the existing members row (Telegram-primary) with the dashboard link + grant + provenance
ALTER TABLE members
  ADD COLUMN auth_user_id         text UNIQUE,                 -- Better Auth user.id; NULLABLE, set on 1st login
  ADD COLUMN can_access_dashboard boolean NOT NULL DEFAULT false,  -- owner grant (D5)
  ADD COLUMN bind_method          text NOT NULL DEFAULT 'group_seed'
       CHECK (bind_method IN ('group_seed','owner_bootstrap','env_override')),
  ADD COLUMN linked_at            timestamptz;                 -- when auth_user_id was set
CREATE INDEX members_auth_user_idx ON members (auth_user_id);

-- 2) Group registry (clean-room lift of camp-404 telegram_chats; renamed kind enum)
CREATE TYPE chat_kind AS ENUM ('house_group','owner_dm','other');
CREATE TABLE chats (
  chat_id       text PRIMARY KEY,                              -- 64-bit id as TEXT
  kind          chat_kind NOT NULL DEFAULT 'other',
  title         text,
  username      text,
  is_active     boolean NOT NULL DEFAULT false,                -- true only after owner /setgroup
  confirmed_by  bigint REFERENCES members(id),
  confirmed_at  timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE UNIQUE INDEX one_active_house_group
  ON chats (kind) WHERE kind = 'house_group' AND is_active AND archived_at IS NULL;

-- 3) Dashboard magic-link tokens (atomic guarded consume, like product's bind_tokens)
CREATE TABLE dashboard_login_tokens (
  jti          text PRIMARY KEY,                               -- random nonce; the signed URL carries {jti,exp}
  member_id    bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,                           -- short TTL (~5 min)
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_login_tokens_member_idx ON dashboard_login_tokens (member_id);
```

`house.owner_telegram_id` is set from the `my_chat_member` "added" event (D5/D7), overridable by
`BAUMY_OWNER_ID`. No schema change to `house` beyond what `product.md` already ships.

> **Audit:** route admin/identity actions (`grant`, `ungrant`, `revoke`, `setgroup`, `leavegroup`,
> `dashboard_login`, and every rejected owner-command attempt) into the **existing `audit_log`** owned by
> `product.md` T9 — do **not** create a separate `admin_audit` table. One audit surface.

### Better Auth tables (generated, not hand-written)

`npx @better-auth/cli generate` against `@baumy/auth` emits Drizzle schema for `user`, `session`, `account`,
and `verification`. (`jwks` is emitted only if the deferred jwt plugin is enabled — D9.) Wire these into the
same `drizzle-kit` generate/migrate pipeline as the memory substrate (`packages/db`). `members.auth_user_id`
references `user.id`. The `user` row is **synthetic** (created by the verify endpoint from the member;
`account`/`verification` stay empty in v1 — no providers, no email verification).

### DB-backed housemate allow-list accessor (cached, fail-closed)

```ts
// @baumy/core
let cache: { at: number; ids: Set<string> } | null = null;
const SEED = new Set((process.env.BAUMY_HOUSEMATE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean));

export async function getHousemateIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 30_000) return cache.ids;
  try {
    const rows = await db.select({ id: members.telegram_user_id }).from(members)
      .where(and(members.is_active, inArray(members.role, ["owner", "member"])));
    cache = { at: Date.now(), ids: new Set(rows.map(r => r.id)) };
    return cache.ids;
  } catch {
    return cache?.ids ?? SEED;                    // FAIL CLOSED to seed — never allow-all
  }
}
export const isHousemate = async (id: string) => (await getHousemateIds()).has(id);
export const isOwner = (id: string) => id === house.owner_telegram_id;  // house singleton (auto-captured / env override)
export function invalidateHousemateCache() { cache = null; }            // call on discover/grant/revoke
```

### Owner-command router (code-level authorization)

```
handleCommand(update):
  # shared fail-closed pre-gate first (product T0): verify secret token (constant-time), dedupe update_id
  parse bot_command entity
  if command == '/dashboard':
     # member-gated, NOT owner-gated — issued in a private chat to a granted member
     if chat.type !== 'private': return                       # never in group
     issue-or-refuse per can_access_dashboard (see /dashboard flow above)
  elif command in OWNER_COMMANDS:
     if update.message.chat.type !== 'private' OR !isOwner(from.id):
        audit_log('rejected', ...); return                    # silently drop group/non-owner attempts
     dispatch(command)
```

- **Owner commands (this workstream):** `/grant`, `/ungrant`, `/mates`, `/revoke`, `/setgroup`, `/groups`,
  `/leavegroup`.
- **Member command (this workstream):** `/dashboard` (private chat; gated on `can_access_dashboard`, not owner).
- **Kill-switch/status commands (product T9):** `/baumy pause|resume|status`. Same owner-gate mechanism.
- Register the owner menu via `setMyCommands` with `BotCommandScopeChat(owner_dm)` **for UX only**.
- **Dropped vs the previous plan:** `/mint`, `/bind`, `/promote`, `/link` (auto-discovery + magic link
  replace them).

### Telegram APIs used

| API | Usage | Source |
|---|---|---|
| `sendMessage(chat_id, text)` | DM the magic-link URL (reply to `/dashboard`, to `dm_chat_id`); owner confirmations. Outbound always targets a server-known id. | https://core.telegram.org/bots/api#sendmessage |
| `my_chat_member` (`ChatMemberUpdated`) | Bot's OWN add/remove → insert an inactive `house_group` candidate **and** capture the owner (`from.id` on "added"). Distinct from `chat_member` (excluded from `allowed_updates`). | https://core.telegram.org/bots/api#chatmemberupdated |
| `getChatMember(chat_id, user_id) → ChatMember` | `/setgroup` defense-in-depth: require `status === 'creator'` before pinning `house.group_chat_id`. | https://core.telegram.org/bots/api#getchatmember |
| `ChatMember.status` enum | Exactly one of `creator`, `administrator`, `member`, `restricted`, `left`, `kicked`. (Owner cross-check uses `'creator'`; member-left detection uses `left`/`kicked`.) | https://core.telegram.org/bots/api#chatmember |
| `setMyCommands` + `BotCommandScope*` | Render the owner menu (`BotCommandScopeChat` on owner DM) — **UI only, never authz** (updates carry no scope info). | https://core.telegram.org/bots/api#setmycommands |
| `leaveChat(chat_id)` | `/leavegroup`: archive a `chats` row and leave a non-house group. | https://core.telegram.org/bots/api#leavechat |

Auto-discovery reads the ordinary `message` update's `from` field (id/first_name/username) — no extra API.

### Env inventory (additions + normalization)

**Added/kept by this workstream:** `BETTER_AUTH_URL` (production domain), `BETTER_AUTH_SECRET`
(`openssl rand -base64 32`, **stable/long-lived**; signs Better Auth sessions), `BAUMY_SESSION_SECRET`
(`openssl rand -base64 32`, **stable/long-lived**; HMAC key for the magic-link token — same env the
rename-map assigns), `BAUMY_OWNER_ID` (**optional** owner override; else captured from
`my_chat_member`). `BAUMY_HOUSEMATE_IDS` remains a **boot seed** (D6), not runtime truth.

**Removed (were in the prior plan):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BAUMY_ADMIN_EMAILS`,
`RESEND_API_KEY` (+ verified sender). Google OAuth, the email allow-list, and Resend magic-link are all
**dropped** — the login is Telegram-native.

**Deferred:** `DATABASE_AUTHENTICATED_URL`, `DATABASE_READONLY_URL` (RLS), `MCP_PUBLIC_URL` (MCP issuer —
**never `VERCEL_URL`**).

Extend `assertServerEnv()` (product T9 pattern): `BETTER_AUTH_SECRET` length ≥ 32, `BAUMY_SESSION_SECRET`
length ≥ 32, `BETTER_AUTH_URL` present. Add the new vars to `turbo.json` `globalEnv` + `.env.example`.

> **Env-name drift to normalize (cross-workstream).** `product.md` uses `BAUMY_HOUSE_CHAT_ID` /
> `BAUMY_HOUSEMATE_IDS` / `BAUMY_TZ` / `BAUMY_OWNER_ID`; `llm-pipeline.md` uses `HOUSE_GROUP_CHAT_ID`
> / `BOT_ID` / `BAUMY_TIMEZONE`; the rename-map lists `BAUMY_ALLOWED_TELEGRAM_USER_IDS`. **`product.md`'s
> `BAUMY_*` set is canonical.** `00-decisions.md` (OWNER) names the override `BAUMY_OWNER_ID`; align to
> product's `BAUMY_OWNER_ID` (same meaning). Owner sign-off on the final set (open Q).

### Deferred design — RLS (when/if built, post-v1)

Helper (bootstrap SQL, not committed with the password):

```sql
CREATE SCHEMA IF NOT EXISTS baumy;
CREATE OR REPLACE FUNCTION baumy.current_member_id() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, baumy AS $$
  SELECT coalesce(
    nullif(current_setting('app.current_member_id', true), '')::bigint,      -- PRIMARY: custom GUC
    (SELECT m.id FROM public.members m WHERE m.auth_user_id = auth.user_id()) -- optional JWT fallback
  ) $$;
REVOKE ALL ON FUNCTION baumy.current_member_id() FROM public;
```

- **Custom GUC is the primary channel** (`SELECT set_config('app.current_member_id', $1, true)` inside a
  transaction on the pooled/WebSocket driver). It needs neither `pg_session_jwt` nor the Data API, so it runs
  on any Neon plan. **Verification nuance:** Drizzle's `db.$withAuth(token)` is **deprecated**; for pooled
  connections inject claims via `set_config`. The neon-http driver-level `authToken` option (which **does
  accept an async `() => Promise<string>` resolver**) remains current for the optional signed-JWT web path
  (requires the deferred jwt plugin, D9).
- Policies reference the helper as `(select baumy.current_member_id())` so Postgres hoists it to a
  once-per-query InitPlan.
- **v1 note:** v1 memory is house-shared and RLS is **dropped** (D9). If any policy is ever added, use only a
  coarse `authenticated`-vs-`anonymous` role gate. The `scope='house'|'member'` per-row split is a *post-v1*
  addition, gated on the product ever introducing member-private memory.

### Deferred design — MCP deltas (when/if lifted, post-v1)

Target the **current stable MCP revision 2025-11-25** (camp-404 targets the older 2025-06-18; a 2026-07-28
RC exists — do not build against the RC). Connector URL is `/api/mcp/mcp` (basePath `/api/mcp` + the literal
`[transport]` segment — looks like a typo, is correct). Issuer/origin **must** come from `MCP_PUBLIC_URL`,
never `VERCEL_URL` (the `*.vercel.app` hash domain is SSO-gated → 403 to Claude's discovery). Keep opaque
SHA-256-hashed tokens; keep the unauthenticated DCR endpoint hardened with the redirect-URI allow-list + rate
limits, plus a stale-client GC job (evaluate CIMD/SEP-991). Expose **READ-ONLY** memory-recall tools only,
gated on `baumy_readonly` + a single house-member check. Clean-room rename all camp identifiers
(`serverInfo.name`, `registerCampMcpTools`, `extra.campUserId`, `@camp404/*`).

---

## Gotchas

- **A bot cannot initiate a DM (403).** The magic link is delivered **as a reply to the member's own
  `/dashboard` message**, never pushed unprompted; that same message backfills `dm_chat_id`. Guard **all**
  outbound DMs (link, nudges) on `dm_chat_id IS NOT NULL`.
- **The magic-link token must be single-use + short-TTL + signed, and re-gated at redeem.** Single-use is
  enforced by the atomic guarded `UPDATE` of `jti` (not by the HMAC); TTL by `expires_at` (checked in the
  same `UPDATE`) and by the signed `exp`; **re-check `can_access_dashboard AND is_active` in the verify
  endpoint** so a grant revoked between issue and click fails closed. Never trust a body/query-supplied
  member id — derive it from the consumed `jti` row.
- **Synthetic Better Auth email is never deliverable and never a login handle.** `tg-<id>@telegram.baumy.local`
  exists only to satisfy `user.email` UNIQUE/NOT NULL; there is no email verification or email sign-in. Do not
  wire any mailer.
- **`nextCookies()` MUST be the LAST plugin** or the verify endpoint's session cookie may not be set on the
  response.
- **`setMyCommands`/`BotCommandScope` is NOT security.** A group message can literally type `/grant 123` or
  `/setgroup`. Only the code check (private chat **and** `from.id === owner`) blocks it. `/dashboard` is the
  one command a non-owner member may run — and only in a private chat, gated on `can_access_dashboard`.
- **`/dashboard` is a privileged write** (it can hand out a session-minting link) — it must pass the SAME
  fail-closed pre-gate (constant-time secret verify, `update_id` dedupe) *before* issuing anything.
- **Owner capture rides `my_chat_member`, and `BAUMY_OWNER_ID` overrides it.** If both a captured
  inviter and the env override exist, the env override wins (recovery/migration). Never derive owner from
  message text.
- **The allow-list accessor is on the per-message hot path** — read `members` **cached** (~30 s) and
  invalidate on discover/grant/revoke, or you add a DB round-trip to every message. On DB error, fall back to
  the env **seed**, never to allow-all.
- **Bot added to multiple groups** → capture every `my_chat_member` candidate as `is_active=false`; require
  explicit owner `/setgroup` (+ `getChatMember` `creator` check) before pinning. Outbound sends target
  **only** the confirmed `house.group_chat_id`, never a chat_id parsed from message text.
- **One-auth-user ↔ one-member** must be enforced by `UNIQUE members.auth_user_id` **and** the atomic guarded
  consume of the magic-link token — otherwise a leaked/re-opened link or a race links a Telegram identity to
  the wrong user row. The link write must run in the verify endpoint under the consumed token, never a
  body-supplied `auth_user_id`.
- **A revoked grant must lock out an EXISTING session immediately.** Because the session cookie outlives the
  grant, `requireAdmin()` re-checks `can_access_dashboard AND is_active` on **every** request/action (it joins
  the session's user to a live `members` row). Do not cache the admit decision in the cookie.
- **Do NOT apply per-user `authUid()` RLS to the shared memory substrate.** It isolates rows by member and
  would hide the house's shared facts from the owner. RLS is **dropped from v1** (D9); if ever enabled, use a
  coarse role gate and **`ENABLE`, never `FORCE`** (FORCE would subject `neondb_owner` and break the
  bot/Inngest write path).
- **`app.current_member_id` (custom GUC), not `request.jwt.claims`.** For the deferred RLS path, the non-JWT
  channel uses the plain custom GUC; `set_config(..., true)` only applies inside a transaction (pooled driver).
- **Rotating `BETTER_AUTH_SECRET` invalidates live sessions**; rotating `BAUMY_SESSION_SECRET` invalidates any
  outstanding (unclicked) magic links. Treat both as stable, long-lived secrets.
- **Runtime = `nodejs`** on the auth route (the verify endpoint uses `node:crypto` + the Neon tx driver).
  Vercel Hobby max duration is **300 s** (Fluid Compute default, per `product.md`) — auth is well within it.
- **`allowed_updates` discrepancy across specs.** `product.md` lists `chat_member`; `llm-pipeline.md` D3
  excludes it. This workstream depends on **neither** — auto-discovery uses `message`, owner/group capture
  uses `my_chat_member`, member-left uses `left_chat_member` (a `message`) / a `my_chat_member` for the bot.
  Align with `llm-pipeline` (exclude `chat_member`).
- **Clean-room:** rename everything from camp-404 — cookie/test names (`camp404_test_user` → `baumy_*`),
  scopes (`@camp404/*` → `@baumy/*`), the `telegram_chats` kind enum, `GOD_EMAILS`/`INVITE_CODES` taxonomy →
  the `can_access_dashboard` grant. **Delete** `issueGroupInviteForUser`/`handleChatMemberUpdate`/
  `queueAnnouncement` rather than adapt. CI grep guard for `camp[-]?404|ops[-]?board|intake|captain|mission|ryanjnoble`
  must be zero.

---

## Tasks (ordered, with dependencies + estimates)

**v1 — Admin auth (Better Auth, session layer only)**

1. **`@baumy/auth` server config.** `betterAuth({...})` with `drizzleAdapter`, `emailAndPassword:false`, no
   social providers, the `telegramMagicLink()` plugin, and `nextCookies()` LAST. — *deps: none. Est: 0.5 d.*
2. **Generate + migrate Better Auth tables.** `npx @better-auth/cli generate` → `user`/`session`/`account`/
   `verification` into `packages/db`; ship in the same drizzle-kit pipeline. (`jwks` only if the deferred jwt
   plugin is enabled.) — *deps: 1. Est: 0.25 d.*
3. **Route handler + client + `requireAdmin()`.** `app/api/auth/[...all]/route.ts` (`runtime='nodejs'`),
   minimal `lib/auth-client.ts` (useSession/signOut), the per-request `requireAdmin()` grant gate
   (session→member→`can_access_dashboard AND is_active`), and the static `/sign-in` "DM `/dashboard`" page.
   — *deps: 1. Est: 0.5 d.*
4. **Auth env.** `BETTER_AUTH_URL`/`BETTER_AUTH_SECRET`/`BAUMY_SESSION_SECRET`/`BAUMY_OWNER_ID`;
   extend `assertServerEnv()` (length checks) + `turbo.json` `globalEnv` + `.env.example`. (No Google OAuth
   provisioning.) — *deps: 1. Est: 0.25 d.*
5. **Telegram magic-link issue + verify.** `issueDashboardMagicLink()`/`verifyMagicToken()` in `@baumy/core`;
   the `telegramMagicLink` verify plugin (signature verify → atomic `jti` consume → grant re-check → lazy
   Better Auth user → `internalAdapter.createSession` + `setSessionCookie` → redirect `/admin`); the
   `/dashboard` DM handler (member-gated, backfills `dm_chat_id`, rate-limited). *Replaces the old
   Resend-magic-link + `/link` tasks.* — *deps: 3, 7. Est: 1.5 d.*
6. **Auth E2E/test seam.** Rename camp-404's `E2E_TEST_MODE` cookie seam to `baumy_*`; `/api/test/login` only
   under `E2E_TEST_MODE=1` (never in deployed envs). Unit-cover `requireAdmin()` admit/deny (granted vs
   revoked vs inactive) + `verifyMagicToken` bad-sig/expired paths. — *deps: 3, 5. Est: 0.5 d.*

**v1 — Identity + Telegram**

7. **Schema extensions.** `ALTER members` (`auth_user_id`, `can_access_dashboard`, `bind_method`, `linked_at`
   + index); new `chats` registry (+ `chat_kind` enum + partial-unique `one_active_house_group`); new
   `dashboard_login_tokens`. Route audit into the existing `audit_log` (product T9). — *deps: product T3
   (house/members/bind_tokens DDL). Est: 0.5 d.*
8. **Allow-list accessor (cached, fail-closed).** `getHousemateIds()`/`isHousemate()`/`isOwner()` in
   `@baumy/core`; wire into the webhook filter (`llm-pipeline` step 4) and the write-gate `trusted_dm`
   classification (product T1). — *deps: 7, product T1. Est: 1 d.*
9. **Owner-command router + code authz + owner capture.** `handleCommand` parses `bot_command`; owner commands
   honoured only if private chat **and** `isOwner(from.id)`, else drop + audit; `/dashboard` member-gated.
   `my_chat_member` "added" captures `house.owner_telegram_id` (env override wins). Register the owner menu via
   `setMyCommands` (UI only). Shares product T0's secret + dedupe pre-gate. — *deps: 8, product T0/T1. Est: 1 d.*
10. **Member auto-discovery + dashboard grant.** First message from an unknown active id in the house group →
    upsert a `members` row (`bind_method='group_seed'`, name from `from`), invalidate the allow-list cache;
    `left_chat_member`/bot-`my_chat_member` → deactivate. `/grant`/`/ungrant` toggle `can_access_dashboard`
    (+ dashboard UI toggle server action); `/mates` lists members (access + `dm_chat_id` status); `/revoke`
    deactivates a member. Every path audits + invalidates the cache. *Replaces the old owner-initiated
    `/mint`/`/bind` binding.* — *deps: 7, 9. Est: 1 d.*
11. **Group allow-list.** `my_chat_member` handler upserts an inactive `house_group` candidate; `/setgroup`
    requires `getChatMember(chat_id, owner_id).status === 'creator'` then sets `chats.is_active=true` +
    `house.group_chat_id`; `/groups` / `/leavegroup`. — *deps: 7, 9, TelegramClient (`getChatMember`,
    `leaveChat`). Est: 1 d.*
12. **TelegramClient extensions + clean-room rename.** Lift `client.ts`/`webhook.ts` as `@baumy/telegram`; add
    `getChatMember` + `leaveChat`; type `MyChatMemberUpdate`; **drop** `issueGroupInviteForUser`/
    `handleChatMemberUpdate`/`queueAnnouncement`. Rename `@camp404/*` → `@baumy/*`; CI grep guard = zero.
    — *deps: none (parallelisable). Est: 0.5 d.*
13. **Tests.** Owner-gate (group-origin `/grant`/`/setgroup` dropped + audited); non-owner private owner-command
    dropped; `/dashboard` from a non-granted member → refused, no link; allow-list DB error → falls back to
    seed (not allow-all); re-opened / forwarded magic link cannot double-redeem (atomic UPDATE returns 0 rows);
    grant revoked between issue and click → verify refuses; `/setgroup` rejects non-`creator`; auto-discovery
    creates exactly one row per new id; leaving the group deactivates without deleting memory. — *deps: 7–12,
    5. Est: 1 d.*

**Deferred (post-v1) — RLS hardening**

14. **RLS bootstrap + policies (post-v1).** `baumy` schema + `current_member_id()` helper; roles
    `baumy_authenticated` / `baumy_readonly` (created out-of-band, passwords in Vercel env only); declare via
    `pgRole(...).existing()` + `pgPolicy(...)`; enable the Better Auth jwt plugin if the JWT branch is used;
    **`ENABLE` (never `FORCE`)**; `withMemberScope()` injects the GUC in a transaction on the pooled driver.
    CI guard greps generated migrations for `FORCE ROW LEVEL SECURITY` (must be zero). Keep the webhook/Inngest
    path on `DATABASE_URL`. Only worth building if member-private memory is introduced. — *deps: 7. Est: ~2–3 d.*

**Deferred (post-v1) — MCP lift**

15. **MCP OAuth 2.1 lift (post-v1, documentation-only in v1).** Copy + clean-room rename the camp-404 MCP/OAuth
    plumbing; strip the access taxonomy to one house-member gate + one scope; **ADD RFC 8707 resource/audience
    validation**; **ADD the path-scoped PRM route**; implement **READ-ONLY** tool registrar; DCR GC (evaluate
    CIMD); DB migration for the `mcp_*` tables; port + extend tests; live Claude.ai connect at
    `https://<domain>/api/mcp/mcp` with `MCP_PUBLIC_URL` set. Reserves/uses the `baumy_readonly` role from task
    14. — *deps: 14 (readonly role), a live dashboard session. Est: ~3–3.5 d.*

---

## Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Owner-command spoofing via group text** (privacy mode OFF): a crafted message types `/grant`/`/setgroup` and, if authz leaned on `setMyCommands` scope, escalates privilege. | High | Authorize every owner command in code (private chat **and** `from.id === owner`); ignore `BotCommandScope` for authz. Drop + audit any owner command from a group or non-owner. Cover in the injection regression corpus (product T10). |
| **Untrusted group input steers a dashboard session** if the webhook path shared the dashboard's session/DB role. | High | Hard separation (D11): webhook uses the service connection with no user session/JWT, gated by secret-token + `update_id` dedupe + write-gate. Auth governs only the dashboard; group text never mints/steers admin sessions. |
| **Allow-list read fails OPEN**: a Neon outage makes `getHousemateIds()` throw and a naive catch treats everyone as a housemate, opening the `trusted_dm` tier. | High | Accessor catches DB errors and returns the env-seed set (or empty) — fail closed, never allow-all; cache serves last-known-good within TTL; unit test asserts the fallback. |
| **Wrong group pinned** as `house.group_chat_id` (bot in multiple groups) → house info leaked to outsiders. | High | Capture `my_chat_member` candidates as inactive; require owner `/setgroup` + `getChatMember` `creator` cross-check; partial-unique index guarantees one active `house_group`; outbound pinned to the confirmed id. |
| **Magic-link interception / re-use / mis-issue** logs the wrong person into the dashboard, or a revoked grant still works. | High | Short TTL (~5 min), single-use atomic `jti` consume, HMAC-signed token, delivered only to the member's own DM; **verify re-checks `can_access_dashboard AND is_active`**; member id derived from the consumed row, never the URL. Owner can `/ungrant`; rate-limit `/dashboard`. |
| **Wrong owner captured** (someone else was mid-adding the bot, or a migration) → wrong admin. | Medium | `BAUMY_OWNER_ID` env override wins over the captured inviter; `/setgroup` `creator` cross-check corroborates; owner change is audited. |
| **Revoked-grant / deactivated member keeps an existing dashboard session.** | Medium | `requireAdmin()` re-checks `can_access_dashboard AND is_active` against a live `members` row on **every** request/action; the admit decision is never cached in the cookie; test the revoked-mid-session case. |
| **Per-user (`authUid`) RLS on the shared substrate** would hide house facts written for/by others from the owner/dashboard. | Medium | RLS **dropped from v1** (D9); v1 control is the app-layer grant. If ever added, coarse role gate only; service/webhook path on the privileged connection; `ENABLE` never `FORCE`. |
| **Choosing the Neon-hosted `@neondatabase/auth` wrapper** inherits beta risk and MCP-oriented complexity Baumy defers. | Medium | Self-host `better-auth` (GA 1.6.23) as session layer only; own the tables + session-creation path. |
| **Clean-room leak** drags `@camp404/*` identifiers or invite/announcement code into Baumy. | Medium | Rename scopes/enums; **delete** the invite/announcement paths rather than adapt; CI grep guard as a required check. |
| **`FORCE ROW LEVEL SECURITY` copied from a Supabase snippet** silently subjects `neondb_owner` to RLS and breaks ingestion. | Medium (deferred) | Standardize on `ENABLE`; CI grep asserts no `FORCE ROW LEVEL SECURITY` in generated migrations; document owner-bypass as load-bearing. |
| **`BETTER_AUTH_SECRET`/`BAUMY_SESSION_SECRET` rotation** invalidates live sessions / outstanding magic links. | Low | Document both as stable long-lived secrets; rotate only deliberately (all users re-`/dashboard`). |

---

## Open questions (for the owner)

1. **Confirm the owner-override env name.** `00-decisions.md` (OWNER) writes `BAUMY_OWNER_ID`; `product.md`
   uses `BAUMY_OWNER_ID`. *Proposal:* standardize on `BAUMY_OWNER_ID` (matches product), env
   override wins over the captured inviter. Owner sign-off.
2. **`/dashboard` magic-link TTL and rate limit.** *Proposal:* ~5 min TTL, single-use, and a per-member rate
   limit (e.g. 3 issuances / 10 min) to bound DM spam / token churn. Confirm the numbers.
3. **Is `house.group_chat_id` (owner-confirmed) the source of truth for outbound sends, or does env
   `BAUMY_HOUSE_CHAT_ID` stay the pinned constant with the DB row as audit only?** Security prefers a pinned
   constant; manageability prefers the DB. *Proposal:* DB row is truth once owner-confirmed, with a startup
   assertion warning if it diverges from the env value when both are set.
4. **`/revoke` vs `/ungrant` semantics.** *Proposal:* `/ungrant` clears `can_access_dashboard` (keeps
   membership); `/revoke` sets `is_active=false` (drops from the allow-list + cancels pending reminders) but
   retains provenance rows for audit. Confirm both are wanted (leaving the group already auto-deactivates).
5. **Multi-owner / co-owner?** v1 assumes a single `house.owner_telegram_id` (multi-owner deferred to v1.1 per
   batch #8). Confirm no v1 need for a second owner.
6. **Is any Baumy memory ever "member-private," or is it all house-shared** (v1 assumption = all shared per
   A3)? Only if member-private memory is introduced does per-member RLS / the `scope` split (task 14) become
   relevant.
7. **Confirm at build time** (marked `verify_needed`, not blocking): the exact tables emitted by
   `@better-auth/cli generate` for the session-only config; the precise `better-auth 1.6.x`
   `createAuthEndpoint`/`internalAdapter.createUser`/`createSession`/`setSessionCookie` signatures used by the
   `telegramMagicLink` plugin; and the neon-http `authToken` resolver shape (only if the deferred RLS JWT
   branch is ever pursued).
