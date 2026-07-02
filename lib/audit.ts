import { type Database } from '@/db/client'
import { auditLog } from '@/db/schema'

// Append-only audit trail for privileged/config actions (security: every grant,
// revoke, membership change, and policy change is recorded and dashboard-visible).
export async function writeAudit(
  db: Database,
  action: string,
  actor: string | null,
  target: string | null,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  await db.insert(auditLog).values({ action, actorMemberId: actor, target, metadata: metadata ?? null })
}
