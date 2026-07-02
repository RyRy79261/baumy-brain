# Baumy Brain — Setup & Deploy

Everything below runs on **free tiers**. The only ongoing cost is LLM tokens (single-digit $/mo at house scale).

## 0. Accounts you'll need
- **Telegram** (you already have it) → talk to **@BotFather**
- **Neon** (Postgres + pgvector) — neon.tech
- **Vercel** (hosting) — vercel.com
- **Anthropic** (replies/digests) — console.anthropic.com
- **OpenAI** (cheap classifier + embeddings) — platform.openai.com
- **Inngest** (background jobs) — inngest.com  *(easiest via the Vercel integration)*

---

## 1. Create the bot + grab the IDs
1. In **@BotFather**: `/newbot` → get the **bot token**.
2. **Disable privacy mode** (so Baumy sees all group messages): `/mybots` → your bot → *Bot Settings* → *Group Privacy* → **Turn off**.
3. Create your **house Telegram group**, add the bot, and **send one message** in it.
4. Get the chat + your user id (works only *before* a webhook is set):
   ```bash
   curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" \
     | jq '.result[].message | {chat: .chat.id, from: .from.id, name: .from.first_name}'
   ```
   - The negative `chat` id → **`BAUMY_HOUSE_CHAT_ID`** (e.g. `-1001234567890`)
   - Your `from` id → **`BAUMY_OWNER_ID`**

## 2. Neon
1. Create a project. Copy **both** connection strings from the dashboard:
   - pooled (`...-pooler...`) → **`DATABASE_URL`**
   - direct/unpooled → **`DATABASE_URL_UNPOOLED`**  *(migrations need the direct one)*
2. pgvector needs no setup — migration `0000` runs `CREATE EXTENSION vector`.

## 3. LLM keys
- Anthropic → **`ANTHROPIC_API_KEY`**
- OpenAI → **`OPENAI_API_KEY`**

## 4. Generate the app secrets
```bash
openssl rand -base64 32   # BAUMY_ENCRYPTION_KEY   (>=32 chars)
openssl rand -hex 24      # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 24      # BAUMY_SESSION_SECRET
openssl rand -hex 24      # BETTER_AUTH_SECRET
```

## 5. Environment variables
Put these in **Vercel → Project → Settings → Environment Variables** (mark secrets *Sensitive*), and in a local **`.env.local`** for dev. See `.env.example`.

| Var | Value |
|-----|-------|
| `DATABASE_URL` | Neon pooled URL |
| `DATABASE_URL_UNPOOLED` | Neon direct URL |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | generated (step 4) |
| `BAUMY_HOUSE_CHAT_ID` | group chat id (step 1) |
| `BAUMY_OWNER_ID` | your user id (step 1) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | LLM keys |
| `BAUMY_ENCRYPTION_KEY` | generated |
| `BAUMY_SESSION_SECRET` | generated |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | generated / your deployed URL *(required by the boot check; placeholders for the deferred Better Auth swap)* |
| `BAUMY_PUBLIC_URL` | your deployed URL (e.g. `https://baumy.vercel.app`) |
| `BAUMY_TIMEZONE` | `Europe/Berlin` (default) |
| `BAUMY_DAILY_SPEND_CAP` | `0.5` (default) |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | **auto-injected** by the Vercel↔Inngest integration |

> ⚠️ **Verify at build:** the default model ids in `lib/ai/models.ts` are placeholders — confirm the current Anthropic/OpenAI ids and set the `BAUMY_*_MODEL` overrides if needed.

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
4. Deploy. Note your production URL → set `BAUMY_PUBLIC_URL` / `BETTER_AUTH_URL` to it and redeploy.

## 8. Register the Telegram webhook
```bash
BAUMY_PUBLIC_URL='https://<your-app>.vercel.app' \
TELEGRAM_BOT_TOKEN='<token>' \
TELEGRAM_WEBHOOK_SECRET='<secret>' \
node --experimental-strip-types scripts/set-webhook.ts
```
It sets the webhook + `allowed_updates`, drops pending updates, and **warns if privacy mode is still on**.

## 9. Go live
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
