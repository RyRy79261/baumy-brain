'use server'

import { revalidatePath } from 'next/cache'
import { createHttpDb } from '@/db/client'
import { requireAdmin } from '@/lib/auth/require-admin'
import { applyMemberAccess } from '@/lib/identity/access'
import { cancelReminder } from '@/lib/reminders/store'
import { setGlobalEnabled, addMutedTopic, removeMutedTopic, setReplyFrequency, REPLY_FLOORS, type ReplyFrequency } from '@/lib/policy'

// All dashboard mutations re-verify the live session server-side; the form payload is
// never trusted for authorization. Dashboard access grants are OWNER-only (enforced in
// applyMemberAccess). How Baumy behaves in the house — pause, reply frequency, muted topics — is
// house territory, open to any dashboard user (a trusted housemate) and audited; infrastructure
// (spend, the console) stays with the owner (docs/spec/olympics-data-split.md). Single-tenant, so an
// id alone is house-scoped by construction.

// Grant/revoke dashboard access — owner-only + lock-out enforced in applyMemberAccess.
export async function setMemberAccessAction(formData: FormData): Promise<void> {
  const session = await requireAdmin()
  if (!session) return
  const targetUserId = String(formData.get('userId') ?? '')
  const allow = formData.get('allow') === 'grant'
  await applyMemberAccess(createHttpDb(), session.uid, targetUserId, allow)
  revalidatePath('/admin')
}

export async function cancelReminderAction(formData: FormData): Promise<void> {
  if (!(await requireAdmin())) return
  const id = String(formData.get('id') ?? '')
  if (id) await cancelReminder(createHttpDb(), id)
  revalidatePath('/admin/reminders')
}

export async function setPolicyEnabledAction(formData: FormData): Promise<void> {
  const session = await requireAdmin()
  if (!session) return
  const enabled = formData.get('enabled') === 'on'
  await setGlobalEnabled(createHttpDb(), enabled, { actor: session.uid, action: 'policy.enabled', metadata: { enabled } })
  revalidatePath('/admin/settings')
}

export async function setReplyFrequencyAction(formData: FormData): Promise<void> {
  const session = await requireAdmin()
  if (!session) return
  const level = String(formData.get('level') ?? '') as ReplyFrequency
  if (level in REPLY_FLOORS) {
    await setReplyFrequency(createHttpDb(), level, { actor: session.uid, action: 'policy.reply_frequency', metadata: { level } })
  }
  revalidatePath('/admin/settings')
}

export async function addMutedTopicAction(formData: FormData): Promise<void> {
  const session = await requireAdmin()
  if (!session) return
  const topic = String(formData.get('topic') ?? '')
  if (topic.trim()) {
    await addMutedTopic(createHttpDb(), topic, { actor: session.uid, action: 'policy.muted_topic.add', metadata: { topic: topic.trim() } })
  }
  revalidatePath('/admin/settings')
}

export async function removeMutedTopicAction(formData: FormData): Promise<void> {
  const session = await requireAdmin()
  if (!session) return
  const topic = String(formData.get('topic') ?? '')
  if (topic) {
    await removeMutedTopic(createHttpDb(), topic, { actor: session.uid, action: 'policy.muted_topic.remove', metadata: { topic } })
  }
  revalidatePath('/admin/settings')
}
