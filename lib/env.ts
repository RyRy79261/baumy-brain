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
  { key: 'BAUMY_HOUSE_CHAT_ID' },
  { key: 'ANTHROPIC_API_KEY' },
  { key: 'OPENAI_API_KEY' },
  { key: 'BAUMY_ENCRYPTION_KEY', minLen: 32 },
  { key: 'BETTER_AUTH_SECRET', minLen: 16 },
  { key: 'BETTER_AUTH_URL' },
  { key: 'BAUMY_SESSION_SECRET', minLen: 16 },
]

let validated = false

export function assertServerEnv(): void {
  if (validated) return
  // Skip during `next build` static collection — no secrets present, not runtime.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const errors: string[] = []
  for (const spec of REQUIRED) {
    const v = process.env[spec.key]
    if (!v) errors.push(`missing ${spec.key}`)
    else if (spec.minLen && v.length < spec.minLen) {
      errors.push(`${spec.key} too short (min ${spec.minLen} chars)`)
    }
  }

  if (errors.length > 0) {
    const msg = `[baumy/env] invalid server environment:\n  - ${errors.join('\n  - ')}`
    if (process.env.NODE_ENV === 'production') throw new Error(msg)
    console.warn(msg) // dev: warn loudly, don't crash the dev server
  }
  validated = true
}

export const houseChatId = (): string => process.env.BAUMY_HOUSE_CHAT_ID ?? ''
export const houseTz = (): string => process.env.BAUMY_TIMEZONE ?? 'Europe/Berlin'
export const dailySpendCapUsd = (): number => Number(process.env.BAUMY_DAILY_SPEND_CAP ?? '0.5')
