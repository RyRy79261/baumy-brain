'use server'

import { revalidatePath } from 'next/cache'
import { createHttpDb } from '@/db/client'
import { requireAdmin } from '@/lib/auth/require-admin'
import { applyMemberAccess } from '@/lib/identity/access'

// Grant/revoke dashboard access from the member view. requireAdmin re-verifies the
// live session; applyMemberAccess enforces owner-only + lock-out. Both re-check the
// DB — the form payload is never trusted for authorization.
export async function setMemberAccessAction(formData: FormData): Promise<void> {
  const session = await requireAdmin()
  if (!session) return
  const targetUserId = String(formData.get('userId') ?? '')
  const allow = formData.get('allow') === 'grant'
  await applyMemberAccess(createHttpDb(), session.uid, targetUserId, allow)
  revalidatePath('/admin')
}
