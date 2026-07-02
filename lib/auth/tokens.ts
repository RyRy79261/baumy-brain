import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { dashboardLoginTokens } from '@/db/schema'

// One-time dashboard login tokens (Phase 6 / decision A1b). The RAW token goes
// in the magic link; only its SHA-256 hash is stored, so a DB dump can't mint
// sessions. Single-use is enforced atomically.
function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export async function issueLoginToken(db: Database, userId: string, ttlSec = 300): Promise<string> {
  const raw = randomBytes(32).toString('base64url')
  await db.insert(dashboardLoginTokens).values({
    tokenHash: hash(raw),
    userId,
    expiresAt: new Date(Date.now() + ttlSec * 1000),
  })
  return raw
}

// Atomic single-use consume: succeeds only if unconsumed AND unexpired.
export async function consumeLoginToken(db: Database, raw: string): Promise<string | null> {
  const rows = await db
    .update(dashboardLoginTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(dashboardLoginTokens.tokenHash, hash(raw)),
        isNull(dashboardLoginTokens.consumedAt),
        gt(dashboardLoginTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: dashboardLoginTokens.userId })
  return rows[0]?.userId ?? null
}
