import { and, eq, lte } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { scheduledTasks } from '@/db/schema'

export interface CreateTaskInput {
  groupId: string
  prompt: string
  cadence: string
  nextRunAt: Date
  untilExpiry?: Date | null
  requesterMemberId: string | null
  modelTier?: 'assess' | 'advisor'
  webSearchEnabled?: boolean
  isSystem?: boolean
}

export async function createScheduledTask(db: Database, input: CreateTaskInput): Promise<string> {
  const [t] = await db
    .insert(scheduledTasks)
    .values({
      groupId: input.groupId,
      prompt: input.prompt,
      cadence: input.cadence,
      nextRunAt: input.nextRunAt,
      untilExpiry: input.untilExpiry ?? null,
      requesterMemberId: input.requesterMemberId,
      modelTier: input.modelTier ?? 'assess',
      webSearchEnabled: input.webSearchEnabled ?? false,
      isSystem: input.isSystem ?? false,
    })
    .returning({ id: scheduledTasks.id })
  return t.id
}

// Active tasks due at/before `before` — for the shared dispatch cron.
export async function dueTasks(db: Database, before: Date, limit = 50) {
  return db
    .select({
      id: scheduledTasks.id,
      groupId: scheduledTasks.groupId,
      prompt: scheduledTasks.prompt,
      cadence: scheduledTasks.cadence,
      modelTier: scheduledTasks.modelTier,
      isSystem: scheduledTasks.isSystem,
      untilExpiry: scheduledTasks.untilExpiry,
    })
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.isActive, true), lte(scheduledTasks.nextRunAt, before)))
    .limit(limit)
}

// Record a run: advance next_run_at, or deactivate if done (null next / past until).
export async function recordRun(db: Database, id: string, nextRunAt: Date | null, untilExpiry: Date | null): Promise<void> {
  const deactivate = nextRunAt === null || (untilExpiry != null && nextRunAt > untilExpiry)
  await db
    .update(scheduledTasks)
    .set({ lastRunAt: new Date(), nextRunAt: deactivate ? null : nextRunAt, isActive: !deactivate })
    .where(eq(scheduledTasks.id, id))
}

export async function cancelScheduledTask(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(scheduledTasks)
    .set({ isActive: false })
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.isActive, true)))
    .returning({ id: scheduledTasks.id })
  return rows.length > 0
}

// Seed the two built-in digests (mid-week + end-of-week). Caller runs this once
// at house bootstrap.
export async function seedSystemDigests(db: Database, groupId: string, nextMid: Date, nextEnd: Date): Promise<void> {
  await db.insert(scheduledTasks).values([
    { groupId, prompt: 'digest', cadence: 'mid-week', nextRunAt: nextMid, isSystem: true },
    { groupId, prompt: 'digest', cadence: 'end-of-week', nextRunAt: nextEnd, isSystem: true },
  ])
}
