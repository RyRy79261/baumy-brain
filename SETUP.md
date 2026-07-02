# Baumy Brain — Setup & Deploy

Everything below runs on **free tiers**. The only ongoing cost is LLM tokens (single-digit $/mo at house scale).

## 0. Accounts you'll need
- **Telegram** (you already have it) → talk to **@BotFather**
- **Neon** (Postgres + pgvector) — neon.tech
- **Vercel** (hosting) — vercel.com
- **Anthropic** (replies/digests) — console.anthropic.com
- **Inngest** (background jobs) — inngest.com  *(easiest via the Vercel integration)*

---

## 1. Create the bot
1. In **@BotFather**: `/newbot` → get the **bot token**.
2. **Disable privacy mode** (so Baumy sees all group messages): `/mybots` → your bot → *Bot Settings* → *Group Privacy* → **Turn off**.
3. Create your **house Telegram group** — but **don't add the bot yet**. You add it in step 9, *after* the webhook is live, so the "you're the owner" capture reaches Baumy.

> You do **not** look up any chat id or your user id. When you add the bot to the
> group (step 9), it captures **that group as the house** and **whoever added it as
> the owner** — automatically, from the Telegram-authenticated event. The env vars
> `BAUMY_HOUSE_CHAT_ID` / `BAUMY_OWNER_ID` exist only as optional pins/overrides.

## 2. Neon
1. Create a project. Copy **both** connection strings from the dashboard:
   - pooled (`...-pooler...`) → **`DATABASE_URL`**
   - direct/unpooled → **`DATABASE_URL_UNPOOLED`**  *(migrations need the direct one)*
2. pgvector needs no setup — migration `0000` runs `CREATE EXTENSION vector`.

## 3. LLM key
- Anthropic → **`ANTHROPIC_API_KEY`**  *(the only AI vendor)*

> Baumy uses **only Anthropic**. Replies/classification run on Claude (Haiku →
> Sonnet → Opus by role); **embeddings are computed locally in-process** (no
> OpenAI, no second key, no model download). If you ever want deeper semantic
> recall, the `lib/ai/embed.ts` seam can be swapped for a local transformer model.

## 4. Generate the app secrets
```bash
openssl rand -hex 24      # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 24      # BAUMY_SESSION_SECRET     (HMAC key; any random >=32-char value)
openssl rand -hex 24      # BAUMY_ENCRYPTION_KEY     (hashed to a 32-byte AES-256 key; any random >=32-char value)
```
> `hex 24` (48 chars) is fine for all three — they only need to be long and random.
> The encryption key is SHA-256-derived to 32 bytes, so the encoding doesn't matter.
> Login is **Telegram magic-link** (`/dashboard` → one-time link → a signed session
> cookie). There is **no Better Auth / Neon Auth** — the only session secret is
> `BAUMY_SESSION_SECRET`. (`BAUMY_ENCRYPTION_KEY` is only needed once the deferred
> secure-value encryption helper is wired.)

## 5. Environment variables
Put these in **Vercel → Project → Settings → Environment Variables** (mark secrets *Sensitive*), and in a local **`.env.local`** for dev. See `.env.example`.

| Var | Value |
|-----|-------|
| `DATABASE_URL` | Neon pooled URL |
| `DATABASE_URL_UNPOOLED` | Neon direct URL |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | generated (step 4) |
| `ANTHROPIC_API_KEY` | your Anthropic key (the only AI vendor) |
| `BAUMY_SESSION_SECRET` | generated — signs the dashboard session cookie |
| `BAUMY_ENCRYPTION_KEY` | generated — any random ≥32-char value (`openssl rand -hex 24`); SHA-256-derived to a 32-byte AES-256 key for secure values (wifi/door/bank). A DB dump is useless without it; losing it makes existing secrets undecryptable. |
| `BAUMY_PUBLIC_URL` | your deployed URL (e.g. `https://baumy.vercel.app`) |
| `BAUMY_TIMEZONE` | `Europe/Berlin` (default) |
| `BAUMY_DAILY_SPEND_CAP` | `0.5` (default) |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | **auto-injected** by the Vercel↔Inngest integration |

> **Optional overrides — you normally set neither:** `BAUMY_HOUSE_CHAT_ID` pins the
> house group (otherwise it's captured on bot-add) and `BAUMY_OWNER_ID` pins the
> owner (otherwise it's whoever adds the bot). Leave both unset for the automatic flow.

> ⚠️ **Verify at build:** the default Claude model ids in `lib/ai/models.ts` are best-effort — confirm the current Anthropic ids and set the `BAUMY_*_MODEL` overrides if any have changed.

## 6. Run the database migrations
```bash
pnpm install
DATABASE_URL_UNPOOLED='<neon-direct-url>' pnpm db:migrate
```
(This also runs automatically on every Vercel deploy via the `vercel-build` script.)

## 7. Deploy to Vercel
1. Import the GitHub repo (`RyRy79261/baumy-brain`) into Vercel.
2. Add the env vars from step 5.
3. Add the **Inngest integration** (Vercel Marketplace) → it injects the Inngest keys and auto-syncs functions on deploy. *(Optionally add the Neon integration to auto-inject the DB URLs + get branch-per-preview.)*
4. Deploy. Note your production URL → set `BAUMY_PUBLIC_URL` to it and redeploy.

## 8. Register the Telegram webhook
```bash
BAUMY_PUBLIC_URL='https://<your-app>.vercel.app' \
TELEGRAM_BOT_TOKEN='<token>' \
TELEGRAM_WEBHOOK_SECRET='<secret>' \
node --experimental-strip-types scripts/set-webhook.ts
```
It sets the webhook + `allowed_updates`, drops pending updates, and **warns if privacy mode is still on**.

## 9. Add the bot → you become the owner
Now that the webhook is live, **add your bot to the house group.** That single act:
- captures **that group as the house** (into `house_config`), and
- makes **you (the account that added it) the owner** — from the Telegram-authenticated
  `my_chat_member` event, never from chat text.

No ids to copy anywhere. (First invite wins — adding the bot to a *different* group later can't hijack the house.)

## 10. Go live
- Say something house-relevant in the group ("rent's due friday") → it's captured.
- Ask a question ("@Baumy when's rent due?") → grounded answer.
- "remind us to pay rent friday" → confirmed + fires exactly once.
- DM the bot **`/dashboard`** → one-time link into `/admin`.

---

## Local development (optional, no deploy)
Use a **separate dev bot** + a **private test group** (never the prod token).
```bash
# .env.local: dev bot token/secret, a dev group chat id, INNGEST_DEV=1
pnpm dev                 # app on :3000
pnpm inngest:dev         # Inngest dev server on :8288
cloudflared tunnel --url http://localhost:3000   # public URL for the webhook
# then run scripts/set-webhook.ts with the tunnel URL
```

## Notes / current gaps (see project memory)
- **Model ids + web-search provider** are verify-at-build / pluggable seams — not wired to a live provider yet.
- **Deferred enrichment:** full fact-extraction/reconcile (M2), Better Auth swap-in, `/pause` kill-switch, ad-hoc nudge scorer. None block core operation.
- The `run pnpm test` suite (78 tests) runs fully offline (PGlite) — no accounts needed.
