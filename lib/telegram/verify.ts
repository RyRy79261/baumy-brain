import { createHash, timingSafeEqual } from 'node:crypto'

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

// Constant-time comparison of the Telegram secret-token header against the
// configured secret (architecture D6/D2). Runs BEFORE any body parse. We compare
// fixed-length SHA-256 digests so NEITHER the length nor the content of the
// supplied token leaks through timing (no early length-branch). Missing config
// or missing/wrong header → false (fail closed).
export function verifyWebhookSecret(req: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? ''
  if (!expected) return false
  const got = req.headers.get(SECRET_HEADER) ?? ''

  const a = createHash('sha256').update(got).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
