import { timingSafeEqual } from 'node:crypto'

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

// Constant-time comparison of the Telegram secret-token header against the
// configured secret (architecture D6). Runs BEFORE any body parse. Any
// mismatch, length difference, or missing config → false (fail closed).
export function verifyWebhookSecret(req: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? ''
  if (!expected) return false
  const got = req.headers.get(SECRET_HEADER) ?? ''

  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    timingSafeEqual(b, b) // keep timing ~constant, then reject
    return false
  }
  return timingSafeEqual(a, b)
}
