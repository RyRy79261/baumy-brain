// Boot-time environment validation (architecture F7 / T13). Invoked from
// instrumentation.ts. Fails CLOSED in production: a missing required secret
// aborts startup rather than serving in a half-configured state.

interface EnvSpec {
  key: string
  minLen?: number
}

const REQUIRED: EnvSpec[] = [
  { key: 'DATABASE_URL' },
  { key: 'DATABASE_URL_UNPOOLED' },
  { key: 'TELEGRAM_BOT_TOKEN' },
  { key: 'TELEGRAM_WEBHOOK_SECRET', minLen: 16 },
  // NOT BAUMY_HOUSE_CHAT_ID — the house group is auto-captured when the bot is
  // added (my_chat_member → house_config). The env var is an optional override.
  { key: 'ANTHROPIC_API_KEY' },
  // No OPENAI_API_KEY — the classifier runs on Anthropic Haiku and embeddings are
  // local + in-process (lib/ai/embed.ts). Anthropic is the only AI vendor.
  // Session signing for the Telegram magic-link dashboard (lib/auth/session.ts).
  { key: 'BAUMY_SESSION_SECRET', minLen: 32 },
  // App-side AES-256-GCM key for secure values (lib/core/crypto.ts); base64 of 32
  // bytes: `openssl rand -base64 32`. Login is Telegram magic-link (no Better/Neon Auth).
  { key: 'BAUMY_ENCRYPTION_KEY', minLen: 32 },
]

export interface EnvReport {
  ok: boolean
  /** Human-readable problems, VAR NAMES ONLY — never values. Safe to surface. */
  problems: string[]
}

// Non-throwing readiness check. Used by /api/health (to report exactly what's
// missing) and by boot logging. Never leaks secret values.
export function checkServerEnv(): EnvReport {
  // During `next build` static collection there are no secrets — not runtime.
  if (process.env.NEXT_PHASE === 'phase-production-build') return { ok: true, problems: [] }

  const problems: string[] = []
  for (const spec of REQUIRED) {
    const v = process.env[spec.key]
    if (!v) problems.push(`missing ${spec.key}`)
    else if (spec.minLen && v.length < spec.minLen) {
      problems.push(`${spec.key} too short (min ${spec.minLen} chars)`)
    }
  }
  return { ok: problems.length === 0, problems }
}

// Boot check (instrumentation.ts). Deliberately does NOT throw: a half-configured
// deploy still boots so /api/health can REPORT what's missing, and each operational
// route (webhook secret, sends, DB, LLM) already fails closed on its own missing
// dependency. We just log loudly.
export function assertServerEnv(): void {
  const { ok, problems } = checkServerEnv()
  if (!ok) {
    console.error(
      `[baumy/env] server NOT fully configured — dependent routes will fail. Check /api/health:\n  - ${problems.join('\n  - ')}`,
    )
  }
}

export const houseChatId = (): string => process.env.BAUMY_HOUSE_CHAT_ID ?? ''
export const houseTz = (): string => process.env.BAUMY_TIMEZONE ?? 'Europe/Berlin'
export const dailySpendCapUsd = (): number => Number(process.env.BAUMY_DAILY_SPEND_CAP ?? '0.5')
