import { eq } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { members } from '@/db/schema'
import type { Roster } from '@/lib/core/origin'

export interface FullRoster extends Roster {
  canAccessDashboard: (id: number) => boolean
}

// Load the roster from DB, FAIL-CLOSED to the env owner seed on any error
// (B10 / security R5). Empty/erroring DB must never authorize everyone.
export async function loadRoster(db: Database): Promise<FullRoster> {
  const envOwner = process.env.BAUMY_OWNER_ID ?? ''
  const closed: FullRoster = {
    isOwner: (id) => envOwner !== '' && String(id) === envOwner,
    isMember: (id) => envOwner !== '' && String(id) === envOwner,
    canAccessDashboard: (id) => envOwner !== '' && String(id) === envOwner,
  }
  try {
    const rows = await db
      .select({ id: members.telegramUserId, role: members.role, dash: members.canAccessDashboard, active: members.isActive })
      .from(members)
    const active = rows.filter((r) => r.active)
    const owners = new Set(active.filter((r) => r.role === 'owner').map((r) => r.id))
    const memberIds = new Set(active.map((r) => r.id))
    const dash = new Set(active.filter((r) => r.dash).map((r) => r.id))
    if (envOwner) {
      owners.add(envOwner)
      memberIds.add(envOwner)
      dash.add(envOwner)
    }
    return {
      isOwner: (id) => owners.has(String(id)),
      isMember: (id) => memberIds.has(String(id)),
      canAccessDashboard: (id) => dash.has(String(id)),
    }
  } catch {
    return closed
  }
}

// Auto-discover / upsert a member from group activity (B10). Reactivates on rejoin.
export async function upsertMember(
  db: Database,
  groupId: string,
  userId: string,
  name: string | null,
  role?: 'owner' | 'member',
): Promise<void> {
  await db
    .insert(members)
    .values({ telegramUserId: userId, groupId, displayName: name, role: role ?? 'member' })
    .onConflictDoUpdate({
      target: members.telegramUserId,
      set: { isActive: true, ...(name ? { displayName: name } : {}), ...(role ? { role } : {}) },
    })
}

export async function deactivateMember(db: Database, userId: string): Promise<void> {
  await db.update(members).set({ isActive: false, deactivatedAt: new Date() }).where(eq(members.telegramUserId, userId))
}

// Capture a member's private-chat id (on /start) so Baumy can DM them later —
// e.g. hand them a dashboard link proactively instead of only ever replying.
export async function setDmChatId(db: Database, userId: string, dmChatId: string): Promise<void> {
  await db.update(members).set({ dmChatId }).where(eq(members.telegramUserId, userId))
}

// Owner-gated dashboard grant/revoke (returns false if no such member row).
export async function setDashboardAccess(db: Database, userId: string, allow: boolean): Promise<boolean> {
  const rows = await db
    .update(members)
    .set({ canAccessDashboard: allow })
    .where(eq(members.telegramUserId, userId))
    .returning({ id: members.telegramUserId })
  return rows.length > 0
}

export async function listActiveMembers(
  db: Database,
): Promise<Array<{ id: string; name: string | null; role: string; dashboard: boolean }>> {
  const rows = await db
    .select({
      id: members.telegramUserId,
      name: members.displayName,
      role: members.role,
      dashboard: members.canAccessDashboard,
      active: members.isActive,
    })
    .from(members)
  return rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name, role: r.role, dashboard: r.dashboard }))
}

// Parse a chat_member update (a HOUSEMATE's status change, not the bot's).
export function parseChatMember(update: unknown): { userId: string | null; status: string | null; name: string | null } {
  const u = update as {
    chat_member?: { new_chat_member?: { user?: { id?: number; first_name?: string; username?: string }; status?: string } }
  }
  const ncm = u.chat_member?.new_chat_member
  if (!ncm?.user?.id) return { userId: null, status: null, name: null }
  return { userId: String(ncm.user.id), status: ncm.status ?? null, name: ncm.user.first_name ?? ncm.user.username ?? null }
}

// Parse a my_chat_member update: was the BOT added, and by whom (→ owner = inviter)?
export function parseMyChatMember(update: unknown): { botAdded: boolean; inviterId: number | null; chatId: string | null } {
  const u = update as {
    my_chat_member?: {
      from?: { id?: number }
      chat?: { id?: number }
      new_chat_member?: { status?: string }
    }
  }
  const mcm = u.my_chat_member
  if (!mcm) return { botAdded: false, inviterId: null, chatId: null }
  const status = mcm.new_chat_member?.status
  const botAdded = status === 'member' || status === 'administrator'
  return {
    botAdded,
    inviterId: mcm.from?.id ?? null,
    chatId: mcm.chat?.id != null ? String(mcm.chat.id) : null,
  }
}
