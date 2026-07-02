import { checkServerEnv } from '@/lib/env'

export const runtime = 'nodejs'

// Readiness probe. Reports MISSING required env by NAME (never values) so a
// misconfigured deploy is diagnosable without digging through function logs.
export function GET() {
  const env = checkServerEnv()
  if (!env.ok) {
    return Response.json({ ok: false, service: 'baumy', notReady: env.problems }, { status: 503 })
  }
  return Response.json({ ok: true, service: 'baumy' })
}
