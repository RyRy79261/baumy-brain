import { createHash, timingSafeEqual } from 'node:crypto'

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

// Constant-time comparison of a supplied token against the configured secret. We compare
// fixed-length SHA-256 digests so NEITHER the length nor the content of the supplied token
// leaks through timing (no early length-branch). An empty `expected` (unset config) is always
// false — fail closed. Shared by the Telegram webhook and the kitchen API bearer token.
export function tokenMatches(got: string, expected: string): boolean {
  if (!expected) return false
  const a = createHash('sha256').update(got).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

// Constant-time comparison of the Telegram secret-token header against the
// configured secret (architecture D6/D2). Runs BEFORE any body parse. Missing
// config or missing/wrong header → false (fail closed).
export function verifyWebhookSecret(req: Request): boolean {
  return tokenMatches(req.headers.get(SECRET_HEADER) ?? '', process.env.TELEGRAM_WEBHOOK_SECRET ?? '')
}
