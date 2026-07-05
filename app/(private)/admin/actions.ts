'use server'

import { revalidatePath } from 'next/cache'
import { createHttpDb } from '@/db/client'
import { requireAdmin, requireOwner } from '@/lib/auth/require-admin'
import { applyMemberAccess } from '@/lib/identity/access'
import { cancelReminder } from '@/lib/reminders/store'
import { setGlobalEnabled, addMutedTopic, removeMutedTopic, setReplyFrequency, REPLY_FLOORS, type ReplyFrequency } from '@/lib/policy'

// All dashboard mutations re-verify the live session server-side; the form payload is
// never trusted for authorization. Privileged config (access, policy) is
// OWNER-only; a low-stakes reminder cancel is open to any dashboard user (a trusted
// housemate). Single-tenant, so an id alone is house-scoped by construction.

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
  if (!(await requireOwner())) return
  await setGlobalEnabled(createHttpDb(), formData.get('enabled') === 'on')
  revalidatePath('/admin/settings')
}

export async function setReplyFrequencyAction(formData: FormData): Promise<void> {
  if (!(await requireOwner())) return
  const level = String(formData.get('level') ?? '') as ReplyFrequency
  if (level in REPLY_FLOORS) await setReplyFrequency(createHttpDb(), level)
  revalidatePath('/admin/settings')
}

export async function addMutedTopicAction(formData: FormData): Promise<void> {
  if (!(await requireOwner())) return
  const topic = String(formData.get('topic') ?? '')
  if (topic.trim()) await addMutedTopic(createHttpDb(), topic)
  revalidatePath('/admin/settings')
}

export async function removeMutedTopicAction(formData: FormData): Promise<void> {
  if (!(await requireOwner())) return
  const topic = String(formData.get('topic') ?? '')
  if (topic) await removeMutedTopic(createHttpDb(), topic)
  revalidatePath('/admin/settings')
}
